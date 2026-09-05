#!/usr/bin/env bun
// End a stale agent session from the desk. Two modes, both explicit clicks:
//   claude-stop <job-id>            graceful: `claude stop <id>` (conversation kept, resumable)
//   term <pid> <startedAtMs>        SIGTERM a provider process — only if the pid still
//                                   belongs to the process the card described (start
//                                   time must match, argv must be an agent binary).
// Never SIGKILL, never automatic, never a pid we did not verify.
import { readFileSync } from "fs";

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const AGENT_BINARY = /(^|\/)(claude|codex|grok|gemini|hermes|opencode|aider|copilot|ollama)(\.js|\.mjs|\.cjs|\.py)?$/;
const START_TOLERANCE_MS = 2500;

export function validJobId(value: unknown): string {
  const id = String(value || "").trim();
  return JOB_ID.test(id) ? id : "";
}
export function processStartMs(pid: number, procRoot = "/proc"): number | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const btime = Number((readFileSync(`${procRoot}/stat`, "utf8").split("\n").find(l => l.startsWith("btime")) || "btime 0").split(" ")[1]);
    return (btime + Number(after[19]) / 100) * 1000;
  } catch { return null; }
}
export function processArgv(pid: number, procRoot = "/proc"): string[] {
  try { return readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { return []; }
}
// The card carries pid + startedAt. Both must still describe the same process.
export function sameProcess(pid: number, startedAtMs: number, procRoot = "/proc"): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(startedAtMs)) return false;
  const start = processStartMs(pid, procRoot);
  if (start === null || Math.abs(start - startedAtMs) > START_TOLERANCE_MS) return false;
  const argv = processArgv(pid, procRoot);
  return AGENT_BINARY.test(argv[0] || "") || (argv.length > 1 && AGENT_BINARY.test(argv[1] || ""));
}

if (import.meta.main) {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "claude-stop") {
    const id = validJobId(a);
    if (!id) process.exit(2);
    const proc = Bun.spawn(["claude", "stop", id], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill("SIGTERM"); } catch {} }, 15_000);
    const code = await proc.exited; clearTimeout(timer);
    process.exit(code === 0 ? 0 : 1);
  }
  if (mode === "term") {
    const pid = Number(a), startedAt = Number(b);
    if (!sameProcess(pid, startedAt)) process.exit(3);
    try { process.kill(pid, "SIGTERM"); process.exit(0); } catch { process.exit(1); }
  }
  process.exit(2);
}
