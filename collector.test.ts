import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join, relative } from "path";
import { providerOf, titleLooksBusy, cmdIsTurnInhibitor, sessionIdFrom, sessionHostsFromEnvironment, tmuxSocketFromEnvironment, parseTmuxPanes, parseTmuxClients, tmuxPaneForAncestors, linkRecentToLive, inferSessionIdsFromRecent, attachSessionTopics, localSessionSummary, cleanGeneratedSummary, activityCellIndex, parseExternalIpTrace, externalIpCacheFresh, frameSnapshot, parseJsonBounded, readRegularFileLimited, safePrompt, sessionPresentation, writePrivateStateFile, decodeProjectDir, dropPartialFirstLine, readHistoryTail, readRegularFileHead, rolloutSessionId, rolloutCwd, topicCacheHit, topicRetryBlocked, pruneTopicCache, reapStateTempFiles, parseGpuLine, parseDfRows, plausibleTimestamp, normalizeUsage, normalizeUsageLimit, ollamaHostIsLocal, topicRefinementAllowed, terminate, rateForModel, estimateValue, valueSummary, alignDailyTokens, localDayKey, loadPricing, todayValueEstimate, herdrSocketFromEnvironment, herdrClientPids, herdrWindowFor } from "./collector.ts";

const testRoot = mkdtempSync(join(tmpdir(), "infomarchy-test-"));
const historyFixture = join(testRoot, "history");
const fixture = join(testRoot, "races");
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

test("collector fixtures stay outside the live plugin tree", () => {
  const relativeFixture = relative(import.meta.dir, fixture);
  expect(relativeFixture === ".." || relativeFixture.startsWith("../")).toBe(true);
});

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

  test("recognizes Hermes as an interactive agent provider", () => {
    expect(providerOf(["/home/user/.hermes/bin/hermes"])).toBe("hermes");
  });
});

