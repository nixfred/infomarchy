import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseRemoteRoster, readRemoteRoster, remoteWorkspace, frameSnapshot } from "./collector";
const root = mkdtempSync(join(tmpdir(), "remote-roster-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const stamp = Date.UTC(2026, 8, 6);
const row = (id: string, attention = "waiting", status = "busy") => ({ id, name: id.toUpperCase(), lastLine: "review this", attention, status });
const doc = (agents: any[], fetchedAt: any = new Date(stamp).toISOString()) => JSON.stringify({ v: 1, fetchedAt, agents });
const parse = (agents: any[]) => parseRemoteRoster(doc(agents), stamp, stamp);
function decode(output: string) {
  const frames = output.trim().split("\n").map(line => JSON.parse(line));
  expect(frames.at(-1).type).toBe("end");
  return JSON.parse(frames.filter(f => f.type === "chunk").map(f => f.data).join(""));
}
test("wire validation, short ids, first wins, ranking and safe text", () => {
  const roster = parse([row("ara", "done"), row("max", "blocked"), row("ara", "blocked"), row("bad", "waiting", "unknown"), row("_bad"), row("a".repeat(65)), row("wait"), { ...row("safe"), name: "<b>\u0000" + "x".repeat(80), lastLine: "password: hunter2 " + "x".repeat(200) }]);
  expect(roster.counts).toEqual({ busy: 4, idle: 0, offline: 0 });
  expect(roster.needsYou.map(r => r.id)).toEqual(["max", "wait", "safe", "ara"]);
  expect(roster.needsYou[2].name).toHaveLength(64);
  expect(roster.needsYou[2].name).not.toContain("\u0000");
  expect(roster.needsYou[2].lastLine).toHaveLength(140);
  expect(roster.needsYou[2].lastLine).not.toContain("hunter2");
  expect(parse([row("x", "invalid"), row("y", "", "idle"), row("z", "", "offline")]).counts).toEqual({ busy: 1, idle: 1, offline: 1 });
});
test("rejected status does not reserve an id; first ingested row wins", () => {
  const roster = parse([row("ara", "blocked", "nope"), row("ara", "waiting", "busy"), row("ara", "done", "idle")]);
  expect(roster.counts).toEqual({ busy: 1, idle: 0, offline: 0 });
  expect(roster.needsYou).toEqual([{ id: "ara", name: "ARA", lastLine: "review this", attention: "waiting" }]);
});
test("invalid documents and timestamps have explicit states", () => {
  for (const text of ['{', '{}', '{"v":2,"agents":[]}', '{"agents":[]}', '{"v":1,"agents":{}}', 'x'.repeat(256 * 1024 + 1)])
    expect(parseRemoteRoster(text, stamp, stamp)).toEqual({ state: "unavailable", fetchedAt: 0, counts: { busy: 0, idle: 0, offline: 0 }, needsYou: [], overflow: 0 });
  for (const time of [null, "garbage", "1999-01-01T00:00:00Z", new Date(stamp + 60001).toISOString()])
    expect(parseRemoteRoster(doc([], time), stamp, stamp).fetchedAt).toBe(stamp);
  expect(parseRemoteRoster(doc([]), stamp, stamp + 300001).state).toBe("stale");
  expect(parseRemoteRoster(doc([]), stamp, stamp + 300000).state).toBe("ok");
});
test("existence is distinct from readable regular files; no writes", () => {
  expect(readRemoteRoster("")).toBeUndefined();
  expect(readRemoteRoster(join(root, "missing"))).toBeUndefined();
  const path = join(root, "roster.json");
  writeFileSync(path, doc([row("ara")]));
  const before = readFileSync(path);
  expect(readRemoteRoster(path, stamp)?.state).toBe("ok");
  expect(readFileSync(path)).toEqual(before);
  symlinkSync(path, join(root, "link"));
  symlinkSync(join(root, "missing"), join(root, "dangling"));
  for (const path of [root, join(root, "link"), join(root, "dangling")]) expect(readRemoteRoster(path)?.state).toBe("unavailable");
  writeFileSync(path, 'x'.repeat(256 * 1024 + 1));
  expect(readRemoteRoster(path)?.state).toBe("unavailable");
});
test("the doorway is opt-in, strictly numeric, and never invents a target", () => {
  const path = join(root, "workspace.json");
  writeFileSync(path, doc([row("ara")]));
  expect(readRemoteRoster(path, stamp)).not.toHaveProperty("workspace");
  expect(remoteWorkspace("10")).toBe(10);
  expect(remoteWorkspace("1")).toBe(1);
  for (const bad of [undefined, "", "0", "100", " 10", "10 ", "1e1", "+1", "-1", "10; hyprctl dispatch exit", "special:magic", "name:work"])
    expect(remoteWorkspace(bad)).toBeUndefined();
  process.env.INFOMARCHY_REMOTE_WORKSPACE = "10";
  try {
    expect(readRemoteRoster(path, stamp)?.workspace).toBe(10);
    // A card that cannot be shown is not a doorway either.
    expect(readRemoteRoster(join(root, "missing"))).toBeUndefined();
    writeFileSync(path, "{");
    expect(readRemoteRoster(path, stamp)).toEqual({ state: "unavailable", fetchedAt: 0, counts: { busy: 0, idle: 0, offline: 0 }, needsYou: [], overflow: 0, workspace: 10 });
    process.env.INFOMARCHY_REMOTE_WORKSPACE = "workspace 10";
    writeFileSync(path, doc([row("ara")]));
    expect(readRemoteRoster(path, stamp)).not.toHaveProperty("workspace");
  } finally { delete process.env.INFOMARCHY_REMOTE_WORKSPACE; }
});
test("100-agent cap, overflow, absence and near-budget local snapshot survive framing", () => {
  const roster = parse(Array.from({ length: 101 }, (_, i) => row("a" + i)));
  expect(roster.counts.busy).toBe(100);
  expect(roster.needsYou).toHaveLength(4);
  expect(roster.overflow).toBe(96);
  const local = { ai: { sessions: [{ id: "local" }], attention: [], events: [] } };
  expect(frameSnapshot({ ai: { ...local.ai, remoteRoster: undefined } })).toBe(frameSnapshot(local));
  const withRoster = decode(frameSnapshot({ ai: { ...local.ai, remoteRoster: roster } }));
  expect(withRoster.ai.sessions).toEqual(local.ai.sessions);
  expect(withRoster.ai.attention).toEqual([]);
  expect(withRoster.ai.events).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(withRoster))).toBeLessThan(960 * 1024);
  const near: any = { ai: local.ai, padding: Array.from({ length: 1908 }, () => "x".repeat(512)) };
  // Each array is capped at 1024 by framing; split realistic bounded collections.
  near.padding = [near.padding.slice(0, 954), near.padding.slice(954)];
  const size = Buffer.byteLength(JSON.stringify(decode(frameSnapshot(near))));
  near.tail = "x".repeat(960 * 1024 - size - 12);
  expect(frameSnapshot({ ...near, ai: { ...near.ai, remoteRoster: roster } })).toBe(frameSnapshot(near));
});
test("overlay and wallpaper read the file; demo remains isolated", async () => {
  const path = join(root, "overlay.json"); writeFileSync(path, doc([row("ara"), row("max")]));
  for (const [args, source] of [[["--id", "overlay"], path], [["--id", "bg"], path], [["--demo"], path], [["--id", "overlay"], ""], [["--id", "overlay"], join(root, "missing")]] as [string[], string][]) {
    const proc = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "tests/collector-offline.ts"), join(import.meta.dir, "collector.ts"), ...args], {
      env: { HOME: root, XDG_STATE_HOME: join(root, "state"), PATH: "/nonexistent", INFOMARCHY_SKIP_GITHUB: "1", INFOMARCHY_SKIP_EXTERNAL_IP: "1", INFOMARCHY_REMOTE_ROSTER: source, INFOMARCHY_REMOTE_WORKSPACE: "10" }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const snapshot = decode(output);
    if (args[0] === "--demo" || source !== path) expect(snapshot.ai).not.toHaveProperty("remoteRoster");
    else {
      expect(snapshot.ai.remoteRoster.needsYou.map((r: any) => r.id)).toEqual(["ara", "max"]);
      // The env var reaches the shipped collector, not just the exported helper.
      expect(snapshot.ai.remoteRoster.workspace).toBe(10);
    }
    if (args[0] !== "--demo") {
      for (const key of ["sessions", "attention", "events", "projects", "workspaces", "collisions", "recent"]) {
        const local = JSON.stringify(snapshot.ai[key]);
        expect(local).toBeDefined();
        expect(local).not.toMatch(/"(?:ara|max|ARA|MAX|remote)"/);
      }
      expect(snapshot.ai.providers.ollama).toMatchObject({ present: true, up: true, models: [], loaded: [], modelCount: 0 });
      expect(snapshot.machine.ping.ok).toBe(false);
    }
  }
});
