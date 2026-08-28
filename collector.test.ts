import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { Database } from "bun:sqlite";
const historyFixture = join(import.meta.dir, ".test-fixture");
afterAll(() => rmSync(historyFixture, { recursive: true, force: true }));
import { join } from "path";
import { providerOf, titleLooksBusy, cmdIsTurnInhibitor, sessionIdFrom, linkRecentToLive, inferSessionIdsFromRecent, attachSessionTopics, localSessionSummary, cleanGeneratedSummary, activityCellIndex, parseExternalIpTrace, externalIpCacheFresh, frameSnapshot, parseJsonBounded, readRegularFileLimited, writePrivateStateFile } from "./collector.ts";

const fixture = join(import.meta.dir, ".test-fixture-races");
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function decodeFrames(output: string): any {
  const frames = output.trim().split("\n").map(line => JSON.parse(line));
  const payload = frames.filter(frame => frame.type === "chunk").map(frame => frame.data).join("");
  expect(frames.at(-1)).toMatchObject({ v: 1, type: "end", chars: payload.length });
  return JSON.parse(payload);
}

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

  test("ignores OpenCode services but keeps its TUI and run sessions", () => {
    expect(providerOf(["opencode", "serve"])).toBeNull();
    expect(providerOf(["/usr/bin/opencode"])).toBe("opencode");
    expect(providerOf(["opencode", "run", "inspect this"])).toBe("opencode");
  });
});

