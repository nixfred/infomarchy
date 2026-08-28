import { describe, expect, test } from "bun:test";
import { normalizeProjectDirectory, projectTerminalCommand } from "./session-actions";

describe("live-session project actions", () => {
  test("opens a home-relative project without shell concatenation", () => {
    expect(projectTerminalCommand("~/Work folder", "/home/tester")).toEqual([
      "uwsm-app", "--", "xdg-terminal-exec", "--dir=/home/tester/Work folder",
    ]);
  });

  test("keeps an absolute directory as one process argument", () => {
    expect(projectTerminalCommand("/tmp/a project", "/home/tester")).toEqual([
      "uwsm-app", "--", "xdg-terminal-exec", "--dir=/tmp/a project",
    ]);
  });

  test("rejects unavailable and malformed project directories", () => {
    expect(normalizeProjectDirectory("relative/path", "/home/tester")).toBeNull();
    expect(normalizeProjectDirectory("/tmp/project\n--bad", "/home/tester")).toBeNull();
    expect(projectTerminalCommand("", "/home/tester")).toBeNull();
  });
});
