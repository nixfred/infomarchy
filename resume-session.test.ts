import { describe, expect, test } from "bun:test";
import { resumeAgentCommand, terminalResumeCommand, validSessionId } from "./resume-session";

describe("provider-specific session resume", () => {
  test("builds the locally verified CLI command for every supported provider", () => {
    expect(resumeAgentCommand("codex", "session-123")).toEqual(["codex", "resume", "session-123"]);
    expect(resumeAgentCommand("claude", "session-123")).toEqual(["claude", "--resume", "session-123"]);
    expect(resumeAgentCommand("grok", "session-123")).toEqual(["grok", "--resume", "session-123"]);
    expect(resumeAgentCommand("opencode", "session-123")).toEqual(["opencode", "--session", "session-123"]);
  });

  test("rejects unsupported providers and unsafe identifiers", () => {
    expect(validSessionId("../bad;command")).toBe(false);
    expect(resumeAgentCommand("gemini", "session-123")).toBeNull();
    expect(resumeAgentCommand("codex", "../bad;command")).toBeNull();
  });

  test("passes cwd and agent arguments without shell concatenation", () => {
    expect(terminalResumeCommand("opencode", "ses_12345678", "~/Work folder", "/home/tester")).toEqual([
      "uwsm-app", "--", "xdg-terminal-exec", "--dir=/home/tester/Work folder", "opencode", "--session", "ses_12345678",
    ]);
  });
});


import { resumeAgentCommand as _cmd } from "./resume-session";
describe("background attach", () => {
  test("claude-attach opens the running background session, not a copy", () => {
    expect(_cmd("claude-attach", "2f866b35-c6d5-4204-a546-7d13608ae3ce")).toEqual(["claude", "attach", "2f866b35-c6d5-4204-a546-7d13608ae3ce"]);
    expect(_cmd("claude-attach", "short")).toBeNull();
  });
});
