// Reads two things from Hermes over SSH, so the desk can show
// OpenRouter-routed usage (Deepseek and anything else Hermes talks to) the
// same way it shows Claude/Codex usage — without a second API key or login:
//
//   1. The per-model billing ledger (~/.hermes/state.db, session_model_usage
//      table) — token counts and a per-row cost estimate, for the model
//      breakdown and the token trend line. This table is only as old as
//      Hermes's local session tracking, which is NOT the same as lifetime
//      OpenRouter spend — verified live: the table went back about 16 hours
//      while the OpenRouter account itself had $10.62 of real lifetime spend.
//      Its per-row cost (estimated_cost_usd) is therefore a fallback, used
//      only when (2) below is unavailable.
//   2. Hermes's own cached snapshot of OpenRouter's key-usage API
//      (~/.hermes/workspace/openrouter_key_usage.json) — usage_daily/
//      usage_weekly/usage_monthly/usage_total, plus the account's monthly
//      credit limit. This is the authoritative dollar figure (it comes from
//      OpenRouter itself, not reconstructed locally) and the only source for
//      a real "lifetime" number or a limit bar, so it's preferred for
//      everything money-shaped; the ledger only fills in what it can't
//      provide (tokens, per-model split, session counts).
//
// Shares FleetHostConfig from fleet-remote.ts — this reads from the same
// configured hosts (INFOMARCHY_FLEET_HOSTS), not a second env var. A host
// missing either file, or with no sqlite3 on PATH, degrades to "no rows" /
// "no key usage" independently — one can be present without the other.

import type { FleetHostConfig } from "./fleet-remote";

export type UsageRunner = (cmd: string[], timeoutMs: number) => Promise<string>;

export type HermesUsageRow = {
  sessionId: string; model: string; billingProvider: string;
  apiCallCount: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  estimatedCostUsd: number; lastSeen: number; // unix seconds, as sqlite stores it
};
export type HermesKeyUsage = {
  checkedAtMs: number;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string;
  usageTotal: number; usageDaily: number; usageWeekly: number; usageMonthly: number;
};
export type HermesUsageHostResult = { host: string; ok: boolean; rows: HermesUsageRow[]; keyUsage: HermesKeyUsage | null; checkedAt: number };
export type HermesUsageStore = { checkedAt: number; results: HermesUsageHostResult[] };

export const HERMES_USAGE_REFRESH_MS = 60_000;
export const HERMES_USAGE_SSH_TIMEOUT_MS = 5_000;
const MAX_ROWS_PER_HOST = 2000;
const MAX_HOSTS = 8;
const USAGE_STORE_MAX_BYTES = 1_048_576;
const MAX_KEY_USAGE_BYTES = 8192;

// Fixed query, never built from configuration — there is nothing here an
// entry in INFOMARCHY_FLEET_HOSTS could inject into. Ordered newest-first so
// a row cap loses only the oldest history, never the most recent activity.
const HERMES_USAGE_QUERY =
  "SELECT session_id, model, billing_provider, api_call_count, input_tokens, output_tokens, " +
  "cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, last_seen " +
  `FROM session_model_usage ORDER BY last_seen DESC LIMIT ${MAX_ROWS_PER_HOST};`;

// Splits the ledger read from the key-usage read in one SSH round trip
// rather than two — each call measured ~1.5s live, so halving the count
// matters on a 60s refresh. Unrelated in principle to unlikely to appear
// itself in either output, but only ever used to split our own command's
// output, never matched against anything remote-supplied.
const OUTPUT_DELIMITER = "___INFOMARCHY_HERMES_USAGE___";

function sshArgs(host: string): string[] {
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=4",
    "-o", "ServerAliveInterval=4",
    "-o", "ServerAliveCountMax=1",
    host,
    // $HOME expands on the remote shell, not here — there is no way to read
    // a remote HERMES_HOME override without a second round trip, so this
    // only covers the default install location, same limitation ps-based
    // detection in fleet-remote.ts already accepts for argv precision.
    `test -f "$HOME/.hermes/state.db" && sqlite3 -json -readonly "$HOME/.hermes/state.db" '${HERMES_USAGE_QUERY}'; ` +
      `echo '${OUTPUT_DELIMITER}'; ` +
      `cat "$HOME/.hermes/workspace/openrouter_key_usage.json" 2>/dev/null | head -c ${MAX_KEY_USAGE_BYTES}`,
  ];
}

