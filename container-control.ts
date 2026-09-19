#!/usr/bin/env bun
// Start or stop one container from the desk. The name is framed over stdin
// and checked against a live `docker ps -a` / `podman ps -a` inventory before
// any mutation. Names are argv elements, never a shell string.

import { existsSync } from "fs";

export type ContainerAction = "start" | "stop";
export type ContainerEngine = "docker" | "podman";
export type ContainerControlRequest = { action: ContainerAction; name: string };
export type ContainerControlResult = {
  ok: boolean;
  action: string;
  name: string;
  message: string;
};
export type ContainerRow = {
  id: string;
  name: string;
  label: string;
  service: string;
  project: string;
  image: string;
  state: string;
  running: boolean;
  health: string;
};

export const DOCKER_BIN = "/usr/bin/docker";
export const PODMAN_BIN = "/usr/bin/podman";
export const MAX_CONTAINERS = 32;
export const MAX_INPUT_BYTES = 4096;
export const MAX_LIST_BYTES = 256 * 1024;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const STATE = /^[a-z]{1,16}$/;
const HEALTH = /^(healthy|unhealthy|starting)$/;

export type RunCommand = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

export function validContainerName(value: unknown): string {
  const name = String(value || "").trim();
  return CONTAINER_NAME.test(name) ? name : "";
}

export function containerEngine(which: (path: string) => boolean = existsSync): ContainerEngine | null {
  if (which(DOCKER_BIN)) return "docker";
  if (which(PODMAN_BIN)) return "podman";
  return null;
}

export function containerListArgv(engine: ContainerEngine): string[] {
  return engine === "docker"
    ? [DOCKER_BIN, "ps", "-a", "--format", "{{json .}}"]
    : [PODMAN_BIN, "ps", "-a", "--format", "json"];
}

export function containerMutateArgv(engine: ContainerEngine, action: ContainerAction, name: string): string[] {
  return [engine === "docker" ? DOCKER_BIN : PODMAN_BIN, action, "--", name];
}

export function parseControlRequest(value: unknown): ContainerControlRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = String((value as any).action || "");
  const name = validContainerName((value as any).name);
  if ((action !== "start" && action !== "stop") || !name) return null;
  return { action, name };
}

function slug(value: unknown, limit = 128): string {
  const text = String(value || "").trim().slice(0, limit);
  return CONTAINER_NAME.test(text) ? text : "";
}

function shortImage(value: unknown): string {
  const raw = String(value || "").trim().slice(0, 256);
  if (!raw || raw.includes("\0") || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  const noDigest = raw.replace(/@sha256:[a-f0-9]{64}$/i, "");
  const slash = noDigest.lastIndexOf("/");
  const name = slash >= 0 ? noDigest.slice(slash + 1) : noDigest;
  return name.slice(0, 64);
}

function composeField(labels: unknown, key: "project" | "service"): string {
  const needle = `com.docker.compose.${key}`;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    return slug((labels as any)[needle]);
  }
  const text = String(labels || "");
  const match = text.match(new RegExp(`${needle.replace(/\./g, "\\.")}=([^,]+)`));
  return slug(match?.[1]);
}

function firstName(value: unknown): string {
  if (Array.isArray(value)) return validContainerName(value[0]);
  const text = String(value || "").trim();
  return validContainerName(text.split(",")[0]);
}

function stateOf(row: any): string {
  const raw = row && typeof row === "object" ? row.State : "";
  const text = raw && typeof raw === "object"
    ? String(raw.Status || raw.status || raw.StatusText || "")
    : String(raw || "");
  const state = text.trim().toLowerCase().slice(0, 16);
  return STATE.test(state) ? state : "";
}

function healthOf(row: any, status: string): string {
  const raw = String(row?.HealthStatus || row?.Health || "").trim().toLowerCase();
  if (HEALTH.test(raw)) return raw;
  const match = String(status || "").match(/\((healthy|unhealthy|starting)\)/i);
  return match ? match[1].toLowerCase() : "";
}

function idOf(row: any): string {
  const raw = String(row?.ID || row?.Id || "").trim().toLowerCase();
  if (!CONTAINER_ID.test(raw)) return "";
  return raw.slice(0, 12);
}

