#!/usr/bin/env bun

export type OllamaAction = "load" | "unload";
export type OllamaControlRequest = { action: OllamaAction; model: string };
export type OllamaControlResult = {
  ok: boolean;
  action: string;
  model: string;
  message: string;
};

const MAX_INPUT_BYTES = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export function normalizeOllamaHost(raw: unknown): string | null {
  const value = String(raw || "http://127.0.0.1:11434").trim();
  try {
    const url = new URL(value.startsWith("http://") || value.startsWith("https://") ? value : `http://${value}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch { return null; }
}

export function parseControlRequest(value: unknown): OllamaControlRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = String((value as any).action || "");
  const model = String((value as any).model || "");
  if ((action !== "load" && action !== "unload") || !MODEL_NAME.test(model)) return null;
  return { action, model };
}

async function boundedJson(response: Response): Promise<any> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function namesFrom(payload: any): Set<string> {
  const result = new Set<string>();
  for (const item of Array.isArray(payload?.models) ? payload.models.slice(0, 256) : []) {
    const name = String(item?.name || item?.model || "");
    if (MODEL_NAME.test(name)) result.add(name);
  }
  return result;
}

export async function controlOllama(
  value: unknown,
  transport: typeof fetch = fetch,
  hostValue: unknown = process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
): Promise<OllamaControlResult> {
  const request = parseControlRequest(value);
  const host = normalizeOllamaHost(hostValue);
  if (!request) return { ok: false, action: "", model: "", message: "Invalid Ollama control request" };
  if (!host) return { ok: false, action: request.action, model: request.model, message: "Invalid OLLAMA_HOST" };

  try {
    const inventoryPath = request.action === "load" ? "/api/tags" : "/api/ps";
    const inventoryResponse = await transport(host + inventoryPath, { signal: AbortSignal.timeout(3000) });
    const inventory = inventoryResponse.ok ? await boundedJson(inventoryResponse) : null;
    if (!inventory) return { ok: false, action: request.action, model: request.model, message: "Ollama inventory is unavailable" };
    const names = namesFrom(inventory);
    if (!names.has(request.model)) {
      return {
        ok: false,
        action: request.action,
        model: request.model,
        message: request.action === "load" ? "Model is not installed" : "Model is not loaded",
      };
    }

    const response = await transport(host + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, prompt: "", stream: false, keep_alive: request.action === "load" ? -1 : 0 }),
      signal: AbortSignal.timeout(120000),
    });
    // Consume and bound the response even though no generated text is needed.
    const payload = response.ok ? await boundedJson(response) : null;
    if (!response.ok || !payload) {
      return { ok: false, action: request.action, model: request.model, message: `Ollama ${request.action} failed (HTTP ${response.status})` };
    }
    return {
      ok: true,
      action: request.action,
      model: request.model,
      message: request.action === "load" ? "Model loaded and pinned" : "Model unloaded",
    };
  } catch {
    return { ok: false, action: request.action, model: request.model, message: "Ollama request timed out or failed" };
  }
}

// Quickshell keeps the helper's stdin open for the life of the Process, so a
// reader that waits for EOF never returns: the request was parsed only after
// the shell exited, the card stayed on WORKING forever and a bun process was
// left behind per click. The frame is newline-terminated (see InfoModel.qml),
// so stop at the first newline exactly like copy-text.ts does.
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
  let result: OllamaControlResult;
  const input = await readBoundedInput(process.stdin);
  try {
    result = input === null
      ? { ok: false, action: "", model: "", message: "Ollama control input exceeded 4 KiB" }
      : await controlOllama(JSON.parse(input));
  } catch {
    result = { ok: false, action: "", model: "", message: "Invalid Ollama control frame" };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  // Exit explicitly: the still-open stdin pipe from Quickshell would otherwise
  // keep the event loop alive, and StdioCollector{waitForEnd} never fires.
  process.exit(result.ok ? 0 : 1);
}
