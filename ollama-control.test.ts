import { describe, expect, test } from "bun:test";
import { controlOllama, normalizeOllamaHost, parseControlRequest, readBoundedInput } from "./ollama-control";

describe("Ollama model controls", () => {
  test("accepts only bounded model operations and sane HTTP hosts", () => {
    expect(parseControlRequest({ action: "load", model: "library/qwen3:8b-q4_K_M" })).toEqual({ action: "load", model: "library/qwen3:8b-q4_K_M" });
    expect(parseControlRequest({ action: "delete", model: "qwen3:8b" })).toBeNull();
    expect(parseControlRequest({ action: "load", model: "../../bad model" })).toBeNull();
    expect(normalizeOllamaHost("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaHost("file:///tmp/socket")).toBeNull();
    expect(normalizeOllamaHost("http://user:secret@host:11434")).toBeNull();
  });

  test("refuses models outside Ollama's current inventory", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ models: [{ name: "gemma3:4b" }] }), { status: 200 });
    const result = await controlOllama({ action: "load", model: "qwen3:8b" }, fakeFetch as typeof fetch);
    expect(result).toMatchObject({ ok: false, message: "Model is not installed" });
  });

  test("loads and unloads with the documented keep_alive contract", async () => {
    const bodies: any[] = [];
    const fakeFetch = async (input: any, init?: RequestInit) => {
      if (String(input).endsWith("/api/tags") || String(input).endsWith("/api/ps"))
        return new Response(JSON.stringify({ models: [{ name: "qwen3:8b" }] }), { status: 200 });
      bodies.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    };
    expect(await controlOllama({ action: "load", model: "qwen3:8b" }, fakeFetch as typeof fetch)).toMatchObject({ ok: true, action: "load" });
    expect(await controlOllama({ action: "unload", model: "qwen3:8b" }, fakeFetch as typeof fetch)).toMatchObject({ ok: true, action: "unload" });
    expect(bodies).toEqual([
      { model: "qwen3:8b", prompt: "", stream: false, keep_alive: -1 },
      { model: "qwen3:8b", prompt: "", stream: false, keep_alive: 0 },
    ]);
  });

  test("bounds stdin frames", async () => {
    async function* chunks() { yield new TextEncoder().encode("1234"); yield new TextEncoder().encode("5"); }
    expect(await readBoundedInput(chunks(), 4)).toBeNull();
  });
});
