import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServices, AppError, paths, validateApps, parseCommand, parseListeners, registry, saveRegistry, withLock, logs, healthy, owns, unitText, checkCliLink, readSmallFile, git, run, SCRIPT, type Runtime } from "./app-services";
const folders: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "infomarchy-apps-test-")); folders.push(dir);
  const p = paths({ HOME: dir, XDG_RUNTIME_DIR: join(dir, "run") });
  const app = validateApps([{ id: "app", name: "Test App", path: dir, port: 4450, unit: "infomarchy-app-app.service", command: ["npm", "run", "dev"] }], p)[0];
  const calls: string[][] = [];
  const io: Runtime = { run: args => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; }, git: () => "## main\0 M app.ts\0",
    unitInfo: () => ({ LoadState: "loaded", ActiveState: "active", MainPID: "123", ControlGroup: "/owned", WorkingDirectory: app.path, UnitFileState: "disabled" }),
    listeners: () => [{ pid: 123, name: "app", path: dir }], owns: () => true, healthy: async () => true };
  return { dir, p, app, calls, io, manager: new AppServices(p, io) };
}
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("development app registry", () => {
  test("a fresh installation has no apps or machine-specific defaults", () => {
    const { p } = fixture(); expect(registry(p)).toEqual([]);
    expect(p.registry).toEndWith("/.config/infomarchy/apps.json");
  });
  test("command strings support quoting without evaluating shell text", () => {
    expect(parseCommand('env LABEL="hello world" npm run dev -- --port 4400')).toEqual(["env", "LABEL=hello world", "npm", "run", "dev", "--", "--port", "4400"]);
    expect(parseCommand("echo 'literal $HOME' \"\" a\\ b")).toEqual(["echo", "literal $HOME", "", "a b"]);
    for (const text of ['npm dev; touch /tmp/x', 'npm dev && echo ok', 'echo $(id)', 'echo `id`', 'PORT=4400 npm dev', '"unclosed']) expect(() => parseCommand(text)).toThrow();
  });
  test("rejects duplicate IDs, ports, units and resolved folders", () => {
    const { app, p, dir } = fixture(); const other = join(dir, "other"); mkdirSync(other);
    const second = { ...app, id: "second", port: 4451, unit: "infomarchy-app-second.service", path: other };
    for (const key of ["id", "port", "unit", "path"] as const) expect(() => validateApps([app, { ...second, [key]: app[key] }], p)).toThrow("Duplicate");
  });
  test("refuses malformed registry fields and unit directive injection", () => {
    const { app, p } = fixture();
    for (const row of [{ ...app, id: undefined }, { ...app, port: 4400.1 }, { ...app, port: 80 }, { ...app, path: "relative" }, { ...app, command: [] }, { ...app, name: "bad\nExecStart=x" }, { ...app, path: "/tmp/a\nRestart=no" }]) expect(() => validateApps([row], p)).toThrow();
  });
  test("registration does not start services or alter the app repo", async () => {
    const { manager, p, app, calls } = fixture();
    const registered = await manager.register({ ...app, command: 'npm run dev -- --port 4450' });
    expect(registered.command.at(-1)).toBe("4450");
    expect(registry(p).map(a => a.id)).toEqual(["app"]);
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
    expect(statSync(p.registry).mode & 0o777).toBe(0o600);
    expect(existsSync(join(app.path, "package.json"))).toBe(false);
    const saved = readFileSync(p.registry, "utf8");
    await expect(manager.register(app)).rejects.toThrow("Duplicate"); expect(readFileSync(p.registry, "utf8")).toBe(saved);
  });
  test("failed installation cannot publish a registration or overwrite an unmanaged unit", async () => {
    const { manager, p, app, calls } = fixture(); mkdirSync(p.units, { recursive: true });
    const file = join(p.units, app.unit); writeFileSync(file, "# Another tool's unit\n");
    await expect(manager.register(app)).rejects.toThrow("unmanaged");
    expect(registry(p)).toEqual([]); expect(calls).toEqual([]); expect(readFileSync(file, "utf8")).toStartWith("# Another");
  });
  test("registry and unit inspection do not follow symlinks", async () => {
    const { manager, p, app, dir } = fixture(); mkdirSync(p.units, { recursive: true });
    symlinkSync(join(dir, "missing"), join(p.units, app.unit));
    await expect(manager.register(app)).rejects.toThrow();
    const target = join(dir, "data"); writeFileSync(target, "[]"); symlinkSync(target, join(dir, "link"));
    expect(() => readSmallFile(join(dir, "link"))).toThrow();
  });
  test("setup preserves login settings and refuses an unrelated CLI", async () => {
    const { manager, p, app, calls } = fixture(); saveRegistry([app], p);
    await manager.installRegistered(true); await manager.installRegistered(true);
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "daemon-reload"]]);
    rmSync(join(p.bin, "infomarchy-apps")); writeFileSync(join(p.bin, "infomarchy-apps"), "other");
    expect(() => checkCliLink(p)).toThrow("unrelated");
  });
});

