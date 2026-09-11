import { describe, expect, test } from "bun:test";
import { filterWebSnapshot, LIVE_SCRIPT, parseDashPrefs } from "./web-page";
import { handleRequest, parseCidrList, parsePrefsPatch } from "./web-server";
import { assessTailscale, boundedCommand, portOccupied, tailOrigin } from "./web-tailscale";

const token = "a".repeat(48);
const snapshot = {
  user: "PRIVATE_USER", host: "PRIVATE_HOST",
  media: { title: "PRIVATE_MEDIA" },
  machine: { externalIp: "PRIVATE_WAN", net: { addr: "PRIVATE_LAN", ssid: "PRIVATE_SSID", wireless: true }, disks: [{ mount: "/home/PRIVATE_USER/work", pct: 3 }] },
  ai: {
    github: { login: "PRIVATE_LOGIN" },
    recent: [{ text: "one two three four PRIVATE_PROMPT", project: "/home/PRIVATE_USER/repo" }, { text: "short prompt" }],
    sessions: [{ provider: "claude", project: "repo", topic: "VISIBLE_TOPIC", cwd: "PRIVATE_CWD", prompt: "PRIVATE_PROMPT", preview: "PRIVATE_PREVIEW" }],
    attention: [{ project: "repo", attention: "waiting", attentionReason: "needs approval", attentionDetail: "PRIVATE_DETAIL", cwd: "PRIVATE_CWD" }],
    usage: { claude: { ready: true, name: "Claude", secret: "PRIVATE_USAGE_EXTRA", limits: [{ label: "week", percent: 0.1, secret: "PRIVATE_LIMIT_EXTRA" }] } },
  },
};
const base = {
  method: "GET", pathname: `/t/${token}/`, host: "127.0.0.1:8787", origin: null,
  sourceIp: "127.0.0.1", contentLength: 0, tokens: [{ id: "aaaaaaaa", token, label: "test", createdAt: 1 }],
  port: 8787, allowedHosts: ["127.0.0.1"], cidrs: parseCidrList([]), snapshot, background: null,
};

