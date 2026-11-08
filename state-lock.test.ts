import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { withStateLock } from "./state-lock";

// withStateLock shells out to hard-coded /usr/bin/timeout and /usr/bin/flock; tests that must get
// past the flock step are skipped on hosts without them (e.g. NixOS session containers).
const hasFlock = existsSync("/usr/bin/flock") && existsSync("/usr/bin/timeout");
const lockedTest = test.skipIf(!hasFlock);

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "infomarchy-lock-test-"));
  chmodSync(directory, 0o700);
  cleanup.push(directory);
  return directory;
}

describe("withStateLock", () => {
  lockedTest("returns the action's value and runs the action once", () => {
    const directory = freshDirectory();
    let calls = 0;
    let heldInside = false;
    const value = withStateLock(directory, "test.lock", () => {
      calls += 1;
      // a second, independent flock on the same file is refused while the action runs: the lock really is held
      heldInside = Bun.spawnSync(["/usr/bin/flock", "--nonblock", join(directory, "test.lock"), "true"]).exitCode !== 0;
      return { answer: 42 };
    });
    expect(value).toEqual({ answer: 42 });
    expect(calls).toBe(1);
    expect(heldInside).toBe(true);
  });

  test("rejects lock names outside ^[a-z-]+\\.lock$ without running the action", () => {
    const directory = freshDirectory();
    let ran = false;
    for (const name of ["bad_name.lock", "../x.lock", "UPPER.lock", "plain", "a.lock.extra", ""]) {
      expect(() => withStateLock(directory, name, () => { ran = true; })).toThrow("Cannot lock settings");
    }
    expect(ran).toBe(false);
  });

  lockedTest("creates the lock file with mode 0600 and size 0", () => {
    const directory = freshDirectory();
    const previousUmask = process.umask(0o022); // the file is created with mode 0600 & ~umask: pin the umask so the check is not ambient
    try { withStateLock(directory, "fresh.lock", () => undefined); } finally { process.umask(previousUmask); }
    const st = statSync(join(directory, "fresh.lock"));
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.size).toBe(0);
  });

  test("refuses a lock file with group/other bits or content", () => {
    const loose = freshDirectory();
    writeFileSync(join(loose, "loose.lock"), "", { mode: 0o600 });
    chmodSync(join(loose, "loose.lock"), 0o640);
    let ran = false;
    expect(() => withStateLock(loose, "loose.lock", () => { ran = true; })).toThrow("Invalid settings lock");

    const other = freshDirectory();
    writeFileSync(join(other, "other.lock"), "", { mode: 0o600 });
    chmodSync(join(other, "other.lock"), 0o602);
    expect(() => withStateLock(other, "other.lock", () => { ran = true; })).toThrow("Invalid settings lock");

    const full = freshDirectory();
    writeFileSync(join(full, "full.lock"), "x", { mode: 0o600 });
    expect(() => withStateLock(full, "full.lock", () => { ran = true; })).toThrow("Invalid settings lock");

    expect(ran).toBe(false);
    expect(existsSync(join(full, "full.lock"))).toBe(true);
  });

  lockedTest("releases the lock when the action throws", () => {
    const directory = freshDirectory();
    expect(() => withStateLock(directory, "boom.lock", () => { throw new Error("action failed"); })).toThrow("action failed");
    expect(withStateLock(directory, "boom.lock", () => "again")).toBe("again");
  });
});
