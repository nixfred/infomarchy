#!/usr/bin/env bun

export function normalizeProjectDirectory(value: unknown, home = process.env.HOME || ""): string | null {
  let directory = String(value || "").trim();
  if (!directory || directory.length > 4096 || /[\0\r\n]/.test(directory)) return null;
  if (directory === "~") directory = home;
  else if (directory.startsWith("~/")) directory = home + directory.slice(1);
  if (!directory.startsWith("/")) return null;
  return directory;
}

export function projectTerminalCommand(value: unknown, home = process.env.HOME || ""): string[] | null {
  const directory = normalizeProjectDirectory(value, home);
  return directory ? ["uwsm-app", "--", "xdg-terminal-exec", "--dir=" + directory] : null;
}

if (import.meta.main) {
  const command = projectTerminalCommand(process.argv[2]);
  if (!command) {
    console.error("invalid project directory");
    process.exit(2);
  }
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}