describe("desktop disclosure boundary", () => {
  test("all response bytes omit private sentinels and leave the desktop source intact", () => {
    const before = JSON.stringify(snapshot);
    for (const prefs of [parseDashPrefs({ privacyMode: true }), parseDashPrefs({}), parseDashPrefs(null), parseDashPrefs({ privacyMode: "false" })]) {
      for (const pathname of [base.pathname, base.pathname + "snapshot.json"]) {
        const r = handleRequest({ ...base, pathname, prefs });
        expect(r.status).toBe(200);
        expect(String(r.body).includes("PRIVATE_")).toBe(false);
        expect(r.body).toContain("VISIBLE_TOPIC");
        expect(r.headers["Cache-Control"]).toBe("no-store");
        expect(handleRequest({ ...base, pathname, prefs, method: "HEAD" }).body).toBe("");
      }
      const html = String(handleRequest({ ...base, prefs }).body);
      expect(html).toContain("one two three four ···");
      expect(html).toContain("short prompt");
      expect(html).toContain("DISK ~/work");
      expect(html).not.toContain('class="open"');
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(LIVE_SCRIPT).not.toContain("im-privacy");
    expect(parsePrefsPatch('{"privacyMode":false}')).toBeNull();
  });
  test("privacy off discloses permitted values but keeps exclusions", () => {
    const html = String(handleRequest({ ...base, prefs: parseDashPrefs({ privacyMode: false }) }).body);
    for (const marker of ["PRIVATE_USER", "PRIVATE_HOST", "PRIVATE_WAN", "PRIVATE_LAN", "PRIVATE_SSID", "PRIVATE_PROMPT"])
      expect(html.includes(marker)).toBe(true);
    for (const marker of ["PRIVATE_LOGIN", "PRIVATE_MEDIA", "PRIVATE_CWD", "PRIVATE_PREVIEW", "PRIVATE_DETAIL"])
      expect(html.includes(marker)).toBe(false);
    const view = filterWebSnapshot(snapshot, false);
    expect(view.ai.recent[0].text).toContain("PRIVATE_PROMPT");
    expect(view.ai.sessions[0].cwd).toBeUndefined();
  });
});

describe("private HTTPS boundary", () => {
  const origin = "https://desk.example.ts.net:8788";
  const proxied = { ...base, externalOrigin: origin, host: "desk.example.ts.net:8788", prefs: parseDashPrefs({}) };
  test("accepts the explicit HTTPS Host through loopback, with token authorization", () => {
    expect(handleRequest(proxied).status).toBe(200);
    expect(handleRequest({ ...proxied, origin }).status).toBe(200);
    expect(handleRequest({ ...proxied, pathname: "/t/" + "b".repeat(48) + "/" }).status).toBe(404);
    for (const sourceIp of ["100.100.1.2", "192.168.1.2", "8.8.8.8"])
      expect(handleRequest({ ...proxied, sourceIp }).status).toBe(403);
    for (const host of [base.host, "evil.ts.net:8788", "desk.example.ts.net", "desk.example.ts.net:443"])
      expect(handleRequest({ ...proxied, host }).status).toBe(403);
    for (const bad of ["http://desk.example.ts.net:8788", "https://evil.ts.net:8788", origin + "/", "null"])
      expect(handleRequest({ ...proxied, origin: bad }).status).toBe(403);
    expect(handleRequest({ ...proxied, externalOrigin: "https://evil.example:8788" }).status).toBe(403);
    expect(handleRequest({ ...proxied, method: "POST", pathname: base.pathname + "prefs", contentType: "application/json", body: "{}" }).status).toBe(403);
  });
  test("LAN cannot opt itself into the HTTPS origin", () => {
    expect(handleRequest({ ...base, host: proxied.host }).status).toBe(403);
    expect(handleRequest({ ...base, origin }).status).toBe(403);
    expect(tailOrigin("desk.example.ts.net.")).toBe(origin);
    for (const name of ["evil.example", "desk.ts.net.evil.example", "-bad.ts.net", "desk.ts.net/path", "desk.ts.net@evil"])
      expect(tailOrigin(name)).toBe("");
  });
});

describe("guided Serve setup", () => {
  const running = { BackendState: "Running", Self: { Online: true, DNSName: "desk.example.ts.net." } };
  const help = "--https --bg";
  test("missing, stopped, signed-out and unsupported states give actionable failures", () => {
    expect(assessTailscale(null, {}, help).state).toBe("unavailable");
    expect(assessTailscale({ BackendState: "Stopped" }, {}, help).state).toBe("stopped");
    expect(assessTailscale({ BackendState: "NeedsLogin" }, {}, help).state).toBe("login");
    expect(assessTailscale(running, null, help).state).toBe("config");
    expect(assessTailscale(running, {}, "old cli").state).toBe("version");
    expect(assessTailscale(running, {}, help).ok).toBe(true);
  });
  test("unrelated services survive inspection; conflicts include foreground and Funnel", () => {
    const unrelated = { TCP: { "443": { HTTPS: true } }, Web: { "desk.example.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3000" } } } } };
    const before = JSON.stringify(unrelated);
    expect(assessTailscale(running, unrelated, help).ok).toBe(true);
    expect(JSON.stringify(unrelated)).toBe(before);
    for (const config of [
      { TCP: { "8788": { HTTPS: true } } },
      { Web: { "desk.example.ts.net:8788": {} } },
      { AllowFunnel: { "desk.example.ts.net:8788": true } },
      { Foreground: { other: { TCP: { "8788": { HTTPS: true } } } } },
    ]) {
      expect(portOccupied(config)).toBe(true);
      expect(assessTailscale(running, config, help).state).toBe("conflict");
    }
  });
  test("CLI output and execution have finite bounds", async () => {
    expect(await boundedCommand(["/usr/bin/printf", "small"], 32)).toBe("small");
    expect(await boundedCommand(["/usr/bin/yes"], 32)).toBeNull();
    expect(await boundedCommand(["/usr/bin/sleep", "10"], 32, 30)).toBeNull();
    expect(await boundedCommand(["/does/not/exist"], 32)).toBeNull();
  });
});
