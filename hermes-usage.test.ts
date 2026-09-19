import { describe, expect, test } from "bun:test";
import {
  emptyHermesUsageStore, hermesUsageRefreshDue, hermesUsageSummary, parseHermesUsageRows, parseKeyUsage,
  parseHermesUsageStoreText, refreshHermesUsage, HERMES_USAGE_REFRESH_MS, type UsageRunner,
} from "./hermes-usage";

const sqliteJson = (rows: object[]) => JSON.stringify(rows);
const DELIM = "___INFOMARCHY_HERMES_USAGE___";
// Mirrors sshArgs()'s own output shape: ledger JSON, the delimiter on its
// own line (echo appends \n), then the key-usage JSON (or nothing).
const combined = (ledger: string, keyUsage = "") => `${ledger}\n${DELIM}\n${keyUsage}`;

const sampleKeyUsage = {
  checked_at_utc: "2026-09-18T08:00Z", limit: 20, limit_remaining: 19.410750168,
  usage_total: 10.618429343, usage_daily: 0.358221824, usage_weekly: 0.589249832, usage_monthly: 0.589249832,
};

describe("parseHermesUsageRows", () => {
  test("parses a well-formed sqlite3 -json result", () => {
    const output = sqliteJson([
      { session_id: "s1", model: "deepseek/deepseek-v4.1-flash", billing_provider: "openrouter", api_call_count: 5, input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_write_tokens: 0, reasoning_tokens: 5, estimated_cost_usd: 0.01, last_seen: 1700000000 },
    ]);
    expect(parseHermesUsageRows(output)).toEqual([{
      sessionId: "s1", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter",
      apiCallCount: 5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0,
      reasoningTokens: 5, estimatedCostUsd: 0.01, lastSeen: 1700000000,
    }]);
  });

  test("an empty result set is [] and reads as success with zero rows", () => {
    expect(parseHermesUsageRows("[]")).toEqual([]);
  });

  test("empty output, garbage, or a non-array means the probe failed (null)", () => {
    expect(parseHermesUsageRows("")).toBeNull();
    expect(parseHermesUsageRows("   ")).toBeNull();
    expect(parseHermesUsageRows("not json")).toBeNull();
    expect(parseHermesUsageRows('{"not":"an array"}')).toBeNull();
  });

  test("drops rows with no model and tolerates a mixed-garbage array", () => {
    const output = sqliteJson([{ model: "", input_tokens: 5 }]);
    expect(parseHermesUsageRows(output)).toEqual([]);
    expect(parseHermesUsageRows('[null, "garbage", {"model":"ok","input_tokens":1}]')).toEqual([
      expect.objectContaining({ model: "ok", inputTokens: 1 }),
    ]);
  });
});

describe("parseKeyUsage", () => {
  test("parses a real openrouter_key_usage.json shape", () => {
    expect(parseKeyUsage(JSON.stringify(sampleKeyUsage))).toEqual({
      checkedAtMs: Date.parse("2026-09-18T08:00Z"),
      limit: 20, limitRemaining: 19.410750168, limitReset: "",
      usageTotal: 10.618429343, usageDaily: 0.358221824, usageWeekly: 0.589249832, usageMonthly: 0.589249832,
    });
  });

  test("missing file, garbage, or a non-object means no key usage (null)", () => {
    expect(parseKeyUsage("")).toBeNull();
    expect(parseKeyUsage("   ")).toBeNull();
    expect(parseKeyUsage("not json")).toBeNull();
    expect(parseKeyUsage("[1,2,3]")).toBeNull();
  });

  test("requires a numeric usage_total — an object missing it is not a key-usage read", () => {
    expect(parseKeyUsage(JSON.stringify({ limit: 20 }))).toBeNull();
  });

  test("a real $0 account is not confused with a missing file", () => {
    expect(parseKeyUsage(JSON.stringify({ ...sampleKeyUsage, usage_total: 0, usage_daily: 0, usage_weekly: 0, usage_monthly: 0 })))
      .toEqual(expect.objectContaining({ usageTotal: 0, usageDaily: 0 }));
  });

  test("no monthly limit configured on the key still parses the usage figures", () => {
    const { limit, limit_remaining, ...rest } = sampleKeyUsage;
    expect(parseKeyUsage(JSON.stringify(rest))).toEqual(expect.objectContaining({ limit: null, limitRemaining: null, usageTotal: 10.618429343 }));
  });
});

