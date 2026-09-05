#!/usr/bin/env bun
// Infomarchy collector — one JSON snapshot of "what is AI doing on this machine"
// plus the boring machine stats. Runs under bun, prints JSON to stdout.
// Never hardcodes a user, host or home path: everything derives from $HOME,
// XDG_*, /proc and /sys. Missing tools/dirs degrade to nulls, never crash.

import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  mkdirSync, openSync, readlinkSync, readdirSync, readSync, renameSync,
  unlinkSync, writeSync,
} from "fs";
import { randomUUID } from "crypto";
import { join, basename } from "path";
import { isIP } from "net";
import { Database } from "bun:sqlite";
import { localDayIndex, localDayStarts } from "./history-time";
import { attentionSignal, parseCommitSummary, parseDiffNumstat, parseGitStatus, projectHealth, repoCollisions, workspaceGroups, resourceDelta, limitForecast } from "./ai-ops";
import { deriveNotificationEvents } from "./notification-events";

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
const MAX_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 24;
// InfoModel.qml caps accumulation at 2 MiB counted as 2 bytes per UTF-16 code
// unit, i.e. 1,048,576 code units. UTF-8 byte length is always >= code units,
// so a byte cap below that with framing headroom can never be rejected there.
const MAX_SNAPSHOT_BYTES = 960 * 1024;
const OUTPUT_FRAME_CHARS = 12 * 1024;
const currentAgentRaw: Record<string, number> = {};
const currentCiByRepo: Record<string, any> = {};
let currentOpencodeTotals: any = null;

// ---------------------------------------------------------------- helpers
export function readRegularFileLimited(p: string, maxBytes = MAX_FILE_BYTES, maxMs = 75): string | null {
  let fd = -1;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    // FIFOs, sockets and devices are rejected before reading. procfs/sysfs
    // pseudo-files report as regular files and are safe with O_NONBLOCK.
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const started = performance.now();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      if (performance.now() - started > maxMs) return null;
      const room = maxBytes - total;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, room + 1));
      const bytes = readSync(fd, buffer, 0, buffer.byteLength, null);
      if (bytes === 0) break;
      total += bytes;
      if (total > maxBytes) return null;
      chunks.push(buffer.subarray(0, bytes));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch { return null; }
  finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
function read(p: string, maxBytes = MAX_FILE_BYTES): string | null {
  return readRegularFileLimited(p, maxBytes);
}
// Append-only JSONL histories outgrow MAX_FILE_BYTES. Refusing to read one
// made a provider disappear from the desk entirely ("present: false" reads as
// "not installed"). The dashboard only ever shows the last 7 days, so keep the
// tail and drop the leading partial line.
export function dropPartialFirstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline < 0 ? "" : text.slice(newline + 1);
}
export function readHistoryTail(path: string, maxBytes = MAX_FILE_BYTES): string | null {
  const whole = readRegularFileLimited(path, maxBytes);
  if (whole !== null) return whole;
  const tail = readRegularFileTail(path, maxBytes);
  return tail === null ? null : dropPartialFirstLine(tail);
}
// First bytes only. Codex rollout files reach tens of MB (they embed the full
// transcript), but the session_meta header we need sits in the first line.
export function readRegularFileHead(path: string, maxBytes: number): string | null {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buffer, 0, maxBytes, 0);
    return bytes > 0 ? buffer.subarray(0, bytes).toString("utf8") : null;
  } catch { return null; }
  finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
function readRegularFileTail(path: string, maxBytes: number, maxMs = 150): string | null {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size <= maxBytes) return null;
    const started = performance.now();
    const chunks: Buffer[] = [];
    let position = opened.size - maxBytes;
    let total = 0;
    while (total < maxBytes) {
      if (performance.now() - started > maxMs) return null;
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total));
      const bytes = readSync(fd, buffer, 0, buffer.byteLength, position);
      if (bytes === 0) break;
      position += bytes;
      total += bytes;
      chunks.push(buffer.subarray(0, bytes));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch { return null; }
  finally { if (fd >= 0) try { closeSync(fd); } catch {} }
}
// JSON.parse happily yields {"toString":0}: an own property shadowing
// Object.prototype, so String(x) / Date.parse(x) throw "No default value".
// Every external JSON source (history lines, usage caches, Ollama, hyprctl,
// gh, hostile files) passes through here, so strip the shadowing keys once
// instead of guarding hundreds of coercion sites.
const COERCION_TRAPS = ["toString", "valueOf", "__proto__", "constructor", "prototype", "toJSON"];
export function structureWithinBudget(value: unknown, maxNodes = MAX_JSON_NODES, maxDepth = MAX_JSON_DEPTH): boolean {
  const stack: Array<{ value: any; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > maxNodes || item.depth > maxDepth) return false;
    if (!item.value || typeof item.value !== "object") continue;
    if (!Array.isArray(item.value))
      for (const trap of COERCION_TRAPS) if (Object.prototype.hasOwnProperty.call(item.value, trap)) delete item.value[trap];
    const values = Array.isArray(item.value) ? item.value : Object.values(item.value);
    if (values.length > MAX_COLLECTION_ITEMS * 8) return false;
    for (const child of values) stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
export function parseJsonBounded(text: string, maxNodes = MAX_JSON_NODES, maxDepth = MAX_JSON_DEPTH): any {
  try {
    const value = JSON.parse(text);
    return structureWithinBudget(value, maxNodes, maxDepth) ? value : null;
  } catch { return null; }
}
function readJson(p: string): any {
  const text = read(p);
  return text === null ? null : parseJsonBounded(text);
}
function ls(p: string): string[] { try { return readdirSync(p); } catch { return []; } }

function ensurePrivateStateDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    let state = lstatSync(path);
    const uid = typeof process.getuid === "function" ? process.getuid() : state.uid;
    if (state.isSymbolicLink() || !state.isDirectory() || state.uid !== uid) return false;
    if ((state.mode & 0o077) !== 0) chmodSync(path, 0o700);
    state = lstatSync(path);
    return !state.isSymbolicLink() && state.isDirectory() && state.uid === uid && (state.mode & 0o077) === 0;
  } catch { return false; }
}
// A collector killed between open() and rename() leaves its temp file behind
// and the finally-block never runs. Sweep our own stale ones so the state dir
// cannot fill with orphans.
export function reapStateTempFiles(directory: string, ttlMs = 10 * 60 * 1000, stamp = Date.now()): number {
  let removed = 0;
  for (const name of ls(directory)) {
    if (!/^\..+\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) continue;
    try {
      const path = join(directory, name);
      const state = lstatSync(path);
      if (!state.isFile() || stamp - state.mtimeMs <= ttlMs) continue;
      unlinkSync(path);
      removed++;
    } catch {}
  }
  return removed;
}
export function writePrivateStateFile(directory: string, name: string, text: string): boolean {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(name) || Buffer.byteLength(text) > MAX_FILE_BYTES) return false;
  if (!ensurePrivateStateDir(directory)) return false;
  const temporary = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let fd = -1;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const data = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < data.byteLength) offset += writeSync(fd, data, offset, data.byteLength - offset);
    fsyncSync(fd);
    closeSync(fd); fd = -1;
    // rename replaces a hostile destination symlink itself; it never follows it.
    renameSync(temporary, join(directory, name));
    reapStateTempFiles(directory);
    return true;
  } catch { return false; }
  finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
  }
}
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
// A killed tool can leave a grandchild holding our stdout pipe (sh → sleep,
// gh → git, git → credential helper). Waiting for EOF then blocks for the
// grandchild's lifetime, and under Quickshell there is no outer timeout: the
// collector Process stays "running" and every tick is skipped. Race the read
// against the budget and give up on the pipe; runCollector() exits explicitly
// so a dangling read cannot keep the event loop alive either.
const KILL_GRACE_MS = 250;
// Firm deadline: SIGTERM, a bounded grace period, then SIGKILL, then reap.
// A child that ignores TERM is not allowed to outlive the collector.
export async function terminate(proc: { kill: (signal?: any) => void; exited: Promise<number>; exitCode: number | null; signalCode: string | null }, graceMs = KILL_GRACE_MS): Promise<void> {
  const alive = () => proc.exitCode === null && proc.signalCode === null;
  if (!alive()) return;
  try { proc.kill("SIGTERM"); } catch {}
  await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, graceMs))]);
  if (alive()) {
    try { proc.kill("SIGKILL"); } catch {}
    await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, graceMs))]);
  }
}
async function run(cmd: string[], timeoutMs = 1500, cwd?: string): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    let expired: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<null>(resolve => { expired = setTimeout(() => resolve(null), timeoutMs); });
    try {
      const out = await Promise.race([boundedStream(proc.stdout, MAX_COMMAND_BYTES), deadline]);
      if (out === null) { await terminate(proc); return ""; }
      // Output complete; give the child a moment to exit on its own, then insist.
      await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, KILL_GRACE_MS))]);
      await terminate(proc);
      return out;
    } finally {
      if (expired) clearTimeout(expired);
    }
  } catch { return ""; }
}
async function fetchJson(url: string, ms = 600): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const text = await boundedStream(r.body, MAX_HTTP_BYTES);
    if (text === null) return null;
    const payload = parseJsonBounded(text);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}