describe("external IP cache", () => {
  test("accepts only IP-shaped Cloudflare trace values", () => {
    expect(parseExternalIpTrace("fl=1\nip=203.0.113.8\n")).toBe("203.0.113.8");
    expect(parseExternalIpTrace("ip=2001:db8::1\n")).toBe("2001:db8::1");
    expect(parseExternalIpTrace("ip=$(touch /tmp/nope)\n")).toBeNull();
    expect(parseExternalIpTrace("fl=1\n")).toBeNull();
  });

  test("backs off for 15 minutes after success or failure", () => {
    const stamp = 2_000_000;
    expect(externalIpCacheFresh({ address: null, checkedAt: stamp - 1 }, stamp)).toBe(true);
    expect(externalIpCacheFresh({ address: "203.0.113.8", checkedAt: stamp - 899_999 }, stamp)).toBe(true);
    expect(externalIpCacheFresh({ address: null, checkedAt: stamp - 900_000 }, stamp)).toBe(false);
    expect(externalIpCacheFresh({ address: null, checkedAt: stamp + 1 }, stamp)).toBe(false);
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

describe("activity heatmap filtering metadata", () => {
  const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 7, 21 + i, 0, 0, 0, 0).getTime());

  test("maps a local timestamp to the same day/hour cell as the heatmap", () => {
    expect(activityCellIndex(new Date(2026, 7, 24, 14, 32).getTime(), days)).toBe(3 * 24 + 14);
  });

  test("rejects stale, malformed, and unavailable activity ranges", () => {
    expect(activityCellIndex(new Date(2026, 7, 20, 23, 59).getTime(), days)).toBe(-1);
    expect(activityCellIndex("not-a-time", days)).toBe(-1);
    expect(activityCellIndex(Date.now(), [])).toBe(-1);
  });
});

describe("recent prompt live-window linking", () => {
  test("extracts provider session IDs without exposing unrelated environment values", () => {
    expect(sessionIdFrom("codex", ["codex"], "TOKEN=do-not-read\0CODEX_THREAD_ID=01a04631-65f2-7140-a12c-ff1ecbc5d0a4\0"))
      .toBe("01a04631-65f2-7140-a12c-ff1ecbc5d0a4");
    expect(sessionIdFrom("claude", ["claude", "--resume", "e28daec7-27df-4c04-a1a4-9898b1a4d60b"], ""))
      .toBe("e28daec7-27df-4c04-a1a4-9898b1a4d60b");
    expect(sessionIdFrom("opencode", ["opencode", "-s", "ses_12345678"], "")).toBe("ses_12345678");
    expect(sessionIdFrom("codex", ["codex", "--session-id", "../bad"], "TOKEN=secret\0")).toBe("");
  });

  test("marks only an exact provider and session match as live and clickable", () => {
    const recent = [
      { provider: "codex", session: "session-open", text: "open" },
      { provider: "codex", session: "session-closed", text: "closed" },
      { provider: "claude", session: "session-open", text: "other provider" },
    ];
    const sessions = [{
      provider: "codex", sessionIds: ["session-helper", "session-open"],
      window: { address: "0xabc", workspace: 4, title: "must not leak into recent" },
    }];
    expect(linkRecentToLive(recent, sessions)).toEqual([
      { ...recent[0], live: true, window: { address: "0xabc", workspace: 4 } },
      { ...recent[1], live: false, window: null },
      { ...recent[2], live: false, window: null },
    ]);
  });

  test("infers one newly started agent from exact provider, directory, and time", () => {
    const sessions = [{ provider: "claude", cwd: "~/Work", startedAt: 1000, session: "", sessionIds: [] }];
    const recent = [
      { provider: "claude", project: "~/Other", ts: 3000, session: "wrong-project" },
      { provider: "claude", project: "~/Work", ts: 2000, session: "session-right" },
    ];
    inferSessionIdsFromRecent(sessions, recent);
    expect(sessions[0].sessionIds).toEqual(["session-right"]);
  });

  test("refuses to infer when two live agents share a provider and directory", () => {
    const sessions = [
      { provider: "claude", cwd: "~/Work", startedAt: 1000, session: "", sessionIds: [] },
      { provider: "claude", cwd: "~/Work", startedAt: 1500, session: "", sessionIds: [] },
    ];
    inferSessionIdsFromRecent(sessions, [{ provider: "claude", project: "~/Work", ts: 2000, session: "session-ambiguous" }]);
    expect(sessions.map(s => s.sessionIds)).toEqual([[], []]);
  });
});

describe("live session topics", () => {
  test("summarizes several prompts without displaying the newest prompt verbatim", () => {
    const sessions = [
      { provider: "codex", project: "~/nixfred.infomarchy", sessionIds: ["session-a"] },
      { provider: "claude", project: "~/auth-service", sessionIds: ["session-a"] },
      { provider: "codex", project: "~/local-ai", sessionIds: ["session-b"] },
    ];
    const recent = [
      { provider: "codex", session: "session-a", ts: 100, text: "fix scrollbar behavior" },
      { provider: "claude", session: "session-a", ts: 250, text: "review authentication failures" },
      { provider: "codex", session: "session-b", ts: 200, text: "add ollama model controls" },
      { provider: "codex", session: "session-a", ts: 300, text: "the scrolling in past prompts is hard to scroll" },
    ];
    attachSessionTopics(sessions, recent);
    expect(sessions.map(session => [session.topic, session.topicAt])).toEqual([
      ["Fixing Infomarchy scrolling behavior", 300],
      ["Reviewing Auth Service authentication failures", 250],
      ["Building Local AI ollama model", 200],
    ]);
    expect(sessions[0].topic).not.toContain(recent[3].text);
  });

  test("uses a generic project summary when exact history is unavailable", () => {
    const sessions = [{ provider: "codex", project: "~/Infomarchy", sessionIds: [] }];
    attachSessionTopics(sessions, [{ provider: "codex", session: "another", ts: 100, text: "wrong session" }]);
    expect(sessions[0]).toMatchObject({ topic: "Improving Infomarchy", topicAt: 0 });
  });

  test("cleans and bounds local-model summaries", () => {
    expect(cleanGeneratedSummary("\n**Improving live session summaries.**\nextra ignored words beyond the allowed maximum here"))
      .toBe("Improving live session summaries. extra ignored words beyond");
    expect(localSessionSummary({ project: "~/Infomarchy" }, [{ text: "make a real short summary of live sessions" }]))
      .toBe("Summarizing Infomarchy live sessions");
  });
});

describe("collector security boundaries", () => {
  test("reads one opened regular file with byte and no-follow limits", () => {
    const root = join(fixture, "safe-read");
    mkdirSync(root, { recursive: true });
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    writeFileSync(target, "bounded content");
    symlinkSync(target, link);
    expect(readRegularFileLimited(target, 64)).toBe("bounded content");
    expect(readRegularFileLimited(target, 4)).toBeNull();
    expect(readRegularFileLimited(link, 64)).toBeNull();
    expect(readRegularFileLimited(root, 64)).toBeNull();
  });

  test("writes state atomically without following a destination symlink", () => {
    const root = join(fixture, "atomic-state");
    const state = join(root, "state");
    const victim = join(root, "victim.txt");
    mkdirSync(state, { recursive: true });
    writeFileSync(victim, "do not overwrite");
    symlinkSync(victim, join(state, "prev-bg.json"));
    expect(writePrivateStateFile(state, "prev-bg.json", "{\"safe\":true}")).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("do not overwrite");
    expect(readFileSync(join(state, "prev-bg.json"), "utf8")).toBe("{\"safe\":true}");
    expect(lstatSync(join(state, "prev-bg.json")).isSymbolicLink()).toBe(false);
    expect(lstatSync(state).mode & 0o077).toBe(0);
  });

  test("rejects excessive JSON depth and node counts", () => {
    expect(parseJsonBounded("[".repeat(20) + "0" + "]".repeat(20), 100, 8)).toBeNull();
    expect(parseJsonBounded(JSON.stringify(Array.from({ length: 50 }, (_, i) => i)), 10, 8)).toBeNull();
    expect(parseJsonBounded('{"ok":[1,2,3]}', 10, 8)).toEqual({ ok: [1, 2, 3] });
  });

  test("frames snapshots into bounded streaming records", () => {
    const framed = frameSnapshot({ value: "x".repeat(50_000), nested: { ok: true } });
    const lines = framed.trim().split("\n").map(line => JSON.parse(line));
    expect(lines.every(line => JSON.stringify(line).length < 65_536)).toBe(true);
    expect(lines.at(-1)).toMatchObject({ v: 1, type: "end" });
    expect(decodeFrames(framed)).toEqual({ value: "x".repeat(512), nested: { ok: true } });
  });
});

describe("prev.json instance files", () => {
  test(" --id writes separate rate-delta files so overlay and wallpaper do not clobber each other", async () => {
    const state = join(fixture, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(fixture, "keep"), "");

    async function collect(id: string) {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "collector.ts"), "--id", id], {
        env: { HOME: fixture, USER: "tester", XDG_STATE_HOME: state, PATH: process.env.PATH || "", INFOMARCHY_SKIP_EXTERNAL_IP: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      decodeFrames(output);
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
      env: { HOME: historyFixture, USER: "tester", XDG_STATE_HOME: join(historyFixture, "state"), PATH: process.env.PATH || "", INFOMARCHY_SKIP_EXTERNAL_IP: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const snap = decodeFrames(output);

    expect(snap.ai.providers.grok.sessions).toBe(2);
    expect(snap.ai.counts.grok.today).toBe(3);
    expect(snap.ai.recent.map((entry: any) => entry.text)).toEqual([
      "deploy with api key: [redacted]",
      "then check status",
      "use ntn_[redacted]",
    ]);
  });

  test("parses OpenCode user prompts, sessions, projects, and redacts secrets", async () => {
    const root = join(import.meta.dir, ".test-fixture-opencode");
    const data = join(root, "data");
    const dbDir = join(data, "opencode");
    mkdirSync(dbDir, { recursive: true });
    const db = new Database(join(dbDir, "opencode.db"));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.query("INSERT INTO session VALUES (?, ?)").run("ses_test12345", join(root, "project"));
    db.query("INSERT INTO message VALUES (?, ?, ?, ?)").run("msg_1", "ses_test12345", Date.now(), JSON.stringify({ role: "user" }));
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("part_1", "msg_1", "ses_test12345", Date.now(), JSON.stringify({ type: "text", text: "inspect with password: very-secret-value" }));
    db.close();

    const proc = Bun.spawn(["bun", join(import.meta.dir, "collector.ts")], {
      env: { HOME: root, USER: "tester", XDG_DATA_HOME: data, XDG_STATE_HOME: join(root, "state"), PATH: process.env.PATH || "", INFOMARCHY_SKIP_EXTERNAL_IP: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const snap = decodeFrames(output);

    expect(snap.ai.providers.opencode).toEqual({ present: true, prompts: 1, sessions: 1 });
    expect(snap.ai.recent[0]).toMatchObject({
      provider: "opencode",
      session: "ses_test12345",
      project: "~/project",
      text: "inspect with password: [redacted]",
    });
    rmSync(root, { recursive: true, force: true });
  });
});
