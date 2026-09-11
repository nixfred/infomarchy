import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_CIDRS, displayMount, escapeHtml, fmtBytes, fmtRate, handleRequest, hostAllowed, ipAllowed, maskSnapshot,
  originAllowed, parseCidr, parseCidrList, parseAsciiQr, parsePrefsPatch, tokensEqual, newToken, ipv4ToInt, wifiLabel,
} from "./web-server";
import { LIVE_SCRIPT, obfuscatePrompt, parseDashPrefs, parseThemeColors, providerColorHex, renderPage, renderUsageSection, webSectionEnabled } from "./web-page";

const root = mkdtempSync(join(tmpdir(), "infomarchy-web-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const token = "a".repeat(48);
const cidrs = parseCidrList([]);
const tokens = [{ id: "aaaaaaaa", token, label: "default", createdAt: 1 }];
const base = {
  method: "GET",
  pathname: `/t/${token}/`,
  host: "172.20.20.142:8787",
  origin: null as string | null,
  sourceIp: "172.20.20.192",
  contentLength: 0,
  tokens,
  port: 8787,
  allowedHosts: ["172.20.20.142", "127.0.0.1"],
  cidrs,
  prefs: parseDashPrefs({}),
  theme: parseThemeColors('background = "#1f1f28"\nforeground = "#dcd7ba"\n'),
  background: null,
  snapshot: { ts: 1, user: "larry", host: "box", machine: { externalIp: "203.0.113.9", net: { ssid: "secret", addr: "172.20.20.142", wireless: true, signal: -47, dev: "wlan0", rxRate: 2_420_000, txRate: 386_000 }, cpu: { pct: 27.4, load: [1.18, 0.92] }, mem: { pct: 44.4, used: 15_246_073_856, total: 34_359_738_368 }, disks: [{ mount: "/home/larry", size: 1_999_844_147_200, used: 816_043_786_240, pct: 40.8 }], ping: { ok: true, ms: 18.6 }, battery: { pct: 81, status: "Charging" }, temp: 52, uptime: 186_300 }, ai: { sessions: [{ provider: "hermes", project: "Halo", topic: "<img src=x onerror=alert(1)>" }], attention: [], recent: [{ provider: "opencode", project: "~/Work", text: "<script>alert(1)</script>", ts: Date.now() - 2 * 3600_000 }], heatmap: { start: 1, days: [1,2,3,4,5,6,7], cells: Array.from({ length: 168 }, () => [0, {}]) }, usageDays: ["2026-09-01","2026-09-02","2026-09-03","2026-09-04","2026-09-05","2026-09-06","2026-09-07"], usage: { grok: { name: "Grok", ready: true, tierLabel: "weekly", todayPrompts: 4, todaySessions: 2, todayTotalTokens: 4000, hasTokenData: true, dailyTokens: [0,0,0,0,0,100,50], models: [{ id: "grok-4.6", share: 0.75, todayTokens: 3000, sessions: 2 }], limits: [{ label: "WEEKLY", percent: 0.03, resetsAt: "2026-09-14T00:26:00-07:00" }], value: { lifetime: 1.2, today: 0.1, totals: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 0 } } }, claude: { name: "Claude Code", ready: true, tierLabel: "Max 5x", todayPrompts: 0, todayTotalTokens: 0, hasTokenData: false, authHelpText: "Claude Code's saved sign-in expired", limits: [{ label: "Session (5-hour)", percent: 0.16, resetsAt: "2026-09-07T13:10:00Z" }] } }, github: { login: "test-viewer", cells: Array.from({ length: 168 }, () => [0, {}, {}]), days: [1,2,3,4,5,6,7] }, providers: { ollama: { present: true, up: true, loaded: [{ name: "qwen3:8b" }], models: [{ name: "qwen3:8b", size: 1 }] } } } },
};

describe("web mode access control", () => {
  test("parses CIDRs and admits the phone LAN plus loopback", () => {
    expect(parseCidr("172.16.0.0/12")?.text).toBe("172.16.0.0/12");
    expect(parseCidr("999.0.0.0/8")).toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(ipv4ToInt("172.20.20.192")).toBeGreaterThan(0);
    expect(ipAllowed("172.20.20.192", cidrs)).toBe(true);
    expect(ipAllowed("127.0.0.1", cidrs)).toBe(true);
    expect(ipAllowed("8.8.8.8", cidrs)).toBe(false);
    expect(ipAllowed("::1", cidrs)).toBe(false);
    expect(DEFAULT_CIDRS).not.toContain("100.64.0.0/10");
    expect(ipAllowed("100.100.1.2", cidrs)).toBe(false);
  });

  test("compares tokens in constant time and rejects the wrong one as 404", () => {
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, "b".repeat(48))).toBe(false);
    expect(tokensEqual("short", token)).toBe(false);
    expect(newToken()).toMatch(/^[0-9a-f]{48}$/);
    const denied = handleRequest({ ...base, pathname: `/t/${"b".repeat(48)}/` });
    expect(denied.status).toBe(404);
    expect(denied.body).not.toContain("Halo");
  });

  test("rejects WAN IPs, bad Host, cross-origin, POST, and traversal", () => {
    expect(handleRequest({ ...base, sourceIp: "8.8.8.8" }).status).toBe(403);
    expect(handleRequest({ ...base, host: "evil.example" }).status).toBe(403);
    expect(hostAllowed("172.20.20.142:8787", base.allowedHosts, 8787)).toBe(true);
    expect(hostAllowed("evil.example", base.allowedHosts, 8787)).toBe(false);
    expect(originAllowed("http://evil.example", base.allowedHosts, 8787)).toBe(false);
    expect(originAllowed(null, base.allowedHosts, 8787)).toBe(true);
    expect(handleRequest({ ...base, method: "PUT" }).status).toBe(405);
    expect(handleRequest({ ...base, pathname: `/t/${token}/../../etc/passwd` }).status).toBe(404);
    expect(handleRequest({ ...base, pathname: `/t/${token}/%2e%2e/` }).status).toBe(404);
    expect(handleRequest({ ...base, contentLength: 9000 }).status).toBe(413);
  });
});

