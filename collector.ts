#!/usr/bin/env bun
// Infomarchy collector — one JSON snapshot of "what is AI doing on this machine"
// plus the boring machine stats. Runs under bun, prints JSON to stdout.
// Never hardcodes a user, host or home path: everything derives from $HOME,
// XDG_*, /proc and /sys. Missing tools/dirs degrade to nulls, never crash.

import { readdirSync, readFileSync, statSync, existsSync, readlinkSync, mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { Database } from "bun:sqlite";
import { localDayIndex, localDayStarts } from "./history-time";
import { attentionState, parseGitStatus, repoCollisions, workspaceGroups, resourceDelta } from "./ai-ops";

const HOME = process.env.HOME || "/root";
const XDG_STATE = process.env.XDG_STATE_HOME || join(HOME, ".local/state");
const STATE_DIR = join(XDG_STATE, "infomarchy");
// Background + overlay each spawn this process. Sharing one prev.json makes
// CPU% and net rates explode when the two ticks land <1s apart (delta / tiny dt).
function instanceId(): string {
  const i = process.argv.indexOf("--id");
  const raw = i >= 0 ? String(process.argv[i + 1] || "") : "bg";
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "bg";
}
const PREV_FILE = join(STATE_DIR, `prev-${instanceId()}.json`);
const now = Date.now();
const MIN_RATE_DT = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_COLLECTION_ITEMS = 256;
const MAX_MODELS = 128;
const currentAgentRaw: Record<string, number> = {};

// ---------------------------------------------------------------- helpers
function read(p: string, maxBytes = MAX_FILE_BYTES): string | null {
  try {
    const size = statSync(p).size;
    if (size > maxBytes) return null;
    return readFileSync(p, "utf8");
  } catch { return null; }
}
function readJson(p: string): any { try { const text = read(p); return text === null ? null : JSON.parse(text); } catch { return null; } }
function ls(p: string): string[] { try { return readdirSync(p); } catch { return []; } }
async function boundedStream(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}
async function run(cmd: string[], timeoutMs = 1500): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    try {
      const out = await boundedStream(proc.stdout, MAX_COMMAND_BYTES);
      if (out === null) { try { proc.kill(); } catch {}; return ""; }
      await proc.exited;
      return out;
    } finally {
      clearTimeout(t);
    }
  } catch { return ""; }
}
async function fetchJson(url: string, ms = 600): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const text = await boundedStream(r.body, MAX_HTTP_BYTES);
    if (text === null) return null;
    const payload = JSON.parse(text);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}
