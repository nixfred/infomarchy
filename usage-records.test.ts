import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Omarchy 4.5 ships a usage collector per agent (22 at rc1 and growing), each
// writing <id>.json. The desk reads them alphabetically up to a cap, so a cap
// below the collector count silently drops the agents that sort last.
const root = mkdtempSync(join(tmpdir(), "usage-records-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function decode(output: string) {
  const frames = output.trim().split("\n").map(line => JSON.parse(line));
  expect(frames.at(-1).type).toBe("end");
  return JSON.parse(frames.filter(f => f.type === "chunk").map(f => f.data).join(""));
}

test("an agent that sorts after twenty unused ones still reaches the desk", async () => {
  const usage = join(root, "state", "omarchy/agents/usage");
  mkdirSync(usage, { recursive: true });
  // What 4.5 prints for an agent this machine does not use: ready false, no stats.
  const idle = (id: string) => ({ schemaVersion: 1, id, name: id, ready: false, limits: [], todayPrompts: 0, totalPrompts: 0 });
  for (let i = 0; i < 22; i++) writeFileSync(join(usage, `agent${String(i).padStart(2, "0")}.json`), JSON.stringify(idle(`agent${i}`)));
  writeFileSync(join(usage, "zai.json"), JSON.stringify({ ...idle("zai"), name: "Z.ai", ready: true, todayPrompts: 3, totalPrompts: 40 }));
  const proc = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "tests/collector-offline.ts"), join(import.meta.dir, "collector.ts"), "--id", "bg"], {
    env: { HOME: root, XDG_STATE_HOME: join(root, "state"), PATH: "/nonexistent", INFOMARCHY_SKIP_GITHUB: "1", INFOMARCHY_SKIP_EXTERNAL_IP: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  const snapshot = decode(output);
  expect(snapshot.ai.usage.zai).toMatchObject({ name: "Z.ai", ready: true, todayPrompts: 3, totalPrompts: 40 });
});