function finiteSize(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : 0;
}
function uiString(value: unknown, limit = 512): string {
  // Objects and arrays from external JSON are never text; "[object Object]"
  // on a card is a bug, and a shadowed toString used to throw here.
  if (value === null || value === undefined || typeof value === "object" || typeof value === "function") return "";
  // Every Text in the dashboard is textFormat: PlainText, so markup needs no
  // escaping — and escaping "&" turned ~/R&D into a directory that does not
  // exist when the same string fed Open Project / Resume / the clipboard.
  return String(value).slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, " ");
}
// Arrays carry the recent-prompt rows (up to 1000 for heatmap drill-down);
// a 256 cap here silently threw away 3/4 of them while recentTruncated still
// said false. Byte and node budgets bound the frame regardless.
const MAX_UI_ARRAY_ITEMS = 1024;
function sanitizeForUi(value: any, depth = 0): any {
  if (depth > 12) return null;
  if (typeof value === "string") return uiString(value);
  if (Array.isArray(value)) return value.slice(0, MAX_UI_ARRAY_ITEMS).map(item => sanitizeForUi(item, depth + 1));
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
  return address.length <= 64 && isIP(address) !== 0 ? address : null;
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
    const trace = response.ok ? await boundedStream(response.body, 16 * 1024) : null;
    const address = trace === null ? null : parseExternalIpTrace(trace);
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
export function parseDfRows(out: string): any[] {
  const rows = String(out || "").trim().split("\n").slice(1).map(l => l.trim().split(/\s+/));
  const seen = new Set<string>(); const res: any[] = [];
  for (const r of rows) {
    if (r.length < 4 || seen.has(r[0]) || !r[0].startsWith("/")) continue; seen.add(r[0]);
    const size = Number(r[1]), used = Number(r[2]), avail = Number(r[3]);
    // A non-numeric column used to produce NaN → null → an empty meter for "/".
    if (![size, used, avail].every(n => Number.isFinite(n) && n >= 0) || size <= 0) continue;
    // btrfs subvolumes (/ and /home on one pool) report identical numbers — show once
    if (res.some(x => x.size === size && x.used === used)) continue;
    res.push({ mount: uiString(r[0], 128), size, used, avail, pct: 100 * used / size });
  }
  return res;
}
async function disk() {
  return parseDfRows(await run(["df", "-B1", "--output=target,size,used,avail", "/", HOME]));
}
async function net() {
  const route = await run(["ip", "-j", "route", "get", "1.1.1.1"], 800);
  let dev = ""; try { dev = parseJsonBounded(route, 2048, 12)?.[0]?.dev || ""; } catch {}
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
  let addr: string | null = null; try { addr = parseJsonBounded(ip, 4096, 12)?.[0]?.addr_info?.[0]?.local || null; } catch {}
  return { dev, wireless, ssid, signal, freq, bitrate, addr, rx, tx, rxRate, txRate };
}
async function ping() {
  const out = await run(["ping", "-n", "-c", "1", "-W", "1", "1.1.1.1"], 1500);
  const m = out.match(/time=([\d.]+)/);
  const ms = m ? Number(m[1]) : NaN;
  // Infinity serializes as null and QML then calls null.toFixed(); require a sane value.
  const ok = Number.isFinite(ms) && ms >= 0 && ms < 60_000;
  return { host: "1.1.1.1", label: "cloudflare", ms: ok ? ms : null, ok };
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
export function parseGpuLine(out: string): { name: string; util: number; memUsed: number; memTotal: number; temp: number } | null {
  const r = String(out || "").trim().split("\n")[0]?.split(",").map(s => s.trim());
  if (!r || r.length < 5 || !r[0]) return null;
  const numbers = r.slice(1, 5).map(Number);
  // ",,,," parses to five empty strings and +"" is 0 — that rendered a GPU
  // named "" with 0/0 memory. Require a name and finite, non-negative numbers.
  if (!numbers.every(n => Number.isFinite(n) && n >= 0) || numbers[2] <= 0) return null;
  return { name: uiString(r[0], 96), util: numbers[0], memUsed: numbers[1] * 1048576, memTotal: numbers[2] * 1048576, temp: numbers[3] };
}
async function gpu() {
  if (!Bun.which("nvidia-smi")) return null;
  const out = await run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"], 1200);
  return parseGpuLine(out);
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
  ["hermes", /(^|\/)hermes(\.js|\.mjs|\.py)?$/],
  ["opencode", /(^|\/)opencode$/],
  ["aider", /(^|\/)aider$/],
  ["copilot", /(^|\/)copilot$/],
  ["ollama", /(^|\/)ollama$/],
];
const INTERPRETERS = /(^|\/)(node|nodejs|bun|deno|python[0-9.]*|uv|npx|bunx|sh|bash|zsh|fish|env)$/;
export function providerOf(cmd: string[]): string | null {
  // Only argv[0] identifies a program. argv[1..2] count solely when argv[0]
  // is an interpreter/launcher, otherwise `cat /tmp/claude` or
  // `vim notes/codex` becomes a phantom agent with repo scans and alerts.
  const candidates = INTERPRETERS.test(cmd[0] || "") ? cmd.slice(0, 3) : cmd.slice(0, 1);
  for (const arg of candidates) {
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
function shortPath(p: string) {
  // Exact HOME or HOME + "/" only: /home/pi2/x is not inside /home/pi.
  return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}
// Grok names session dirs after a percent-encoded cwd. A literal "%" in the
// project path makes decodeURIComponent throw, which used to abort the whole
// snapshot. Fall back to the raw directory name instead.
export function decodeProjectDir(dir: string): string {
  try { return decodeURIComponent(dir); } catch { return dir; }
}

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
function contextValue(value: unknown, limit = 80): string {
  return uiString(value, limit).replace(/\s+/g, " ").trim();
}
function contextId(value: unknown): string {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9%][A-Za-z0-9_.:%-]{0,127}$/.test(id) ? id : "";
}
export type SessionHost = {
  kind: "herdr" | "boomux" | "tmux";
  label: string;
  workspace?: string;
  workspaceId?: string;
  shell?: string;
  shellId?: string;
  runId?: string;
  tabId?: string;
  paneId?: string;
  session?: string;
  window?: string;
  pane?: string;
  attached?: boolean;
  // True when an attached client is currently showing this very pane; only
  // then does the terminal's title describe this agent.
  activePane?: boolean;
  server?: string;
};
// Extract only documented multiplexer identity variables. Never serialize or
// search the rest of /proc/<pid>/environ, which may contain credentials.
export function sessionHostsFromEnvironment(environ = ""): SessionHost[] {
  const hosts: SessionHost[] = [];
  const herdrPane = contextId(envValue(environ, "HERDR_PANE_ID"));
  const herdrWorkspace = contextId(envValue(environ, "HERDR_WORKSPACE_ID"));
  const herdrTab = contextId(envValue(environ, "HERDR_TAB_ID"));
  if (envValue(environ, "HERDR_ENV") === "1" && (herdrPane || herdrWorkspace || herdrTab)) {
    const parts = [herdrWorkspace, herdrTab, herdrPane].filter(Boolean);
    hosts.push({ kind: "herdr", label: "Herdr " + parts.join(" / "), workspaceId: herdrWorkspace, tabId: herdrTab, paneId: herdrPane });
  }
  const boomuxShellId = contextId(envValue(environ, "BOOMUX_SHELL_ID"));
  if (boomuxShellId) {
    const workspace = contextValue(envValue(environ, "BOOMUX_WORKSPACE"), 64);
    const shell = contextValue(envValue(environ, "BOOMUX_SHELL_NAME"), 64);
    const workspaceId = contextId(envValue(environ, "BOOMUX_WORKSPACE_ID"));
    const runId = contextId(envValue(environ, "BOOMUX_RUN_ID"));
    const friendly = [workspace, shell].filter(Boolean).join(" / ");
    hosts.push({
      kind: "boomux", label: "Boomux " + (friendly || ("shell " + boomuxShellId.slice(0, 8))),
      workspace, workspaceId, shell, shellId: boomuxShellId, runId,
    });
  }
  const tmuxPane = contextId(envValue(environ, "TMUX_PANE"));
  if (envValue(environ, "TMUX") || tmuxPane) hosts.push({ kind: "tmux", label: "tmux", paneId: tmuxPane });
  return hosts;
}

export function tmuxSocketFromEnvironment(environ = ""): string {
  const socket = String(envValue(environ, "TMUX") || "").split(",")[0];
  return socket.length > 0 && socket.length <= 256 && socket.startsWith("/") && !/[\u0000-\u001f\u007f]/.test(socket) ? socket : "";
}
export type TmuxPane = { pid: number; paneId: string; session: string; window: string; pane: string; cwd: string; active: boolean; server: string };
export type TmuxClient = { pid: number; session: string; server: string; paneId: string };
export function parseTmuxPanes(text: string, server = ""): TmuxPane[] {
  const result: TmuxPane[] = [];
  for (const line of String(text || "").split("\n").slice(0, MAX_COLLECTION_ITEMS)) {
    const [rawPid, rawPaneId, rawSession, rawWindow, rawPane, rawCwd, rawActive] = line.split("\t");
    const pid = Number(rawPid), paneId = contextId(rawPaneId), session = contextValue(rawSession, 64);
    if (!Number.isInteger(pid) || pid < 2 || !paneId || !session) continue;
    result.push({ pid, paneId, session, window: contextValue(rawWindow, 16), pane: contextValue(rawPane, 16), cwd: contextValue(rawCwd, 256), active: rawActive === "1", server });
  }
  return result;
}
export function parseTmuxClients(text: string, server = ""): TmuxClient[] {
  const result: TmuxClient[] = [];
  for (const line of String(text || "").split("\n").slice(0, MAX_COLLECTION_ITEMS)) {
    const [rawPid, rawSession, rawPane] = line.split("\t"), pid = Number(rawPid), session = contextValue(rawSession, 64);
    if (Number.isInteger(pid) && pid > 1 && session) result.push({ pid, session, server, paneId: contextId(rawPane) });
  }
  return result;
}
export function tmuxPaneForAncestors(ancestors: number[], panes: TmuxPane[], paneId = "", server = ""): TmuxPane | null {
  const candidates = server ? panes.filter(pane => pane.server === server) : panes;
  const byPid = new Map(candidates.map(pane => [pane.pid, pane]));
  for (const pid of ancestors) if (byPid.has(pid)) return byPid.get(pid)!;
  const exact = paneId ? candidates.find(pane => pane.paneId === paneId) : null;
  if (exact) return exact;
  return null;
}
// /proc/<pid>/environ was read up to three times per agent per tick (session
// ids, tmux socket, multiplexer hosts). Read once; the value is per-process.
const environCache = new Map<number, string>();
function environOf(pid: number): string {
  if (!environCache.has(pid)) environCache.set(pid, read(`/proc/${pid}/environ`) || "");
  return environCache.get(pid)!;
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
    const envOrArg = sessionIdFrom(provider, candidateCmd, environOf(candidate));
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

// A generate call that times out must NOT be cached as if it had succeeded:
// the local fallback would be pinned against this fingerprint forever and the
// model would never be consulted again. Record a short retry backoff instead.
const TOPIC_TIMEOUT_MS = 6000;
const TOPIC_RETRY_MS = 60_000;
// Entries written before the failure-marker fix are shape-identical to good
// ones: they hold a local fallback in `summary` as though the model had
// produced it, so they would be served forever. Require the version stamp so
// pre-fix caches are discarded on first read instead of staying poisoned.
const TOPIC_CACHE_VERSION = 2;
export function topicCacheHit(cached: any, fingerprint: string, model: string): string {
  return cached && cached.v === TOPIC_CACHE_VERSION && cached.fingerprint === fingerprint && cached.model === model
    && typeof cached.summary === "string" && cached.summary ? cached.summary : "";
}

export function topicRetryBlocked(cached: any, fingerprint: string, model: string, stamp: number): boolean {
  if (!cached || cached.v !== TOPIC_CACHE_VERSION || cached.fingerprint !== fingerprint || cached.model !== model) return false;
  const failedAt = Number(cached.failedAt || 0);
  return failedAt > 0 && stamp - failedAt < TOPIC_RETRY_MS;
}
// Keys are provider:sessionId. Dead sessions would accumulate forever, and an
// oversized prev-*.json silently fails to write, killing every rate stat.
export function pruneTopicCache(cache: Record<string, any>, liveKeys: Set<string>, limit = 64): Record<string, any> {
  const kept = Object.entries(cache).filter(([key]) => liveKeys.has(key));
  const rest = Object.entries(cache).filter(([key]) => !liveKeys.has(key))
    .sort((a, b) => Number(b[1]?.checkedAt || 0) - Number(a[1]?.checkedAt || 0));
  return Object.fromEntries([...kept, ...rest].slice(0, limit));
}

// Topic refinement POSTs recent prompt text to the Ollama host. That is
// fine for a model on this machine; it is silent data egress when OLLAMA_HOST
// points at a shared GPU box. Refine only against loopback unless the user
// opts in explicitly. Explicit LOAD/UNLOAD clicks are not affected.
export function ollamaHostIsLocal(hostValue: unknown): boolean {
  const raw = String(hostValue || "http://127.0.0.1:11434").trim();
  try {
    const url = new URL(raw.startsWith("http://") || raw.startsWith("https://") ? raw : "http://" + raw);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "0.0.0.0";
  } catch { return false; }
}
export function topicRefinementAllowed(env = process.env): boolean {
  return env.INFOMARCHY_ALLOW_REMOTE_OLLAMA === "1" || ollamaHostIsLocal(env.OLLAMA_HOST);
}
async function refineSessionTopics(sessions: any[], recentEntries: any[], ollama: any): Promise<Record<string, any>> {
  const previous = prev.topicSummaries && typeof prev.topicSummaries === "object" ? prev.topicSummaries : {};
  const next: Record<string, any> = {};
  for (const [key, entry] of Object.entries(previous)) if (entry && (entry as any).v === TOPIC_CACHE_VERSION) next[key] = entry;
  const liveKeys = new Set<string>();
  const model = topicRefinementAllowed() ? String((ollama.loaded || [])[0]?.name || "") : "";
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const base = host.startsWith("http") ? host : "http://" + host;
  // Never fan out an unbounded number of generate requests at one local model.
  const MAX_TOPIC_REQUESTS = 6;
  let requests = 0;
  await Promise.all(sessions.map(async session => {
    const entries = exactSessionEntries(session, recentEntries);
    if (!entries.length) return;
    const ids = (session.sessionIds || []).map((value: any) => cleanSessionId(value)).filter(Boolean);
    const key = `${session.provider}:${ids[0] || session.pid}`;
    liveKeys.add(key);
    if (!model) return;
    const fingerprint = String(Bun.hash(JSON.stringify(entries.map(entry => [entry.ts, entry.text]))));
    const cached = previous[key];
    const hit = topicCacheHit(cached, fingerprint, model);
    if (hit) { session.topic = hit; return; }
    if (topicRetryBlocked(cached, fingerprint, model, now)) return;
    if (++requests > MAX_TOPIC_REQUESTS) return;
    let generated = "";
    try {
      const prompt = "Summarize the current work as a specific 3-7 word gerund phrase. Do not quote a request. No punctuation or preamble.\nProject: " +
        topicProjectLabel(session) + "\nRecent requests:\n" + entries.map(entry => "- " + String(entry.text || "").slice(0, 320)).join("\n");
      const response = await fetch(base + "/api/generate", {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(TOPIC_TIMEOUT_MS),
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.1, num_predict: 20 } }),
      });
      const text = response.ok ? await boundedStream(response.body, 64 * 1024) : null;
      const payload = text === null ? null : parseJsonBounded(text, 256, 6);
      generated = payload && typeof payload === "object" ? cleanGeneratedSummary(payload.response) : "";
    } catch {}
    if (generated) {
      session.topic = generated;
      next[key] = { v: TOPIC_CACHE_VERSION, fingerprint, model, summary: generated, checkedAt: now };
    } else {
      // Keep the local summary on screen, but remember this as a FAILURE so a
      // later tick retries once the backoff expires.
      next[key] = { v: TOPIC_CACHE_VERSION, fingerprint, model, failedAt: now, checkedAt: now };
    }
  }));
  return pruneTopicCache(next, liveKeys);
}

export function inferSessionIdsFromRecent(sessions: any[], recentEntries: any[]): void {
  const unresolvedByKey = new Map<string, any[]>();
  const liveByKey = new Map<string, number>();
  const owned = new Set<string>();
  for (const session of sessions) {
    const key = `${session.provider}\0${session.cwd}`;
    liveByKey.set(key, (liveByKey.get(key) || 0) + 1);
    for (const id of session.sessionIds || []) { const clean = cleanSessionId(id); if (clean) owned.add(`${session.provider}\0${clean}`); }
    if ((session.sessionIds || []).length || !session.cwd || session.cwd === "/") continue;
    const group = unresolvedByKey.get(key) || [];
    group.push(session);
    unresolvedByKey.set(key, group);
  }
  for (const [key, group] of unresolvedByKey) {
    // Two live agents in the same provider/project are indistinguishable from
    // history alone — including one that already resolved its own id, whose
    // prompts would otherwise be handed to its neighbour. Refuse to guess.
    if (group.length !== 1 || (liveByKey.get(key) || 0) !== 1) continue;
    const session = group[0];
    // recent is newest-first, so a plain find() returned the NEWEST prompt in
    // the project — which can belong to a later session that already exited.
    // Take the prompt closest after launch, and only within a short window.
    const startedAt = Number(session.startedAt || 0);
    let candidate: any = null;
    for (const entry of recentEntries) {
      if (`${entry.provider}\0${entry.project}` !== key || !cleanSessionId(entry.session)) continue;
      if (owned.has(`${entry.provider}\0${cleanSessionId(entry.session)}`)) continue;
      const ts = Number(entry.ts || 0);
      if (ts < startedAt - 5000 || ts > startedAt + 30 * 60_000) continue;
      if (!candidate || ts < Number(candidate.ts || 0)) candidate = entry;
    }
    const id = cleanSessionId(candidate?.session);
    if (!id) continue;
    session.session = id;
    session.sessionIds = [id];
  }
}

async function githubCiState(cwd: string): Promise<any> {
  const previous = prev.ciByRepo && typeof prev.ciByRepo === "object" ? prev.ciByRepo[cwd] : null;
  const checkedAt = Number(previous?.checkedAt || 0);
  if (checkedAt > 0 && now >= checkedAt && now - checkedAt < 10 * 60 * 1000) {
    currentCiByRepo[cwd] = previous;
    return previous;
  }
  if (!Bun.which("gh")) {
    const unavailable = previous ? { ...previous, checkedAt: now, stale: true } : { state: "unavailable", checkedAt: now };
    currentCiByRepo[cwd] = unavailable;
    return unavailable;
  }
  const output = await run(["gh", "run", "list", "--limit", "1", "--json", "status,conclusion,name,headSha,updatedAt"], 1800, cwd);
  const rows = parseJsonBounded(output, 256, 10);
  const latest = Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === "object" ? rows[0] : null;
  const state = String(latest?.conclusion || latest?.status || "").toLowerCase();
  const result = latest && /^[a-z_]+$/.test(state) ? {
    state,
    name: uiString(latest.name, 80),
    headSha: /^[0-9a-f]{7,64}$/i.test(String(latest.headSha || "")) ? String(latest.headSha) : "",
    updatedAt: uiString(latest.updatedAt, 40),
    checkedAt: now,
    stale: false,
  } : previous ? { ...previous, checkedAt: now, stale: true } : { state: "unavailable", checkedAt: now };
  currentCiByRepo[cwd] = result;
  return result;
}

async function repoState(cwd: string) {
  if (!cwd) return { root: "", state: null, changes: null, ci: null };
  const [root, status, diff, commitLine, ci] = await Promise.all([
    run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], 700),
    run(["git", "-C", cwd, "-c", "core.quotePath=off", "status", "--porcelain=v2", "--branch"], 900),
    run(["git", "-C", cwd, "diff", "--numstat", "HEAD", "--"], 900),
    run(["git", "-C", cwd, "log", "-1", "--format=%H%x09%h%x09%ct%x09%s"], 700),
    githubCiState(cwd),
  ]);
  const state = parseGitStatus(status), stats = parseDiffNumstat(diff), commit = parseCommitSummary(commitLine);
  // Status and numstat cannot tell one edit from another edit of the same
  // size; fold in the mtimes of the reported paths so "seen" tracks content.
  const stamps = (state?.files || []).slice(0, 12).map(file => { try { return lstatSync(join(root.trim() || cwd, file)).mtimeMs; } catch { return 0; } });
  const fingerprint = String(Bun.hash(JSON.stringify([commit?.hash || "", status, diff, stamps])));
  return {
    root: root.trim(), state,
    changes: state || commit ? {
      fingerprint,
      count: state?.dirty || 0,
      staged: state?.staged || 0,
      untracked: state?.untracked || 0,
      files: state?.files || [],
      testFiles: (state?.files || []).filter(file => /(^|\/)(test|tests|spec|specs)(\/|\.)|\.(test|spec)\./i.test(file)).length,
      additions: stats.additions,
      deletions: stats.deletions,
      head: commit?.hash || "",
      headShort: commit?.short || "",
      commitSubject: commit?.subject || "",
      committedAt: commit?.committedAt || 0,
    } : null,
    ci,
  };
}