describe("web mode rendering", () => {
  test("escapes HTML and strips identity fields", () => {
    expect(escapeHtml("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;");
    const masked = maskSnapshot(base.snapshot);
    expect(masked.user).toBeNull();
    expect(masked.host).toBeNull();
    expect(masked.machine.externalIp).toBeNull();
    expect(masked.machine.net.ssid).toBeNull();
    expect(masked.machine.net.addr).toBeNull();
    expect(masked.ai.github.login).toBe("");
    const page = handleRequest(base);
    expect(page.status).toBe(200);
    const body = String(page.body);
    expect(page.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(page.headers["Content-Security-Policy"]).toContain("img-src 'self'");
    expect(page.headers["X-Frame-Options"]).toBe("DENY");
    expect(body).toContain("Halo");
    expect(body).toContain("&lt;img src=x");
    expect(body).not.toContain("<img src");
    expect(body).not.toContain("<script>alert");
    expect(body.match(/<script/g)?.length).toBe(1);
    expect(body).not.toContain("test-viewer");
    expect(body).toContain("controlled on desktop");
    expect(body).toContain('id="privacy"');
    expect(body).toContain("PRIVACY ON");
    expect(body).toContain("WAN/LAN/SSID hidden");
    expect(body).not.toContain("WAN 203.0.113.9");
    expect(body).not.toContain("WIFI secret");
    expect(body).toContain("DISK ~");
    expect(body).not.toContain("DISK /home/larry");
    expect(body).toContain("LIVE AI SESSIONS");
    expect(body).toContain("RECENT TASKS");
    expect(body).toContain('class="recent-ago"');
    expect(body).toContain(">2h<");
    expect(body).toContain('class="recent-project"');
    expect(body).toContain(">Work<");
    expect(body).toContain("grid-template-columns:subgrid");
    expect(body).toContain("grid-column:1 / -1");
    expect(body).not.toContain("minmax(4em,7em)");
    expect(body).not.toContain(".recent-project { color:var(--dim); font-size:12px; overflow:hidden; text-overflow:ellipsis");
    expect(body).not.toContain(".recent-row .meta { display:none; }");
    expect(body).toContain("LOCAL AI");
    expect(body).not.toContain("CONTAINERS");
    expect(body).not.toContain("MEDIA CONTROLS");
    expect(body).toContain("grid-template-columns:minmax(0,1fr) minmax(300px,28%)");
    expect(body).not.toContain("backdrop-filter");
    const deskFill = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8").match(/cardBg:\s*Util\.alpha\(view\.desk\.themeBackground,\s*([0-9.]+)\)/)?.[1];
    expect(deskFill).toBeTruthy();
    expect(body).toMatch(new RegExp(`--card:rgba\\(\\d+,\\d+,\\d+,${deskFill}\\)`));
    expect(body).toContain("object-position:center");
    expect(body).toContain("object-fit:cover");
    const usageAt = body.indexOf("USAGE");
    const sessionsAt = body.indexOf("LIVE AI SESSIONS");
    expect(usageAt).toBeGreaterThan(0);
    expect(sessionsAt).toBeGreaterThan(0);
    expect(body).toContain("TOKENS · 7 days");
    expect(body).not.toContain("$ VALUE · 7 days");
    expect(body).toContain("polyline");
    expect(body).toContain('width="100%"');
    expect(body).toContain('preserveAspectRatio="none"');
    expect(body).toContain('class="chart-y"');
    expect(body).toContain('class="chart-x"');
    expect(body).not.toContain('font-size="9"');
    expect(body).toContain(".chart-y { display:flex;");
    expect(body).toContain(".chart svg { display:block; width:100%; height:72px; }");
    expect(body).not.toContain('height="88"');
    expect(body).not.toContain("height:auto");
    expect(body).toContain("WEEKLY");
    expect(body).toContain("3%");
    expect(body).toContain("today 4p · 2 sess · 4K tok");
    expect(body).toContain("grok-4.6");
    expect(body).toContain("3K tok  ·  75%");
    expect(body).toContain("Claude Code");
    expect(body).toContain("sign-in expired");
    expect(body).not.toContain("today 0p · 0 tok");
    expect(body).not.toContain('http-equiv="refresh"');
    expect(body).toContain(">Refresh</a>");
    expect(body).toContain('id="view"');
    expect(body).toContain("fetch(location.pathname");
    expect(body).toContain('id="zoom-in"');
    expect(body).toContain("data-toggle-section");
    expect(body).toContain("data-move");
    expect(body).toContain("--stack-order");
    expect(body).toContain("zoom:var(--scale)");
    expect(body).toContain("display:contents");
    expect(page.headers["Content-Security-Policy"]).toContain("connect-src 'self'");
    expect(page.headers["Content-Security-Policy"]).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
    expect(body).toMatch(/<script nonce="[0-9a-f]{32}">/);
    expect(body).toContain("CPU");
    expect(body).toContain("RAM");
    expect(body).toContain("DISK ~");
    expect(body).toContain("WIFI");
    expect(body).toContain("-47 dBm");
    expect(body).toContain("BAT 81% charging");
    expect(body).toContain("⇄ 19 ms");
    expect(fmtBytes(15_246_073_856)).toBe("14.2G");
    expect(fmtRate(2_420_000)).toBe("19.4Mb/s");
    expect(displayMount("/home/larry/Projects")).toBe("~/Projects");
    expect(wifiLabel({ wireless: true, ssid: "secret", dev: "wlan0" })).toBe("WIFI");
    expect(body).toContain('querySelector("style")');
    expect(() => new Function(LIVE_SCRIPT)).not.toThrow();
  });

  test("element colors come from the live Omarchy theme, including named green/yellow keys", () => {
    const toml = [
      'background = "#101315"',
      'foreground = "#cacccc"',
      'accent = "#798186"',
      'green = "#9fa5a9"',
      'yellow = "#d9dbdc"',
      'red = "#565d60"',
      'cyan = "#707070"',
      'blue = "#798186"',
      'magenta = "#aeaeae"',
    ].join("\n");
    const theme = parseThemeColors(toml);
    expect(theme.green).toBe("#9fa5a9");
    expect(theme.yellow).toBe("#d9dbdc");
    expect(providerColorHex("claude", theme)).toBe("#d9dbdc");
    expect(providerColorHex("codex", theme)).toBe("#707070");
    expect(providerColorHex("grok", theme)).toBe("#aeaeae");
    expect(providerColorHex("hermes", theme)).toBe("#9fa5a9");
    const fromAnsi = parseThemeColors('color2 = "#00aa00"\ncolor3 = "#bbbb00"\n');
    expect(fromAnsi.green).toBe("#00aa00");
    expect(fromAnsi.yellow).toBe("#bbbb00");
    const namedWins = parseThemeColors('green = "#111111"\ncolor2 = "#00aa00"\n');
    expect(namedWins.green).toBe("#111111");
    const html = renderPage(base.snapshot, "/t/" + token + "/", "", parseDashPrefs({}), theme, false);
    expect(html).toContain("#9fa5a9");
    expect(html).toContain("#d9dbdc");
    expect(html).toContain("#aeaeae");
    expect(html).toContain("--green:#9fa5a9");
    expect(html).not.toContain("#61afef");
    expect(html).not.toContain("#98c379");
    expect(html).not.toContain("#e5c07b");
  });

  test("usage matches the desk: sessions, hasTokenData, per-model meters, status when no bars", () => {
    const html = renderUsageSection({
      ai: {
        usage: {
          grok: {
            name: "Grok", ready: true, todayPrompts: 18, todaySessions: 5, hasTokenData: false,
            models: [{ id: "session-model", share: 0, sessions: 3, todayTokens: 0 }],
            limits: [], usageStatusText: "credits, not rate-limit windows",
          },
          claude: {
            name: "Claude", ready: true, todayPrompts: 4, todayTotalTokens: 12000, hasTokenData: true,
            models: [{ id: "family-a", share: 0.7, todayTokens: 8400, sessions: 2 }],
            limits: [{ label: "WEEKLY", percent: 0.4 }],
          },
        },
      },
    });
    expect(html).toContain("today 18p · 5 sess");
    expect(html).not.toContain("today 18p · 5 sess · 0 tok");
    expect(html).toContain("credits, not rate-limit windows");
    expect(html).toContain("session-model");
    expect(html).toContain("3 sess");
    expect(html).toContain("family-a");
    expect(html).toContain("8K tok  ·  70%");
    expect(html).toContain('class="meter"');
    expect(html).toContain('class="fill"');
    expect(html).not.toContain("$ VALUE · 7 days");
  });

  test("web section prefs hide a card and media never renders", () => {
    expect(webSectionEnabled("media", parseDashPrefs({ webSections: { media: true } }))).toBe(false);
    expect(webSectionEnabled("recent", parseDashPrefs({ webSections: { recent: false } }))).toBe(false);
    const html = renderPage(base.snapshot, "/t/" + token + "/", "", parseDashPrefs({ webSections: { recent: false } }), parseThemeColors(""), false);
    expect(html).toContain('data-section="recent"');
    expect(html).toContain('data-section="recent" style="--stack-order:');
    expect(html).toMatch(/class="card block off"[^>]*data-section="recent"/);
    expect(html).not.toContain('data-section="containers"');
    expect(html).toContain("LIVE AI SESSIONS");
    expect(html).not.toContain("MEDIA CONTROLS");
  });

  test("privacy masks recent-task prompts the same way as the desk", () => {
    expect(obfuscatePrompt("one two three four five six")).toBe("one two three four ···");
    expect(obfuscatePrompt("one two three four")).toBe("one two three four");
    const snap = {
      ...base.snapshot,
      ai: {
        ...base.snapshot.ai,
        recent: [{ provider: "opencode", project: "~/Projects/luddite-infomarchy", text: "please review the secret token dump now", ts: Date.now() - 90_000 }],
      },
    };
    const html = renderPage(snap, "/t/" + token + "/", "", parseDashPrefs({}), parseThemeColors(""), false);
    expect(html).toContain("please review the secret ···");
    expect(html).not.toContain("please review the secret token dump now");
    expect(html).not.toContain('class="shut"');
    expect(html).toContain(">1m<");
    expect(html).toContain(">luddite-infomarchy<");
    expect(html).not.toContain("~/Projects/luddite-infomarchy");
  });

  test("accepts a second token and serves wallpaper bytes", () => {
    const other = "b".repeat(48);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const extra = handleRequest({ ...base, pathname: `/t/${other}/`, tokens: [...tokens, { id: "bbbbbbbb", token: other, label: "phone", createdAt: 2 }] });
    expect(extra.status).toBe(200);
    const bg = handleRequest({ ...base, pathname: `/t/${token}/bg`, background: { type: "image/png", bytes: png } });
    expect(bg.status).toBe(200);
    expect(bg.headers["Content-Type"]).toBe("image/png");
    expect(bg.headers["Cache-Control"]).toBe("no-store");
    expect(Buffer.from(bg.body as Uint8Array).equals(png)).toBe(true);
    const page = handleRequest({ ...base, background: { type: "image/png", bytes: png } });
    const html = String(page.body);
    expect(html).toContain('<img class="wall" src="bg?v=1-1" alt="" aria-hidden="true">');
    expect(html).toMatch(/id="view"[^>]*>[\s\S]*class="wall"/);
    expect(html).toContain(".stage { position:relative; isolation:isolate;");
    expect(html).toContain("background:var(--bg)");
    expect(html).toContain(".wall { position:absolute;");
    expect(html).toContain("opacity:0.32");
    expect(html).not.toContain("background-image:");
    const deskWall = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8").match(/wallpaperOpacity:\s*([0-9.]+)/)?.[1];
    expect(deskWall).toBe("0.32");
    const poisoned = renderPage(base.snapshot, "/t/" + token + "/", "", parseDashPrefs({}), parseThemeColors(""), true, '1-1" onerror="alert(1)');
    expect(poisoned).toContain('<img class="wall" src="bg" alt="" aria-hidden="true">');
    expect(poisoned).not.toMatch(/<img class="wall"[^>]*onerror/i);
  });

  test("parses qrencode ASCII into a square matrix", () => {
    const rows = parseAsciiQr("######  ######\n##      ##    \n######  ######\n");
    expect(rows.length).toBe(0);
    const square = parseAsciiQr(Array.from({ length: 21 }, () => "##".repeat(21)).join("\n"));
    expect(square.length).toBe(21);
    expect(square[0]).toBe("1".repeat(21));
  });

  test("HEAD is empty and missing snapshots are 503", () => {
    expect(handleRequest({ ...base, method: "HEAD" }).body).toBe("");
    expect(handleRequest({ ...base, snapshot: null }).status).toBe(503);
  });

  test("prefs POST is origin and JSON bounded", () => {
    const prefsPath = `/t/${token}/prefs`;
    expect(handleRequest({ ...base, method: "POST", pathname: prefsPath }).status).toBe(403);
    expect(handleRequest({ ...base, method: "POST", pathname: prefsPath, origin: "http://172.20.20.142:8787", contentType: "text/plain", body: "{}" }).status).toBe(415);
    expect(handleRequest({ ...base, method: "POST", pathname: prefsPath, origin: "http://172.20.20.142:8787", contentType: "application/json", body: "{" }).status).toBe(400);
    expect(parsePrefsPatch(JSON.stringify({ webSections: { recent: false, media: true, __proto__: { x: 1 } } }))).toEqual({ webSections: { recent: false } });
    expect(parsePrefsPatch(JSON.stringify({ webNarrowOrder: ["machine", "sessions", "nope"] }))?.webNarrowOrder?.[0]).toBe("machine");
    expect(parsePrefsPatch("{}")).toBeNull();
  });
});

describe("live listen", () => {
  test("refresh follows desktop privacy, prefs cannot unmask, revocation fails closed", async () => {
    const state = join(root, "state");
    const dir = join(state, "infomarchy");
    mkdirSync(dir, { recursive: true });
    const fixture = structuredClone(base.snapshot);
    fixture.ai.recent[0].text = "one two three four PRIVATE_PROMPT_SENTINEL";
    fixture.ai.sessions[0] = { ...fixture.ai.sessions[0], cwd: "/home/PRIVATE_CWD", prompt: "PRIVATE_PROMPT_SENTINEL" } as any;
    writeFileSync(join(dir, "web-snapshot.json"), JSON.stringify(fixture));
    writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ privacyMode: true }));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "web-server.ts")], {
      env: { HOME: root, USER: "tester", XDG_STATE_HOME: state, PATH: "/usr/bin:/bin", INFOMARCHY_WEB_PORT: "0" },
      stdout: "pipe", stderr: "ignore",
    });
    try {
      const first = await proc.stdout.getReader().read();
      const status = JSON.parse(new TextDecoder().decode(first.value).trim());
      expect(status.ok).toBe(true);
      expect(status.url).toBeUndefined();
      const config = JSON.parse(readFileSync(join(dir, "web.json"), "utf8"));
      const url = `http://127.0.0.1:${status.port}/t/${config.tokens[0].token}/`;
      const request = (path = "", init: RequestInit = {}) => fetch(url + path, init);
      const page = await request();
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("one two three four ···");
      expect(html.includes("PRIVATE_PROMPT_SENTINEL")).toBe(false);
      expect(html.includes("203.0.113.9")).toBe(false);
      const json = await (await request("snapshot.json")).text();
      expect(json.includes("PRIVATE_CWD")).toBe(false);
      expect(json.includes("PRIVATE_PROMPT_SENTINEL")).toBe(false);
      const post = (body: unknown) => request("prefs", { method: "POST", headers: {
        "content-type": "application/json", Origin: `http://127.0.0.1:${status.port}`,
      }, body: JSON.stringify(body) });
      expect((await post({ privacyMode: false, webSections: { recent: false } })).status).toBe(400);
      expect(JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8")).privacyMode).toBe(true);
      expect((await post({ webSections: { recent: false } })).status).toBe(200);
      expect(JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8")).privacyMode).toBe(true);
      writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ privacyMode: false }));
      const open = await (await request()).text();
      expect(open.includes("PRIVATE_PROMPT_SENTINEL")).toBe(true);
      expect(open.includes("203.0.113.9")).toBe(true);
      expect(open).toContain("PRIVACY OFF");
      for (const raw of ['{}', '{"privacyMode":"false"}', '{malformed', '{"privacyMode":true}']) {
        writeFileSync(join(dir, "dashboard.json"), raw);
        expect((await (await request()).text()).includes("PRIVATE_PROMPT_SENTINEL")).toBe(false);
      }
      config.tokens = [{ ...config.tokens[0], token: "b".repeat(48) }];
      writeFileSync(join(dir, "web.json"), JSON.stringify(config));
      for (const path of ["", "snapshot.json", "bg", "prefs"]) expect((await request(path)).status).toBe(404);
      writeFileSync(join(dir, "web.json"), "{malformed");
      expect((await request()).status).toBe(503);
    } finally { proc.kill("SIGTERM"); await proc.exited; }
  });
});
