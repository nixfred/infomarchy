// HERMES HOSTS: a read-only overview of other machines running the Hermes
// agent. One row per host: is its gateway connected, what is it working on,
// how many approvals are waiting on a human, and how old that knowledge is.
//
// SOURCE. Hermes keeps its live state in plain files under its home directory
// ($HOME/.hermes unless the host overrides HERMES_HOME), so nothing here needs
// a Hermes API, a token or a daemon. One ssh round trip reads:
//   state/gateway.heartbeat      the gateway's own liveness record (pid, time)
//   gateway_state.json           gateway_state and active_agents
//   state.db  `sessions`         the newest session that has not ended
//   pending/{memory,skills}/*.json   writes staged for human approval
// Every command is fixed text. Nothing in configuration reaches a remote shell
// except the ssh alias, which is validated by parseHostList(). There is no
// write, no control and no approve or deny anywhere in this module.
//
// STALENESS is the point, so it is computed twice over and never trusted:
//   - age is measured on the REMOTE clock (remote `date +%s` against the
//     heartbeat the remote wrote), then advanced by the local time since the
//     probe. A host whose clock is off cannot make old data look fresh.
//   - a host that fails the probe is `unreachable`. Its last good state is
//     never shown; only "last seen N ago" survives.
//   - fresh, stale and critical are cut by two configurable thresholds.
//
// WINDOWS. The probe is POSIX sh. A Windows host works when its ssh shell is
// sh-compatible (WSL, Git Bash, MSYS); a host whose ssh shell is cmd or
// PowerShell answers the probe with nothing usable and reads `unreadable`
// rather than anything invented.
import { parseHostList, type FleetHostConfig, type FleetRunner } from "./fleet-remote";

export type HermesHostStatus = "ok" | "unreadable" | "unreachable";
export type HermesStaleLevel = "fresh" | "stale" | "critical";
export type HermesApproval = { kind: string; summary: string; ageSec: number };
export type HermesHostFacts = {
  gateway: string;            // gateway_state as Hermes reports it, e.g. "running"
  activeAgents: number;
  task: string;               // title of the newest session still open
  activity: string;           // what that session last did
  taskAgeSec: number | null;  // on the remote clock
  heartbeatAgeSec: number | null; // remote now - gateway heartbeat, remote clock
  approvals: { count: number; items: HermesApproval[] };
};
export type HermesHostResult = {
  label: string; host: string; status: HermesHostStatus;
  checkedAt: number;          // local ms of the last probe, good or bad
  lastGoodAt: number;         // local ms of the last probe that returned state, 0 if never
  facts: HermesHostFacts | null; // present only when the LAST probe returned state
};
export type HermesHostsStore = { checkedAt: number; results: HermesHostResult[] };
export type HermesThresholds = { staleSec: number; criticalSec: number };
export type HermesHostRow = {
  label: string; host: string; status: HermesHostStatus;
  connected: boolean; gateway: string; activeAgents: number;
  task: string; activity: string; working: boolean;
  approvals: number; approvalItems: HermesApproval[];
  ageSec: number | null;      // how old what you are looking at is
  lastSeenSec: number | null; // unreachable rows: time since the last good read
  level: HermesStaleLevel;
};

export const HERMES_HOSTS_REFRESH_MS = 30_000;
export const HERMES_HOSTS_SSH_TIMEOUT_MS = 6_000;
export const DEFAULT_STALE_SEC = 300;
export const DEFAULT_CRITICAL_SEC = 1800;
const MAX_HOSTS = 8;
const MAX_APPROVAL_ITEMS = 5;
const MAX_APPROVAL_COUNT = 99;
const STORE_MAX_BYTES = 262_144;
const PROBE_MAX_BYTES = 24_576;
const MARK_OK = "___HERMES_HOSTS_OK___";
const MARK_HEARTBEAT = "___HERMES_HEARTBEAT___";
const MARK_STATE = "___HERMES_STATE___";
const MARK_SESSION = "___HERMES_SESSION___";
const MARK_PENDING = "___HERMES_PENDING___";
const MARK_FILE = "___HERMES_FILE___";

const SESSION_QUERY =
  "SELECT title, last_activity_description AS activity, last_activity_at AS at FROM sessions " +
  "WHERE ended_at IS NULL AND last_activity_at IS NOT NULL ORDER BY last_activity_at DESC LIMIT 1;";

