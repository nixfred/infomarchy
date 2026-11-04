#!/usr/bin/env bun
// Bring an agent's Orca tab to the foreground: `orca terminal switch <handle>`.
//
// Orca hands every terminal it opens an ORCA_TERMINAL_HANDLE, and the agent
// running inside inherits it, so the handle in /proc/<pid>/environ addresses
// the exact tab that agent is typing into. That is the whole mechanism; the
// CLI does the window management.
//
// WHY THIS EXISTS AT ALL: an Orca-hosted agent also inherits whatever terminal
// Orca itself was launched from. On this desk Orca was started from a Herdr
// pane, so all six Orca agents carried the SAME HERDR_PANE_ID (w30:p1) and the
// desk sent every one of their clicks to that one pane. The card looked broken
// while pointing at a real, live pane. Orca wins over inherited multiplexer
// variables in sessionHostsFromEnvironment for that reason.
import { existsSync } from "fs";
export const ORCA_TIMEOUT_MS = 4000;
// term_ plus a v4 UUID, which is what Orca 1.4 issues. Checked here even though
// InfoModel.qml checks it too, because this is where it becomes a command.
const HANDLE = /^term_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function validOrcaHandle(value: unknown): string {
  const handle = String(value || "").trim();
  return HANDLE.test(handle) ? handle : "";
}

// The desk inherits the compositor's PATH, not a login shell's. Orca installs
// as an AppImage symlinked into ~/bin, which is on PATH on this desk but is
// not guaranteed anywhere else, so resolve it rather than hoping.
export function resolveOrcaBinary(home = process.env.HOME || ""): string {
  const found = typeof Bun !== "undefined" ? Bun.which("orca") : "";
  if (found) return found;
  for (const candidate of [home ? home + "/bin/orca" : "", "/usr/local/bin/orca", "/usr/bin/orca"]) {
    try { if (candidate && existsSync(candidate)) return candidate; } catch {}
  }
  return "orca";
}

export function orcaSwitchArgv(handle: unknown, binary = "orca"): string[] {
  const id = validOrcaHandle(handle);
  // The handle is a FLAG, not a positional: `orca terminal switch <id>`
  // answers "Unknown command" and still exits 0, so a positional call looks
  // like a successful jump while doing nothing. Verified against orca 1.4.217.
  return id ? [binary, "terminal", "switch", "--terminal", id] : [];
}

// Resolves true only when the CLI exits 0. A handle for a tab Orca has since
// closed exits non-zero, and the caller treats that as "no jump" rather than
// pretending the click worked.
export async function switchToOrcaTerminal(handle: unknown, timeoutMs = ORCA_TIMEOUT_MS, binary = resolveOrcaBinary()): Promise<boolean> {
  const argv = orcaSwitchArgv(handle, binary);
  if (!argv.length) return false;
  try {
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    const code = await child.exited;
    clearTimeout(timer);
    return code === 0;
  } catch { return false; }
}

if (import.meta.main) {
  const ok = await switchToOrcaTerminal(process.argv[2]);
  process.exit(ok ? 0 : 1);
}
