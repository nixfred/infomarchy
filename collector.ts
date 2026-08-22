#!/usr/bin/env bun
// Desk collector — one JSON snapshot of "what is AI doing on this machine"
// plus the boring machine stats. Runs under bun, prints JSON to stdout.
// Never hardcodes a user, host or home path: everything derives from $HOME,
// XDG_*, /proc and /sys. Missing tools/dirs degrade to nulls, never crash.

import { readdirSync, readFileSync, statSync, existsSync, readlinkSync, mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";

const HOME = process.env.HOME || "/root";
const XDG_STATE = process.env.XDG_STATE_HOME || join(HOME, ".local/state");
const STATE_DIR = join(XDG_STATE, "omarchy-desk");
const PREV_FILE = join(STATE_DIR, "prev.json");
const now = Date.now();

// ---------------------------------------------------------------- helpers
function read(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }
function readJson(p: string): any { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }
function ls(p: string): string[] { try { return readdirSync(p); } catch { return []; } }
function mtime(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }
async function run(cmd: string[], timeoutMs = 1500): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(t);
    return out;
  } catch { return ""; }
}
async function fetchJson(url: string, ms = 600): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const prev = readJson(PREV_FILE) || {};
const dt = prev.ts ? (now - prev.ts) / 1000 : 0;

// ---------------------------------------------------------------- machine
function cpu() {
  const line = (read("/proc/stat") || "").split("\n")[0].split(/\s+/).slice(1).map(Number);
  const idle = line[3] + line[4], total = line.reduce((a, b) => a + b, 0);
  let pct: number | null = null;
  if (prev.cpu && total > prev.cpu.total) {
    pct = 100 * (1 - (idle - prev.cpu.idle) / (total - prev.cpu.total));
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
  if (prev.net && prev.net.dev === dev && dt > 0) {
    rxRate = Math.max(0, (rx - prev.net.rx) / dt); txRate = Math.max(0, (tx - prev.net.tx) / dt);
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
function providerOf(cmd: string[]): string | null {
  for (const arg of cmd.slice(0, 3)) {
    for (const [name, re] of PROVIDERS) if (re.test(arg)) {
      if (name === "ollama" && !(cmd[1] === "run" || cmd[1] === "runner")) return null; // only chats/runners, not the daemon
      return name;
    }
  }
  return null;
}
function shortPath(p: string) { return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p; }

async function liveSessions(pids: number[]) {
  let clients: any[] = [];
  try { clients = JSON.parse(await run(["hyprctl", "clients", "-j"], 1000)) || []; } catch {}
  const winByPid = new Map<number, any>(clients.map((c: any) => [c.pid, c]));
  const sessions: any[] = [];
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
    sessions.push({
      provider: prov, pid: p.pid, cwd: shortPath(p.cwd), project: basename(p.cwd || "") || "/",
      startedAt: p.start, uptimeSec: Math.max(0, (now - p.start) / 1000),
      window: w ? { address: w.address, title: w.title, class: w.class, workspace: w.workspace?.id ?? null } : null,
      args: p.cmd.slice(1, 4).join(" ").slice(0, 60),
    });
  }
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  return sessions;
}

// ---------------------------------------------------------------- AI history
const DAY = 86400000;
function dayKey(ts: number) { const d = new Date(ts); return d.toISOString().slice(0, 10); }
function heatmapInit() {
  // 7 days x 24 hours, local time, oldest first; each cell {total, byProvider}
  const cells: any[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) cells.push({ d, h, n: 0, p: {} as Record<string, number> });
  return cells;
}
const heat = heatmapInit();
const start7 = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() - 6 * DAY; })();
function bump(ts: number, prov: string) {
  if (ts < start7 || ts > now + 60000) return;
  const d = new Date(ts); const dayIdx = Math.floor((d.getTime() - start7) / DAY);
  if (dayIdx < 0 || dayIdx > 6) return;
  const cell = heat[dayIdx * 24 + d.getHours()]; cell.n++; cell.p[prov] = (cell.p[prov] || 0) + 1;
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
      recent.push({ provider: "claude", ts, project: shortPath(e.project || ""), text: String(e.display || "").slice(0, 140), session: e.sessionId });
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
      recent.push({ provider: "codex", ts, project: "", text: String(e.text || "").slice(0, 140), session: e.session_id });
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
  let sessions = 0;
  for (const dir of ls(join(base, "sessions"))) {
    const full = join(base, "sessions", dir);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    const project = shortPath(decodeURIComponent(dir));
    for (const f of ls(full)) {
      const ts = mtime(join(full, f)); if (!ts) continue; sessions++;
      bump(ts, "grok"); cnt("grok", ts);
      recent.push({ provider: "grok", ts, project, text: "session " + f.replace(/\.[^.]+$/, "").slice(0, 24), session: f });
    }
  }
  return { present: true, sessions, active: active.map((a: any) => ({ pid: a.pid, cwd: shortPath(a.cwd || ""), openedAt: Date.parse(a.opened_at) })) };
}
async function ollamaState() {
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const base = host.startsWith("http") ? host : "http://" + host;
  const ps = await fetchJson(base + "/api/ps"); const tags = await fetchJson(base + "/api/tags");
  if (!ps && !tags) return { present: false, up: false };
  return {
    present: true, up: true,
    loaded: (ps?.models || []).map((m: any) => ({ name: m.name, vram: m.size_vram, size: m.size, until: m.expires_at })),
    models: (tags?.models || []).map((m: any) => m.name),
    modelCount: (tags?.models || []).length,
  };
}
function agentsUsage() {
  // Omarchy's own agents plugin caches rate limits + token usage here; reuse it when present.
  const dir = join(XDG_STATE, "omarchy/agents/usage");
  const out: Record<string, any> = {};
  for (const f of ls(dir)) {
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
const pids = scanProcs();
const [cpuS, memS, diskS, netS, pingS, gpuS, sessions, ollama] = await Promise.all([
  Promise.resolve(cpu()), Promise.resolve(mem()), disk(), net(), ping(), gpu(), liveSessions(pids), ollamaState(),
]);
const claude = claudeHistory(), codex = codexHistory(), grok = grokHistory();
recent.sort((a, b) => b.ts - a.ts);

const snapshot = {
  ts: now, host: (read("/etc/hostname") || "").trim() || null, user: process.env.USER || null,
  machine: {
    cpu: { pct: cpuS.pct, load: cpuS.load, cores: cpuS.cores }, mem: memS, disks: diskS, net: netS, ping: pingS,
    battery: battery(), gpu: gpuS, temp: temp(), uptime: uptime(),
  },
  ai: {
    sessions, counts, providers: { claude, codex, grok, ollama }, usage: agentsUsage(),
    heatmap: { start: start7, cells: heat.map(c => [c.n, c.p]) }, recent: recent.slice(0, 40),
  },
};

try {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PREV_FILE, JSON.stringify({ ts: now, cpu: cpuS._raw, net: { dev: netS.dev, rx: netS.rx, tx: netS.tx } }));
} catch {}
console.log(JSON.stringify(snapshot));
