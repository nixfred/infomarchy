// Presence detection for AI agents running on other machines, reached over
// SSH — typically a Tailscale MagicDNS name that's already resolvable
// through the caller's own ssh client. This is the "Fleet row: other hosts'
// AI load over SSH/Tailscale" item from the project roadmap.
//
// It mirrors collector.ts's local /proc scan in spirit but can only see what
// one bounded `ps` call reports, so process identification is a
// launcher-name heuristic on whitespace-joined argv — the same trade-off
// local detection makes (matching the launcher name, not the runtime),
// just without exact null-delimited argv boundaries. Good enough to answer
// "is Hermes running over there", not precise enough for anything finer.
//
// Host config never carries a user, identity file, or path: point
// INFOMARCHY_FLEET_HOSTS at whatever alias you'd type after `ssh` yourself.
// User, IdentityFile, and ProxyJump belong in ~/.ssh/config like any other
// host. BatchMode=yes means an unknown host key fails the probe instead of
// prompting — first contact with a new host still has to happen at a real
// terminal once, the normal way.

import { isIP } from "net";

export type FleetRunner = (cmd: string[], timeoutMs: number) => Promise<string>;
export type ProviderMatcher = (cmd: string[]) => string | null;

export type FleetHostConfig = { label: string; host: string };
export type FleetAgent = { provider: string; pid: number };
export type FleetHostResult = { label: string; host: string; ok: boolean; agents: FleetAgent[]; checkedAt: number; latencyMs: number };
export type FleetStore = { checkedAt: number; results: FleetHostResult[] };
export type FleetSnapshotRow = { label: string; host: string; ok: boolean; checkedAt: number; providers: { provider: string; count: number }[] };

export const FLEET_REFRESH_MS = 30_000;
export const FLEET_SSH_TIMEOUT_MS = 4_000;
const MAX_FLEET_HOSTS = 8;
const MAX_AGENTS_PER_HOST = 64;
const MAX_PROBE_BYTES = 65_536;

// One shot, read-only, no shell state changed on the remote end. head -c
// bounds the transfer even if the box has thousands of procs; the local
// runner bounds it again on this end (see collector.ts's run()).
const FLEET_PROBE_CMD = `ps -eo pid=,args= 2>/dev/null | head -c ${MAX_PROBE_BYTES}`;

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,31})$/;

function validHost(value: string): string {
  const host = value.trim();
  if (!host || host.length > 253) return "";
  if (isIP(host)) return host;
  return HOST_RE.test(host) ? host : "";
}

function validLabel(value: string, fallback: string): string {
  const label = value.trim();
  return LABEL_RE.test(label) ? label : fallback;
}

export function fleetEnabled(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): boolean {
  return env.INFOMARCHY_SKIP_FLEET !== "1";
}

// INFOMARCHY_FLEET_HOSTS="hermes-vps,Backup Box=other-host" — bare entries
// use the host itself as the label; "label=host" sets a display name.
// Never a user@host or a path; see the module header for why.
export function fleetHostsFromEnv(env: NodeJS.Dict<string> | NodeJS.ProcessEnv = process.env): FleetHostConfig[] {
  const raw = String(env.INFOMARCHY_FLEET_HOSTS || "");
  if (!raw.trim()) return [];
  const seen = new Set<string>();
  const hosts: FleetHostConfig[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const rawLabel = eq > 0 ? trimmed.slice(0, eq) : "";
    const rawHost = eq > 0 ? trimmed.slice(eq + 1) : trimmed;
    const host = validHost(rawHost);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push({ label: validLabel(rawLabel, host), host });
    if (hosts.length >= MAX_FLEET_HOSTS) break;
  }
  return hosts;
}

export function emptyFleetStore(): FleetStore {
  return { checkedAt: 0, results: [] };
}

const FLEET_STORE_MAX_BYTES = 262_144;

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeAgent(raw: unknown): FleetAgent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const provider = typeof source.provider === "string" ? source.provider.slice(0, 32) : "";
  const pid = Math.floor(finite(source.pid));
  return provider && pid > 0 ? { provider, pid } : null;
}