// POSIX sh, fixed text. `H` is expanded by the remote shell. The pending loop
// prints a marker before each file so the count never depends on the file
// parsing, and each file is cut at 1 KiB. The whole output is cut again at
// PROBE_MAX_BYTES, so a hostile or runaway host cannot flood the collector.
const PROBE_CMD =
  `H="\${HERMES_HOME:-$HOME/.hermes}"; echo ${MARK_OK}; date +%s; ` +
  `echo ${MARK_HEARTBEAT}; head -c 2048 "$H/state/gateway.heartbeat" 2>/dev/null; echo; ` +
  `echo ${MARK_STATE}; head -c 4096 "$H/gateway_state.json" 2>/dev/null; echo; ` +
  `echo ${MARK_SESSION}; test -f "$H/state.db" && sqlite3 -json -readonly "$H/state.db" '${SESSION_QUERY}' 2>/dev/null; echo; ` +
  `echo ${MARK_PENDING}; for f in "$H"/pending/memory/*.json "$H"/pending/skills/*.json; do ` +
  `[ -f "$f" ] && { echo ${MARK_FILE}; head -c 1024 "$f"; echo; }; done; true`;

function sshArgs(host: string): string[] {
  return [
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4",
    "-o", "ServerAliveInterval=4", "-o", "ServerAliveCountMax=1",
    host, `(${PROBE_CMD}) | head -c ${PROBE_MAX_BYTES}`,
  ];
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Text that came from another machine reaches the desk only as plain, bounded
// text: control characters become spaces, length is clamped.
export function safeText(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

// Config values: env wins, bad or absent values fall back to the defaults, and
// critical can never sit below stale (that would make a row skip its warning).
export function thresholdsFromEnv(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): HermesThresholds {
  const read = (name: string, fallback: number, min: number) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), 7 * 86_400) : fallback;
  };
  const staleSec = read("INFOMARCHY_HERMES_STALE_SECS", DEFAULT_STALE_SEC, 30);
  const criticalSec = Math.max(staleSec, read("INFOMARCHY_HERMES_CRITICAL_SECS", DEFAULT_CRITICAL_SEC, 30));
  return { staleSec, criticalSec };
}

export function hermesHostsFromEnv(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): FleetHostConfig[] {
  return parseHostList(String(env.INFOMARCHY_HERMES_HOSTS || ""));
}

export function hermesHostsEnabled(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): boolean {
  return env.INFOMARCHY_SKIP_HERMES_HOSTS !== "1";
}

function split(output: string): Record<string, string> | null {
  const marks = [MARK_OK, MARK_HEARTBEAT, MARK_STATE, MARK_SESSION, MARK_PENDING];
  if (!output.includes(MARK_OK)) return null;
  const sections: Record<string, string> = {};
  let current = "";
  for (const line of output.split("\n")) {
    const mark = marks.find(m => line.trim() === m);
    if (mark) { current = mark; sections[current] = ""; continue; }
    if (current) sections[current] += line + "\n";
  }
  return sections;
}

