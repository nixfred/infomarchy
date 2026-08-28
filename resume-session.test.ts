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