function finite(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// null means "could not read the ledger" (unreachable host, no sqlite3, no
// db); [] means "read it, zero rows" — sqlite3 -json prints [] for an empty
// result set, so this distinction is real, not guessed.
export function parseHermesUsageRows(output: string): HermesUsageRow[] | null {
  const text = output.trim();
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const rows: HermesUsageRow[] = [];
  for (const raw of parsed.slice(0, MAX_ROWS_PER_HOST)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const model = typeof r.model === "string" ? r.model.trim().slice(0, 96) : "";
    if (!model) continue;
    rows.push({
      sessionId: typeof r.session_id === "string" ? r.session_id.slice(0, 128) : "",
      model,
      billingProvider: typeof r.billing_provider === "string" ? r.billing_provider.slice(0, 32) : "",
      apiCallCount: Math.floor(finite(r.api_call_count)),
      inputTokens: Math.floor(finite(r.input_tokens)),
      outputTokens: Math.floor(finite(r.output_tokens)),
      cacheReadTokens: Math.floor(finite(r.cache_read_tokens)),
      cacheWriteTokens: Math.floor(finite(r.cache_write_tokens)),
      reasoningTokens: Math.floor(finite(r.reasoning_tokens)),
      estimatedCostUsd: finite(r.estimated_cost_usd),
      lastSeen: finite(r.last_seen),
    });
  }
  return rows;
}

// null means the file was absent, unreadable, or not valid JSON — a real
// account legitimately reading $0 everywhere still has every field present
// and numeric, so an all-zero object is never confused with "no data".
export function parseKeyUsage(output: string): HermesKeyUsage | null {
  const text = output.trim();
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r.usage_total !== "number" || !Number.isFinite(r.usage_total)) return null;
  const checkedAtMs = typeof r.checked_at_utc === "string" ? Date.parse(r.checked_at_utc) : NaN;
  const limit = typeof r.limit === "number" && Number.isFinite(r.limit) && r.limit > 0 ? r.limit : null;
  const limitRemaining = typeof r.limit_remaining === "number" && Number.isFinite(r.limit_remaining) ? Math.max(0, r.limit_remaining) : null;
  return {
    checkedAtMs: Number.isFinite(checkedAtMs) ? checkedAtMs : 0,
    limit, limitRemaining,
    limitReset: typeof r.limit_reset === "string" ? r.limit_reset.slice(0, 32) : "",
    usageTotal: finite(r.usage_total), usageDaily: finite(r.usage_daily),
    usageWeekly: finite(r.usage_weekly), usageMonthly: finite(r.usage_monthly),
  };
}

async function fetchHost(host: string, runner: UsageRunner, now: number): Promise<HermesUsageHostResult> {
  try {
    const output = await runner(sshArgs(host), HERMES_USAGE_SSH_TIMEOUT_MS);
    const split = output.indexOf(OUTPUT_DELIMITER);
    const ledgerPart = split >= 0 ? output.slice(0, split) : output;
    const keyUsagePart = split >= 0 ? output.slice(split + OUTPUT_DELIMITER.length) : "";
    const rows = parseHermesUsageRows(ledgerPart);
    return { host, ok: rows !== null, rows: rows || [], keyUsage: parseKeyUsage(keyUsagePart), checkedAt: now };
  } catch {
    return { host, ok: false, rows: [], keyUsage: null, checkedAt: now };
  }
}

export function emptyHermesUsageStore(): HermesUsageStore {
  return { checkedAt: 0, results: [] };
}

export function hermesUsageRefreshDue(store: HermesUsageStore, now: number): boolean {
  const last = store.checkedAt || 0;
  if (!(last > 0) || last > now) return true;
  return now - last >= HERMES_USAGE_REFRESH_MS;
}

export async function refreshHermesUsage(store: HermesUsageStore, now: number, hosts: FleetHostConfig[], runner: UsageRunner): Promise<HermesUsageStore> {
  const capped = hosts.slice(0, MAX_HOSTS);
  if (!capped.length) return { checkedAt: now, results: [] };
  const results = await Promise.all(capped.map(h => fetchHost(h.host, runner, now)));
  return { checkedAt: now, results };
}