// Returns facts when the host answered AND Hermes state was readable, null
// when the shell answered but nothing about Hermes could be read (no Hermes,
// wrong shell, unreadable home). `null` is never "all clear".
export function parseHermesProbe(output: string): HermesHostFacts | null {
  const sections = split(output);
  if (!sections) return null;
  const nowEpoch = Number((sections[MARK_OK] || "").trim().split("\n")[0]);
  const heartbeat = parseJsonObject(sections[MARK_HEARTBEAT] || "");
  const state = parseJsonObject(sections[MARK_STATE] || "");
  let session: Record<string, unknown> | null = null;
  try {
    const rows = JSON.parse((sections[MARK_SESSION] || "").trim() || "[]");
    if (Array.isArray(rows) && rows[0] && typeof rows[0] === "object") session = rows[0] as Record<string, unknown>;
  } catch {}
  const pendingText = sections[MARK_PENDING] || "";
  const files = pendingText.split(MARK_FILE).slice(1);
  if (!heartbeat && !state && !session && !files.length) return null;
  const remoteNow = Number.isFinite(nowEpoch) && nowEpoch > 0 ? nowEpoch : 0;

  const beat = heartbeat && typeof heartbeat.updated_at === "string" ? Date.parse(heartbeat.updated_at) / 1000 : NaN;
  const heartbeatAgeSec = remoteNow && Number.isFinite(beat) ? Math.max(0, Math.round(remoteNow - beat)) : null;
  const sessionAt = session ? finite(session.at) : 0;
  const taskAgeSec = remoteNow && sessionAt ? Math.max(0, Math.round(remoteNow - sessionAt)) : null;

  const items: HermesApproval[] = [];
  for (const raw of files) {
    if (items.length >= MAX_APPROVAL_ITEMS) break;
    const record = parseJsonObject(raw);
    const created = record ? finite(record.created_at) : 0;
    items.push({
      kind: record ? safeText(record.subsystem, 16) || "write" : "write",
      summary: record ? safeText(record.summary, 80) : "",
      ageSec: remoteNow && created ? Math.max(0, Math.round(remoteNow - created)) : 0,
    });
  }
  return {
    gateway: safeText(state?.gateway_state, 24),
    activeAgents: Math.min(999, Math.floor(finite(state?.active_agents))),
    task: session ? safeText(session.title, 80) : "",
    activity: session ? safeText(session.activity, 60) : "",
    taskAgeSec,
    heartbeatAgeSec,
    approvals: { count: Math.min(MAX_APPROVAL_COUNT, files.length), items },
  };
}

export function emptyHermesHostsStore(): HermesHostsStore {
  return { checkedAt: 0, results: [] };
}

function normalizeFacts(raw: unknown): HermesHostFacts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, any>;
  const items = Array.isArray(s.approvals?.items)
    ? s.approvals.items.slice(0, MAX_APPROVAL_ITEMS).filter((i: any) => i && typeof i === "object").map((i: any) => ({ kind: safeText(i.kind, 16), summary: safeText(i.summary, 80), ageSec: Math.floor(finite(i.ageSec)) }))
    : [];
  const age = (v: unknown) => (v === null || v === undefined ? null : Math.floor(finite(v)));
  return {
    gateway: safeText(s.gateway, 24), activeAgents: Math.min(999, Math.floor(finite(s.activeAgents))),
    task: safeText(s.task, 80), activity: safeText(s.activity, 60),
    taskAgeSec: age(s.taskAgeSec), heartbeatAgeSec: age(s.heartbeatAgeSec),
    approvals: { count: Math.min(MAX_APPROVAL_COUNT, Math.floor(finite(s.approvals?.count))), items },
  };
}

export function normalizeHermesHostsStore(raw: unknown): HermesHostsStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyHermesHostsStore();
  const source = raw as Record<string, unknown>;
  const results: HermesHostResult[] = [];
  for (const entry of Array.isArray(source.results) ? source.results.slice(0, MAX_HOSTS) : []) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const parsed = parseHostList(String(e.host ?? ""));
    if (!parsed.length) continue;
    const status: HermesHostStatus = e.status === "ok" || e.status === "unreadable" ? e.status : "unreachable";
    results.push({
      label: parseHostList(`${String(e.label ?? "")}=${parsed[0].host}`)[0]?.label || parsed[0].host,
      host: parsed[0].host, status, checkedAt: finite(e.checkedAt), lastGoodAt: finite(e.lastGoodAt),
      facts: status === "ok" ? normalizeFacts(e.facts) : null,
    });
  }
  return { checkedAt: finite(source.checkedAt), results };
}

export function parseHermesHostsStoreText(text: string | null | undefined): HermesHostsStore {
  if (typeof text !== "string" || !text || text.length > STORE_MAX_BYTES) return emptyHermesHostsStore();
  try { return normalizeHermesHostsStore(JSON.parse(text)); } catch { return emptyHermesHostsStore(); }
}

export function hermesHostsRefreshDue(store: HermesHostsStore, now: number): boolean {
  const last = store.checkedAt || 0;
  if (!(last > 0) || last > now) return true;
  return now - last >= HERMES_HOSTS_REFRESH_MS;
}