function processAncestors(pid: number): number[] {
  const result: number[] = [], seen = new Set<number>();
  let current = info(pid);
  while (current && current.pid > 1 && !seen.has(current.pid)) {
    seen.add(current.pid); result.push(current.pid); current = info(current.ppid);
  }
  return result;
}
function windowForProcess(pid: number, winByPid: Map<number, any>): any {
  for (const ancestor of processAncestors(pid)) if (winByPid.has(ancestor)) return winByPid.get(ancestor);
  return null;
}
export function sessionPresentation(window: any, cmd: string[]): { window: any; args: string } {
  const argv = (cmd || []).slice(1, 4);
  const sanitizedArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index] || "");
    const assignedCredential = arg.match(/^(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|secret))=/i);
    if (assignedCredential) {
      sanitizedArgs.push(`${assignedCredential[1]}=[redacted]`);
      continue;
    }
    sanitizedArgs.push(safePrompt(arg));
    if (/^--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|secret)$/i.test(arg) && index + 1 < argv.length) {
      sanitizedArgs.push("[redacted]");
      index++;
    }
  }
  return {
    window: window ? {
      address: window.address,
      title: safePrompt(window.title),
      class: uiString(window.class, 128),
      workspace: window.workspace?.id ?? null,
    } : null,
    args: sanitizedArgs.join(" ").slice(0, 60),
  };
}
async function tmuxState(winByPid: Map<number, any>, pids: number[]): Promise<{ panes: TmuxPane[]; windows: Map<string, any> }> {
  const windows = new Map<string, any>();
  const tmuxRunning = [...cmdByPid.values()].some(cmd => cmd.some(arg => /(^|\/)tmux$|^tmux: server$/.test(arg)));
  if (!tmuxRunning || !Bun.which("tmux")) return { panes: [], windows };
  const sockets = new Set<string>();
  for (const pid of pids) {
    if (!providerOf(cmdByPid.get(pid) || [])) continue;
    const socket = tmuxSocketFromEnvironment(environOf(pid));
    if (socket) sockets.add(socket);
    if (sockets.size >= 8) break;
  }
  if (!sockets.size) sockets.add("");
  const formatPane = "#{pane_pid}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_path}\t#{pane_active}";
  // Two clients on one session usually sit on different panes; key by the
  // client's current pane so a card focuses the terminal actually showing it,
  // and fall back to the session only when no client is on that pane.
  const formatClient = "#{client_pid}\t#{session_name}\t#{pane_id}";
  const panes: TmuxPane[] = [];
  for (const socket of [...sockets]) {
    const prefix = socket ? ["tmux", "-S", socket] : ["tmux"];
    const [paneText, clientText] = await Promise.all([
      run([...prefix, "list-panes", "-a", "-F", formatPane], 650),
      run([...prefix, "list-clients", "-F", formatClient], 650),
    ]);
    panes.push(...parseTmuxPanes(paneText, socket));
    for (const client of parseTmuxClients(clientText, socket)) {
      const window = windowForProcess(client.pid, winByPid);
      if (!window) continue;
      if (client.paneId) { const paneKey = client.server + "\0pane\0" + client.paneId; if (!windows.has(paneKey)) windows.set(paneKey, window); }
      const key = client.server + "\0" + client.session;
      if (!windows.has(key)) windows.set(key, window);
    }
  }
  return { panes, windows };
}

