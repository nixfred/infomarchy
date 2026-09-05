import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { herdrFocusRequests, sendHerdrRequests, validHerdrSocket } from "./herdr-focus";

describe("Herdr focus helper", () => {
  test("socket path must be an absolute .sock without whitespace; empty means the default", () => {
    expect(validHerdrSocket("/home/u/.config/herdr/herdr.sock", "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
    expect(validHerdrSocket("", "/home/u")).toBe("/home/u/.config/herdr/herdr.sock");
    expect(validHerdrSocket("relative.sock", "/home/u")).toBe("");
    expect(validHerdrSocket("/tmp/x.sock; rm -rf", "/home/u")).toBe("");
    expect(validHerdrSocket("/tmp/notasocket", "/home/u")).toBe("");
  });

  test("builds workspace → tab → pane requests only for well-formed ids", () => {
    expect(herdrFocusRequests("wM", "wM:t1", "wM:p1").map(r => [r.method, Object.values(r.params)[0]])).toEqual([
      ["workspace.focus", "wM"], ["tab.focus", "wM:t1"], ["pane.focus", "wM:p1"],
    ]);
    expect(herdrFocusRequests("", "", "wM:p1").map(r => r.method)).toEqual(["pane.focus"]);
    expect(herdrFocusRequests("M", "t1", "p1")).toEqual([]);
    expect(herdrFocusRequests("wM\n", "wM:t1;x", "wM:p1 --flag")).toEqual([]);
  });

  test("sends the requests in order over one connection and counts successful replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infomarchy-herdr-test-"));
    const socketPath = join(dir, "herdr.sock");
    const seen: string[] = [];
    const server = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, chunk) {
          for (const line of new TextDecoder().decode(chunk).split("\n").filter(Boolean)) {
            const request = JSON.parse(line); seen.push(request.method);
            // Third call fails, as Herdr would answer for an unknown pane.
            const reply = request.method === "pane.focus"
              ? { id: request.id, error: { code: "not_found", message: "no such pane" } }
              : { id: request.id, result: { ok: true } };
            socket.write(JSON.stringify(reply) + "\n");
          }
        },
      },
    });
    try {
      const ok = await sendHerdrRequests(socketPath, herdrFocusRequests("wM", "wM:t1", "wM:p9"), 1000);
      expect(seen).toEqual(["workspace.focus", "tab.focus", "pane.focus"]);
      expect(ok).toBe(2);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dead socket resolves promptly with zero successes instead of hanging", async () => {
    const started = performance.now();
    const ok = await sendHerdrRequests("/nonexistent/herdr.sock", herdrFocusRequests("wM", "", ""), 500);
    expect(ok).toBe(0);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
