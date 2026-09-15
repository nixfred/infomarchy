import { describe, expect, test } from "bun:test";
import { emptyGiteaStore, giteaBaseUrl, giteaConfig, giteaEventKind, giteaRefreshDue, giteaSnapshot, parseGiteaStore, refreshGiteaActivity, GITEA_MAX_BYTES, type GiteaFetch } from "./gitea-activity";
import { localDayIndex, localDayStarts } from "./history-time";

const now = new Date(2026, 8, 15, 12).getTime();
const tea = `logins:
  - name: work
    url: https://git.example/Team
    token: test-token
    default: true
  - name: personal
    url: http://git.example:3000
    token: other-test-token
`;
const config = () => giteaConfig(tea, {});
const activity = (id: number, op = "commit_repo", ts = now - 3600_000, actor = "demo") => ({
  id, op_type: op, created: new Date(ts).toISOString(), act_user: { login: actor },
  repo: { full_name: "demo/project", private: true }, content: "PRIVATE COMMIT TEXT", comment: { body: "PRIVATE ISSUE TEXT" },
});
const cellIndex = (ts: number, days: number[]) => { const day = localDayIndex(ts, days); return day < 0 ? -1 : day * 24 + new Date(ts).getHours(); };
function mock(pages: Record<number, any[]> = { 1: [activity(1)] }, requests: string[] = []): GiteaFetch {
  return async (url, init) => {
    requests.push(url);
    expect(url.startsWith("https://git.example/Team/api/v1/")).toBe(true);
    expect(init.redirect).toBe("error");
    expect((init.headers as any).Authorization).toBe("token test-token");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url.endsWith("/user")) return Response.json({ login: "demo", email: "private@example.test" });
    expect(new URL(url).searchParams.get("only-performed-by")).toBe("true");
    return Response.json(pages[Number(new URL(url).searchParams.get("page"))] || []);
  };
}

describe("Gitea configuration", () => {
  test("uses tea's default, sole or explicitly named login without assuming a server", () => {
    expect(config().url).toBe("https://git.example/Team");
    expect(giteaConfig(tea, { INFOMARCHY_GITEA_LOGIN: "personal" }).url).toBe("http://git.example:3000");
    expect(giteaConfig('logins: [{name: only, url: "http://[::1]:3000/base/", token: token}]', {}).url).toBe("http://[::1]:3000/base");
    expect(giteaConfig(tea.replace("default: true", "default: false"), {}).state).toBe("configuration");
    expect(giteaConfig(tea, { INFOMARCHY_GITEA_LOGIN: "unknown" }).state).toBe("configuration");
    expect(giteaConfig(null, {}).state).toBe("missing");
    expect(giteaConfig("[broken", {}).state).toBe("configuration");
    expect(giteaConfig(tea, { INFOMARCHY_SKIP_GITEA: "1" }).state).toBe("disabled");
  });
  test("preserves subpaths and explicit HTTP, rejects credentials and unsafe URLs", () => {
    expect(giteaBaseUrl("git.example/CaseSensitive/")).toBe("https://git.example/CaseSensitive");
    for (const invalid of ["ftp://git.example", "https://user:secret@git.example", "http://git.example?token=x", "http://git.example#x", "https://git.example\\@evil.test", "https://git.example\n"]) expect(giteaBaseUrl(invalid)).toBe("");
  });
  test("scopes explicit credentials to an explicit host and isolates accounts", () => {
    expect(giteaConfig(tea, { GITEA_TOKEN: "override" }).state).toBe("configuration");
    expect(giteaConfig(tea, { GITEA_HOST: "http://elsewhere.test", INFOMARCHY_GITEA_LOGIN: "work" }).state).toBe("configuration");
    expect(giteaConfig(tea, { GITEA_HOST: "http://git.example:3000" }).token).toBe("other-test-token");
    const explicit = giteaConfig(null, { GITEA_HOST: "https://forge.example", GITEA_TOKEN: "new-token" });
    expect(explicit.state).toBe("ready");
    expect(explicit.key).not.toBe(config().key);
    expect(giteaConfig(tea.replace("test-token", "rotated-token"), {}).key).not.toBe(config().key);
  });
});