async function liveSessions(pids: number[]) {
  let clients: any[] = [];
  try { clients = parseJsonBounded(await run(["hyprctl", "clients", "-j"], 1000), 50_000, 16) || []; } catch {}
  // Shape-check every client: a null entry, a non-integer pid or a non-string
  // address used to throw here and blank the whole desk.
  clients = (Array.isArray(clients) ? clients : []).filter((c: any) =>
    c && typeof c === "object" && Number.isInteger(c.pid) && c.pid > 0 && typeof c.address === "string");
  const winByPid = new Map<number, any>(clients.map((c: any) => [c.pid, c]));
  const sessions: any[] = [];
  const [gpuByPid, tmux] = await Promise.all([gpuMemoryByPid(), tmuxState(winByPid, pids)]);
  for (const pid of pids) {
    const prov = providerOf(cmdByPid.get(pid) || []); if (!prov) continue;
    const p = info(pid); if (!p) continue;
    // skip children of an already-reported agent process (subagents, helpers)
    let anc = info(p.ppid), child = false;
    while (anc && anc.pid > 1) { if (providerOf(anc.cmd)) { child = true; break; } anc = info(anc.ppid); }
    if (child) continue;
    // Direct terminals share ancestry with the agent. Multiplexer servers do
    // not, so tmux is resolved through its pane and attached client below.
    let w: any = windowForProcess(p.pid, winByPid);
    const environ = environOf(p.pid);
    const hosts = sessionHostsFromEnvironment(environ);
    const tmuxHost = hosts.find(host => host.kind === "tmux");
    const tmuxSocket = tmuxSocketFromEnvironment(environ);
    const pane = tmuxPaneForAncestors(processAncestors(p.pid), tmux.panes, tmuxHost?.paneId || "", tmuxSocket);
    if (pane) {
      const attachedWindow = tmux.windows.get(pane.server + "\0pane\0" + pane.paneId) || tmux.windows.get(pane.server + "\0" + pane.session) || null;
      if (!tmuxHost) hosts.push({ kind: "tmux", label: "tmux" });
      const host = hosts.find(item => item.kind === "tmux")!;
      host.session = pane.session; host.window = pane.window; host.pane = pane.pane; host.paneId = pane.paneId;
      host.attached = !!attachedWindow;
      host.activePane = tmux.windows.has(pane.server + "\0pane\0" + pane.paneId);
      host.server = pane.server;
      host.label = "tmux " + pane.session + ":" + pane.window + "." + pane.pane;
      if (!w && attachedWindow) w = attachedWindow;
    }
    const sessionIds = processSessionIds(p.pid, prov, p.cmd);
    const sample = processTreeSample(p.pid);
    // A reused pid with a fresh process must not inherit the old baseline.
    const agentKey = `${p.pid}:${Math.round(p.start)}`;
    currentAgentRaw[agentKey] = sample.ticks;
    const presentation = sessionPresentation(w, p.cmd);
    sessions.push({
      provider: prov, pid: p.pid, cwd: shortPath(p.cwd), project: basename(p.cwd || "") || "/",
      _cwd: p.cwd,
      startedAt: p.start, uptimeSec: Math.max(0, (now - p.start) / 1000),
      session: sessionIds[0] || "", sessionIds,
      hosts,
      window: presentation.window,
      args: presentation.args,
      resources: {
        cpuPct: resourceDelta(sample.ticks, prev.agents?.[agentKey], dt),
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
    // A tmux window title describes the pane the client is showing. For a
    // pane that is not on screen, the title is somebody else's.
    const tmuxHostOf = (s.hosts || []).find((host: any) => host.kind === "tmux");
    if (tmuxHostOf && tmuxHostOf.attached && !tmuxHostOf.activePane && s.window) s.window = { ...s.window, title: "" };
    const titleBusy = !!(s.window && titleLooksBusy(s.window.title));
    // Grok's terminal title sticks on 🧠 after the turn. Trust the inhibitor.
    s.busy = s.provider === "grok" ? turnBusy.has(s.pid) : (titleBusy || turnBusy.has(s.pid));
    if (!s.busy && s.window && titleLooksBusy(s.window.title) && s.provider === "grok")
      s.window = { ...s.window, title: "" };
  }
  // Each repo costs four git spawns plus an occasional gh. Bound the fan-out;
  // sessions beyond the cap simply show no repo state rather than spawning
  // hundreds of processes per tick.
  const MAX_REPOS_PER_TICK = 24;
  const repos = new Map<string, Promise<{ root: string; state: any; changes: any; ci: any }>>();
  for (const session of sessions) {
    if (!session._cwd || repos.has(session._cwd)) continue;
    if (repos.size >= MAX_REPOS_PER_TICK) break;
    repos.set(session._cwd, repoState(session._cwd));
  }
  await Promise.all(sessions.map(async session => {
    const repo = session._cwd ? await repos.get(session._cwd) : null;
    session.repoRoot = repo?.root ? shortPath(repo.root) : "";
    session.git = repo?.state || null;
    session.changes = repo?.changes || null;
    session.ci = repo?.ci || null;
    // Title words like "permission" or "failed" describe the TASK while the
    // agent is still working. Only an idle agent can be blocked/waiting/done.
    const signal = session.busy ? null : attentionSignal(session.window?.title, session.git?.conflicts || 0);
    session.attention = signal?.state || "";
    session.attentionReason = signal?.reason || "";
    session.attentionAction = signal?.action || "";
    session.attentionDetail = signal?.detail || "";
    delete session._cwd;
  }));
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  return sessions;
}

// ---------------------------------------------------------------- AI history
export function safePrompt(value: unknown): string {
  return String(typeof value === "object" ? "" : (value || ""))
    // PEM blocks, JWTs, authenticated URLs, cloud-style keys and env-style
    // credential assignments. Best-effort by design: it cannot know every
    // format, so the README says "redacted" not "guaranteed".
    .replace(/-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END[^-]{0,40}PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "eyJ[redacted]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@"']+:)[^\s\/@"']+@/gi, "$1[redacted]@")
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1[redacted]")
    .replace(/\b(AIza)[A-Za-z0-9_-]{20,}\b/g, "$1[redacted]")
    .replace(/\b(xox[abprs]-)[A-Za-z0-9-]{10,}\b/g, "$1[redacted]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Z0-9_]*)(\s*=\s*)(?:"[^"]{4,}"|'[^']{4,}'|[^\s"']{4,})/g, "$1$2[redacted]")
    // Common token formats. Keep a small prefix so the redaction is still recognizable.
    .replace(/\b(sk-(?:proj-|ant-)?|gh[opusr]_)[A-Za-z0-9_-]{12,}\b/gi, "$1[redacted]")
    .replace(/\b(ntn_)[A-Za-z0-9_-]{12,}\b/gi, "$1[redacted]")
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s"']+/gi, "$1[redacted]")
    // Credential CLI flags, with either a separate value or --flag=value.
    .replace(/(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|passwd|secret))\b(\s+|=)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, "$1$2[redacted]")
    // Credentials pasted as explicit assignments or natural-language "token/key: value" pairs.
    // An explicitly labeled credential is redacted whatever its length —
    // "password: hunter2" is still a password.
    .replace(/\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|token|password|passwd|secret)\b(\s*(?:is|=|:)\s*)(?:"[^"]+"|'[^']+'|[^\s"']+)/gi, "$1$2[redacted]")
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
// A row dated 2099 used to count as today AND sort above every real task.
export function plausibleTimestamp(ts: unknown, stamp = now): boolean {
  const time = Number(ts);
  return Number.isFinite(time) && time > 946_684_800_000 && time <= stamp + 60_000;
}
function cnt(prov: string, ts: number) {
  if (!plausibleTimestamp(ts)) return;
  const c = counts[prov] ||= { today: 0, week: 0, total: 0 };
  c.total++; if (ts >= todayStart) c.today++; if (ts >= start7) c.week++;
}

