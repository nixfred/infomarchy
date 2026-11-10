#!/usr/bin/env bun

import { normalizeProjectDirectory } from "./session-actions";

const RESUME_COMMANDS: Record<string, (id: string) => string[]> = {
  codex: id => ["codex", "resume", id],
  claude: id => ["claude", "--resume", id],
  // A daemon-hosted background session: attach to the RUNNING session instead
  // of resuming a copy. "The session keeps running either way" (claude attach --help).
  "claude-attach": id => ["claude", "attach", id],
  grok: id => ["grok", "--resume", id],
  hermes: id => ["hermes", "--resume", id],
  opencode: id => ["opencode", "--session", id],
  pi: id => ["pi", "--session", id],
  omp: id => ["omp", "--resume", id],
  cursor: id => ["cursor-agent", "--resume", id],
};

export function validSessionId(value: unknown): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(String(value || ""));
}

export function resumeAgentCommand(provider: unknown, sessionId: unknown): string[] | null {
  const name = String(provider || "").toLowerCase();
  const id = String(sessionId || "");
  if (!validSessionId(id) || !RESUME_COMMANDS[name]) return null;
  return RESUME_COMMANDS[name](id);
}

// no-mistakes attaches to the pipeline run for a REPOSITORY, not to a session
// id, so this cannot go through RESUME_COMMANDS. Its workers have no terminal
// of their own (parent is `no-mistakes daemon run`, stdout a pipe), which is
// why the desk needs a way to open one.
export function daemonAttachCommand(owner: unknown, cwd: unknown, home = process.env.HOME || ""): string[] | null {
  if (String(owner || "") !== "no-mistakes") return null;
  const directory = normalizeProjectDirectory(cwd, home);
  if (!directory) return null;
  return ["uwsm-app", "--", "xdg-terminal-exec", "--dir=" + directory, "no-mistakes", "attach"];
}

export function terminalResumeCommand(provider: unknown, sessionId: unknown, cwd: unknown, home = process.env.HOME || ""): string[] | null {
  const agent = resumeAgentCommand(provider, sessionId);
  if (!agent) return null;
  const command = ["uwsm-app", "--", "xdg-terminal-exec"];
  const directory = normalizeProjectDirectory(cwd, home);
  if (directory) command.push("--dir=" + directory);
  command.push(...agent);
  return command;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "daemon-attach") {
    const command = daemonAttachCommand(args[1], args[2]);
    if (!command) process.exit(2);
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    process.exit(0);
  }
  const printOnly = args[0] === "--print";
  const offset = printOnly ? 1 : 0;
  const command = terminalResumeCommand(args[offset], args[offset + 1], args[offset + 2]);
  if (!command) {
    console.error("unsupported provider or invalid session id");
    process.exit(2);
  }
  if (printOnly) console.log(JSON.stringify(command));
  else {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
  }
}

