import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
const historyFixture = join(import.meta.dir, ".test-fixture");
afterAll(() => rmSync(historyFixture, { recursive: true, force: true }));
import { join } from "path";
import { providerOf, titleLooksBusy, cmdIsTurnInhibitor } from "./collector.ts";

const fixture = join(import.meta.dir, ".test-fixture-races");
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("providerOf", () => {
  test("treats an interactive Codex CLI as a session", () => {
    expect(providerOf(["/usr/bin/codex", "--yolo"])).toBe("codex");
  });

  test("ignores Codex app-server and mcp-server daemons", () => {
    expect(providerOf(["/usr/lib/chatgpt/resources/codex", "-c", "features.code_mode_host=true", "app-server"])).toBeNull();
    expect(providerOf(["codex", "mcp-server"])).toBeNull();
  });

  test("ignores the Ollama daemon but keeps chats", () => {
    expect(providerOf(["ollama", "serve"])).toBeNull();
    expect(providerOf(["/usr/bin/ollama", "run", "llama3"])).toBe("ollama");
  });
});

describe("busy detection", () => {
  test("titleLooksBusy matches processing titles and not idle checkmarks", () => {
    expect(titleLooksBusy("🧠 Processing request.")).toBe(true);
    expect(titleLooksBusy("⚙️ Processing request.")).toBe(true);
    expect(titleLooksBusy("✅ All five PRs checked")).toBe(false);
    expect(titleLooksBusy("wallpaper.Larry")).toBe(false);
  });

  test("cmdIsTurnInhibitor matches Grok's idle-inhibit, not other inhibitors", () => {
    expect(cmdIsTurnInhibitor(["systemd-inhibit", "--what=idle", "--who=grok", "--why=agent turn in progress", "sleep", "infinity"])).toBe(true);
    expect(cmdIsTurnInhibitor(["/usr/bin/systemd-inhibit", "--what=idle", "--who=grok", "--why=agent turn in progress", "sleep", "infinity"])).toBe(true);
    expect(cmdIsTurnInhibitor(["systemd-inhibit", "--what=sleep", "--who=Omarchy", "--why=Lock screen before suspend"])).toBe(false);
    expect(cmdIsTurnInhibitor(["grok", "--yolo"])).toBe(false);
  });
});

describe("prev.json instance files", () => {
  test(" --id writes separate rate-delta files so overlay and wallpaper do not clobber each other", async () => {
    const state = join(fixture, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(fixture, "keep"), "");

    async function collect(id: string) {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "collector.ts"), "--id", id], {
        env: { HOME: fixture, USER: "tester", XDG_STATE_HOME: state, PATH: process.env.PATH || "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      JSON.parse(output);
    }

    await collect("bg");
    await collect("overlay");
    expect(existsSync(join(state, "infomarchy", "prev-bg.json"))).toBe(true);
    expect(existsSync(join(state, "infomarchy", "prev-overlay.json"))).toBe(true);
    expect(existsSync(join(state, "infomarchy", "prev.json"))).toBe(false);
  });
});
describe("history collection", () => {
  test("parses Grok prompts and redacts secrets from recent tasks", async () => {
    const grokDir = join(historyFixture, ".grok", "sessions", encodeURIComponent(join(historyFixture, "project")));
    mkdirSync(grokDir, { recursive: true });
    const timestamp = new Date().toISOString();
    writeFileSync(join(grokDir, "prompt_history.jsonl"), [
      JSON.stringify({ timestamp, session_id: "session-a", prompt: "deploy with api key: super-secret-value", is_bash: false }),
      JSON.stringify({ timestamp, session_id: "session-a", prompt: "then check status", is_bash: false }),
      JSON.stringify({ timestamp, session_id: "session-b", prompt: "use ntn_abcdefghijklmnopqrstuvwxyz", is_bash: false }),
    ].join("\n"));

    const proc = Bun.spawn(["bun", join(import.meta.dir, "collector.ts")], {
      env: { HOME: historyFixture, USER: "tester", XDG_STATE_HOME: join(historyFixture, "state"), PATH: process.env.PATH || "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const snap = JSON.parse(output);

    expect(snap.ai.providers.grok.sessions).toBe(2);
    expect(snap.ai.counts.grok.today).toBe(3);
    expect(snap.ai.recent.map((entry: any) => entry.text)).toEqual([
      "deploy with api key: [redacted]",
      "then check status",
      "use ntn_[redacted]",
    ]);
  });
});
