#!/usr/bin/env bun

export const MAX_CLIPBOARD_CHARS = 10_000;
export const MAX_CLIPBOARD_FRAME_BYTES = 64 * 1024;

export function decodeClipboardFrame(frame: Uint8Array): string | null {
  if (frame.byteLength === 0 || frame.byteLength > MAX_CLIPBOARD_FRAME_BYTES) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
    return typeof value === "string" && value.length > 0 && value.length <= MAX_CLIPBOARD_CHARS && !/\0/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

export async function readClipboardFrame(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  const bytes: number[] = [];
  try {
    while (bytes.length <= MAX_CLIPBOARD_FRAME_BYTES) {
      const { done, value } = await reader.read();
      if (done) return null;
      for (const byte of value) {
        if (byte === 0x0a) return decodeClipboardFrame(Uint8Array.from(bytes));
        bytes.push(byte);
        if (bytes.length > MAX_CLIPBOARD_FRAME_BYTES) return null;
      }
    }
    return null;
  } finally {
    reader.releaseLock();
  }
}

if (import.meta.main) {
  if (!Bun.which("wl-copy")) process.exit(2);
  const text = await readClipboardFrame(Bun.stdin.stream());
  if (!text) process.exit(2);
  const proc = Bun.spawn(["wl-copy"], { stdin: new Blob([text]), stdout: "ignore", stderr: "ignore" });
  process.exit(await proc.exited);
}