describe("refreshHermesUsage", () => {
  test("fetches every host, splits ledger from key usage on the delimiter, preserves failure", async () => {
    const runner: UsageRunner = async (cmd) => {
      const host = cmd[cmd.length - 2];
      if (host === "vps") return combined(sqliteJson([{ model: "deepseek/deepseek-v4.1-flash", input_tokens: 10, last_seen: 1700000000 }]), JSON.stringify(sampleKeyUsage));
      return ""; // no db, no sqlite3, or unreachable
    };
    const store = await refreshHermesUsage(emptyHermesUsageStore(), 5000, [{ label: "vps", host: "vps" }, { label: "dead", host: "dead" }], runner);
    expect(store.checkedAt).toBe(5000);
    expect(store.results).toEqual([
      expect.objectContaining({
        host: "vps", ok: true,
        rows: [expect.objectContaining({ model: "deepseek/deepseek-v4.1-flash" })],
        keyUsage: expect.objectContaining({ usageTotal: 10.618429343 }),
      }),
      expect.objectContaining({ host: "dead", ok: false, rows: [], keyUsage: null }),
    ]);
  });

  test("ledger read can succeed while key usage is absent, and vice versa", async () => {
    const ledgerOnly: UsageRunner = async () => combined(sqliteJson([{ model: "m", input_tokens: 1, last_seen: 1700000000 }]));
    const keyUsageOnly: UsageRunner = async () => combined("", JSON.stringify(sampleKeyUsage));
    const a = await refreshHermesUsage(emptyHermesUsageStore(), 1, [{ label: "vps", host: "vps" }], ledgerOnly);
    expect(a.results[0]).toEqual(expect.objectContaining({ ok: true, keyUsage: null }));
    const b = await refreshHermesUsage(emptyHermesUsageStore(), 1, [{ label: "vps", host: "vps" }], keyUsageOnly);
    expect(b.results[0]).toEqual(expect.objectContaining({ ok: false, keyUsage: expect.objectContaining({ usageTotal: 10.618429343 }) }));
  });

  test("no hosts means no probes", async () => {
    const runner: UsageRunner = async () => { throw new Error("should not be called"); };
    const store = await refreshHermesUsage(emptyHermesUsageStore(), 5000, [], runner);
    expect(store).toEqual({ checkedAt: 5000, results: [] });
  });
});

describe("hermesUsageRefreshDue", () => {
  test("due on a fresh store and after the interval elapses", () => {
    expect(hermesUsageRefreshDue(emptyHermesUsageStore(), 1000)).toBe(true);
    const checked = { checkedAt: 1000, results: [] };
    expect(hermesUsageRefreshDue(checked, 1000 + HERMES_USAGE_REFRESH_MS - 1)).toBe(false);
    expect(hermesUsageRefreshDue(checked, 1000 + HERMES_USAGE_REFRESH_MS)).toBe(true);
  });
});

describe("parseHermesUsageStoreText", () => {
  test("round-trips a store written by refreshHermesUsage, including key usage", async () => {
    const runner: UsageRunner = async () => combined(sqliteJson([{ session_id: "s1", model: "m", input_tokens: 1, last_seen: 1700000000 }]), JSON.stringify(sampleKeyUsage));
    const store = await refreshHermesUsage(emptyHermesUsageStore(), 5000, [{ label: "vps", host: "vps" }], runner);
    expect(parseHermesUsageStoreText(JSON.stringify(store))).toEqual(store);
  });

  test("degrades to an empty store on missing or malformed input", () => {
    expect(parseHermesUsageStoreText(null)).toEqual(emptyHermesUsageStore());
    expect(parseHermesUsageStoreText("not json")).toEqual(emptyHermesUsageStore());
    expect(parseHermesUsageStoreText("x".repeat(2_000_000))).toEqual(emptyHermesUsageStore());
  });
});