async function probeHost(config: FleetHostConfig, previous: HermesHostResult | undefined, runner: FleetRunner, now: number): Promise<HermesHostResult> {
  const base = { label: config.label, host: config.host, checkedAt: now };
  let output = "";
  try { output = await runner(sshArgs(config.host), HERMES_HOSTS_SSH_TIMEOUT_MS); } catch {}
  // Empty output is a timeout, a refused connection or a failed spawn: the
  // runner folds them together, and a host that is up always prints the marker.
  if (!output.includes(MARK_OK)) return { ...base, status: "unreachable", lastGoodAt: previous?.lastGoodAt || 0, facts: null };
  const facts = parseHermesProbe(output);
  if (!facts) return { ...base, status: "unreadable", lastGoodAt: now, facts: null };
  return { ...base, status: "ok", lastGoodAt: now, facts };
}

export async function refreshHermesHosts(store: HermesHostsStore, now: number, hosts: FleetHostConfig[], runner: FleetRunner): Promise<HermesHostsStore> {
  if (!hosts.length) return { checkedAt: now, results: [] };
  const results = await Promise.all(hosts.slice(0, MAX_HOSTS).map(host => probeHost(host, store.results.find(r => r.host === host.host), runner, now)));
  return { checkedAt: now, results };
}

export function levelForAge(ageSec: number | null, thresholds: HermesThresholds): HermesStaleLevel {
  if (ageSec === null) return "critical";
  if (ageSec >= thresholds.criticalSec) return "critical";
  if (ageSec >= thresholds.staleSec) return "stale";
  return "fresh";
}

// Rows are derived at read time, so the age keeps growing between probes and
// the overlay (which never probes) shows the same truth as the background.
export function hermesHostsSnapshot(store: HermesHostsStore, now: number, thresholds: HermesThresholds): HermesHostRow[] {
  return store.results.map(result => {
    const since = (ms: number) => (ms > 0 && ms <= now ? Math.round((now - ms) / 1000) : null);
    const row: HermesHostRow = {
      label: result.label, host: result.host, status: result.status,
      connected: false, gateway: "", activeAgents: 0, task: "", activity: "", working: false,
      approvals: 0, approvalItems: [], ageSec: null, lastSeenSec: since(result.lastGoodAt), level: "critical",
    };
    if (result.status === "unreachable") return row;
    const probeAge = since(result.checkedAt);
    if (result.status === "unreadable") return { ...row, ageSec: probeAge, level: levelForAge(probeAge, thresholds) };
    const f = result.facts;
    if (!f) return { ...row, status: "unreadable", ageSec: probeAge, level: levelForAge(probeAge, thresholds) };
    // What you are looking at is as old as the OLDER of: the host's own
    // heartbeat (a hung gateway stops writing it) and our last probe.
    const ageSec = f.heartbeatAgeSec === null || probeAge === null ? null : f.heartbeatAgeSec + probeAge;
    const level = levelForAge(ageSec, thresholds);
    const working = f.activeAgents > 0;
    return {
      ...row, connected: f.gateway === "running" && level !== "critical", gateway: f.gateway, activeAgents: f.activeAgents,
      task: working ? f.task : "", activity: working ? f.activity : "", working,
      approvals: f.approvals.count, approvalItems: f.approvals.items, ageSec, level,
    };
  });
}

// Demo mode. Fake hosts only: invented labels, invented tasks, no alias a real
// machine could have. One stale, one unreachable, so the public preview shows
// every state the real panel can be in.
export function demoHermesHosts(): HermesHostRow[] {
  return [
    { label: "Studio Mac", host: "demo-mac", status: "ok", connected: true, gateway: "running", activeAgents: 2, task: "Summarize the quarterly metrics export", activity: "calling tool", working: true, approvals: 2, approvalItems: [{ kind: "skills", summary: "Update the release-notes skill", ageSec: 540 }, { kind: "memory", summary: "Remember the deploy window", ageSec: 120 }], ageSec: 8, lastSeenSec: 8, level: "fresh" },
    { label: "Laptop Windows", host: "demo-win", status: "ok", connected: true, gateway: "running", activeAgents: 0, task: "", activity: "", working: false, approvals: 0, approvalItems: [], ageSec: 12 * 60, lastSeenSec: 12 * 60, level: "stale" },
    { label: "Office Mac", host: "demo-mac-2", status: "unreachable", connected: false, gateway: "", activeAgents: 0, task: "", activity: "", working: false, approvals: 0, approvalItems: [], ageSec: null, lastSeenSec: 3 * 3600, level: "critical" },
  ];
}