describe("multiplexer session identity", () => {
  test("extracts only documented Herdr, Boomux, and tmux identity fields", () => {
    const hosts = sessionHostsFromEnvironment([
      "TOKEN=must-never-appear", "HERDR_ENV=1", "HERDR_WORKSPACE_ID=w1", "HERDR_TAB_ID=w1:t2", "HERDR_PANE_ID=w1:p3",
      "BOOMUX_WORKSPACE_ID=workspace-123", "BOOMUX_WORKSPACE=atlas", "BOOMUX_SHELL_ID=shell-456", "BOOMUX_SHELL_NAME=builder", "BOOMUX_RUN_ID=run-789",
      "TMUX=/tmp/tmux/default,1,0", "TMUX_PANE=%7",
    ].join("\0") + "\0");
    expect(hosts.map(host => host.kind)).toEqual(["herdr", "boomux", "tmux"]);
    expect(hosts[0]).toMatchObject({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p3" });
    expect(hosts[1]).toMatchObject({ workspace: "atlas", shell: "builder", shellId: "shell-456", runId: "run-789" });
    expect(hosts[2]).toMatchObject({ paneId: "%7" });
    expect(tmuxSocketFromEnvironment("TMUX=/tmp/tmux-1000/custom,1,0\0TOKEN=hidden\0")).toBe("/tmp/tmux-1000/custom");
    expect(tmuxSocketFromEnvironment("TMUX=../../bad,1,0\0")).toBe("");
    expect(JSON.stringify(hosts)).not.toContain("must-never-appear");
  });

  test("parses bounded tmux inventory and resolves the nearest pane", () => {
    const panes = parseTmuxPanes("320\t%7\twork\t2\t1\t/home/user/project\t1\ninvalid\n");
    expect(panes).toEqual([{ pid: 320, paneId: "%7", session: "work", window: "2", pane: "1", cwd: "/home/user/project", active: true, server: "" }]);
    expect(parseTmuxClients("410\twork\n")).toEqual([{ pid: 410, session: "work", server: "", paneId: "" }]);
    // Clients report their current pane so two terminals on one session resolve separately.
    expect(parseTmuxClients("410\twork\t%7\n411\twork\t%9\n")).toEqual([
      { pid: 410, session: "work", server: "", paneId: "%7" },
      { pid: 411, session: "work", server: "", paneId: "%9" },
    ]);
    expect(tmuxPaneForAncestors([900, 500, 320, 1], panes)?.paneId).toBe("%7");
    expect(tmuxPaneForAncestors([900], panes, "%7")?.session).toBe("work");
    expect(tmuxPaneForAncestors([900], panes, "%8")).toBeNull();
  });
});

describe("external IP cache", () => {
  test("accepts only IP-shaped Cloudflare trace values", () => {
    expect(parseExternalIpTrace("fl=1\nip=203.0.113.8\n")).toBe("203.0.113.8");
    expect(parseExternalIpTrace("ip=2001:db8::1\n")).toBe("2001:db8::1");
    expect(parseExternalIpTrace("ip=$(touch /tmp/nope)\n")).toBeNull();
    expect(parseExternalIpTrace("ip=1.2.3.999\n")).toBeNull();
    expect(parseExternalIpTrace("ip=:::1\n")).toBeNull();
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
  test("redacts credentials from live-session titles and arguments before framing", () => {
    const titleCredential = ["title", "credential", "value"].join("-");
    const argumentCredential = ["session", "credential", "value"].join("-");
    const rawTitle = `Authorization: Bearer ${titleCredential}`;
    const presentation = sessionPresentation(
      { address: "0xabc", title: rawTitle, class: "test", workspace: { id: 2 } },
      ["aider", "--password", argumentCredential],
    );
    expect(presentation.window.title).toStartWith("Authorization: Bearer ");
    expect(presentation.window.title.length).toBeLessThan(rawTitle.length);
    expect(presentation.args).not.toContain(argumentCredential);
    expect(JSON.stringify(presentation)).not.toContain(titleCredential);
  });

  test("redacts generic credential flags from live-session arguments", () => {
    const separate = sessionPresentation(null, ["tool", "--token", "abcdefghijklmnop"]);
    const assigned = sessionPresentation(null, ["tool", "--api-key=qrstuvwxyzabcdef"]);
    expect(separate.args).toBe("--token [redacted]");
    expect(assigned.args).toBe("--api-key=[redacted]");
    expect(JSON.stringify([separate, assigned])).not.toMatch(/abcdefghijklmnop|qrstuvwxyzabcdef/);
  });

  test("redacts a complete separate credential argv value containing spaces", () => {
    const presentation = sessionPresentation(null, ["tool", "--token", "two word secret"]);
    expect(presentation.args).toBe("--token [redacted]");
    expect(presentation.args).not.toContain("word secret");
  });

  test("redacts complete assigned credential argv values containing spaces", () => {
    for (const flag of ["--token", "--api-key", "--password", "--secret"]) {
      const presentation = sessionPresentation(null, ["tool", `${flag}=two word secret`]);
      expect(presentation.args).toBe(`${flag}=[redacted]`);
      expect(presentation.args).not.toContain("word secret");
    }
  });

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
  test("preserves benign credential-related prose", () => {
    const prompts = ["implement password reset flow", "design password recovery flow"];
    expect(prompts.map(safePrompt)).toEqual(prompts);
  });

  test("redacts authorization headers and complete quoted secrets", () => {
    const sanitized = safePrompt('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.private-signature password: "two word secret"');
    expect(sanitized).toBe("Authorization: Bearer [redacted] password: [redacted]");
    expect(sanitized).not.toContain("private-signature");
    expect(sanitized).not.toContain("word secret");
  });

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
    const root = join(testRoot, "opencode");
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

describe("degrading instead of crashing", () => {
  const guard = join(import.meta.dir, ".test-fixture-guards");
  afterAll(() => rmSync(guard, { recursive: true, force: true }));

  test("a literal % in a grok project dir does not throw", () => {
    // decodeURIComponent("100%home") throws — this used to abort the whole snapshot.
    expect(decodeProjectDir("100%home%2Fpi")).toBe("100%home%2Fpi");
    expect(decodeProjectDir("%2Fhome%2Fdev")).toBe("/home/dev");
  });

  test("oversized JSONL history keeps its tail rather than disappearing", () => {
    mkdirSync(guard, { recursive: true });
    const path = join(guard, "history.jsonl");
    const line = JSON.stringify({ timestamp: 1, display: "x".repeat(200) }) + "\n";
    let text = "";
    while (Buffer.byteLength(text) < 40 * 1024) text += line;
    text += JSON.stringify({ timestamp: 2, display: "NEWEST" }) + "\n";
    writeFileSync(path, text);
    // Under the cap: whole file.
    expect(readHistoryTail(path, 8 * 1024 * 1024)!.length).toBe(text.length);
    // Over the cap: the newest entries survive, and no partial first line leaks.
    const tail = readHistoryTail(path, 4 * 1024)!;
    expect(tail).toContain("NEWEST");
    expect(tail.length).toBeLessThan(text.length);
    for (const row of tail.split("\n").filter(Boolean)) expect(() => JSON.parse(row)).not.toThrow();
  });

  test("dropPartialFirstLine discards a truncated leading record", () => {
    expect(dropPartialFirstLine('mp":1}\n{"ok":true}\n')).toBe('{"ok":true}\n');
    expect(dropPartialFirstLine("no newline at all")).toBe("");
  });
});

describe("codex project resolution", () => {
  const codex = join(import.meta.dir, ".test-fixture-codex");
  afterAll(() => rmSync(codex, { recursive: true, force: true }));

  test("reads the session id out of a rollout filename", () => {
    expect(rolloutSessionId("rollout-2026-08-30T17-03-16-01a0547b-d5fb-7923-afd8-5e3a8ee3e715.jsonl"))
      .toBe("01a0547b-d5fb-7923-afd8-5e3a8ee3e715");
    expect(rolloutSessionId("history.jsonl")).toBe("");
  });

  test("extracts cwd from the session_meta header only", () => {
    expect(rolloutCwd('{"type":"session_meta","payload":{"session_id":"x","cwd":"/home/dev/Projects/thing"}}\n{"cwd":"/wrong"}'))
      .toBe("/home/dev/Projects/thing");
    expect(rolloutCwd('{"payload":{"cwd":"/tmp/a b"}}')).toBe("/tmp/a b");
    expect(rolloutCwd("not json")).toBe("");
  });

  test("reads only the head of a large rollout file", () => {
    mkdirSync(codex, { recursive: true });
    const path = join(codex, "rollout-2026-01-01T00-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
    writeFileSync(path, '{"type":"session_meta","payload":{"cwd":"/home/dev/Work"}}\n' + "z".repeat(512 * 1024));
    const head = readRegularFileHead(path, 4096)!;
    expect(head.length).toBe(4096);
    expect(rolloutCwd(head)).toBe("/home/dev/Work");
  });
});

describe("topic cache never pins its own failure", () => {
  test("a hit requires a real summary", () => {
    expect(topicCacheHit({ v: 2, fingerprint: "f", model: "m", summary: "Fixing the thing" }, "f", "m")).toBe("Fixing the thing");
    expect(topicCacheHit({ v: 2, fingerprint: "f", model: "m", failedAt: 1 }, "f", "m")).toBe("");
    expect(topicCacheHit({ v: 2, fingerprint: "f", model: "other", summary: "s" }, "f", "m")).toBe("");
  });

  test("pre-fix cache entries are discarded, not served forever", () => {
    // Written before the failure marker existed: a local fallback parked in
    // `summary` as though the model had produced it. No version stamp.
    const poisoned = { fingerprint: "f", model: "m", summary: "Improving Pi now nixfred", checkedAt: 1 };
    expect(topicCacheHit(poisoned, "f", "m")).toBe("");
    expect(topicRetryBlocked(poisoned, "f", "m", 2)).toBe(false);
  });

  test("a failed generate backs off, then retries", () => {
    const failed = { v: 2, fingerprint: "f", model: "m", failedAt: 1000 };
    expect(topicRetryBlocked(failed, "f", "m", 1000 + 30_000)).toBe(true);
    expect(topicRetryBlocked(failed, "f", "m", 1000 + 61_000)).toBe(false);
    // New prompts mean a new fingerprint — always retry.
    expect(topicRetryBlocked(failed, "different", "m", 1000 + 1)).toBe(false);
  });

  test("prunes dead sessions so prev-*.json cannot grow without bound", () => {
    const cache: Record<string, any> = {};
    for (let i = 0; i < 300; i++) cache[`claude:dead-${i}`] = { summary: "s", checkedAt: i };
    cache["claude:alive"] = { summary: "live", checkedAt: 0 };
    const pruned = pruneTopicCache(cache, new Set(["claude:alive"]), 64);
    expect(Object.keys(pruned).length).toBe(64);
    // The live session survives even though it has the oldest timestamp.
    expect(pruned["claude:alive"]).toBeTruthy();
  });
});

describe("state dir hygiene", () => {
  const dir = join(import.meta.dir, ".test-fixture-tmpreap");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reaps temp files orphaned by a killed collector", () => {
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, ".prev-bg.json.3105095.269b5d36-3ca7-4aca-95d4-a627651b9a71.tmp");
    writeFileSync(orphan, "{}");
    const keep = join(dir, "prev-bg.json");
    writeFileSync(keep, "{}");
    // Fresh orphans are left alone (another collector may be mid-write).
    expect(reapStateTempFiles(dir, 10 * 60 * 1000)).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    // Stale ones go.
    expect(reapStateTempFiles(dir, 0, Date.now() + 1000)).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });
});

describe("machine parsers refuse garbage", () => {
  test("nvidia-smi rows need a name and sane numbers", () => {
    expect(parseGpuLine("NVIDIA RTX 4050 Laptop GPU, 12, 1024, 6144, 51")).toEqual({ name: "NVIDIA RTX 4050 Laptop GPU", util: 12, memUsed: 1073741824, memTotal: 6442450944, temp: 51 });
    expect(parseGpuLine(",,,,")).toBeNull();
    expect(parseGpuLine("x,y")).toBeNull();
    expect(parseGpuLine("GPU, NaN, 1, 2, 3")).toBeNull();
    expect(parseGpuLine("")).toBeNull();
  });
  test("df rows need numeric columns and an absolute mount", () => {
    expect(parseDfRows("Mounted on Size Used Avail\n/ 100 40 60\n/home 100 40 60\n/boot 10 3 7")).toEqual([
      { mount: "/", size: 100, used: 40, avail: 60, pct: 40 },
      { mount: "/boot", size: 10, used: 3, avail: 7, pct: 30 },
    ]);
    expect(parseDfRows("Mounted on Size Used Avail\n/ x y z\n/ 1 2")).toEqual([]);
    expect(parseDfRows("")).toEqual([]);
  });
});

describe("second-reviewer findings (2026-09-04)", () => {
  test("parsed JSON cannot smuggle coercion traps", () => {
    const value = parseJsonBounded('{"name":{"toString":0,"valueOf":0},"list":[{"cwd":{"toString":0}}],"ok":"x"}');
    expect(() => String(value.name)).not.toThrow();
    expect(() => String(value.list[0].cwd)).not.toThrow();
    expect(value.ok).toBe("x");
  });

  test("timestamps in the future or before 2000 are rejected everywhere", () => {
    const stamp = Date.UTC(2026, 8, 4);
    expect(plausibleTimestamp(stamp - 1000, stamp)).toBe(true);
    expect(plausibleTimestamp(stamp + 30_000, stamp)).toBe(true);
    expect(plausibleTimestamp(stamp + 3_600_000, stamp)).toBe(false);
    expect(plausibleTimestamp(Date.UTC(2099, 0, 1), stamp)).toBe(false);
    expect(plausibleTimestamp(0, stamp)).toBe(false);
    expect(plausibleTimestamp("nope", stamp)).toBe(false);
  });

  test("usage caches are normalized to displayed fields with hard bounds", () => {
    const big: Record<string, any> = {};
    for (let i = 0; i < 5000; i++) big["model-" + i] = { input: i, output: i, nested: { deeper: { deepest: i } } };
    const usage = normalizeUsage({
      name: "Codex", limits: [null, "junk", { label: "WEEKLY", percent: "0.5", resetsAt: "2026-09-10T00:00:00Z" }],
      modelUsage: big, recentDays: Array.from({ length: 400 }, (_, i) => ({ day: i, prompts: i })), todayPrompts: "12",
    }, Date.UTC(2026, 8, 4));
    expect(usage.limits.length).toBe(1);
    expect(usage.limits[0].percent).toBe(0.5);
    expect(usage.limits[0].forecast).toBeGreaterThan(0.5);
    expect(Object.keys(usage.modelUsage).length).toBe(32);
    expect(usage.recentDays.length).toBe(31);
    expect(usage.todayPrompts).toBe(12);
    expect(normalizeUsageLimit(null)).toBeNull();
  });

  test("a snapshot larger than 128 KiB reaches the consumer intact", async () => {
    // Bun's process.stdout.write is async; exiting right after it truncated
    // pipes at exactly 131072 bytes. Build a history big enough to cross that.
    const home = join(import.meta.dir, ".test-fixture-bigsnap");
    rmSync(home, { recursive: true, force: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const lines: string[] = [];
    const base = Date.now() - 60_000;
    for (let i = 0; i < 1100; i++) lines.push(JSON.stringify({ timestamp: base - i * 1000, display: "prompt " + i + " " + "words ".repeat(40), project: "/proj/" + (i % 7), sessionId: "aaaaaaaa-bbbb-cccc-dddd-" + String(100000000000 + i) }));
    writeFileSync(join(home, ".claude", "history.jsonl"), lines.join("\n") + "\n");
    try {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "collector.ts"), "--id", "bigsnap"], {
        stdout: "pipe", stderr: "ignore",
        env: { HOME: home, USER: "tester", XDG_STATE_HOME: join(home, "state"), PATH: process.env.PATH || "", INFOMARCHY_SKIP_EXTERNAL_IP: "1", OLLAMA_HOST: "http://127.0.0.1:9" },
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      expect(output.length).toBeGreaterThan(131072);
      const frames = output.trim().split("\n").map(line => JSON.parse(line));
      const end = frames[frames.length - 1];
      expect(end.type).toBe("end");
      const data = frames.filter(f => f.type === "chunk").map(f => f.data).join("");
      expect(data.length).toBe(end.chars);
      expect(JSON.parse(data).ai.recent.length).toBe(1000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("prompt text never leaves the machine by default", () => {
  test("only loopback Ollama hosts qualify for automatic topic refinement", () => {
    expect(ollamaHostIsLocal(undefined)).toBe(true);
    expect(ollamaHostIsLocal("http://127.0.0.1:11434")).toBe(true);
    expect(ollamaHostIsLocal("localhost:11434")).toBe(true);
    expect(ollamaHostIsLocal("http://[::1]:11434")).toBe(true);
    expect(ollamaHostIsLocal("http://100.68.193.41:11434")).toBe(false);
    expect(ollamaHostIsLocal("https://shared.example")).toBe(false);
    expect(ollamaHostIsLocal("not a url at all ::")).toBe(false);
    expect(topicRefinementAllowed({ OLLAMA_HOST: "http://100.68.193.41:11434" } as any)).toBe(false);
    expect(topicRefinementAllowed({ OLLAMA_HOST: "http://100.68.193.41:11434", INFOMARCHY_ALLOW_REMOTE_OLLAMA: "1" } as any)).toBe(true);
  });

  test("redaction covers env assignments, URLs, PEM, JWT and cloud keys", () => {
    expect(safePrompt("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe("AWS_SECRET_ACCESS_KEY=[redacted]");
    // Only the credential inside an authenticated URL is masked; the rest stays readable.
    expect(safePrompt("DATABASE_URL=postgres://admin:hunter2@example/db")).toBe("DATABASE_URL=postgres://admin:[redacted]@example/db");
    expect(safePrompt("connect to postgres://admin:hunter2@example/db please")).toBe("connect to postgres://admin:[redacted]@example/db please");
    expect(safePrompt("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----")).toBe("[redacted private key]");
    expect(safePrompt("header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toBe("header eyJ[redacted]");
    expect(safePrompt("key AKIAIOSFODNN7EXAMPLE used")).toBe("key AKIA[redacted] used");
    // Ordinary text with the same words is left alone.
    expect(safePrompt("rotate the api key in the secret manager")).toBe("rotate the api key in the secret manager");
  });
});

describe("third-pass findings (Astra, 2026-09-05)", () => {
  test("a deeply nested value smuggled into a passthrough field cannot blank the desk", () => {
    let pid: any = 1;
    for (let i = 0; i < 22; i++) pid = { x: pid };
    // Passes the input budget on its own, used to exceed depth once nested in the snapshot.
    expect(() => frameSnapshot({ ai: { providers: { grok: { active: [{ pid, cwd: "/tmp" }] } } } })).not.toThrow();
  });

  test("explicitly labeled credentials are redacted whatever their length", () => {
    expect(safePrompt("token: example_plain_secret_123")).toBe("token: [redacted]");
    expect(safePrompt("password: hunter2")).toBe("password: [redacted]");
    expect(safePrompt("the token bucket algorithm")).toBe("the token bucket algorithm");
  });

  test("only the executable identifies an agent unless it is an interpreter", () => {
    expect(providerOf(["cat", "/tmp/claude"])).toBeNull();
    expect(providerOf(["vim", "/home/x/notes/codex"])).toBeNull();
    expect(providerOf(["/usr/bin/claude", "--resume", "x"])).toBe("claude");
    expect(providerOf(["node", "/opt/claude.js"])).toBe("claude");
    expect(providerOf(["bun", "run", "/x/codex"])).toBe("codex");
  });

  test("history inference never hands out an id another live agent owns", () => {
    const sessions = [
      { provider: "codex", cwd: "~/p", startedAt: 1000, sessionIds: ["aaaaaaaa-bbbb-cccc-dddd-000000000001"], session: "aaaaaaaa-bbbb-cccc-dddd-000000000001" },
      { provider: "codex", cwd: "~/p", startedAt: 1000, sessionIds: [], session: "" },
    ];
    const recentRows = [{ provider: "codex", project: "~/p", session: "aaaaaaaa-bbbb-cccc-dddd-000000000001", ts: 2000, text: "x" }];
    inferSessionIdsFromRecent(sessions, recentRows);
    expect(sessions[1].sessionIds).toEqual([]);
  });
});

describe("firm subprocess deadlines", () => {
  test("a tool that ignores SIGTERM is SIGKILLed within the grace period and reaped", async () => {
    const proc = Bun.spawn(["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300); // let the child install its handler, as a real long-running tool has
    const started = performance.now();
    await terminate(proc, 200);
    expect(proc.signalCode).toBe("SIGKILL");
    expect(performance.now() - started).toBeLessThan(2000);
  });
  test("a tool that honours SIGTERM is not SIGKILLed", async () => {
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    await terminate(proc, 500);
    expect(proc.signalCode).toBe("SIGTERM");
  });
});

describe("API value estimate and daily token series", () => {
  test("the bundled price table loads and resolves plain or provider-prefixed model ids", () => {
    const table = loadPricing();
    expect(Object.keys(table).length).toBeGreaterThan(100);
    expect(rateForModel("claude-opus-5", table)).toBeTruthy();
    expect(rateForModel("gpt-6-astra", table)).toBeTruthy();
    expect(rateForModel("codex-auto-review", table)).toBeNull();
    expect(rateForModel("", table)).toBeNull();
  });

  test("estimates dollars from per-token rates and refuses partially priced usage", () => {
    const rate = { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000001, cache_creation_input_token_cost: 0.00000125 };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 10_000_000, cacheCreationInputTokens: 0 };
    expect(estimateValue(usage, rate)).toBeCloseTo(1 + 1 + 1, 6);
    // Used a cache field the table does not price → unpriced, not underpriced.
    expect(estimateValue(usage, { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 })).toBeNull();
    expect(estimateValue(usage, null)).toBeNull();
  });

  test("valueSummary separates priced from unpriced models and sums totals", () => {
    const table = { "m-priced": { input_cost_per_token: 0.00001, output_cost_per_token: 0.00005, cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost: 0.0000125 } };
    const summary = valueSummary({
      "m-priced": { inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "m-mystery": { inputTokens: 50_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }, table as any);
    expect(summary.value).toBeCloseTo(1 + 0.5, 6);
    expect(summary.pricedTokens).toBe(110_000);
    expect(summary.totalTokens).toBe(160_000);
    expect(summary.unpriced).toEqual(["m-mystery"]);
    expect(valueSummary({ "m-mystery": { inputTokens: 5 } }, table as any).value).toBeNull();
  });

  test("recentDays align onto the dashboard's seven local days with gaps as zero", () => {
    const stamp = new Date(2026, 8, 5, 12).getTime();
    const keys = [6, 5, 4, 3, 2, 1, 0].map(back => localDayKey(stamp - back * 86_400_000));
    expect(keys[6]).toBe("2026-09-05");
    const series = alignDailyTokens([{ date: "2026-09-05", messageCount: 80_146_806 }, { date: "2026-09-03", messageCount: 12 }, { date: "garbage", messageCount: 1 }, null], keys);
    expect(series).toEqual([0, 0, 0, 0, 12, 0, 80_146_806]);
  });
});

describe("today's value at the blended lifetime rate", () => {
  test("uses each model's own lifetime $/token; skips unpriced or unknown models", () => {
    const table = { m: { input_cost_per_token: 0.00001, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.00001, cache_creation_input_token_cost: 0.00001 } };
    const lifetime = { m: { inputTokens: 500_000, outputTokens: 500_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }; // $10 over 1M tokens → $10/M
    expect(todayValueEstimate({ m: 200_000, mystery: 999 }, lifetime, table as any)).toBeCloseTo(2, 6);
    expect(todayValueEstimate({ mystery: 999 }, lifetime, table as any)).toBeNull();
    expect(todayValueEstimate({ m: "junk" }, lifetime, table as any)).toBeNull();
  });
});

describe("Herdr-hosted agents get their client's window", () => {
  test("only the herdr CLIENT process counts, never the server or utility invocations", () => {
    const commands = new Map<number, string[]>([
      [10, ["/usr/bin/herdr", "server"]],
      [11, ["herdr"]],
      [12, ["/usr/bin/herdr", "--session", "work"]],
      [13, ["herdr", "api", "snapshot"]],
      [14, ["kitty"]],
    ]);
    expect(herdrClientPids(commands)).toEqual([11, 12]);
  });

  test("the session socket from the agent's environment is validated", () => {
    expect(herdrSocketFromEnvironment("HERDR_ENV=1\0HERDR_SOCKET_PATH=/home/u/.config/herdr/herdr.sock\0")).toBe("/home/u/.config/herdr/herdr.sock");
    expect(herdrSocketFromEnvironment("HERDR_SOCKET_PATH=relative.sock\0")).toBe("");
    expect(herdrSocketFromEnvironment("HERDR_SOCKET_PATH=/tmp/x.sock;rm -rf\0")).toBe("");
    expect(herdrSocketFromEnvironment("")).toBe("");
  });

  test("prefers the client attached to the same socket, else any client with a window", () => {
    const a = { address: "0xa" }, b = { address: "0xb" };
    const clients = [
      { pid: 1, socket: "/s/one.sock", window: a },
      { pid: 2, socket: "/s/two.sock", window: b },
      { pid: 3, socket: "/s/three.sock", window: null },
    ];
    expect(herdrWindowFor({ kind: "herdr", label: "", socket: "/s/two.sock" }, clients)).toBe(b);
    expect(herdrWindowFor({ kind: "herdr", label: "", socket: "/s/nine.sock" }, clients)).toBe(a);
    expect(herdrWindowFor({ kind: "herdr", label: "" }, clients)).toBe(a);
    expect(herdrWindowFor({ kind: "herdr", label: "" }, [clients[2]])).toBeNull();
  });
});