function claudeHistory() {
  const p = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"), "history.jsonl");
  const txt = readHistoryTail(p); if (!txt) return { present: false };
  const lines = txt.split("\n").filter(Boolean);
  for (const l of lines) {
    try {
      const e = parseJsonBounded(l, 2048, 12); const ts = +e?.timestamp; if (!ts) continue;
      bump(ts, "claude"); cnt("claude", ts);
      if (plausibleTimestamp(ts)) recent.push({ provider: "claude", ts, project: shortPath(e.project || ""), text: safePrompt(e.display), session: e.sessionId });
    } catch {}
  }
  return { present: true, prompts: lines.length };
}
// Codex history.jsonl carries no cwd, which left every Codex row on the desk
// with a blank project and made RESUME open a terminal in $HOME. The working
// directory lives in the session_meta header of the matching rollout file, and
// the session id is in that file's name — so read only the first bytes.
export function rolloutSessionId(fileName: string): string {
  const match = fileName.match(/rollout-.*?-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return cleanSessionId(match?.[1]);
}
export function rolloutCwd(head: string): string {
  const line = String(head || "").split("\n")[0] || "";
  const match = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.){0,4096})"/);
  if (!match) return "";
  try { return JSON.parse('"' + match[1] + '"'); } catch { return ""; }
}
function codexSessionDirectories(base: string): Map<string, string> {
  const result = new Map<string, string>();
  const root = join(base, "sessions");
  const files: string[] = [];
  // sessions/YYYY/MM/DD/rollout-*.jsonl — newest day first; stop as soon as the
  // cap is reached so a day with a huge number of rollouts is not enumerated.
  outer: for (const year of ls(root).sort().reverse().slice(0, 4))
    for (const month of ls(join(root, year)).sort().reverse().slice(0, 12))
      for (const day of ls(join(root, year, month)).sort().reverse().slice(0, 31)) {
        const names = ls(join(root, year, month, day)).filter(file => file.endsWith(".jsonl")).sort().reverse().slice(0, MAX_COLLECTION_ITEMS);
        for (const file of names) files.push(join(root, year, month, day, file));
        if (files.length >= MAX_COLLECTION_ITEMS) break outer;
      }
  for (const path of files.slice(0, MAX_COLLECTION_ITEMS)) {
    const id = rolloutSessionId(basename(path));
    if (!id || result.has(id)) continue;
    const cwd = rolloutCwd(readRegularFileHead(path, 4096) || "");
    if (cwd) result.set(id, shortPath(cwd));
  }
  return result;
}

