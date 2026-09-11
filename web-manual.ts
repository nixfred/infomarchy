// Existing-certificate HTTPS. No issuance, trust-store mutation, DNS or downloads.
import { X509Certificate, createPrivateKey } from "crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "fs";
import { isIP } from "net";
import { join } from "path";
import { parseJsonBounded, readRegularFileLimited } from "./collector";

export type ManualHttps = { hostname: string; bind: string; port: number; certPath: string; keyPath: string; fingerprint: string };
export const MANUAL_PORT = 8789;
const fail = (message: string): never => { throw new Error(message); };
export function manualHostname(value: unknown): string {
  if (typeof value !== "string") return "";
  const host = value.trim().toLowerCase();
  if (isIP(host) === 4) return privateBind(host) ? host : "";
  if (/^[0-9.]+$/.test(host)) return "";
  return host.length <= 253 && !isIP(host) && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : "";
}
export function privateBind(value: unknown): boolean {
  if (typeof value !== "string" || isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export function parseManualHttps(raw: any): ManualHttps | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const hostname = manualHostname(raw.hostname), port = Number(raw.port);
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint.trim().replace(/:/g, "").toLowerCase() : "";
  const pathOk = (p: unknown) => typeof p === "string" && p.startsWith("/") && p.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(p) && p.split("/").slice(1).every(s => s && s !== "." && s !== "..");
  if (!hostname || !privateBind(raw.bind) || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      !pathOk(raw.certPath) || !pathOk(raw.keyPath) || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
  return { hostname, bind: raw.bind, port, certPath: raw.certPath, keyPath: raw.keyPath, fingerprint };
}
export function manualOrigin(config: ManualHttps): string { return `https://${config.hostname}:${config.port}`; }
export function validManualOrigin(value: string): boolean {
  try { const u = new URL(value); return !!manualHostname(u.hostname) && Number(u.port) >= 1024 && Number(u.port) <= 65535 && value === `https://${u.hostname}:${u.port}`; }
  catch { return false; }
}
export function readManualPrefs(): unknown {
  const directory = join(process.env.XDG_STATE_HOME || join(process.env.HOME || "/", ".local/state"), "infomarchy");
  const raw = readRegularFileLimited(join(directory, "dashboard.json"), 256 * 1024);
  return raw ? parseJsonBounded(raw, 20000, 16)?.manualHttps : null;
}

// Hold every parent descriptor: the bytes validated below are the bytes passed
// to TLS, never Bun.file(path) reopening a changed key after validation.
function readPem(path: string, secret: boolean): Buffer {
  const label = secret ? "private key" : "certificate chain";
  const parts = path.split("/").slice(1);
  let dir = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  let fd = -1;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = openSync(`/proc/self/fd/${dir}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      closeSync(dir); dir = next;
      const st = fstatSync(dir);
      if (![0, process.getuid!()].includes(st.uid) || ((st.mode & 0o022) && !(st.uid === 0 && (st.mode & 0o1000)))) fail(`Untrusted ${label} directory. Use a protected directory without symlinks.`);
    }
    fd = openSync(`/proc/self/fd/${dir}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd), limit = secret ? 32768 : 131072;
    if (!st.isFile() || ![0, process.getuid!()].includes(st.uid) || st.nlink !== 1 || (st.mode & (secret ? 0o077 : 0o022)) || st.size > limit)
      fail(`Unsafe ${label} file. Use a bounded regular file; the private key must have mode 0600 or 0400.`);
    const buf = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buf.length) { const n = readSync(fd, buf, total, buf.length - total, null); if (!n) break; total += n; }
    if (total > limit) fail(`${label} file is too large.`);
    return buf.subarray(0, total);
  } finally { if (fd >= 0) closeSync(fd); closeSync(dir); }
}
export function loadManualTls(raw: unknown, now = Date.now()) {
  const config = parseManualHttps(raw);
  if (!config) fail("Complete Manual HTTPS: hostname or private IPv4 address, private bind address, port (1024–65535), certificate/key paths and SHA-256 fingerprint.");
  let cert: Buffer, key: Buffer;
  try { cert = readPem(config.certPath, false); key = readPem(config.keyPath, true); }
  catch { fail("Cannot safely read certificate/key files. Check paths, symlinks, ownership and private-key permissions (0600 or 0400)."); }
  try {
    const pem = cert.toString("utf8"), matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    if (!matches.length || matches.length > 8 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) fail("Use a PEM certificate chain, leaf certificate first (at most eight certificates).");
    const chain = matches.map(p => new X509Certificate(p)), leaf = chain[0];
    if (leaf.fingerprint256.replace(/:/g, "").toLowerCase() !== config.fingerprint) fail("Certificate SHA-256 fingerprint mismatch. Confirm the intended certificate before updating the fingerprint.");
    if (chain.some(c => !(Date.parse(c.validFrom) <= now && now < Date.parse(c.validTo)))) fail("Certificate chain is expired or not yet valid. Install a valid certificate and retry.");
    const identityMatches = isIP(config.hostname) === 4 ? leaf.checkIP(config.hostname) : leaf.checkHost(config.hostname, { subject: "never", partialWildcards: false });
    if (leaf.ca || !identityMatches) fail("The server certificate must cover the configured hostname or IP address in its matching DNS or IP subject alternative names.");
    if (!leaf.checkPrivateKey(createPrivateKey(key))) fail("The private key does not match the server certificate.");
    for (let i = 0; i + 1 < chain.length; i++) if (!chain[i + 1].ca || !chain[i].verify(chain[i + 1].publicKey)) fail("Certificate chain is not in leaf-to-issuer order or its signatures do not match.");
    return { config, origin: manualOrigin(config), tls: { cert, key }, expiresAt: Math.min(...chain.map(c => Date.parse(c.validTo))) };
  } catch (e) {
    key.fill(0);
    // Never expose crypto/parser errors: they may embed PEM input.
    const message = e instanceof Error ? e.message : "";
    if (/^(Use a PEM|Certificate SHA-256|Certificate chain is|The server certificate|The private key does)/.test(message)) throw e;
    fail("Cannot parse the certificate/private key. Use a PEM certificate chain and an unencrypted PEM private key.");
  }
}

if (import.meta.main) {
  try { loadManualTls(readManualPrefs()); console.log(JSON.stringify({ ok: true, message: "Certificate, key, hostname and fingerprint match. Client trust and DNS are managed separately." })); }
  catch (e) { console.log(JSON.stringify({ ok: false, message: e instanceof Error ? e.message : "Manual HTTPS validation failed." })); }
}
