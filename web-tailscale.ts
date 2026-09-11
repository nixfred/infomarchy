// No credentials or raw CLI output leave this helper. Status is read-only.
import { existsSync } from "fs";
import { join } from "path";
import { parseJsonBounded } from "./collector";

export const SERVE_PORT = 8788;
export type TailStatus = { ok: boolean; state: string; message: string; origin: string };
const failure = (state: string, message: string): TailStatus => ({ ok: false, state, message, origin: "" });

export function tailOrigin(name: unknown): string {
  const host = String(name || "").replace(/\.$/, "").toLowerCase();
  return host.length <= 200 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/.test(host)
    ? `https://${host}:${SERVE_PORT}` : "";
}

export async function boundedCommand(args: string[], cap = 262144, timeout = 4000, includeStderr = false): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try { proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: includeStderr ? "pipe" : "ignore", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME || "/" } }); }
  catch { return null; }
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > cap) { proc.kill("SIGKILL"); throw new Error("output limit"); }
        chunks.push(chunk);
      }
    };
    await Promise.all([collect(proc.stdout as ReadableStream<Uint8Array>),
      includeStderr ? collect(proc.stderr as ReadableStream<Uint8Array>) : Promise.resolve()]);
    return await proc.exited === 0 ? Buffer.concat(chunks).toString("utf8") : null;
  } catch { return null; }
  finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
}

// Reject any use of our port, including nested foreground sessions and Funnel.
// Unrelated listeners are retained by the CLI's foreground configuration.
export function portOccupied(config: any, port = SERVE_PORT): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) return true;
  if (Object.hasOwn(config.TCP || {}, String(port))) return true;
  for (const field of ["Web", "AllowFunnel"]) {
    if (Object.keys(config[field] || {}).some(k => k.endsWith(":" + port))) return true;
  }
  return Object.values(config.Foreground || {}).some(c => portOccupied(c, port));
}

export function assessTailscale(status: any, config: any, help: string): TailStatus {
  if (!status || typeof status !== "object") return failure("unavailable", "Cannot read Tailscale status. Start tailscaled and check local permissions.");
  if (status.BackendState === "NeedsLogin" || status.BackendState === "NeedsMachineAuth")
    return failure("login", "Sign in with tailscale up and complete any device approval, then check again.");
  if (status.BackendState !== "Running" || status.Self?.Online !== true)
    return failure("stopped", "Tailscale is not connected. Start tailscaled and connect with tailscale up, then check again.");
  const origin = tailOrigin(status.Self?.DNSName);
  if (!origin) return failure("dns", "Enable MagicDNS and HTTPS certificates in your Tailscale admin console, then check again.");
  if (!help.includes("--https") || !help.includes("--bg"))
    return failure("version", "This Tailscale CLI does not advertise the required Serve options. Update Tailscale, then check again.");
  if (!config || typeof config !== "object" || Array.isArray(config))
    return failure("config", "Cannot inspect Serve configuration. Check tailscale serve status --json and local permissions.");
  if (portOccupied(config)) return failure("conflict", "HTTPS port 8788 already has a Serve or Funnel mapping. Existing services were left untouched; free that port before setup.");
  return { ok: true, state: "ready", message: "Ready to configure private HTTPS on port 8788. Enable HTTPS certificates in the admin console if prompted by Tailscale.", origin };
}

export async function inspectTailscale(): Promise<TailStatus> {
  if (!existsSync("/usr/bin/tailscale")) return failure("missing", "Install Tailscale on this computer, start tailscaled, and sign in. Then check again.");
  const [status, config, help] = await Promise.all([
    boundedCommand(["/usr/bin/tailscale", "status", "--json"]),
    boundedCommand(["/usr/bin/tailscale", "serve", "status", "--json"]),
    boundedCommand(["/usr/bin/tailscale", "serve", "--help"], 65536, 4000, true),
  ]);
  return assessTailscale(status ? parseJsonBounded(status, 20000, 12) : null,
    config ? parseJsonBounded(config, 20000, 12) || (config.trim() === "null" ? {} : null) : null, help || "");
}

export function startServe(port: number) {
  // Python execs tailscale with a parent-death signal, rather than detaching it.
  return Bun.spawn(["/usr/bin/python3", "-I", "-S", join(import.meta.dir, "web-child.py"), String(process.pid), String(port)],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME || "/" } });
}

export async function serveMappingReady(origin: string, port: number): Promise<boolean> {
  const raw = await boundedCommand(["/usr/bin/tailscale", "serve", "status", "--json"]);
  const config = raw ? parseJsonBounded(raw, 20000, 12) : null;
  return mappingReady(config, origin, port);
}

export function mappingReady(config: any, origin: string, port: number): boolean {
  if (!config) return false;
  const host = new URL(origin).host;
  if (config.AllowFunnel?.[host]) return false;
  // Only our foreground mapping qualifies. Never adopt an existing background service.
  return Object.values(config.Foreground || {}).some((c: any) =>
    c?.TCP?.[String(SERVE_PORT)]?.HTTPS === true &&
    c?.Web?.[host]?.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${port}` &&
    !Object.values(c.AllowFunnel || {}).some(Boolean));
}

if (import.meta.main) {
  const status = await inspectTailscale();
  // Hostname is not needed by the settings UI.
  const { origin, ...publicStatus } = status;
  console.log(JSON.stringify(publicStatus));
}