describe("Gitea activity", () => {
  test("collects only the authenticated user's events and strips payloads and credentials", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key);
    await refreshGiteaActivity(store, cfg, now, mock({ 1: [activity(9), activity(8, "create_pull_request"), activity(7, "comment_issue", now - 1, "someone-else"), activity(6, "mirror_sync_push"), activity(5, "unknown")] }));
    expect(Object.keys(store.events)).toHaveLength(2);
    expect(store.events[9][1]).toBe("push");
    expect(store.events[8][1]).toBe("pr");
    expect(store.walk).toBeNull();
    const snapshot = giteaSnapshot(store, cfg, now, localDayStarts(now, 7), cellIndex);
    expect(snapshot.state).toBe("ok");
    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.counts.push).toEqual({ today: 1, week: 1 });
    expect(snapshot.cells.reduce((n, cell) => n + cell[0], 0)).toBe(2);
    for (const secret of [cfg.token, cfg.url, "PRIVATE", "private@example.test", "someone-else"]) expect(JSON.stringify({ store, snapshot })).not.toContain(secret);
  });
  test("maps reviews, comments and issue transitions without calling pushes commits", () => {
    expect(giteaEventKind("approve_pull_request")).toBe("review");
    expect(giteaEventKind("comment_pull")).toBe("comment");
    expect(giteaEventKind("reopen_issue")).toBe("issue");
    expect(giteaEventKind("publish_release")).toBe("other");
  });
  test("continues short server-limited pages, deduplicates and resumes across ticks", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key), requests: string[] = [];
    const fetcher = mock({ 1: [activity(3), activity(2)], 2: [activity(2), activity(1)], 3: [] }, requests);
    await refreshGiteaActivity(store, cfg, now, fetcher);
    expect(store.walk?.page).toBe(3);
    expect(store.head).toBe("");
    expect(giteaRefreshDue(store, now + 59_999)).toBe(false);
    expect(giteaRefreshDue(store, now + 60_000)).toBe(true);
    const resumed = parseGiteaStore(JSON.stringify(store), cfg.key);
    await refreshGiteaActivity(resumed, cfg, now + 60_000, fetcher);
    expect(resumed.walk).toBeNull();
    expect(resumed.head).toBe("3");
    expect(Object.keys(resumed.events)).toHaveLength(3);
    expect(requests).toHaveLength(4); // /user plus three pages
    expect(giteaRefreshDue(resumed, now + 359_999)).toBe(false);
    expect(giteaRefreshDue(resumed, now + 360_000)).toBe(true);
    await refreshGiteaActivity(resumed, cfg, now + 360_000, mock({ 1: [activity(4), activity(3)] }));
    expect(resumed.head).toBe("4");
    expect(resumed.walk).toBeNull();
    expect(Object.keys(resumed.events)).toHaveLength(4);
  });
  test("re-walks the window periodically and stops at its oldest boundary", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key);
    await refreshGiteaActivity(store, cfg, now, mock());
    await refreshGiteaActivity(store, cfg, now + 6 * 3600_000, mock({ 1: [activity(2), activity(1)], 2: [activity(0, "commit_repo", now - 8 * 86400_000)] }));
    expect(store.walk).toBeNull();
    expect(store.reconciledAt).toBe(now + 6 * 3600_000);
    expect(store.events[0]).toBeUndefined();
  });
  test("retries failed pages without losing coverage, backs off, keeps stale data", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key);
    await refreshGiteaActivity(store, cfg, now, mock());
    const failed: GiteaFetch = async () => { throw new Error("secret token in transport error"); };
    await refreshGiteaActivity(store, cfg, now + 5 * 60_000, failed);
    expect(store.error).toBe("fetch failed");
    expect(store.walk?.page).toBe(1);
    expect(giteaRefreshDue(store, now + 6 * 60_000)).toBe(true);
    expect(giteaSnapshot(store, cfg, now + 5 * 60_000, localDayStarts(now, 7), cellIndex).state).toBe("ok");
    await refreshGiteaActivity(store, cfg, now + 16 * 60_000, failed);
    expect(giteaRefreshDue(store, now + 17 * 60_000)).toBe(false);
    expect(giteaSnapshot(store, cfg, now + 16 * 60_000, localDayStarts(now, 7), cellIndex).state).toBe("stale");
    expect(Object.keys(store.events)).toHaveLength(1);
  });
  test("clears private rows after revoked access, account changes or logout", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key);
    await refreshGiteaActivity(store, cfg, now, mock());
    expect(Object.keys(parseGiteaStore(JSON.stringify(store), "another-account").events)).toHaveLength(0);
    expect(giteaSnapshot(store, giteaConfig(null, {}), now, localDayStarts(now, 7), cellIndex).counts.push.week).toBe(0);
    await refreshGiteaActivity(store, cfg, now + 300_000, async () => new Response("private server error", { status: 401 }));
    expect(store.error).toBe("authentication failed");
    expect(store.login).toBe("");
    expect(Object.keys(store.events)).toHaveLength(0);
    expect(giteaSnapshot(store, cfg, now, localDayStarts(now, 7), cellIndex).state).toBe("unauthenticated");
  });
  test("rejects corrupt, oversized or invalid responses without retaining raw error text", async () => {
    const cfg = config();
    for (const response of [Response.json({ bad: true }), new Response("not JSON"), new Response("x".repeat(GITEA_MAX_BYTES + 1))]) {
      const store = emptyGiteaStore(cfg.key);
      await refreshGiteaActivity(store, cfg, now, async () => response);
      expect(["invalid response", "response too large"]).toContain(store.error);
      expect(store.events).toEqual({});
    }
    expect(parseGiteaStore("{broken", cfg.key)).toEqual(emptyGiteaStore(cfg.key));
    expect(parseGiteaStore(JSON.stringify({ key: cfg.key, events: { 1: [Infinity, "push", "demo/repo"], 2: [now, "wrong", "demo/repo"] }, error: "TOKEN" }), cfg.key).error).toBe("");
  });
  test("buckets local days, ignores future rows and changes days without refetching", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key);
    await refreshGiteaActivity(store, cfg, now, mock({ 1: [activity(3, "commit_repo", now + 1), activity(2), activity(1, "commit_repo", now - 86400_000)] }));
    const days = localDayStarts(now, 7);
    expect(giteaSnapshot(store, cfg, now, days, cellIndex).counts.push).toEqual({ today: 1, week: 2 });
    expect(giteaSnapshot(store, cfg, now + 86400_000, localDayStarts(now + 86400_000, 7), cellIndex).counts.push).toEqual({ today: 0, week: 2 });
  });
  test("disabled or missing configuration makes no requests and exposes no previous login", async () => {
    const store = emptyGiteaStore(config().key);
    store.login = "previous-account";
    for (const cfg of [giteaConfig(null, {}), giteaConfig(tea, { INFOMARCHY_SKIP_GITEA: "1" })]) {
      await refreshGiteaActivity(store, cfg, now, async () => { throw new Error("must not fetch"); });
      const snapshot = giteaSnapshot(store, cfg, now, localDayStarts(now, 7), cellIndex);
      expect(snapshot.login).toBe("");
      expect(store.attemptedAt).toBe(0);
    }
  });
  test("cache limits never silently claim full coverage for discarded activity", async () => {
    const cfg = config(), store = emptyGiteaStore(cfg.key);
    store.login = "demo"; store.loginCheckedAt = now;
    store.head = "6000"; store.coveredFrom = now - 7 * 86400_000; store.reconciledAt = now;
    for (let id = 1; id <= 6000; id++) store.events[id] = [now - 86400_000 + id, "push", "demo/project"];
    await refreshGiteaActivity(store, cfg, now, mock({ 1: [activity(6001), activity(6000)] }));
    expect(Object.keys(store.events)).toHaveLength(6000);
    expect(store.events[1]).toBeUndefined();
    expect(giteaSnapshot(store, cfg, now, localDayStarts(now, 7), cellIndex).coverage).toBe("partial");
  });
});