function normalizeRow(raw: unknown): HermesUsageRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const model = typeof r.model === "string" ? r.model.slice(0, 96) : "";
  if (!model) return null;
  return {
    sessionId: typeof r.sessionId === "string" ? r.sessionId.slice(0, 128) : "",
    model,
    billingProvider: typeof r.billingProvider === "string" ? r.billingProvider.slice(0, 32) : "",
    apiCallCount: Math.floor(finite(r.apiCallCount)),
    inputTokens: Math.floor(finite(r.inputTokens)),
    outputTokens: Math.floor(finite(r.outputTokens)),
    cacheReadTokens: Math.floor(finite(r.cacheReadTokens)),
    cacheWriteTokens: Math.floor(finite(r.cacheWriteTokens)),
    reasoningTokens: Math.floor(finite(r.reasoningTokens)),
    estimatedCostUsd: finite(r.estimatedCostUsd),
    lastSeen: finite(r.lastSeen),
  };
}

function normalizeKeyUsage(raw: unknown): HermesKeyUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.usageTotal !== "number" || !Number.isFinite(r.usageTotal)) return null;
  const limit = typeof r.limit === "number" && Number.isFinite(r.limit) && r.limit > 0 ? r.limit : null;
  const limitRemaining = typeof r.limitRemaining === "number" && Number.isFinite(r.limitRemaining) ? Math.max(0, r.limitRemaining) : null;
  return {
    checkedAtMs: finite(r.checkedAtMs),
    limit, limitRemaining,
    limitReset: typeof r.limitReset === "string" ? r.limitReset.slice(0, 32) : "",
    usageTotal: finite(r.usageTotal), usageDaily: finite(r.usageDaily),
    usageWeekly: finite(r.usageWeekly), usageMonthly: finite(r.usageMonthly),
  };
}

function normalizeHostResult(raw: unknown): HermesUsageHostResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const host = typeof r.host === "string" ? r.host.slice(0, 253) : "";
  if (!host) return null;
  const rows = Array.isArray(r.rows) ? r.rows.slice(0, MAX_ROWS_PER_HOST).map(normalizeRow).filter((x): x is HermesUsageRow => x !== null) : [];
  return { host, ok: r.ok === true, rows, keyUsage: normalizeKeyUsage(r.keyUsage), checkedAt: finite(r.checkedAt) };
}

// Disk-persisted between collector ticks, same reasoning as fleet-remote.ts's
// store: collector.ts is re-invoked fresh every 5s and has no other place to
// keep a refresh clock.
export function normalizeHermesUsageStore(raw: unknown): HermesUsageStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyHermesUsageStore();
  const source = raw as Record<string, unknown>;
  const results = Array.isArray(source.results)
    ? source.results.slice(0, MAX_HOSTS).map(normalizeHostResult).filter((r): r is HermesUsageHostResult => r !== null)
    : [];
  return { checkedAt: finite(source.checkedAt), results };
}

export function parseHermesUsageStoreText(text: string | null | undefined): HermesUsageStore {
  if (typeof text !== "string" || !text || text.length > USAGE_STORE_MAX_BYTES) return emptyHermesUsageStore();
  try { return normalizeHermesUsageStore(JSON.parse(text)); } catch { return emptyHermesUsageStore(); }
}

