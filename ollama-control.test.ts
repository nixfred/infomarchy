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

  test("stops at the frame newline instead of waiting for EOF", async () => {
    // Quickshell never closes the helper's stdin. A reader that needs EOF
    // parses nothing until the shell exits.
    let pulled = 0;
    async function* endless() {
      yield new TextEncoder().encode('{"action":"unload",');
      yield new TextEncoder().encode('"model":"x:y"}\ntrailing garbage that must never be read');
      while (true) { pulled++; yield new TextEncoder().encode("x"); }
    }
    expect(await readBoundedInput(endless())).toBe('{"action":"unload","model":"x:y"}');
    expect(pulled).toBe(0);
  });

  test("the helper process exits promptly while stdin is still open", async () => {
    const proc = Bun.spawn(["bun", new URL("./ollama-control.ts", import.meta.url).pathname], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: { ...process.env, OLLAMA_HOST: "http://127.0.0.1:9" },
    });
    proc.stdin.write('{"action":"unload","model":"x:y"}\n');
    await proc.stdin.flush();
    // stdin deliberately left open — this is exactly what the shell does.
    const started = performance.now();
    const exit = await Promise.race([proc.exited, Bun.sleep(4000).then(() => "timeout" as const)]);
    proc.kill();
    expect(exit).not.toBe("timeout");
    expect(performance.now() - started).toBeLessThan(3500);
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(out.ok).toBe(false);
  });
});
