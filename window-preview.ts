#!/usr/bin/env bun
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_RAW_CAPTURE_BYTES = 32 * 1024 * 1024;

export interface PreviewTarget {
  directory: string;
  path: string;
  fd: number;
}

export function validWindowAddress(value: unknown): string | null {
  const address = String(value || "").toLowerCase();
  return /^0x[0-9a-f]+$/.test(address) ? address : null;
}

export const PREVIEW_PREFIX = "infomarchy-preview-";
export const PREVIEW_TTL_MS = 5 * 60 * 1000;

// Only names mkdtemp could have produced: prefix + exactly six [A-Za-z0-9].
// A prefix-only check would have recursively deleted any same-prefix
// directory the user happened to own.
export const PREVIEW_DIR_NAME = /^infomarchy-preview-[A-Za-z0-9]{6}$/;
export function expiredPreviewDirectories(names: string[], ages: Record<string, number>, ttlMs = PREVIEW_TTL_MS): string[] {
  return names.filter(name => PREVIEW_DIR_NAME.test(name) && Number(ages[name] ?? 0) > ttlMs);
}
// A directory is ours only if it holds nothing but the preview file we write.
export function looksLikeOurPreviewDirectory(entries: string[]): boolean {
  return entries.length <= 1 && entries.every(entry => entry === "preview.png");
}

// A successful capture keeps its directory so QML can load the PNG; nothing
// used to delete it, so sustained hover leaked one directory every few seconds.
// Sweep our own stale ones on each run instead of holding a daemon.
export function reapPreviewDirectories(baseDirectory = tmpdir(), ttlMs = PREVIEW_TTL_MS, stamp = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try { names = readdirSync(baseDirectory); } catch { return 0; }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!PREVIEW_DIR_NAME.test(name)) continue;
    const path = join(baseDirectory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (uid !== undefined && stat.uid !== uid) continue;
      if (stamp - stat.mtimeMs <= ttlMs) continue;
      if (!looksLikeOurPreviewDirectory(readdirSync(path))) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

export function createPreviewTarget(baseDirectory = tmpdir()): PreviewTarget {
  const directory = mkdtempSync(join(baseDirectory, "infomarchy-preview-"));
  try {
    chmodSync(directory, 0o700);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== (process.getuid?.() ?? stat.uid) || (stat.mode & 0o777) !== 0o700) {
      throw new Error("unsafe preview directory");
    }
    const path = join(directory, "preview.png");
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    return { directory, path, fd };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

const STAGE_TIMEOUT_MS = 4000;
// A hung hyprctl/grim/magick used to leave the QML preview Process running
// forever. Every stage gets a deadline; on expiry the child is killed and the
// helper exits non-zero.
async function withDeadline<T>(promise: Promise<T>, proc: { kill: (signal?: any) => void }, ms = STAGE_TIMEOUT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expiry = new Promise<null>(resolve => { timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(null); }, ms); });
  try { return await Promise.race([promise, expiry]); }
  finally { if (timer) clearTimeout(timer); }
}
async function readBounded(stream: ReadableStream<Uint8Array>, limit = MAX_PREVIEW_BYTES): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("preview output limit exceeded");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

if (import.meta.main) {
  const address = validWindowAddress(process.argv[2]);
  if (!address || !Bun.which("grim") || !Bun.which("magick")) process.exit(2);
  const clientsProc = Bun.spawn(["hyprctl", "clients", "-j"], { stdout: "pipe", stderr: "ignore" });
  const clientsRaw = await withDeadline(readBounded(clientsProc.stdout, MAX_PREVIEW_BYTES), clientsProc);
  if (!clientsRaw) process.exit(6);
  let clients: any[] = [];
  try { const parsed = JSON.parse(new TextDecoder().decode(clientsRaw)); clients = Array.isArray(parsed) ? parsed : []; } catch { process.exit(6); }
  const client = clients.find((item: any) => item && typeof item === "object" && String(item.address || "").toLowerCase() === address);
  const at = client?.at, size = client?.size;
  if (!Array.isArray(at) || !Array.isArray(size) || size[0] < 20 || size[1] < 20) process.exit(3);
  reapPreviewDirectories();
  const target = createPreviewTarget();
  let keepTarget = false;
  try {
    const geometry = `${at[0]},${at[1]} ${size[0]}x${size[1]}`;
    const grim = Bun.spawn(["grim", "-g", geometry, "-"], { stdout: "pipe", stderr: "ignore" });
    const grimResult = await withDeadline(Promise.all([grim.exited, readBounded(grim.stdout, MAX_RAW_CAPTURE_BYTES)]), grim);
    const [grimExit, raw] = grimResult || [1, new Uint8Array(0)];
    if (grimExit !== 0 || raw.byteLength === 0) process.exitCode = 4;
    else {
      const magick = Bun.spawn(
        ["magick", "png:-", "-resize", "160x90!", "-blur", "0x10", "-scale", "320x180!", "png:-"],
        { stdin: new Blob([raw]), stdout: "pipe", stderr: "ignore" },
      );
      const magickResult = await withDeadline(Promise.all([magick.exited, readBounded(magick.stdout)]), magick);
      const [magickExit, preview] = magickResult || [1, new Uint8Array(0)];
      if (magickExit !== 0 || preview.byteLength === 0) process.exitCode = 5;
      else {
        let offset = 0;
        while (offset < preview.byteLength) offset += writeSync(target.fd, preview, offset);
        fsyncSync(target.fd);
        keepTarget = true;
        console.log(target.path);
      }
    }
  } finally {
    closeSync(target.fd);
    if (!keepTarget) rmSync(target.directory, { recursive: true, force: true });
  }
}