// Mirrors collector.ts's own localDayKey() (year-month-day in the viewer's
// local time) rather than importing it — importing from collector.ts here
// would create the same import cycle providerOf() avoids in fleet-remote.ts,
// and the function is four lines.
function localDayKey(stampMs: number): string {
  const d = new Date(stampMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type HermesUsageSummary = {
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  todayTokensByModel: Record<string, number>;
  modelSessions: Record<string, number>;
  recentDays: { date: string; messageCount: number }[];
  todayPrompts: number; totalPrompts: number;
  todaySessions: number; totalSessions: number;
  todayTotalTokens: number;
  costLifetimeUsd: number; costTodayUsd: number;
  // Present only when at least one host's openrouter_key_usage.json read
  // succeeded — the authoritative source costLifetimeUsd/costTodayUsd
  // already prefer over the ledger's own per-row sum (see module header).
  costSource: "openrouter" | "ledger";
  monthlyLimit: { limit: number; percent: number; checkedAtMs: number } | null;
};

// Aggregates every host's rows into the shape normalizeUsage() (collector.ts)
// expects as input, plus the cost/limit fields normalizeUsage() cannot
// derive itself (see the module header). dayKeys is the dashboard's existing
// 7 aligned local days (heatDays.map(localDayKey) at the call site) so this
// shares one x-axis with every other provider's trend line.
export function hermesUsageSummary(store: HermesUsageStore, dayKeys: string[]): HermesUsageSummary | null {
  const rows = store.results.filter(r => r.ok).flatMap(r => r.rows);
  const keyUsages = store.results.map(r => r.keyUsage).filter((k): k is HermesKeyUsage => k !== null);
  if (!rows.length && !keyUsages.length) return null;
  const today = dayKeys[dayKeys.length - 1];
  const modelUsage: HermesUsageSummary["modelUsage"] = {};
  const dayTotals = new Map<string, number>();
  const todayModelTotals = new Map<string, number>();
  const sessionIds = new Set<string>();
  const todaySessionIds = new Set<string>();
  const modelSessionIds = new Map<string, Set<string>>();
  let totalPrompts = 0, todayPrompts = 0, ledgerCostLifetimeUsd = 0, ledgerCostTodayUsd = 0;

  for (const row of rows) {
    // reasoning tokens are billed as output by every provider Hermes talks
    // to; there is no separate slot for them in the shared TokenUsage shape.
    const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.reasoningTokens;
    const entry = modelUsage[row.model] || (modelUsage[row.model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    entry.inputTokens += row.inputTokens;
    entry.outputTokens += row.outputTokens + row.reasoningTokens;
    entry.cacheReadInputTokens += row.cacheReadTokens;
    entry.cacheCreationInputTokens += row.cacheWriteTokens;

    totalPrompts += row.apiCallCount;
    ledgerCostLifetimeUsd += row.estimatedCostUsd;
    if (row.sessionId) {
      sessionIds.add(row.sessionId);
      let modelSet = modelSessionIds.get(row.model);
      if (!modelSet) { modelSet = new Set(); modelSessionIds.set(row.model, modelSet); }
      modelSet.add(row.sessionId);
    }

    const date = row.lastSeen > 0 ? localDayKey(row.lastSeen * 1000) : "";
    if (date) dayTotals.set(date, (dayTotals.get(date) || 0) + tokens);
    if (date && date === today) {
      todayPrompts += row.apiCallCount;
      ledgerCostTodayUsd += row.estimatedCostUsd;
      if (row.sessionId) todaySessionIds.add(row.sessionId);
      todayModelTotals.set(row.model, (todayModelTotals.get(row.model) || 0) + tokens);
    }
  }

  const modelSessions: Record<string, number> = {};
  for (const [model, ids] of modelSessionIds) modelSessions[model] = ids.size;

  // openrouter_key_usage.json is OpenRouter's own account-level figure, not
  // reconstructed from local rows — preferred whenever at least one host has
  // it. Summed across hosts on the (uncommon) assumption of distinct
  // accounts; the common case is one host, where this is just that host's
  // number.
  const hasKeyUsage = keyUsages.length > 0;
  const costLifetimeUsd = hasKeyUsage ? keyUsages.reduce((sum, k) => sum + k.usageTotal, 0) : ledgerCostLifetimeUsd;
  const costTodayUsd = hasKeyUsage ? keyUsages.reduce((sum, k) => sum + k.usageDaily, 0) : ledgerCostTodayUsd;
  const limited = keyUsages.filter(k => k.limit !== null);
  const monthlyLimit = limited.length
    ? {
        limit: limited.reduce((sum, k) => sum + (k.limit || 0), 0),
        percent: limited.reduce((sum, k) => sum + k.usageMonthly, 0) / limited.reduce((sum, k) => sum + (k.limit || 0), 0),
        checkedAtMs: Math.max(...limited.map(k => k.checkedAtMs)),
      }
    : null;

  return {
    modelUsage,
    todayTokensByModel: Object.fromEntries(todayModelTotals),
    modelSessions,
    recentDays: dayKeys.map(date => ({ date, messageCount: dayTotals.get(date) || 0 })),
    todayPrompts, totalPrompts,
    todaySessions: todaySessionIds.size, totalSessions: sessionIds.size,
    todayTotalTokens: dayTotals.get(today) || 0,
    costLifetimeUsd, costTodayUsd,
    costSource: hasKeyUsage ? "openrouter" : "ledger",
    monthlyLimit,
  };
}
