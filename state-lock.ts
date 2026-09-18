// flock holds the inherited descriptor's open-file description after the child
// exits. Closing our descriptor (also on crash) releases it. Never replace or
// unlink the lock inode. All reads and writes of a transaction run under it.
import { closeSync, constants, fstatSync, openSync } from "fs";
import { join } from "path";
import { ensurePrivateStateDir } from "./collector";

export function withStateLock<T>(directory: string, name: string, action: () => T): T {
  if (!/^[a-z-]+\.lock$/.test(name) || !ensurePrivateStateDir(directory)) throw new Error("Cannot lock settings");
  const fd = openSync(join(directory, name), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o077) || st.size !== 0)
      throw new Error("Invalid settings lock");
    const result = Bun.spawnSync(["/usr/bin/timeout", "-k", "1", "3", "/usr/bin/flock", "--wait", "2", "0"], {
      stdin: fd, stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" },
    });
    if (result.exitCode !== 0) throw new Error("Settings are busy; try again");
    return action();
  } finally { closeSync(fd); }
}
