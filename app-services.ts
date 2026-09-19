#!/usr/bin/env bun
/** Optional local development services. No daemon, app-repo edits or agent dependency. */
import { constants, openSync, closeSync, fstatSync, readSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync, statSync, realpathSync, readlinkSync, symlinkSync, existsSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type App = { id: string; name: string; path: string; port: number; unit: string; command: string[]; healthPath: string; category?: string; url: string; logPath: string };
export type Listener = { pid: number | null; name: string; path: string };
export type AppStatus = Pick<App, "id" | "name" | "path" | "port" | "unit" | "url" | "logPath"> & {
  state: string; ready: boolean; active: boolean; pid: number; portListening: boolean;
  branch: string; changes: number; conflicts: Listener[]; autostart: boolean; detail: string;
};
export type Paths = { registry: string; logs: string; units: string; locks: string; bin: string; home: string };
export const MARKER = "# Managed by Infomarchy Apps\n";
export const SCRIPT = realpathSync(fileURLToPath(import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNIT = /^[a-z0-9][a-z0-9-]{0,100}\.service$/;
const CONTROL = /[\x00-\x1f\x7f]/;
export class AppError extends Error {}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

export function paths(env = process.env): Paths {
  const home = env.HOME || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    home, registry: env.INFOMARCHY_APPS_REGISTRY || join(config, "infomarchy/apps.json"),
    logs: join(env.XDG_STATE_HOME || join(home, ".local/state"), "infomarchy/apps/logs"),
    units: join(config, "systemd/user"), bin: join(home, ".local/bin"),
    locks: join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`, "infomarchy-apps"),
  };
}
export function appPath(value: string, home = homedir()): string {
  const expanded = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new AppError("Project folder must be an absolute path or start with ~/");
  try { return realpathSync(expanded); } catch { return resolve(expanded); }
}
/** Quoting only: no substitutions, environment assignments, pipes or shell evaluation. */
export function parseCommand(input: string): string[] {
  if (input.length > 16384 || CONTROL.test(input)) throw new AppError("Invalid command");
  const words: string[] = []; let word = "", quote = "", started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && ['"', "\\", "$", "`"].includes(input[i + 1])) word += input[++i];
      else word += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (c === "\\") { if (++i === input.length) throw new AppError("Trailing command escape"); word += input[i]; started = true; }
    else if (/\s/.test(c)) { if (started) { words.push(word); word = ""; started = false; } }
    else { if (/[;&|<>`$()]/.test(c)) throw new AppError("Use a single command; shell operators and expansion are not supported"); word += c; started = true; }
  }
  if (quote) throw new AppError("Unclosed command quote");
  if (started) words.push(word);
  if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) throw new AppError("Use an executable command (env KEY=value command for environment overrides)");
  return words;
}
export function validateApps(value: unknown, p = paths()): App[] {
  if (!Array.isArray(value) || value.length > 256) throw new AppError("Registry must be a list of at most 256 apps");
  const ids = new Set(), ports = new Set(), units = new Set(), folders = new Set();
  return value.map(row => {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.unit !== "string" || !ID.test(row.id) || !UNIT.test(row.unit)) throw new AppError("Invalid app ID or unit");
    for (const key of ["name", "path"]) if (typeof row[key] !== "string" || !row[key].trim() || row[key].length > 4096 || CONTROL.test(row[key])) throw new AppError(`Invalid app ${key}`);
    if (!Number.isInteger(row.port) || row.port < 1024 || row.port > 65535) throw new AppError("Port must be an integer between 1024 and 65535");
    const folder = appPath(row.path, p.home), healthPath = row.healthPath ?? "/";
    if (typeof healthPath !== "string" || !healthPath.startsWith("/") || healthPath.length > 2048 || CONTROL.test(healthPath)) throw new AppError("Health path must begin with /");
    if (!Array.isArray(row.command) || !row.command.length || row.command.length > 128 || row.command.some((v: unknown) => typeof v !== "string" || v.length > 16384 || CONTROL.test(v)) || !row.command[0]) throw new AppError("Command must be an executable argument array");
    if (ids.has(row.id) || ports.has(row.port) || units.has(row.unit) || folders.has(folder)) throw new AppError("Duplicate app ID, port, unit or folder");
    ids.add(row.id); ports.add(row.port); units.add(row.unit); folders.add(folder);
    return { id: row.id, name: row.name, path: folder, port: row.port, unit: row.unit, command: [...row.command], healthPath,
      ...(typeof row.category === "string" ? { category: row.category } : {}), url: `http://localhost:${row.port}`, logPath: join(p.logs, `${row.id}.log`) };
  });
}
export function readSmallFile(file: string, limit = 1024 * 1024): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new AppError(`Expected a regular file of at most ${limit} bytes: ${file}`);
    const data = Buffer.alloc(limit + 1); let count = 0, n;
    while (count <= limit && (n = readSync(fd, data, count, data.length - count, null)) > 0) count += n;
    if (count > limit) throw new AppError(`File grew beyond its size limit: ${file}`);
    return data.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}
export function registry(p = paths()): App[] {
  try { return validateApps(JSON.parse(readSmallFile(p.registry)), p); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" && !process.env.INFOMARCHY_APPS_REGISTRY) return []; throw e; }
}
export function atomicWrite(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { writeFileSync(temporary, value, { flag: "wx", mode: 0o600 }); renameSync(temporary, file); }
  finally { try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
}
export function saveRegistry(rows: App[], p = paths()): void {
  const saved = validateApps(rows, p).map(({ url, logPath, ...row }) => row);
  atomicWrite(p.registry, JSON.stringify(saved, null, 2) + "\n");
}
export type CommandResult = { code: number; stdout: string; stderr: string };
export function run(args: string[], options: { check?: boolean; cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}): CommandResult {
  const child = Bun.spawnSync(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: options.cwd,
    env: options.env || process.env, timeout: options.timeout ?? 8000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  if (child.signalCode) throw new AppError(`${args[0]} timed out or was interrupted`);
  const result = { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  if (options.check !== false && result.code) throw new AppError(result.stderr.trim() || result.stdout.trim() || `${args[0]} failed`);
  return result;
}
export function git(cwd: string, args: string[]): string {
  return run(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, check: false, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).stdout.trim();
}
export function unitInfo(app: App): Record<string, string> {
  const fields = "LoadState,ActiveState,SubState,MainPID,ControlGroup,WorkingDirectory,UnitFileState,Result,ExecMainStatus";
  const result = run(["systemctl", "--user", "show", app.unit, `--property=${fields}`], { check: false });
  const info = Object.fromEntries(result.stdout.split("\n").filter(s => s.includes("=")).map(s => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
  if (result.code && info.LoadState !== "not-found") throw new AppError(result.stderr.trim() || "Cannot inspect user service");
  return info;
}
export function parseListeners(text: string): Listener[] {
  return text.trim().split("\n").filter(Boolean).flatMap<Listener>(line => {
    const pids = [...new Set([...line.matchAll(/pid=(\d+)/g)].map(m => Number(m[1])))];
    if (!pids.length) return [{ pid: null, name: "unidentified listener", path: "" }];
    return pids.map(pid => {
      try { return { pid, name: readFileSync(`/proc/${pid}/comm`, "utf8").trim(), path: readlinkSync(`/proc/${pid}/cwd`) }; }
      catch { return { pid, name: "process", path: "" }; }
    });
  });
}
export function listeners(port: number): Listener[] { return parseListeners(run(["ss", "-H", "-ltnp", `sport = :${port}`]).stdout); }
export function owns(pid: number | null, group?: string): boolean {
  if (!pid || !group || group === "/" || !group.startsWith("/")) return false;
  try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").some(line => { const value = line.split(":").slice(2).join(":"); return value === group || value.startsWith(group + "/"); }); }
  catch { return false; }
}
export async function healthy(app: App): Promise<boolean> {
  try {
    // Do not follow a login redirect or download a response body to prove readiness.
    const response = await fetch(`http://127.0.0.1:${app.port}${app.healthPath}`, { redirect: "manual", signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 500;
  } catch { return false; }
}
export const conflictMessage = (app: { port: number; conflicts: Listener[] }) =>
  `Port ${app.port} is occupied by ${app.conflicts.map(p => `${p.name} (PID ${p.pid || "?"}, ${p.path || "unknown directory"})`).join(", ")}. Inspect that process; Infomarchy Apps will not stop it or change ports.`;

// Dependency injection keeps process/state tests isolated from the real user services.
export type Runtime = { run: typeof run; unitInfo: typeof unitInfo; listeners: typeof listeners; owns: typeof owns; healthy: typeof healthy; git: typeof git };
const runtime: Runtime = { run, unitInfo, listeners, owns, healthy, git };
export class AppServices {
  constructor(readonly p = paths(), readonly io: Runtime = runtime) {}
  async status(app: App, probe = true): Promise<AppStatus> {
    const info = this.io.unitInfo(app), bound = this.io.listeners(app.port);
    const conflicts = bound.filter(p => !this.io.owns(p.pid, info.ControlGroup));
    const active = ["active", "activating", "reloading"].includes(info.ActiveState);
    const ready = active && !!bound.length && !conflicts.length && (!probe || await this.io.healthy(app));
    const state = conflicts.length ? "conflict" : info.LoadState === "not-found" ? "not-installed" : ready ? "running" : active ? (bound.length ? "unhealthy" : "starting") : info.ActiveState === "failed" ? "failed" : "stopped";
    const entries = this.io.git(app.path, ["status", "--porcelain=v1", "--branch", "-z"]).split("\0");
    const branch = entries[0]?.startsWith("## ") ? entries[0].slice(3).split("...")[0] : "not a Git repo";
    let changes = 0;
    for (let i = 1; i < entries.length && entries[i]; i += /[RC]/.test(entries[i].slice(0, 2)) ? 2 : 1) changes++;
    const detail = conflicts.length ? conflictMessage({ ...app, conflicts }) : !existsSync(app.path) ? `Project folder is missing: ${app.path}` : state === "not-installed" ? "Service is not installed. Run infomarchy-apps install." : state === "failed" ? `Service failed: ${info.Result || "unknown"} (exit ${info.ExecMainStatus || "?"}). Open Logs for details.` : state === "unhealthy" ? "App is listening, but its HTTP check failed. Open Logs for details." : state === "starting" ? "Waiting for the app to listen on its assigned port." : "";
    return { id: app.id, name: app.name, path: app.path, port: app.port, unit: app.unit, url: app.url, logPath: app.logPath, state, ready, active, pid: Number(info.MainPID || 0), portListening: !!bound.length, branch, changes, conflicts, autostart: ["enabled", "enabled-runtime"].includes(info.UnitFileState), detail };
  }
  async displayStatus(app: App): Promise<AppStatus> {
    try { return await this.status(app); }
    catch (e) { return { id: app.id, name: app.name, path: app.path, port: app.port, unit: app.unit, url: app.url, logPath: app.logPath, state: "unavailable", ready: false, active: false, pid: 0, portListening: false, branch: "unknown", changes: 0, conflicts: [], autostart: false, detail: message(e) }; }
  }
  checkWorktree(app: App, cwd = process.cwd()): void {
    const current = this.io.git(cwd, ["rev-parse", "--show-toplevel"]), managed = this.io.git(app.path, ["rev-parse", "--show-toplevel"]);
    if (current && managed && resolve(current) !== resolve(managed)) {
      const a = this.io.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), b = this.io.git(app.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (a && b && resolve(a) === resolve(b)) throw new AppError(`This is another worktree. ${app.url} serves ${app.path}. Register this checkout with a distinct port; use --shared only to select the original checkout.`);
    }
  }
  async ensure(app: App, timeout = 90000): Promise<AppStatus> {
    const before = await this.status(app, false);
    if (before.conflicts.length) throw new AppError(conflictMessage(before));
    const info = this.io.unitInfo(app);
    if (info.LoadState === "not-found") throw new AppError("Service is not installed. Run infomarchy-apps install first.");
    if (info.WorkingDirectory !== app.path) throw new AppError("Service folder differs from the registry; reinstall before starting.");
    this.io.run(["systemctl", "--user", "start", app.unit], { timeout: 30000 });
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await this.status(app);
      if (state.conflicts.length) throw new AppError(conflictMessage(state));
      if (state.ready) return state;
      if (!state.active || Date.now() >= deadline) throw new AppError(`${app.name} did not become ready. Run infomarchy-apps logs ${app.id}.`);
      await Bun.sleep(500);
    }
  }
  install(rows: App[]): void {
    for (const app of rows) {
      const file = join(this.p.units, app.unit);
      let present = false;
      try { lstatSync(file); present = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (present && !readSmallFile(file).startsWith(MARKER)) throw new AppError(`Refusing to replace unmanaged unit: ${app.unit}`);
      if (!statSync(app.path).isDirectory()) throw new AppError(`Missing checkout: ${app.path}`);
    }
    mkdirSync(this.p.logs, { recursive: true, mode: 0o700 });
    for (const app of rows) atomicWrite(join(this.p.units, app.unit), unitText(app, this.p));
    this.io.run(["systemctl", "--user", "daemon-reload"]);
  }
  async register(payload: any): Promise<App> {
    return withLock("@registry", this.p, async () => {
      const rows = registry(this.p), command = typeof payload?.command === "string" ? parseCommand(payload.command) : payload?.command;
      const app = validateApps([...rows, { ...payload, unit: `infomarchy-app-${payload?.id}.service`, command }], this.p).at(-1)!;
      this.install([app]); // Publish only after unit validation/install succeeds. Nothing starts.
      saveRegistry([...rows, app], this.p);
      return app;
    });
  }
  async installRegistered(setup = false): Promise<void> {
    await withLock("@registry", this.p, async () => {
      const rows = registry(this.p);
      if (setup) checkCliLink(this.p);
      await withAppLocks(rows, this.p, async () => { this.install(rows); saveRegistry(rows, this.p); if (setup) installCli(this.p); });
    });
  }
  async action(action: string, id: string, shared = false): Promise<AppStatus> {
    return withLock(id, this.p, async () => {
      const app = registry(this.p).find(a => a.id === id);
      if (!app) throw new AppError(`Unknown app: ${id}`);
      if (["ensure", "start", "restart", "open"].includes(action) && !shared) this.checkWorktree(app);
      if (["ensure", "start", "open"].includes(action)) return this.ensure(app);
      if (this.io.unitInfo(app).WorkingDirectory !== app.path) throw new AppError("Unit does not belong to this checkout; refusing to change it.");
      if (["stop", "restart"].includes(action)) {
        this.io.run(["systemctl", "--user", "stop", app.unit], { timeout: 30000 });
        return action === "restart" ? this.ensure(app) : this.status(app);
      }
      if (["enable", "disable"].includes(action)) { this.io.run(["systemctl", "--user", action, app.unit]); return this.status(app); }
      throw new AppError(`Unsupported action: ${action}`);
    });
  }
}
/** flock owns the lock. EOF on this private pipe releases it even if the caller dies.
 * The fixed helper does no app work, and never inherits the lock into a service. */
export async function withLock<T>(id: string, p: Paths, body: () => Promise<T>): Promise<T> {
  if (id !== "@registry" && !ID.test(id)) throw new AppError("Invalid lock ID");
  mkdirSync(p.locks, { recursive: true, mode: 0o700 });
  const file = join(p.locks, id === "@registry" ? "_registry.lock" : `${id}.lock`);
  const holder = Bun.spawn(["flock", "--exclusive", "--timeout", "120", "--conflict-exit-code", "75", "--close", file,
    process.execPath, "--eval", 'process.stdout.write("locked\\n"); await Bun.stdin.text();'], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const reader = holder.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    if (first.done || new TextDecoder().decode(first.value) !== "locked\n") throw new AppError((await new Response(holder.stderr).text()).trim() || "Another app action is still running; try again shortly.");
    return await body();
  } finally { holder.stdin.end(); await holder.exited; }
}
async function withAppLocks<T>(rows: App[], p: Paths, body: () => Promise<T>): Promise<T> {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const next = (index: number): Promise<T> => index === sorted.length ? body() : withLock(sorted[index].id, p, () => next(index + 1));
  return next(0);
}
export function unitQuote(value: string, command = false): string {
  if (CONTROL.test(value)) throw new AppError("Control characters are not allowed in unit values");
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", command ? "$$" : "$") + '"';
}
export function unitText(app: App, p = paths()): string {
  return `${MARKER}[Unit]\nDescription=${app.name.replaceAll("%", "%%")} (Infomarchy Apps)\nStartLimitIntervalSec=30\nStartLimitBurst=3\n\n[Service]\nType=exec\nWorkingDirectory=${app.path.replaceAll("%", "%%")}\nExecStart=${unitQuote(process.execPath, true)} ${unitQuote(SCRIPT, true)} _run ${app.id}\nEnvironment=NODE_ENV=development PORT=${app.port}\nEnvironment=${unitQuote("INFOMARCHY_APPS_REGISTRY=" + p.registry)}\nEnvironment=${unitQuote("PATH=" + p.bin + ":/usr/local/bin:/usr/bin")}\nRestart=on-failure\nRestartSec=3\nRestartPreventExitStatus=78\nKillMode=control-group\nTimeoutStopSec=20\nStandardOutput=append:${app.logPath.replaceAll("%", "%%")}\nStandardError=append:${app.logPath.replaceAll("%", "%%")}\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
export function logs(app: App, lines = 100): string {
  let fd: number;
  try { fd = openSync(app.logPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "No application logs yet."; throw e; }
  try {
    const stat = fstatSync(fd); if (!stat.isFile()) throw new AppError("App log is not a regular file");
    const data = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    const count = readSync(fd, data, 0, data.length, Math.max(0, stat.size - data.length));
    return data.subarray(0, count).toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/).slice(-lines).join("\n")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  } finally { closeSync(fd); }
}
const launcher = () => join(dirname(SCRIPT), "infomarchy-apps");
export function checkCliLink(p = paths()): void {
  const file = join(p.bin, "infomarchy-apps");
  try { if (!lstatSync(file).isSymbolicLink() || resolve(dirname(file), readlinkSync(file)) !== launcher()) throw new AppError(`Refusing to replace unrelated command: ${file}`); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}
function installCli(p = paths()): void {
  checkCliLink(p); mkdirSync(p.bin, { recursive: true });
  const file = join(p.bin, "infomarchy-apps");
  if (!existsSync(file)) symlinkSync(launcher(), file);
}
function serve(app: App): never {
  const conflicts = listeners(app.port);
  if (conflicts.length) throw new AppError(conflictMessage({ ...app, conflicts }));
  const executable = Bun.which(app.command[0], { cwd: app.path });
  if (!executable) throw new AppError(`Executable not found: ${app.command[0]}`);
  if (typeof process.execve !== "function") throw new AppError("Infomarchy Apps requires Bun with process.execve support (tested on Bun 1.4)");
  process.chdir(app.path);
  // Replace the Bun runner: systemd tracks the real app and no helper stays resident.
  process.execve(executable, [executable, ...app.command.slice(1)], { ...process.env, PORT: String(app.port), NODE_ENV: "development" } as Record<string, string>);
  throw new AppError("App process could not be started");
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const json = args.includes("--json"), shared = args.includes("--shared");
  const plain = args.filter(a => a !== "--json" && a !== "--shared");
  const [action, id, setting] = plain, manager = new AppServices();
  let result: any;
  try {
    if ([undefined, "--help", "help"].includes(action)) {
      console.log("infomarchy-apps setup | register --registration JSON | registry | status [id] | ensure|start|stop|restart|open|logs <id> | autostart <id> on|off | install\nOptions: --json, --shared (explicitly use the registered checkout)"); return;
    }
    if (action === "register") {
      if (id !== "--registration" || !setting || plain.length !== 3) throw new AppError("Use register --registration JSON");
      const app = await manager.register(JSON.parse(setting)); result = { ok: true, message: `Registered ${app.name}. Start it when ready; its command must honor port ${app.port}.` };
    } else if (["setup", "install"].includes(action)) {
      if (plain.length !== 1) throw new AppError(`Use ${action} without an app ID`);
      await manager.installRegistered(action === "setup"); result = { ok: true, message: "Installed app services. Existing processes and login startup settings are unchanged." };
    } else {
      const rows = registry(), app = rows.find(a => a.id === id);
      if (id && !app) throw new AppError(`Unknown app: ${id}`);
      if (action === "registry") result = { ok: true, services: rows, registry: manager.p.registry };
      else if (action === "status") {
        const selected = app ? [app] : rows, states: AppStatus[] = [];
        for (let i = 0; i < selected.length; i += 4) states.push(...await Promise.all(selected.slice(i, i + 4).map(a => manager.displayStatus(a))));
        result = { ok: true, services: states };
      } else {
        if (!app) throw new AppError("This command requires an app ID");
        if (action === "_run") serve(app);
        if (action === "logs") result = { ok: true, log: logs(app) };
        else {
          if (action === "autostart" && !["on", "off"].includes(setting)) throw new AppError("Use autostart <id> on|off");
          const state = await manager.action(action === "autostart" ? (setting === "on" ? "enable" : "disable") : action, app.id, shared);
          result = { ok: true, status: state, message: `${app.name}: ${state.state} · ${app.url}` };
          if (action === "open") Bun.spawn(["xdg-open", app.url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
        }
      }
    }
    if (json || action === "registry") console.log(JSON.stringify(result));
    else if (result.services) for (const s of result.services) console.log(`${s.id.padEnd(24)} ${s.state.padEnd(14)} ${s.url}  ${s.branch}${s.detail ? "\n  " + s.detail : ""}`);
    else console.log(result.log ?? result.message);
  } catch (e) {
    if (json) console.log(JSON.stringify({ ok: false, error: message(e) })); else console.error(message(e));
    process.exitCode = action === "_run" ? 78 : 1;
  }
}
if (import.meta.main) await main();