describe("hermesUsageSummary", () => {
  const dayKeys = ["2026-09-16", "2026-09-17", "2026-09-18"];
  // 2026-09-18 00:00:00 UTC-ish; exact tz doesn't matter, only that this
  // lands on dayKeys' last entry via localDayKey's local-time math.
  const todaySeconds = Math.floor(new Date(2026, 8, 18, 12, 0, 0).getTime() / 1000);
  const yesterdaySeconds = Math.floor(new Date(2026, 8, 17, 12, 0, 0).getTime() / 1000);
  const row = (over: object) => ({ sessionId: "s1", model: "m", billingProvider: "openrouter", apiCallCount: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0, lastSeen: todaySeconds, ...over });

  test("returns null when there is no successful row and no key usage anywhere", () => {
    expect(hermesUsageSummary({ checkedAt: 1, results: [{ host: "vps", ok: false, rows: [], keyUsage: null, checkedAt: 1 }] }, dayKeys)).toBeNull();
  });

  test("aggregates tokens, cost, sessions and day-buckets across hosts, using ledger cost when no key usage exists", () => {
    const store = {
      checkedAt: 1, results: [
        { host: "vps", ok: true, checkedAt: 1, keyUsage: null, rows: [
          { sessionId: "s1", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter", apiCallCount: 5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 5, estimatedCostUsd: 0.01, lastSeen: todaySeconds },
          { sessionId: "s1", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter", apiCallCount: 2, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.002, lastSeen: yesterdaySeconds },
          { sessionId: "s2", model: "deepseek/deepseek-v4.1-flash", billingProvider: "openrouter", apiCallCount: 1, inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.0001, lastSeen: todaySeconds },
        ] },
      ],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary.totalSessions).toBe(2);
    expect(summary.todaySessions).toBe(2);
    expect(summary.totalPrompts).toBe(8);
    expect(summary.todayPrompts).toBe(6);
    expect(summary.costSource).toBe("ledger");
    expect(summary.costLifetimeUsd).toBeCloseTo(0.0121, 6);
    expect(summary.costTodayUsd).toBeCloseTo(0.0101, 6);
    expect(summary.monthlyLimit).toBeNull();
    expect(summary.modelUsage["deepseek/deepseek-v4.1-flash"]).toEqual({ inputTokens: 125, outputTokens: 66, cacheReadInputTokens: 10, cacheCreationInputTokens: 0 });
    expect(summary.modelSessions).toEqual({ "deepseek/deepseek-v4.1-flash": 2 });
    expect(summary.recentDays).toEqual([
      { date: "2026-09-16", messageCount: 0 },
      { date: "2026-09-17", messageCount: 30 },
      { date: "2026-09-18", messageCount: 171 },
    ]);
  });

  test("ignores rows from hosts that failed", () => {
    const store = {
      checkedAt: 1, results: [
        { host: "vps", ok: true, checkedAt: 1, keyUsage: null, rows: [row({})] },
        { host: "dead", ok: false, checkedAt: 1, keyUsage: null, rows: [row({ sessionId: "should-not-appear", apiCallCount: 99 })] },
      ],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary.totalPrompts).toBe(1);
    expect(summary.totalSessions).toBe(1);
  });

  // This is the actual bug this rework fixes: verified live against a real
  // Hermes instance, the ledger's own per-row sum ($0.37) badly undercounted
  // true lifetime spend ($10.62, confirmed against OpenRouter's own
  // dashboard) because the local ledger is only as old as Hermes's current
  // session-tracking window, not the account's real history.
  test("prefers OpenRouter's own key-usage figures over the ledger's per-row sum once available", () => {
    const store = {
      checkedAt: 1, results: [
        { host: "vps", ok: true, checkedAt: 1, keyUsage: parseKeyUsage(JSON.stringify(sampleKeyUsage)), rows: [row({ estimatedCostUsd: 0.02 })] },
      ],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary.costSource).toBe("openrouter");
    expect(summary.costLifetimeUsd).toBeCloseTo(10.618429343, 6);
    expect(summary.costTodayUsd).toBeCloseTo(0.358221824, 6);
    expect(summary.monthlyLimit).toEqual({ limit: 20, percent: 0.589249832 / 20, checkedAtMs: Date.parse("2026-09-18T08:00Z") });
  });

  test("key usage alone (no ledger rows yet) still produces a summary", () => {
    const store = {
      checkedAt: 1, results: [
        { host: "vps", ok: true, checkedAt: 1, keyUsage: parseKeyUsage(JSON.stringify(sampleKeyUsage)), rows: [] },
      ],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary).not.toBeNull();
    expect(summary.costSource).toBe("openrouter");
    expect(summary.totalPrompts).toBe(0);
    expect(Object.keys(summary.modelUsage)).toEqual([]);
  });

  test("a key with no configured monthly limit still prices spend but draws no limit bar", () => {
    const { limit, limit_remaining, ...unlimited } = sampleKeyUsage;
    const store = {
      checkedAt: 1, results: [{ host: "vps", ok: true, checkedAt: 1, keyUsage: parseKeyUsage(JSON.stringify(unlimited)), rows: [] }],
    };
    const summary = hermesUsageSummary(store, dayKeys)!;
    expect(summary.costSource).toBe("openrouter");
    expect(summary.monthlyLimit).toBeNull();
  });
});