function finiteSize(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : 0;
}
function uiString(value: unknown, limit = 512): string {
  return String(value ?? "").slice(0, limit)
    .replace(/[<>&]/g, character => character === "<" ? "‹" : character === ">" ? "›" : "＆")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
}
function sanitizeForUi(value: any, depth = 0): any {
  if (depth > 12) return null;
  if (typeof value === "string") return uiString(value);
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION_ITEMS).map(item => sanitizeForUi(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, any> = {};
    for (const [rawKey, item] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
      const key = uiString(rawKey, 128);
      if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
      result[key] = sanitizeForUi(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function parseExternalIpTrace(value: unknown): string | null {
  const line = String(value || "").split("\n").find(entry => entry.startsWith("ip="));
  const address = String(line || "").slice(3).trim();
  return address.length >= 3 && address.length <= 64 && /^[0-9a-f:.]+$/i.test(address) && /[.:]/.test(address) ? address : null;
}
export function externalIpCacheFresh(cached: any, stamp = Date.now()): boolean {
  const checkedAt = Number(cached && cached.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt > 0 && stamp >= checkedAt && stamp - checkedAt < 15 * 60 * 1000;
}
async function externalIp() {
  const cached = prev.externalIp || {};
  // Cache failures too, otherwise a disconnected host would retry every tick.
  if (externalIpCacheFresh(cached, now)) return cached;
  if (process.env.INFOMARCHY_SKIP_EXTERNAL_IP === "1") return { address: cached.address || null, checkedAt: now };
  try {
    const response = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(1200) });
    const address = response.ok ? parseExternalIpTrace(await response.text()) : null;
    return { address, checkedAt: now };
  } catch {
    return { address: cached.address || null, checkedAt: now };
  }
}
const prev = readJson(PREV_FILE) || {};
const dt = prev.ts ? (now - prev.ts) / 1000 : 0;

// ---------------------------------------------------------------- machine
function cpu() {
  const line = (read("/proc/stat") || "").split("\n")[0].split(/\s+/).slice(1).map(Number);
  const idle = line[3] + line[4], total = line.reduce((a, b) => a + b, 0);
  let pct: number | null = null;
  if (prev.cpu && total > prev.cpu.total && dt >= MIN_RATE_DT) {
    pct = 100 * (1 - (idle - prev.cpu.idle) / (total - prev.cpu.total));
  } else if (dt > 0 && dt < MIN_RATE_DT && typeof prev.cpu?.pct === "number") {
    pct = prev.cpu.pct;
  }
  const load = (read("/proc/loadavg") || "0 0 0").split(" ").slice(0, 3).map(Number);
  const cores = (read("/proc/cpuinfo") || "").split("\n").filter(l => l.startsWith("processor")).length;
  return { pct, load, cores, _raw: { idle, total } };
}
function mem() {
  const m: Record<string, number> = {};
  for (const l of (read("/proc/meminfo") || "").split("\n")) {
    const [k, v] = l.split(":"); if (v) m[k.trim()] = parseInt(v) * 1024;
  }
  const total = m.MemTotal || 0, avail = m.MemAvailable || 0;
  return { total, used: total - avail, pct: total ? 100 * (total - avail) / total : null,
    swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0) };
}
async function disk() {
  const out = await run(["df", "-B1", "--output=target,size,used,avail", "/", HOME]);
  const rows = out.trim().split("\n").slice(1).map(l => l.trim().split(/\s+/));
  const seen = new Set<string>(); const res: any[] = [];
  for (const r of rows) {
    if (r.length < 4 || seen.has(r[0])) continue; seen.add(r[0]);
    const size = +r[1], used = +r[2];
    // btrfs subvolumes (/ and /home on one pool) report identical numbers — show once
    if (res.some(x => x.size === size && x.used === used)) continue;
    res.push({ mount: r[0], size, used, avail: +r[3], pct: size ? 100 * used / size : null });
  }
  return res;
}
async function net() {
  const route = await run(["ip", "-j", "route", "get", "1.1.1.1"], 800);
  let dev = ""; try { dev = JSON.parse(route)[0]?.dev || ""; } catch {}
  if (!dev) return { dev: null };
  const rx = +(read(`/sys/class/net/${dev}/statistics/rx_bytes`) || 0);
  const tx = +(read(`/sys/class/net/${dev}/statistics/tx_bytes`) || 0);
  let rxRate: number | null = null, txRate: number | null = null;
  if (prev.net && prev.net.dev === dev && dt >= MIN_RATE_DT) {
    rxRate = Math.max(0, (rx - prev.net.rx) / dt); txRate = Math.max(0, (tx - prev.net.tx) / dt);
  } else if (prev.net && prev.net.dev === dev && dt > 0 && dt < MIN_RATE_DT) {
    rxRate = prev.net.rxRate ?? null; txRate = prev.net.txRate ?? null;
  }
  const wireless = existsSync(`/sys/class/net/${dev}/wireless`);
  let ssid: string | null = null, signal: number | null = null, freq: number | null = null, bitrate: string | null = null;
  if (wireless) {
    const link = await run(["iw", "dev", dev, "link"], 800);
    ssid = link.match(/SSID:\s*(.+)/)?.[1]?.trim() || null;
    signal = link.match(/signal:\s*(-?\d+)/) ? +link.match(/signal:\s*(-?\d+)/)![1] : null;
    freq = link.match(/freq:\s*(\d+)/) ? +link.match(/freq:\s*(\d+)/)![1] : null;
    bitrate = link.match(/tx bitrate:\s*([\d.]+ \S+)/)?.[1] || null;
    if (signal === null) {
      const w = (read("/proc/net/wireless") || "").split("\n").find(l => l.includes(dev + ":"));
      if (w) signal = parseFloat(w.trim().split(/\s+/)[3]);
    }
  }
  const ip = await run(["ip", "-j", "-4", "addr", "show", dev], 800);
  let addr: string | null = null; try { addr = JSON.parse(ip)[0]?.addr_info?.[0]?.local || null; } catch {}
  return { dev, wireless, ssid, signal, freq, bitrate, addr, rx, tx, rxRate, txRate };
}
async function ping() {
  const out = await run(["ping", "-n", "-c", "1", "-W", "1", "1.1.1.1"], 1500);
  const m = out.match(/time=([\d.]+)/);
  return { host: "1.1.1.1", label: "cloudflare", ms: m ? +m[1] : null, ok: !!m };
}
function battery() {
  for (const d of ls("/sys/class/power_supply")) {
    const base = `/sys/class/power_supply/${d}`;
    if ((read(`${base}/type`) || "").trim() !== "Battery") continue;
    const cap = read(`${base}/capacity`), st = read(`${base}/status`);
    if (cap) return { name: d, pct: +cap, status: (st || "").trim() };
  }
  return null;
}
async function gpu() {
  if (!Bun.which("nvidia-smi")) return null;
  const out = await run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"], 1200);
  const r = out.trim().split("\n")[0]?.split(",").map(s => s.trim());
  if (!r || r.length < 5) return null;
  return { name: r[0], util: +r[1], memUsed: +r[2] * 1048576, memTotal: +r[3] * 1048576, temp: +r[4] };
}
function temp() {
  let best: number | null = null;
  for (const z of ls("/sys/class/thermal")) {
    if (!z.startsWith("thermal_zone")) continue;
    const t = read(`/sys/class/thermal/${z}/temp`); if (!t) continue;
    const v = +t / 1000; if (v > 0 && (best === null || v > best)) best = v;
  }
  return best;
}
function uptime() { return parseFloat((read("/proc/uptime") || "0").split(" ")[0]); }

// ---------------------------------------------------------------- processes
type Proc = { pid: number; ppid: number; cmd: string[]; start: number; cwd: string };
const CLK_TCK = 100;
const btime = +((read("/proc/stat") || "").split("\n").find(l => l.startsWith("btime")) || "btime 0").split(" ")[1];
// Cheap pass: argv only. stat/cwd are read lazily for matched pids + ancestors.
const cmdByPid = new Map<number, string[]>();
const infoCache = new Map<number, Proc | null>();
function scanProcs(): number[] {
  const pids: number[] = [];
  for (const d of ls("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    const cmdline = read(`/proc/${d}/cmdline`); if (!cmdline) continue;
    cmdByPid.set(+d, cmdline.split("\0").filter(Boolean)); pids.push(+d);
  }
  return pids;
}
function info(pid: number): Proc | null {
  if (infoCache.has(pid)) return infoCache.get(pid)!;
  const stat = read(`/proc/${pid}/stat`);
  let p: Proc | null = null;
  if (stat) {
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    let cwd = ""; try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch {}
    p = { pid, ppid: +after[1], cmd: cmdByPid.get(pid) || [], start: (btime + +after[19] / CLK_TCK) * 1000, cwd };
  }
  infoCache.set(pid, p); return p;
}
// provider detection from argv — match the launcher name, not the runtime
const PROVIDERS: [string, RegExp][] = [
  ["claude", /(^|\/)claude(\.js|\.mjs|\.cjs)?$/],
  ["codex", /(^|\/)codex(\.js|\.mjs)?$/],
  ["grok", /(^|\/)grok(\.js|\.mjs)?$/],
  ["gemini", /(^|\/)gemini(\.js|\.mjs)?$/],
  ["opencode", /(^|\/)opencode$/],
  ["aider", /(^|\/)aider$/],
  ["copilot", /(^|\/)copilot$/],
  ["ollama", /(^|\/)ollama$/],
];
export function providerOf(cmd: string[]): string | null {
  for (const arg of cmd.slice(0, 3)) {
    for (const [name, re] of PROVIDERS) if (re.test(arg)) {
      if (name === "ollama" && !(cmd[1] === "run" || cmd[1] === "runner")) return null; // only chats/runners, not the daemon
      // Codex app-server / mcp-server are long-lived daemons, not a desk session.
      if (name === "codex" && cmd.some(a => a === "app-server" || a === "mcp-server")) return null;
      // OpenCode also exposes several persistent services. Only its TUI/run
      // invocations represent a session that belongs on the desk.
      if (name === "opencode" && cmd.some(a => ["serve", "web", "acp", "mcp", "github"].includes(a))) return null;
      return name;
    }
  }
  return null;
}
// Claude/Codex retitle the terminal on idle (✅ …). Grok leaves
// "🧠 Processing request." stuck after the turn, so title-based busy
// is a lie. Grok's real signal is systemd-inhibit "agent turn in progress".
export function titleLooksBusy(title: string): boolean {
  return /Processing|🧠|⚙|⏳|…/.test(String(title || ""));
}
export function cmdIsTurnInhibitor(cmd: string[]): boolean {
  const bin = cmd[0] || "";
  if (!/(^|\/)systemd-inhibit$/.test(bin)) return false;
  return cmd.some(a => /agent turn in progress/i.test(a));
}
function shortPath(p: string) { return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p; }

function cleanSessionId(value: unknown): string {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id) ? id : "";
}
function envValue(text: string | null, key: string): string {
  if (!text) return "";
  const prefix = key + "=";
  for (const entry of text.split("\0")) if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  return "";
}
// Extract only known session identifiers. /proc/*/environ can contain secrets,
// so the collector never serializes or scans arbitrary environment values.
export function sessionIdFrom(provider: string, cmd: string[], environ = ""): string {
  const keys: Record<string, string[]> = {
    claude: ["CLAUDE_SESSION_ID"],
    codex: ["CODEX_SESSION_ID", "CODEX_THREAD_ID"],
    grok: ["GROK_SESSION_ID"],
    gemini: ["GEMINI_SESSION_ID"],
    opencode: ["OPENCODE_SESSION_ID"],
  };
  for (const key of keys[provider] || []) {
    const id = cleanSessionId(envValue(environ, key));
    if (id) return id;
  }
  for (let i = 0; i < cmd.length - 1; i++) {
    const sessionFlag = ["--resume", "--session", "--session-id", "--thread-id"].includes(cmd[i]) ||
      (provider === "opencode" && cmd[i] === "-s");
    if (!sessionFlag) continue;
    const id = cleanSessionId(cmd[i + 1]);
    if (id) return id;
  }
  return "";
}
function childPids(pid: number): number[] {
  return (read(`/proc/${pid}/task/${pid}/children`) || "").trim().split(/\s+/).filter(Boolean).map(Number);
}
function processTreeSample(pid: number) {
  const queue = [pid], seen = new Set<number>();
  let ticks = 0, rss = 0;
  while (queue.length) {
    const candidate = queue.shift()!;
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const stat = read(`/proc/${candidate}/stat`);
    if (stat) {
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(fields[11] || 0) + Number(fields[12] || 0);
    }
    const statm = (read(`/proc/${candidate}/statm`) || "").trim().split(/\s+/);
    rss += Number(statm[1] || 0) * 4096;
    queue.push(...childPids(candidate));
  }
  return { ticks, rss, pids: [...seen] };
}
async function gpuMemoryByPid() {
  const result = new Map<number, number>();
  if (!Bun.which("nvidia-smi")) return result;
  const output = await run(["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"], 1000);
  for (const line of output.split("\n")) {
    const parts = line.split(",").map(v => v.trim()), pid = Number(parts[0]), mib = Number(parts[1]);
    if (Number.isInteger(pid) && Number.isFinite(mib)) result.set(pid, mib * 1048576);
  }
  return result;
}
function openSessionIds(pid: number, provider: string): string[] {
  const ids = new Set<string>();
  for (const fd of ls(`/proc/${pid}/fd`)) {
    let target = "";
    try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    let match: RegExpMatchArray | null = null;
    if (provider === "codex")
      match = target.match(/\/thread-writer-locks\/([^/]+)\.lock$/) || target.match(/\/rollout-[^/]*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
    else if (provider === "claude")
      match = target.match(/\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
    const id = cleanSessionId(match?.[1]);
    if (id) ids.add(id);
  }
  return [...ids];
}
function processSessionIds(pid: number, provider: string, cmd: string[]): string[] {
  const ids = new Set<string>();
  function inspectProcess(candidate: number, candidateCmd: string[]) {
    const envOrArg = sessionIdFrom(provider, candidateCmd, read(`/proc/${candidate}/environ`) || "");
    if (envOrArg) ids.add(envOrArg);
    for (const id of openSessionIds(candidate, provider)) ids.add(id);
  }
  inspectProcess(pid, cmd);
  // Codex and similar tools pass the current ID into their command/sandbox
  // descendants. Walk only this agent's small process tree, not all of /proc.
  const queue = childPids(pid), seen = new Set<number>();
  while (queue.length) {
    const child = queue.shift()!;
    if (!child || seen.has(child)) continue;
    seen.add(child);
    inspectProcess(child, cmdByPid.get(child) || []);
    queue.push(...childPids(child));
  }
  return [...ids];
}

export function linkRecentToLive(recentEntries: any[], sessions: any[]): any[] {
  const liveBySession = new Map<string, any>();
  for (const session of sessions) {
    const ids = Array.isArray(session.sessionIds) ? session.sessionIds : [session.session];
    for (const value of ids) {
      const id = cleanSessionId(value);
      if (id) liveBySession.set(`${session.provider}\0${id}`, session);
    }
  }
  return recentEntries.map(entry => {
    const id = cleanSessionId(entry.session);
    const live = id ? liveBySession.get(`${entry.provider}\0${id}`) : null;
    return {
      ...entry,
      live: !!live,
      window: live?.window ? { address: live.window.address, workspace: live.window.workspace } : null,
    };
  });
}

const TOPIC_STOP_WORDS = new Set([
  "about", "add", "after", "again", "also", "and", "are", "audit", "basically", "been", "being", "build", "can", "cards", "check", "could", "create", "does", "doesnt", "doing", "dont", "fix", "for", "from", "had", "hard", "has", "have", "implement", "in", "into", "is", "it", "its", "just", "last", "little", "make", "more", "need", "needed", "not", "of", "on", "only", "other", "part", "past", "please", "prompt", "prompts", "real", "really", "remove", "review", "screen", "short", "should", "some", "still", "summary", "than", "that", "the", "their", "them", "there", "these", "they", "this", "those", "through", "to", "very", "want", "was", "were", "what", "when", "where", "which", "while", "with", "work", "working", "would", "your"
]);

function topicProjectLabel(session: any): string {
  const raw = String(session.project || session.cwd || "").replace(/\/$/, "").split("/").pop() || "";
  const clean = raw.split(".").filter(Boolean).pop() || raw;
  return clean && clean !== "~" ? clean.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\bAi\b/g, "AI") : "";
}

function exactSessionEntries(session: any, recentEntries: any[]): any[] {
  const ids = new Set((Array.isArray(session.sessionIds) ? session.sessionIds : [session.session])
    .map((value: any) => cleanSessionId(value)).filter(Boolean));
  if (!ids.size) return [];
  return recentEntries.filter(entry => entry.provider === session.provider && ids.has(cleanSessionId(entry.session)))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 5);
}

export function localSessionSummary(session: any, entries: any[]): string {
  const text = entries.map(entry => String(entry.text || "")).join(" ").toLowerCase();
  const latest = String(entries[0]?.text || "").toLowerCase();
  const action = /\b(summar\w*|synopsis|topic)\b/.test(latest) ? "Summarizing" :
    /\b(remove\w*|simplif\w*|declutter\w*|duplicate|dont want|don't want|only)\b/.test(latest) ? "Simplifying" :
    /\b(fix\w*|bug|broken|hard to|doesnt|doesn't|issue|crash|error|scroll\w*)\b/.test(latest) ? "Fixing" :
    /\b(audit|review|check|verify|inspect)\b/.test(latest) ? "Reviewing" :
    /\b(research\w*|compare|investigat\w*|find out)\b/.test(latest) ? "Researching" :
    /\b(add|build\w*|creat\w*|implement\w*|introduc\w*|make)\b/.test(latest) ? "Building" : "Improving";
  const aliases: Record<string, string> = { session: "sessions", scrolling: "scrolling", scroll: "scrolling", scrollbar: "scrolling", card: "cards", dashboard: "dashboard" };
  const scores = new Map<string, number>();
  entries.forEach((entry, index) => {
    const weight = Math.max(1, 5 - index);
    for (const token of String(entry.text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []) {
      const word = aliases[token] || token;
      if (TOPIC_STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
      scores.set(word, (scores.get(word) || 0) + weight);
    }
  });
  const project = topicProjectLabel(session);
  const projectLower = project.toLowerCase();
  const keywords = [...scores.entries()].filter(([word]) => word !== projectLower)
    .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([word]) => word);
  const subject = [project, ...keywords].filter(Boolean).join(" ") || "active session";
  return `${action} ${subject}`.split(/\s+/).slice(0, 7).join(" ").slice(0, 64).trim();
}

export function cleanGeneratedSummary(value: unknown): string {
  return String(value || "").replace(/[\r\n]+/g, " ").replace(/[*_#]+/g, "").replace(/^[\s"'`-]+|[\s"'`*.!,:;-]+$/g, "")
    .replace(/\s+/g, " ").split(" ").slice(0, 8).join(" ").slice(0, 72).trim();
}

export function attachSessionTopics(sessions: any[], recentEntries: any[]): any[] {
  for (const session of sessions) {
    const entries = exactSessionEntries(session, recentEntries);
    session.topic = localSessionSummary(session, entries);
    session.topicAt = entries.length ? Number(entries[0].ts || 0) : 0;
  }
  return sessions;
}

async function refineSessionTopics(sessions: any[], recentEntries: any[], ollama: any): Promise<Record<string, any>> {
  const previous = prev.topicSummaries && typeof prev.topicSummaries === "object" ? prev.topicSummaries : {};
  const next: Record<string, any> = { ...previous };
  const model = String((ollama.loaded || [])[0]?.name || "");
  if (!model) return next;
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const base = host.startsWith("http") ? host : "http://" + host;
  await Promise.all(sessions.map(async session => {
    const entries = exactSessionEntries(session, recentEntries);
    if (!entries.length) return;
    const ids = (session.sessionIds || []).map((value: any) => cleanSessionId(value)).filter(Boolean);
    const key = `${session.provider}:${ids[0] || session.pid}`;
    const fingerprint = String(Bun.hash(JSON.stringify(entries.map(entry => [entry.ts, entry.text]))));
    const cached = previous[key];
    if (cached && cached.fingerprint === fingerprint && cached.model === model && cached.summary) {
      session.topic = cached.summary;
      return;
    }
    try {
      const prompt = "Summarize the current work as a specific 3-7 word gerund phrase. Do not quote a request. No punctuation or preamble.\nProject: " +
        topicProjectLabel(session) + "\nRecent requests:\n" + entries.map(entry => "- " + String(entry.text || "").slice(0, 320)).join("\n");
      const response = await fetch(base + "/api/generate", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(2200),
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1, num_predict: 20 } }),
      });
      const generated = response.ok ? cleanGeneratedSummary((await response.json() as any).response) : "";
      if (generated) session.topic = generated;
    } catch {}
    next[key] = { fingerprint, model, summary: session.topic, checkedAt: now };
  }));
  return next;
}

export function inferSessionIdsFromRecent(sessions: any[], recentEntries: any[]): void {
  const unresolvedByKey = new Map<string, any[]>();
  for (const session of sessions) {
    if ((session.sessionIds || []).length || !session.cwd || session.cwd === "/") continue;
    const key = `${session.provider}\0${session.cwd}`;
    const group = unresolvedByKey.get(key) || [];
    group.push(session);
    unresolvedByKey.set(key, group);
  }
  for (const [key, group] of unresolvedByKey) {
    // Two live agents in the same provider/project are indistinguishable from
    // history alone. Refuse to guess; their prompt rows remain safely dim.
    if (group.length !== 1) continue;
    const session = group[0];
    const candidate = recentEntries.find(entry =>
      `${entry.provider}\0${entry.project}` === key &&
      cleanSessionId(entry.session) &&
      Number(entry.ts || 0) >= Number(session.startedAt || 0) - 5000
    );
    const id = cleanSessionId(candidate?.session);
    if (!id) continue;
    session.session = id;
    session.sessionIds = [id];
  }
}

async function repoState(cwd: string) {
  if (!cwd) return { root: "", state: null };
  const [root, status] = await Promise.all([
    run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], 700),
    run(["git", "-C", cwd, "status", "--porcelain=v2", "--branch"], 900),
  ]);
  return { root: root.trim(), state: parseGitStatus(status) };
}

async function liveSessions(pids: number[]) {
  let clients: any[] = [];
  try { clients = JSON.parse(await run(["hyprctl", "clients", "-j"], 1000)) || []; } catch {}
  const winByPid = new Map<number, any>(clients.map((c: any) => [c.pid, c]));
  const sessions: any[] = [];
  const gpuByPid = await gpuMemoryByPid();
  for (const pid of pids) {
    const prov = providerOf(cmdByPid.get(pid) || []); if (!prov) continue;
    const p = info(pid); if (!p) continue;
    // skip children of an already-reported agent process (subagents, helpers)
    let anc = info(p.ppid), child = false;
    while (anc && anc.pid > 1) { if (providerOf(anc.cmd)) { child = true; break; } anc = info(anc.ppid); }
    if (child) continue;
    // find the hyprland window hosting it by walking up the parent chain
    let w: any = null, q: Proc | null = p;
    while (q && q.pid > 1) { if (winByPid.has(q.pid)) { w = winByPid.get(q.pid); break; } q = info(q.ppid); }
    const sessionIds = processSessionIds(p.pid, prov, p.cmd);
    const sample = processTreeSample(p.pid);
    currentAgentRaw[String(p.pid)] = sample.ticks;
    sessions.push({
      provider: prov, pid: p.pid, cwd: shortPath(p.cwd), project: basename(p.cwd || "") || "/",
      _cwd: p.cwd,
      startedAt: p.start, uptimeSec: Math.max(0, (now - p.start) / 1000),
      session: sessionIds[0] || "", sessionIds,
      window: w ? { address: w.address, title: w.title, class: w.class, workspace: w.workspace?.id ?? null } : null,
      args: p.cmd.slice(1, 4).join(" ").slice(0, 60),
      resources: {
        cpuPct: resourceDelta(sample.ticks, prev.agents?.[String(p.pid)], dt),
        rss: sample.rss,
        processes: sample.pids.length,
        gpuMemory: sample.pids.reduce((sum, child) => sum + (gpuByPid.get(child) || 0), 0) || null,
      },
    });
  }
  const sessionPids = new Set(sessions.map((s: any) => s.pid as number));
  const turnBusy = new Set<number>();
  for (const pid of pids) {
    if (!cmdIsTurnInhibitor(cmdByPid.get(pid) || [])) continue;
    let q = info(pid);
    while (q && q.pid > 1) {
      if (sessionPids.has(q.pid)) { turnBusy.add(q.pid); break; }
      q = info(q.ppid);
    }
  }
  for (const s of sessions) {
    const titleBusy = !!(s.window && titleLooksBusy(s.window.title));
    // Grok's terminal title sticks on 🧠 after the turn. Trust the inhibitor.
    s.busy = s.provider === "grok" ? turnBusy.has(s.pid) : (titleBusy || turnBusy.has(s.pid));
    if (!s.busy && s.window && titleLooksBusy(s.window.title) && s.provider === "grok")
      s.window = { ...s.window, title: "" };
  }
  const repos = new Map<string, Promise<{ root: string; state: any }>>();
  for (const session of sessions) if (session._cwd && !repos.has(session._cwd)) repos.set(session._cwd, repoState(session._cwd));
  await Promise.all(sessions.map(async session => {
    const repo = session._cwd ? await repos.get(session._cwd) : null;
    session.repoRoot = repo?.root ? shortPath(repo.root) : "";
    session.git = repo?.state || null;
    session.attention = attentionState(session.window?.title, session.git?.conflicts || 0);
    delete session._cwd;
  }));
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  return sessions;
}

// ---------------------------------------------------------------- AI history
function safePrompt(value: unknown): string {
  return String(value || "")
    // Common token formats. Keep a small prefix so the redaction is still recognizable.
    .replace(/\b(sk-(?:proj-|ant-)?|gh[opusr]_)[A-Za-z0-9_-]{12,}\b/gi, "$1[redacted]")
    .replace(/\b(ntn_)[A-Za-z0-9_-]{12,}\b/gi, "$1[redacted]")
    // Credentials pasted as assignments or natural-language "token/key: value" pairs.
    .replace(/\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|secret)\b(\s*(?:is|=|:)\s*)["']?[^\s"']{8,}/gi, "$1$2[redacted]")
    .slice(0, 140);
}
function heatmapInit() {
  // 7 days x 24 hours, local time, oldest first; each cell {total, byProvider}
  const cells: any[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push({ d, h, n: 0, p: {} as Record<string, number> });
  return cells;
}
const heat = heatmapInit();
const heatDays = localDayStarts(now, 7);
const start7 = heatDays[0];
export function activityCellIndex(ts: unknown, dayStarts: unknown): number {
  const time = Number(ts);
  if (!Number.isFinite(time) || !Array.isArray(dayStarts) || dayStarts.length !== 7) return -1;
  const day = localDayIndex(time, dayStarts.map(Number));
  if (day < 0 || day > 6) return -1;
  const hour = new Date(time).getHours();
  return day * 24 + hour;
}
function bump(ts: number, prov: string) {
  if (ts < start7 || ts > now + 60000) return;
  const index = activityCellIndex(ts, heatDays);
  if (index < 0) return;
  const cell = heat[index]; cell.n++; cell.p[prov] = (cell.p[prov] || 0) + 1;
}
const recent: any[] = [];
const todayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const counts: Record<string, { today: number; week: number; total: number }> = {};
function cnt(prov: string, ts: number) {
  const c = counts[prov] ||= { today: 0, week: 0, total: 0 };
  c.total++; if (ts >= todayStart) c.today++; if (ts >= start7) c.week++;
}

function claudeHistory() {
  const p = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"), "history.jsonl");
  const txt = read(p); if (!txt) return { present: false };
  const lines = txt.split("\n").filter(Boolean);
  for (const l of lines) {
    try {
      const e = JSON.parse(l); const ts = +e.timestamp; if (!ts) continue;
      bump(ts, "claude"); cnt("claude", ts);
      recent.push({ provider: "claude", ts, project: shortPath(e.project || ""), text: safePrompt(e.display), session: e.sessionId });
    } catch {}
  }
  return { present: true, prompts: lines.length };
}
function codexHistory() {
  const base = process.env.CODEX_HOME || join(HOME, ".codex");
  if (!existsSync(base)) return { present: false };
  const hist = read(join(base, "history.jsonl")) || "";
  let prompts = 0;
  for (const l of hist.split("\n").filter(Boolean)) {
    try { const e = JSON.parse(l); const ts = (+e.ts || 0) * 1000; if (!ts) continue; prompts++;
      bump(ts, "codex"); cnt("codex", ts);
      recent.push({ provider: "codex", ts, project: "", text: safePrompt(e.text), session: e.session_id });
    } catch {}
  }
  const threads: any[] = [];
  for (const l of (read(join(base, "session_index.jsonl")) || "").split("\n").filter(Boolean)) {
    try { const e = JSON.parse(l); threads.push({ id: e.id, name: e.thread_name, updatedAt: Date.parse(e.updated_at) }); } catch {}
  }
  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  return { present: true, prompts, threads: threads.slice(0, 8), threadCount: threads.length };
}
function grokHistory() {
  const base = join(HOME, ".grok");
  if (!existsSync(base)) return { present: false };
  const active = readJson(join(base, "active_sessions.json")) || [];
  const sessionIds = new Set<string>();
  for (const dir of ls(join(base, "sessions"))) {
    const full = join(base, "sessions", dir);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    const project = shortPath(decodeURIComponent(dir));
    const history = read(join(full, "prompt_history.jsonl")) || "";
    for (const l of history.split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(l), ts = Date.parse(e.timestamp);
        if (!Number.isFinite(ts)) continue;
        const session = String(e.session_id || "");
        if (session) sessionIds.add(session);
        bump(ts, "grok"); cnt("grok", ts);
        recent.push({ provider: "grok", ts, project, text: safePrompt(e.prompt), session });
      } catch {}
    }
  }
  return { present: true, sessions: sessionIds.size, active: active.map((a: any) => ({ pid: a.pid, cwd: shortPath(a.cwd || ""), openedAt: Date.parse(a.opened_at) })) };
}
function opencodeHistory() {
  const dataRoot = process.env.XDG_DATA_HOME || join(HOME, ".local/share");
  const path = join(dataRoot, "opencode/opencode.db");
  if (!existsSync(path)) return { present: false };
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query(`
      SELECT m.session_id AS session, m.time_created AS ts, s.directory AS project,
        (SELECT json_extract(p.data, '$.text')
           FROM part p
          WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'text'
          ORDER BY p.time_created, p.id LIMIT 1) AS text
        FROM message m
        JOIN session s ON s.id = m.session_id
       WHERE json_extract(m.data, '$.role') = 'user'
       ORDER BY m.time_created DESC, m.id DESC
    `).all() as any[];
    const sessions = new Set<string>();
    let prompts = 0;
    for (const row of rows) {
      const ts = Number(row.ts || 0);
      if (!ts || !row.text) continue;
      prompts++;
      const session = cleanSessionId(row.session);
      if (session) sessions.add(session);
      bump(ts, "opencode"); cnt("opencode", ts);
      recent.push({ provider: "opencode", ts, project: shortPath(String(row.project || "")), text: safePrompt(row.text), session });
    }
    return { present: true, prompts, sessions: sessions.size };
  } catch (error) {
    return { present: true, prompts: 0, sessions: 0, error: String(error) };
  } finally {
    try { db?.close(); } catch {}
  }
}
async function ollamaState() {
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const base = host.startsWith("http") ? host : "http://" + host;
  const ps = await fetchJson(base + "/api/ps"); const tags = await fetchJson(base + "/api/tags");
  if (!ps && !tags) return { present: false, up: false };
  const loaded = Array.isArray(ps?.models) ? ps.models.slice(0, MAX_MODELS) : [];
  const models = Array.isArray(tags?.models) ? tags.models.slice(0, MAX_MODELS) : [];
  return {
    present: true, up: true,
    loaded: loaded.filter((model: any) => model && typeof model === "object")
      .map((model: any) => ({ name: uiString(model.name, 256), vram: finiteSize(model.size_vram),
        size: finiteSize(model.size), until: uiString(model.expires_at, 64) })),
    models: models.filter((model: any) => model && typeof model === "object")
      .map((model: any) => uiString(model.name, 256)).filter(Boolean),
    modelCount: models.length,
  };
}
function agentsUsage() {
  // Omarchy's own agents plugin caches rate limits + token usage here; reuse it when present.
  const dir = join(XDG_STATE, "omarchy/agents/usage");
  const out: Record<string, any> = {};
  for (const f of ls(dir).slice(0, MAX_COLLECTION_ITEMS)) {
    if (!f.endsWith(".json")) continue;
    const j = readJson(join(dir, f)); if (!j) continue;
    out[f.replace(/\.json$/, "")] = {
      name: j.name, ready: j.ready, tierLabel: j.tierLabel, limits: j.limits || [],
      todayPrompts: j.todayPrompts, todaySessions: j.todaySessions, todayTotalTokens: j.todayTotalTokens,
      totalPrompts: j.totalPrompts, totalSessions: j.totalSessions, updatedAt: j.updatedAt,
      modelUsage: j.modelUsage || {}, recentDays: j.recentDays || [], usageStatusText: j.usageStatusText,
    };
  }
  return out;
}

// ---------------------------------------------------------------- main
async function runCollector() {
  const pids = scanProcs();
  const [cpuS, memS, diskS, netS, pingS, gpuS, sessions, ollama, externalIpS] = await Promise.all([
    Promise.resolve(cpu()), Promise.resolve(mem()), disk(), net(), ping(), gpu(), liveSessions(pids), ollamaState(), externalIp(),
  ]);
  const claude = claudeHistory(), codex = codexHistory(), grok = grokHistory(), opencode = opencodeHistory();
  recent.sort((a, b) => b.ts - a.ts);
  for (const entry of recent) entry.activityCell = activityCellIndex(entry.ts, heatDays);
  inferSessionIdsFromRecent(sessions, recent);
  attachSessionTopics(sessions, recent);
  const topicSummaries = await refineSessionTopics(sessions, recent, ollama);
  const linkedRecent = linkRecentToLive(recent, sessions);
  const weekRecentCount = linkedRecent.filter(entry => entry.activityCell >= 0).length;
  // Default view still shows 40. Keep enough week rows in the snapshot for
  // heatmap drill-down without allowing an unbounded history payload.
  const dashboardRecent = linkedRecent.slice(0, Math.max(40, Math.min(1000, weekRecentCount)));

  // Hyprland >= 0.56 takes Lua in `hyprctl dispatch`; older takes "dispatcher arg".
  let hyprLua = false;
  try { const v = JSON.parse(await run(["hyprctl", "version", "-j"], 800)); const m = String(v.tag || v.version || "").match(/(\d+)\.(\d+)/); hyprLua = !!m && (+m[1] > 0 || +m[2] >= 56); } catch {}

  const snapshot = {
    ts: now, hyprLua, host: (read("/etc/hostname") || "").trim() || null, user: process.env.USER || null,
    machine: {
      cpu: { pct: cpuS.pct, load: cpuS.load, cores: cpuS.cores }, mem: memS, disks: diskS, net: netS, ping: pingS,
      battery: battery(), gpu: gpuS, temp: temp(), uptime: uptime(), externalIp: externalIpS.address,
    },
    ai: {
      sessions,
      workspaces: workspaceGroups(sessions),
      attention: sessions.filter((s: any) => s.attention),
      collisions: repoCollisions(sessions),
      counts, providers: { claude, codex, grok, opencode, ollama }, usage: agentsUsage(),
      heatmap: { start: start7, days: heatDays, cells: heat.map(c => [c.n, c.p]) },
      recent: dashboardRecent, recentTruncated: weekRecentCount > 1000,
    },
  };

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PREV_FILE, JSON.stringify({
      ts: now,
      cpu: { ...cpuS._raw, pct: cpuS.pct },
      net: { dev: netS.dev, rx: netS.rx, tx: netS.tx, rxRate: netS.rxRate, txRate: netS.txRate },
      agents: currentAgentRaw,
      externalIp: externalIpS,
      topicSummaries,
    }));
  } catch {}
  console.log(JSON.stringify(sanitizeForUi(snapshot)));
}

if (import.meta.main) await runCollector();