describe("ownership and readiness", () => {
  test("a foreign or unidentified listener is never healthy or killed", async () => {
    const { manager, io, app, calls } = fixture(); io.owns = () => false;
    expect((await manager.status(app)).state).toBe("conflict");
    await expect(manager.ensure(app)).rejects.toThrow("will not stop"); expect(calls).toEqual([]);
    expect(parseListeners("LISTEN 0 128 127.0.0.1:4450 0.0.0.0:*")[0].pid).toBeNull();
    expect(owns(process.pid, "/")).toBe(false);
  });
  test("inspection failures cannot be mistaken for a free port", async () => {
    const { manager, io, app, calls } = fixture(); io.listeners = () => { throw new AppError("socket inspection failed"); };
    await expect(manager.ensure(app)).rejects.toThrow("inspection failed"); expect(calls).toEqual([]);
    expect((await manager.displayStatus(app)).state).toBe("unavailable");
  });
  test("HTTP readiness is separate from having a running process", async () => {
    const { manager, io, app } = fixture(); io.healthy = async () => false;
    expect((await manager.status(app)).state).toBe("unhealthy");
    await expect(manager.ensure(app, 0)).rejects.toThrow("did not become ready");
    io.healthy = async () => true; expect((await manager.ensure(app)).ready).toBe(true);
  });
  test("readiness accepts redirects without following them and rejects 500 responses", async () => {
    const { app } = fixture(); let code = 302, requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Response("", { status: code, headers: { location: "http://127.0.0.1:1/never-follow" } }); } });
    try { expect(await healthy({ ...app, port: server.port! })).toBe(true); expect(requests).toBe(1); code = 500; expect(await healthy({ ...app, port: server.port! })).toBe(false); }
    finally { await server.stop(true); }
  });
  test("missing or mismatched units are never started or stopped", async () => {
    const { manager, io, app, p, calls } = fixture(); saveRegistry([app], p);
    io.unitInfo = () => ({ LoadState: "not-found" }); io.listeners = () => [];
    expect((await manager.status(app)).state).toBe("not-installed");
    await expect(manager.ensure(app)).rejects.toThrow("not installed");
    io.unitInfo = () => ({ WorkingDirectory: "/other" });
    await expect(manager.action("stop", app.id)).rejects.toThrow("does not belong"); expect(calls).toEqual([]);
  });
  test("unit paths and values preserve spaces, percent and dollar characters", () => {
    const { app, p } = fixture(); const unit = unitText({ ...app, name: "100% ready", path: '/tmp/space % $ "quote"', logPath: '/tmp/log % $.txt' }, p);
    expect(unit).toContain('Description=100%% ready'); expect(unit).toContain('WorkingDirectory=/tmp/space %% $ "quote"');
    expect(unit).toContain('RestartPreventExitStatus=78'); expect(unit).toContain('KillMode=control-group'); expect(unit).toContain('app-services.ts'); expect(unit).not.toContain('python');
  });
  test("log reads preserve HTTP requests and never rewrite the raw file", () => {
    const { app, p } = fixture(); mkdirSync(p.logs, { recursive: true });
    const raw = "GET /first 200\n\x1b[32mGET /redirect 302\x1b[0m\nPOST /save 201\n"; writeFileSync(app.logPath, raw);
    expect(logs(app, 2)).toBe("GET /redirect 302\nPOST /save 201"); expect(readFileSync(app.logPath, "utf8")).toBe(raw);
  });
});

describe("shared services across tasks", () => {
  test("another worktree must be selected explicitly; nested folders in one checkout work", () => {
    const { dir, p, app } = fixture(); const main = join(dir, "main"), preview = join(dir, "preview");
    run(["git", "init", main]); run(["git", "-C", main, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    run(["git", "-C", main, "worktree", "add", "-b", "preview", preview]);
    const nested = join(main, "frontend"); mkdirSync(nested);
    const manager = new AppServices(p);
    expect(() => manager.checkWorktree({ ...app, path: main }, preview)).toThrow("another worktree");
    expect(() => manager.checkWorktree({ ...app, path: nested }, main)).not.toThrow();
  });
  test("independent processes serialize on the same OS lock", async () => {
    const { p, dir } = fixture(); const output = join(dir, "order");
    const code = `import {withLock} from ${JSON.stringify(SCRIPT)}; import {appendFileSync} from 'node:fs'; await withLock('app', ${JSON.stringify(p)}, async()=>{appendFileSync(${JSON.stringify(output)},'start\\n');await Bun.sleep(60);appendFileSync(${JSON.stringify(output)},'end\\n');});`;
    const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(children.map(c => c.exited))).toEqual([0, 0, 0, 0]);
    expect(readFileSync(output, "utf8")).toBe("start\nend\n".repeat(4));
  });
  test("an app named registry does not collide with the registry lock", async () => {
    const { p } = fixture(); let entered = false;
    await withLock("@registry", p, () => withLock("registry", p, async () => { entered = true; })); expect(entered).toBe(true);
  });
});
