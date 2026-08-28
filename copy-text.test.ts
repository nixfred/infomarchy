import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decodeClipboardFrame, MAX_CLIPBOARD_FRAME_BYTES } from "./copy-text";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("clipboard transport", () => {
  test("accepts one bounded JSON string frame", () => {
    expect(decodeClipboardFrame(new TextEncoder().encode(JSON.stringify("line one\nline two")))).toBe("line one\nline two");
    expect(decodeClipboardFrame(new TextEncoder().encode(JSON.stringify("bad\0text")))).toBeNull();
    expect(decodeClipboardFrame(new Uint8Array(MAX_CLIPBOARD_FRAME_BYTES + 1))).toBeNull();
    expect(decodeClipboardFrame(new TextEncoder().encode("not-json"))).toBeNull();
  });

  test("copies through stdin without exposing prompt text in process arguments", async () => {
    const directory = mkdtempSync(join(tmpdir(), "infomarchy-copy-test-"));
    cleanup.push(directory);
    const fakeBin = join(directory, "bin");
    const capture = join(directory, "capture");
    const frame = join(directory, "frame");
    mkdirSync(fakeBin, { mode: 0o700 });
    const fakeCopy = join(fakeBin, "wl-copy");
    writeFileSync(fakeCopy, "#!/bin/sh\ncat > \"$INFOMARCHY_CAPTURE\"\nsleep 0.5\n", { mode: 0o700 });
    chmodSync(fakeCopy, 0o700);
    const secret = "private prompt that must never enter argv";
    writeFileSync(frame, JSON.stringify(secret) + "\n", { mode: 0o600 });
    const proc = Bun.spawn(["bun", join(import.meta.dir, "copy-text.ts")], {
      stdin: Bun.file(frame),
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}`, INFOMARCHY_CAPTURE: capture },
    });
    expect(readFileSync(`/proc/${proc.pid}/cmdline`, "utf8")).not.toContain(secret);
    expect(await proc.exited).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe(secret);
  });

  test("QML launches the helper with a fixed argv and writes the payload to stdin", () => {
    const qml = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    expect(qml).toContain('command: ["bun", root.copyTextPath]');
    expect(qml).toContain("stdinEnabled: true");
    expect(qml).toContain('write(JSON.stringify(pendingText) + "\\n")');
    expect(qml).not.toContain('Quickshell.execDetached(["bun", root.copyTextPath, value])');
  });
});