export function parseContainerRecord(row: unknown): ContainerRow | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const item = row as any;
  const name = firstName(item.Names ?? item.Name);
  if (!name) return null;
  const state = stateOf(item);
  const status = String(item.Status || "");
  const project = composeField(item.Labels, "project");
  const service = composeField(item.Labels, "service");
  return {
    id: idOf(item),
    name,
    label: service || name,
    service,
    project,
    image: shortImage(item.Image),
    state,
    running: state === "running",
    health: healthOf(item, status),
  };
}

function recordsFrom(text: string): unknown[] {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, MAX_CONTAINERS + 1) : [];
    } catch { return []; }
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (out.length > MAX_CONTAINERS) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { out.push(JSON.parse(trimmed)); } catch {}
  }
  return out;
}

export function parseContainerList(text: string): ContainerRow[] {
  const seen = new Set<string>();
  const items: ContainerRow[] = [];
  for (const record of recordsFrom(text)) {
    if (items.length >= MAX_CONTAINERS) break;
    const row = parseContainerRecord(record);
    if (!row || seen.has(row.name)) continue;
    seen.add(row.name);
    items.push(row);
  }
  const projects = new Set(items.map(item => item.project).filter(Boolean));
  for (const item of items) {
    if (item.service) item.label = projects.size > 1 && item.project ? item.project + "/" + item.service : item.service;
  }
  items.sort((a, b) => Number(b.running) - Number(a.running) || a.label.localeCompare(b.label));
  return items;
}

async function defaultRun(argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    let expired: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<null>(resolve => { expired = setTimeout(() => resolve(null), timeoutMs); });
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = proc.stdout.getReader();
      const readAll = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_LIST_BYTES) { try { proc.kill("SIGKILL"); } catch {} return null; }
          chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder().decode(bytes);
      })();
      const out = await Promise.race([readAll, deadline]);
      if (out === null) {
        try { proc.kill("SIGTERM"); } catch {}
        await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, 250))]);
        try { proc.kill("SIGKILL"); } catch {}
        await Promise.race([proc.exited, new Promise(resolve => setTimeout(resolve, 250))]);
        return { code: 1, stdout: "" };
      }
      let grace: ReturnType<typeof setTimeout> | null = null;
      const code = await Promise.race([
        proc.exited,
        new Promise<number>(resolve => {
          grace = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch {}
            resolve(1);
          }, 2000);
        }),
      ]);
      if (grace) clearTimeout(grace);
      return { code: typeof code === "number" ? code : 1, stdout: out };
    } finally {
      if (expired) clearTimeout(expired);
    }
  } catch {
    return { code: 1, stdout: "" };
  }
}

export async function controlContainer(
  value: unknown,
  engine: ContainerEngine | null = containerEngine(),
  run: RunCommand = defaultRun,
): Promise<ContainerControlResult> {
  const request = parseControlRequest(value);
  if (!request) return { ok: false, action: "", name: "", message: "Invalid container control request" };
  if (!engine) return { ok: false, action: request.action, name: request.name, message: "No container engine" };

  const listed = await run(containerListArgv(engine), 3000);
  const items = parseContainerList(listed.stdout);
  const match = items.find(item => item.name === request.name);
  if (!match) return { ok: false, action: request.action, name: request.name, message: "Container is not in the live inventory" };
  if (request.action === "start" && match.running)
    return { ok: true, action: request.action, name: request.name, message: "Already running" };
  if (request.action === "stop" && !match.running)
    return { ok: true, action: request.action, name: request.name, message: "Already stopped" };

  const mutated = await run(containerMutateArgv(engine, request.action, match.name), request.action === "stop" ? 20000 : 15000);
  if (mutated.code !== 0) {
    return { ok: false, action: request.action, name: request.name, message: `Container ${request.action} failed` };
  }
  return {
    ok: true,
    action: request.action,
    name: request.name,
    message: request.action === "start" ? "Container started" : "Container stopped",
  };
}

export async function readBoundedInput(stream: AsyncIterable<Uint8Array | string>, limit = MAX_INPUT_BYTES): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    const newline = chunk.indexOf(0x0a);
    const piece = newline >= 0 ? chunk.subarray(0, newline) : chunk;
    total += piece.byteLength;
    if (total > limit) return null;
    chunks.push(piece);
    if (newline >= 0) break;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

if (import.meta.main) {
  let result: ContainerControlResult;
  const input = await readBoundedInput(process.stdin);
  try {
    result = input === null
      ? { ok: false, action: "", name: "", message: "Container control input exceeded 4 KiB" }
      : await controlContainer(JSON.parse(input));
  } catch {
    result = { ok: false, action: "", name: "", message: "Invalid container control frame" };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}