function codexHistory() {
  const base = process.env.CODEX_HOME || join(HOME, ".codex");
  if (!existsSync(base)) return { present: false };
  const hist = readHistoryTail(join(base, "history.jsonl")) || "";
  const directories = codexSessionDirectories(base);
  let prompts = 0;
  for (const l of hist.split("\n").filter(Boolean)) {
    try { const e = parseJsonBounded(l, 2048, 12); const ts = (+e?.ts || 0) * 1000; if (!ts) continue; prompts++;
      bump(ts, "codex"); cnt("codex", ts);
      if (plausibleTimestamp(ts)) recent.push({ provider: "codex", ts, project: directories.get(cleanSessionId(e.session_id)) || "", text: safePrompt(e.text), session: e.session_id });
    } catch {}
  }
  const threads: any[] = [];
  for (const l of (read(join(base, "session_index.jsonl")) || "").split("\n").filter(Boolean)) {
    try {
      const e = parseJsonBounded(l, 2048, 12);
      const updatedAt = e ? Date.parse(uiString(e.updated_at, 64)) : NaN;
      if (e && Number.isFinite(updatedAt)) threads.push({ id: cleanSessionId(e.id), name: uiString(e.thread_name, 120), updatedAt });
    } catch {}
  }
  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  return { present: true, prompts, threads: threads.slice(0, 8), threadCount: threads.length };
}
function grokHistory() {
  const base = join(HOME, ".grok");
  if (!existsSync(base)) return { present: false };
  const activeRaw = readJson(join(base, "active_sessions.json"));
  const active = Array.isArray(activeRaw) ? activeRaw : [];
  const sessionIds = new Set<string>();
  for (const dir of ls(join(base, "sessions"))) {
    const full = join(base, "sessions", dir);
    try { const state = lstatSync(full); if (state.isSymbolicLink() || !state.isDirectory()) continue; } catch { continue; }
    const project = shortPath(decodeProjectDir(dir));
    const history = readHistoryTail(join(full, "prompt_history.jsonl")) || "";
    for (const l of history.split("\n").filter(Boolean)) {
      try {
        const e = parseJsonBounded(l, 2048, 12), ts = Date.parse(e?.timestamp);
        if (!Number.isFinite(ts)) continue;
        const session = String(e.session_id || "");
        if (session) sessionIds.add(session);
        bump(ts, "grok"); cnt("grok", ts);
        if (plausibleTimestamp(ts)) recent.push({ provider: "grok", ts, project, text: safePrompt(e.prompt), session });
      } catch {}
    }
  }
  const activeSessions = active.filter((a: any) => a && typeof a === "object")
    .slice(0, MAX_COLLECTION_ITEMS)
    .map((a: any) => ({
      pid: Number.isInteger(a.pid) && a.pid > 0 ? a.pid : null,
      cwd: shortPath(uiString(a.cwd, 512)),
      openedAt: (() => { const t = Date.parse(uiString(a.opened_at, 64)); return Number.isFinite(t) ? t : null; })(),
    }))
    .filter((a: any) => a.pid !== null);
  return { present: true, sessions: sessionIds.size, active: activeSessions };
}
function opencodeHistory() {
  const dataRoot = process.env.XDG_DATA_HOME || join(HOME, ".local/share");
  const path = join(dataRoot, "opencode/opencode.db");
  // Every other history reader opens with O_NOFOLLOW; a symlinked database
  // would let any SQLite file masquerade as prompt history, and a FIFO would
  // block the native open.
  let identity = "";
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { present: false };
    identity = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch { return { present: false }; }
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    // Heatmap/counts need every prompt of the week but only its timestamp;
    // the detailed (text) query below is capped and feeds the Recent list.
    for (const row of db.query(`
      SELECT time_created AS ts FROM message
       WHERE time_created >= ? AND json_valid(data) AND json_extract(data, '$.role') = 'user'
    `).all(start7) as any[]) {
      const ts = Number(row.ts || 0);
      if (ts) { bump(ts, "opencode"); cnt("opencode", ts); }
    }
    // Only the last seven days are ever displayed, and never more than 1000
    // rows; scanning and JSON-decoding the whole table every tick did not
    // scale. json_valid() keeps one corrupt row from zeroing the provider.
    const rows = db.query(`
      SELECT m.session_id AS session, m.time_created AS ts, s.directory AS project,
        (SELECT json_extract(p.data, '$.text')
           FROM part p
          WHERE p.message_id = m.id AND json_valid(p.data) AND json_extract(p.data, '$.type') = 'text'
          ORDER BY p.time_created, p.id LIMIT 1) AS text
        FROM message m
        JOIN session s ON s.id = m.session_id
       WHERE m.time_created >= ? AND json_valid(m.data) AND json_extract(m.data, '$.role') = 'user'
       ORDER BY m.time_created DESC, m.id DESC
       LIMIT 2000
    `).all(start7) as any[];
    // Lifetime totals walk the whole table; recompute only when the file changed.
    const cachedTotals = prev.opencodeTotals && prev.opencodeTotals.identity === identity ? prev.opencodeTotals : null;
    const totals = cachedTotals || { identity, ...(db.query(`
      SELECT COUNT(*) AS prompts, COUNT(DISTINCT session_id) AS sessions
        FROM message WHERE json_valid(data) AND json_extract(data, '$.role') = 'user'
    `).get() as any) };
    currentOpencodeTotals = { identity, prompts: Number(totals.prompts) || 0, sessions: Number(totals.sessions) || 0 };
    const sessions = new Set<string>();
    let prompts = 0;
    for (const row of rows) {
      const ts = Number(row.ts || 0);
      if (!ts || !row.text) continue;
      prompts++;
      const session = cleanSessionId(row.session);
      if (session) sessions.add(session);
      if (plausibleTimestamp(ts)) recent.push({ provider: "opencode", ts, project: shortPath(String(row.project || "")), text: safePrompt(row.text), session });
    }
    return { present: true, prompts: Math.max(prompts, currentOpencodeTotals.prompts), sessions: Math.max(sessions.size, currentOpencodeTotals.sessions) };
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
        size: finiteSize(model.size), until: uiString(model.expires_at, 64) }))
      .filter((model: any) => !!model.name),
    models: models.filter((model: any) => model && typeof model === "object")
      .map((model: any) => ({
        name: uiString(model.name || model.model, 256),
        size: finiteSize(model.size),
        modifiedAt: uiString(model.modified_at, 64),
        family: uiString(model.details?.family, 64),
        parameterSize: uiString(model.details?.parameter_size, 32),
        quantization: uiString(model.details?.quantization_level, 32),
      })).filter((model: any) => !!model.name),
    modelCount: models.length,
  };
}
const MAX_USAGE_FILES = 16;
const MAX_USAGE_FILE_BYTES = 512 * 1024;
export function normalizeUsageLimit(limit: any, stamp = now): any | null {
  if (!limit || typeof limit !== "object") return null;
  const percent = Number(limit.percent);
  return {
    label: uiString(limit.label ?? limit.title, 64),
    title: uiString(limit.title ?? limit.label, 64),
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(10, percent)) : 0,
    resetsAt: uiString(limit.resetsAt, 40),
    forecast: limitForecast(limit, stamp),
  };
}
export function normalizeUsage(j: any, stamp = now): any {
  const count = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const modelUsage: Record<string, any> = {};
  for (const [key, value] of Object.entries(j.modelUsage && typeof j.modelUsage === "object" ? j.modelUsage : {}).slice(0, 32)) {
    const name = uiString(key, 64); if (!name) continue;
    modelUsage[name] = value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).slice(0, 8).map(([k, v]) => [uiString(k, 32), typeof v === "string" ? uiString(v, 64) : count(v)]))
      : count(value);
  }
  const recentDays = (Array.isArray(j.recentDays) ? j.recentDays : []).slice(0, 31)
    .map((day: any) => day && typeof day === "object"
      ? Object.fromEntries(Object.entries(day).slice(0, 8).map(([k, v]) => [uiString(k, 32), typeof v === "string" ? uiString(v, 32) : count(v)]))
      : count(day));
  return {
    name: uiString(j.name, 64), ready: j.ready !== false, tierLabel: uiString(j.tierLabel, 32),
    // Ship the projection from the tested implementation instead of letting
    // the QML re-derive it (the copy there had drifted out of test coverage).
    limits: (Array.isArray(j.limits) ? j.limits : []).slice(0, 16).map((limit: any) => normalizeUsageLimit(limit, stamp)).filter(Boolean),
    todayPrompts: count(j.todayPrompts), todaySessions: count(j.todaySessions), todayTotalTokens: count(j.todayTotalTokens),
    totalPrompts: count(j.totalPrompts), totalSessions: count(j.totalSessions), updatedAt: count(j.updatedAt),
    modelUsage, recentDays, usageStatusText: uiString(j.usageStatusText, 160),
  };
}
function agentsUsage() {
  // Omarchy's own agents plugin caches rate limits + token usage here; reuse it when present.
  // Every field is normalized to what the cards display: two individually valid
  // caches could otherwise push the aggregate snapshot over its node budget and
  // blank the desk, and 256 x 8 MiB files was a plausible 2 GiB read per tick.
  const dir = join(XDG_STATE, "omarchy/agents/usage");
  const out: Record<string, any> = {};
  for (const f of ls(dir).filter(name => name.endsWith(".json")).sort().slice(0, MAX_USAGE_FILES)) {
    const text = read(join(dir, f), MAX_USAGE_FILE_BYTES);
    const j = text === null ? null : parseJsonBounded(text, 4000, 12);
    if (!j || typeof j !== "object") continue;
    const key = uiString(f.replace(/\.json$/, ""), 32);
    if (key) out[key] = normalizeUsage(j);
  }
  return out;
}