function normalizeHostResult(raw: unknown): FleetHostResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const host = validHost(String(source.host ?? ""));
  if (!host) return null;
  const label = validLabel(String(source.label ?? ""), host);
  const agents = Array.isArray(source.agents)
    ? source.agents.slice(0, MAX_AGENTS_PER_HOST).map(normalizeAgent).filter((a): a is FleetAgent => a !== null)
    : [];
  return { label, host, ok: source.ok === true, agents, checkedAt: finite(source.checkedAt), latencyMs: finite(source.latencyMs) };
}

// Disk-persisted between collector ticks — collector.ts is re-invoked fresh
// every 5s, so this is the only place refresh throttling can live. Same
// shape of trust as github-activity.ts's store: never assume the file on
// disk still matches this module's types.
export function normalizeFleetStore(raw: unknown): FleetStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyFleetStore();
  const source = raw as Record<string, unknown>;
  const results = Array.isArray(source.results)
    ? source.results.slice(0, MAX_FLEET_HOSTS).map(normalizeHostResult).filter((r): r is FleetHostResult => r !== null)
    : [];
  return { checkedAt: finite(source.checkedAt), results };
}

export function parseFleetStoreText(text: string | null | undefined): FleetStore {
  if (typeof text !== "string" || !text || text.length > FLEET_STORE_MAX_BYTES) return emptyFleetStore();
  try { return normalizeFleetStore(JSON.parse(text)); } catch { return emptyFleetStore(); }
}

export function fleetRefreshDue(store: FleetStore, now: number): boolean {
  const last = store.checkedAt || 0;
  if (!(last > 0) || last > now) return true;
  return now - last >= FLEET_REFRESH_MS;
}

function sshArgs(host: string): string[] {
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=4",
    "-o", "ServerAliveInterval=4",
    "-o", "ServerAliveCountMax=1",
    host,
    FLEET_PROBE_CMD,
  ];
}

export function parseAgents(output: string, providerOf: ProviderMatcher): FleetAgent[] {
  const agents: FleetAgent[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const cmd = match[2].trim().split(/\s+/).filter(Boolean);
    if (!cmd.length) continue;
    const provider = providerOf(cmd);
    if (!provider) continue;
    agents.push({ provider, pid });
    if (agents.length >= MAX_AGENTS_PER_HOST) break;
  }
  return agents;
}

async function probeHost(config: FleetHostConfig, runner: FleetRunner, providerOf: ProviderMatcher, now: number): Promise<FleetHostResult> {
  const started = Date.now();
  try {
    const output = await runner(sshArgs(config.host), FLEET_SSH_TIMEOUT_MS);
    // The runner's contract collapses "timed out", "spawn failed" and "no
    // output" into the same empty string, and a genuinely reachable host's
    // own ps/sshd rows mean it's never truly silent — so empty reads as
    // unreachable. A real host degrading to "not present", never a
    // fabricated one.
    const ok = output.trim().length > 0;
    return { label: config.label, host: config.host, ok, agents: ok ? parseAgents(output, providerOf) : [], checkedAt: now, latencyMs: Date.now() - started };
  } catch {
    return { label: config.label, host: config.host, ok: false, agents: [], checkedAt: now, latencyMs: Date.now() - started };
  }
}

export async function refreshFleet(store: FleetStore, now: number, hosts: FleetHostConfig[], runner: FleetRunner, providerOf: ProviderMatcher): Promise<FleetStore> {
  if (!hosts.length) return { checkedAt: now, results: [] };
  const results = await Promise.all(hosts.map(host => probeHost(host, runner, providerOf, now)));
  return { checkedAt: now, results };
}

export function fleetSnapshot(store: FleetStore): FleetSnapshotRow[] {
  return store.results.map(result => {
    const counts = new Map<string, number>();
    for (const agent of result.agents) counts.set(agent.provider, (counts.get(agent.provider) || 0) + 1);
    return {
      label: result.label, host: result.host, ok: result.ok, checkedAt: result.checkedAt,
      providers: [...counts.entries()].map(([provider, count]) => ({ provider, count })),
    };
  });
}
