import { describe, expect, test } from "bun:test";
import { processStartMs, sameProcess, validJobId } from "./stop-session";

describe("stop-session guards", () => {
  test("job ids are the short Claude job id or a full session id, nothing else", () => {
    expect(validJobId("2f866b35")).toBe("2f866b35");
    expect(validJobId("2f866b35-c6d5-4204-a546-7d13608ae3ce")).toBe("2f866b35-c6d5-4204-a546-7d13608ae3ce");
    expect(validJobId("short")).toBe("");
    expect(validJobId("2f866b35; rm -rf /")).toBe("");
    expect(validJobId("")).toBe("");
  });

  test("a pid is only ended when its start time and argv still match the card", async () => {
    // A real child we own, with an agent-looking argv[0] via a symlinked copy of sleep.
    const dir = (await import("fs")).mkdtempSync((await import("path")).join((await import("os")).tmpdir(), "infomarchy-stop-"));
    const fs = await import("fs"); const path = await import("path");
    const fake = path.join(dir, "claude"); fs.copyFileSync("/bin/sleep", fake); fs.chmodSync(fake, 0o755);
    const proc = Bun.spawn([fake, "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(150);
      const start = processStartMs(proc.pid)!;
      expect(start).toBeGreaterThan(0);
      expect(sameProcess(proc.pid, start)).toBe(true);
      // Wrong start time (a reused pid) → refused. Nonsense pid → refused.
      expect(sameProcess(proc.pid, start - 60_000)).toBe(false);
      expect(sameProcess(999_999_999, start)).toBe(false);
      expect(sameProcess(1, start)).toBe(false);
    } finally {
      proc.kill(); await proc.exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-agent process is refused even with a matching start time", async () => {
    const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(150);
      const start = processStartMs(proc.pid)!;
      expect(sameProcess(proc.pid, start)).toBe(false);
    } finally { proc.kill(); await proc.exited; }
  });
});