// ---------------------------------------------------------------- main
export function frameSnapshot(value: unknown): string {
  // sanitizeForUi caps depth at 12 and every collection, so an input that
  // passed its own bounds but sits deeper inside the snapshot (a 22-level
  // object smuggled in as a pid) can no longer trip the budget check into
  // replacing the whole desk with an error frame.
  const sanitized = sanitizeForUi(value);
  if (!structureWithinBudget(sanitized, MAX_JSON_NODES, MAX_JSON_DEPTH)) throw new Error("snapshot structure exceeded budget");
  const payload = JSON.stringify(sanitized);
  if (Buffer.byteLength(payload, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("snapshot exceeded byte budget");
  const lines: string[] = [];
  for (let offset = 0; offset < payload.length; offset += OUTPUT_FRAME_CHARS) {
    lines.push(JSON.stringify({ v: 1, type: "chunk", data: payload.slice(offset, offset + OUTPUT_FRAME_CHARS) }));
  }
  lines.push(JSON.stringify({ v: 1, type: "end", chars: payload.length }));
  return lines.join("\n") + "\n";
}

function protocolError(message: string): string {
  return JSON.stringify({ v: 1, type: "error", message: uiString(message, 160) }) + "\n";
}

function demoSnapshot(stamp = Date.now()) {
  const dayStarts = localDayStarts(stamp, 7);
  const cells = Array.from({ length: 168 }, (_, index) => {
    const hour = index % 24;
    const day = Math.floor(index / 24);
    const n = ((hour + day * 3) % 11 === 0) ? 7 : ((hour + day) % 5 === 0 ? 3 : (hour > 8 && hour < 19 ? 1 : 0));
    return [n, n ? (index % 3 === 0 ? { claude: n } : index % 3 === 1 ? { codex: n } : { opencode: n }) : {}];
  });
  const sessions = [
    {
      provider: "codex", pid: 42421, cwd: "~/Code/atlas", project: "atlas", startedAt: stamp - 38 * 60_000,
      uptimeSec: 38 * 60, session: "demo-codex-session", sessionIds: ["demo-codex-session"], busy: true,
      topic: "Hardening atomic state persistence", topicAt: stamp - 90_000,
      window: { address: "0xd001", title: "Implementing bounded snapshot transport", class: "com.mitchellh.ghostty", workspace: 2 },
      resources: { cpuPct: 18.4, rss: 912_261_120, processes: 7, gpuMemory: null },
      repoRoot: "~/Code/atlas", git: { branch: "release/dashboard", dirty: 4, staged: 1, untracked: 1, files: ["collector.ts", "InfoView.qml", "tests/dashboard.test.ts", "README.md"], ahead: 2, behind: 0, conflicts: 0 }, attention: "",
      attentionReason: "", attentionAction: "", attentionDetail: "",
      hosts: [{ kind: "tmux", label: "tmux build:2.0", session: "build", window: "2", pane: "0", paneId: "%4", attached: true }],
      changes: { fingerprint: "atlas-demo-2", count: 4, staged: 1, untracked: 1, files: ["collector.ts", "InfoView.qml", "tests/dashboard.test.ts", "README.md"], testFiles: 1, additions: 186, deletions: 24, head: "a11a5d00", headShort: "a11a5d0", commitSubject: "feat: add operations intelligence", committedAt: stamp - 12 * 60_000 },
      ci: { state: "in_progress", name: "test", headSha: "a11a5d00", updatedAt: new Date(stamp - 2 * 60_000).toISOString(), checkedAt: stamp },
    },
    {
      provider: "claude", pid: 42463, cwd: "~/Code/orbit", project: "orbit", startedAt: stamp - 74 * 60_000,
      uptimeSec: 74 * 60, session: "demo-claude-session", sessionIds: ["demo-claude-session"], busy: false,
      topic: "Reviewing plugin submission checks", topicAt: stamp - 4 * 60_000,
      window: { address: "0xd002", title: "Waiting for marketplace review", class: "kitty", workspace: 4 },
      resources: { cpuPct: 2.1, rss: 604_241_920, processes: 5, gpuMemory: null },
      repoRoot: "~/Code/orbit", git: { branch: "main", dirty: 0, staged: 0, untracked: 0, files: [], ahead: 0, behind: 0, conflicts: 0 }, attention: "waiting",
      attentionReason: "waiting for your permission", attentionAction: "answer", attentionDetail: "Waiting for marketplace review approval",
      hosts: [{ kind: "boomux", label: "Boomux release / reviewer", workspace: "release", shell: "reviewer", shellId: "demo-boomux-shell", runId: "demo-boomux-run" }],
      changes: { fingerprint: "orbit-demo-1", count: 0, staged: 0, untracked: 0, files: [], testFiles: 0, additions: 0, deletions: 0, head: "0b17cafe", headShort: "0b17caf", commitSubject: "security: pass marketplace review", committedAt: stamp - 48 * 60_000 },
      ci: { state: "success", name: "validate", headSha: "0b17cafe", updatedAt: new Date(stamp - 44 * 60_000).toISOString(), checkedAt: stamp },
    },
    {
      provider: "opencode", pid: 42511, cwd: "~/Code/beacon", project: "beacon", startedAt: stamp - 16 * 60_000,
      uptimeSec: 16 * 60, session: "demo-opencode-session", sessionIds: ["demo-opencode-session"], busy: true,
      topic: "Building interactive model controls", topicAt: stamp - 45_000,
      window: { address: "0xd003", title: "Local AI model controls", class: "Alacritty", workspace: 6 },
      resources: { cpuPct: 9.7, rss: 486_539_264, processes: 4, gpuMemory: 1_288_490_188 },
      repoRoot: "~/Code/beacon", git: { branch: "feat/local-ai", dirty: 2, staged: 0, untracked: 1, files: ["LocalAi.qml", "local-ai.test.ts"], ahead: 1, behind: 0, conflicts: 0 }, attention: "",
      attentionReason: "", attentionAction: "", attentionDetail: "",
      hosts: [{ kind: "herdr", label: "Herdr w2 / w2:t3 / w2:p7", workspaceId: "w2", tabId: "w2:t3", paneId: "w2:p7" }],
      changes: { fingerprint: "beacon-demo-3", count: 2, staged: 0, untracked: 1, files: ["LocalAi.qml", "local-ai.test.ts"], testFiles: 1, additions: 94, deletions: 8, head: "bea00ace", headShort: "bea00ac", commitSubject: "feat: control local models", committedAt: stamp - 35 * 60_000 },
      ci: { state: "failure", name: "qml-check", headSha: "bea00ace", updatedAt: new Date(stamp - 8 * 60_000).toISOString(), checkedAt: stamp },
    },
  ];
  const promptSeeds = [
    ["codex", "atlas", "Verify atomic state writes and output limits", "demo-codex-session"],
    ["claude", "orbit", "Review the marketplace submission checklist", "demo-claude-session"],
    ["opencode", "beacon", "Add selectable local model controls", "demo-opencode-session"],
    ["codex", "atlas", "Make activity details follow the pointer", "closed-demo-session"],
    ["claude", "orbit", "Audit desktop layout at 1920 by 1080", "closed-demo-session-2"],
    ["opencode", "beacon", "Test prompt search and smooth scrolling", "closed-demo-session-3"],
    ["codex", "atlas", "Summarize each live session topic", "demo-codex-session"],
    ["claude", "orbit", "Keep every dashboard module removable", "demo-claude-session"],
    ["opencode", "beacon", "Persist the right column card order", "demo-opencode-session"],
    ["codex", "atlas", "Show cached external connectivity data", "closed-demo-session-4"],
  ];
  const recent = promptSeeds.map((entry, index) => ({
    provider: entry[0], project: `~/Code/${entry[1]}`, text: entry[2], session: entry[3], ts: stamp - index * 7 * 60_000,
    activityCell: activityCellIndex(stamp - index * 7 * 60_000, dayStarts),
    live: index < 3 || index === 6 || index === 7 || index === 8,
    window: index % 3 === 0 ? { address: "0xd001", workspace: 2 } : index % 3 === 1 ? { address: "0xd002", workspace: 4 } : { address: "0xd003", workspace: 6 },
  }));
  return {
    ts: stamp, hyprLua: true, host: "omarchy-demo", user: "alex",
    machine: {
      cpu: { pct: 27.4, load: [1.18, 0.92, 0.76], cores: 16 },
      mem: { total: 34_359_738_368, used: 15_246_073_856, pct: 44.4, swapTotal: 8_589_934_592, swapUsed: 0 },
      disks: [{ mount: "/", size: 1_999_844_147_200, used: 816_043_786_240, avail: 1_183_800_360_960, pct: 40.8 }],
      net: { dev: "wlan0", wireless: true, ssid: "Omarchy Lab", signal: -47, addr: "192.0.2.15", rxRate: 2_420_000, txRate: 386_000 },
      ping: { host: "1.1.1.1", label: "cloudflare", ms: 18.6, ok: true }, battery: null,
      gpu: { name: "NVIDIA RTX 4070", util: 31, memUsed: 3_006_477_312, memTotal: 12_884_901_888, temp: 49 },
      temp: 52, uptime: 186_300, externalIp: "203.0.113.42",
    },
    ai: {
      sessions, projects: projectHealth(sessions), workspaces: workspaceGroups(sessions), attention: [sessions[1]], collisions: [],
      counts: { claude: { today: 18, week: 96, total: 640 }, codex: { today: 27, week: 144, total: 1102 }, opencode: { today: 11, week: 51, total: 214 } },
      providers: {
        claude: { present: true, prompts: 640 }, codex: { present: true, prompts: 1102, threadCount: 37 },
        grok: { present: true, sessions: 9 }, opencode: { present: true, prompts: 214, sessions: 12 },
        ollama: { present: true, up: true, loaded: [{ name: "qwen3:8b", vram: 6_442_450_944 }], models: [
          { name: "qwen3:8b", size: 5_200_000_000, parameterSize: "8.2B", quantization: "Q4_K_M" },
          { name: "gemma3:4b", size: 3_300_000_000, parameterSize: "4.3B", quantization: "Q4_K_M" },
        ], modelCount: 2 },
      },
      usage: {
        claude: { name: "Claude", ready: true, tierLabel: "Max", todayPrompts: 18, todayTotalTokens: 184_000, limits: [{ label: "SESSION", percent: 0.46, resetsAt: new Date(stamp + 2.1 * 3600_000).toISOString() }, { label: "WEEKLY", percent: 0.61, resetsAt: new Date(stamp + 3.4 * 86400_000).toISOString() }] },
        codex: { name: "Codex", ready: true, tierLabel: "Pro", todayPrompts: 27, todayTotalTokens: 311_000, limits: [{ label: "5-HOUR", percent: 0.38, resetsAt: new Date(stamp + 3.2 * 3600_000).toISOString() }, { label: "7-DAY", percent: 0.54, resetsAt: new Date(stamp + 4.2 * 86400_000).toISOString() }] },
      },
      heatmap: { start: dayStarts[0], days: dayStarts, cells }, recent, recentTruncated: false,
    },
  };
}

async function runCollector() {
  if (process.argv.includes("--demo")) {
    await emit(frameSnapshot(demoSnapshot()));
    return;
  }
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
  const notificationState = deriveNotificationEvents(prev.sessionNotifications, sessions);
  const linkedRecent = linkRecentToLive(recent, sessions);
  const weekRecentCount = linkedRecent.filter(entry => entry.activityCell >= 0).length;
  // Default view still shows 40. Keep enough week rows in the snapshot for
  // heatmap drill-down without allowing an unbounded history payload.
  const dashboardRecent = linkedRecent.slice(0, Math.max(40, Math.min(1000, weekRecentCount)));
  const recentTruncated = linkedRecent.length > dashboardRecent.length;

  // Hyprland >= 0.56 takes Lua in `hyprctl dispatch`; older takes "dispatcher arg".
  let hyprLua = false;
  try { const v = parseJsonBounded(await run(["hyprctl", "version", "-j"], 800), 2048, 12) || {}; const m = String(v.tag || v.version || "").match(/(\d+)\.(\d+)/); hyprLua = !!m && (+m[1] > 0 || +m[2] >= 56); } catch {}

  const snapshot = {
    ts: now, hyprLua, host: (read("/etc/hostname") || "").trim() || null, user: process.env.USER || null,
    machine: {
      cpu: { pct: cpuS.pct, load: cpuS.load, cores: cpuS.cores }, mem: memS, disks: diskS, net: netS, ping: pingS,
      battery: battery(), gpu: gpuS, temp: temp(), uptime: uptime(), externalIp: externalIpS.address,
    },
    ai: {
      sessions,
      projects: projectHealth(sessions),
      workspaces: workspaceGroups(sessions),
      attention: sessions.filter((s: any) => s.attention),
      events: notificationState.events,
      collisions: repoCollisions(sessions),
      counts, providers: { claude, codex, grok, opencode, ollama }, usage: agentsUsage(),
      heatmap: { start: start7, days: heatDays, cells: heat.map(c => [c.n, c.p]) },
      recent: dashboardRecent, recentTruncated,
    },
  };

  try {
    writePrivateStateFile(STATE_DIR, basename(PREV_FILE), JSON.stringify({
      ts: now,
      cpu: { ...cpuS._raw, pct: cpuS.pct },
      net: { dev: netS.dev, rx: netS.rx, tx: netS.tx, rxRate: netS.rxRate, txRate: netS.txRate },
      agents: currentAgentRaw,
      externalIp: externalIpS,
      topicSummaries,
      ciByRepo: currentCiByRepo,
      opencodeTotals: currentOpencodeTotals,
      sessionNotifications: notificationState.tracked,
    }));
  } catch {}
  await emit(frameSnapshot(snapshot));
}

// process.stdout.write() is asynchronous in Bun. Exiting right after it
// truncated pipes at exactly 128 KiB and wrote nothing at all to a file
// (measured 2026-09-04). Bun.write() resolves only once the bytes are handed
// to the fd, so it is the only safe way to combine output with process.exit.
async function emit(text: string): Promise<void> {
  await Bun.write(Bun.stdout, text);
}
if (import.meta.main) {
  try { await runCollector(); }
  catch { try { await emit(protocolError("collector failed safely")); } catch {} }
  // Orphaned grandchildren of killed tools can hold our pipes open; a pending
  // read on one keeps Bun alive indefinitely. The frame is written — leave.
  process.exit(0);
}
