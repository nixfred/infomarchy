#!/usr/bin/env bun

const RESUME_COMMANDS: Record<string, (id: string) => string[]> = {
  codex: id => ["codex", "resume", id],
  claude: id => ["claude", "--resume", id],
  grok: id => ["grok", "--resume", id],
  opencode: id => ["opencode", "--session", id],
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

export function terminalResumeCommand(provider: unknown, sessionId: unknown, cwd: unknown, home = process.env.HOME || ""): string[] | null {
  const agent = resumeAgentCommand(provider, sessionId);
  if (!agent) return null;
  let directory = String(cwd || "").trim();
  if (directory === "~") directory = home;
  else if (directory.startsWith("~/")) directory = home + directory.slice(1);
  const command = ["uwsm-app", "--", "xdg-terminal-exec"];
  if (directory) command.push("--dir=" + directory);
  command.push(...agent);
  return command;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
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

