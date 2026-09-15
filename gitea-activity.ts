// Gitea's own activity feed, displayed by the same HeatPanel as GitHub.
// Credentials stay in tea's config (or the environment), never in the cache.
import { createHash } from "crypto";

export const GITEA_KINDS = ["push", "pr", "review", "issue", "comment", "other"] as const;
export type GiteaKind = typeof GITEA_KINDS[number];
type EventRow = [number, GiteaKind, string];
export const GITEA_MAX_BYTES = 4 * 1024 * 1024;
const WINDOW_MS = 7 * 86400_000 + 3600_000;
const MAX_ROWS = 6000;
const PAGE_SIZE = 100;
type Env = Record<string, string | undefined>;
export type GiteaConfig = { state: "ready" | "missing" | "configuration" | "disabled"; url: string; token: string; key: string; error: string };
export type GiteaStore = {
  key: string; login: string; loginCheckedAt: number; attemptedAt: number;
  fetchedAt: number; okAt: number; failCount: number; error: string;
  coveredFrom: number; reconciledAt: number; head: string;
  walk: { page: number; stop: string; head: string; from: number } | null;
  events: Record<string, EventRow>;
};

export function giteaBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > 2048 || /[\s\\\x00-\x1f]/.test(raw)) return "";
  try {
    const url = new URL(raw.includes("://") ? raw : "https://" + raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
    return url.href.replace(/\/+$/, "");
  } catch { return ""; }
}

// Match tea's default (or sole) login. A named override also supports two
// accounts on the same server without guessing which token should be used.
export function giteaConfig(text: string | null, env: Env = process.env): GiteaConfig {
  const unavailable = (state: GiteaConfig["state"], error = ""): GiteaConfig => ({ state, url: "", token: "", key: "", error });
  if (env.INFOMARCHY_SKIP_GITEA === "1") return unavailable("disabled");
  let logins: any[] = [];
  try {
    if (text && text.length <= 256 * 1024) {
      const data: any = Bun.YAML.parse(text);
      if (Array.isArray(data?.logins)) logins = data.logins.filter((x: any) => x && typeof x === "object").slice(0, 100);
    }
  } catch { return unavailable("configuration", "cannot read tea config"); }
  const host = env.GITEA_HOST ? giteaBaseUrl(env.GITEA_HOST) : "";
  if (env.GITEA_HOST && !host) return unavailable("configuration", "invalid GITEA_HOST");
  if (env.GITEA_TOKEN && !host) return unavailable("configuration", "GITEA_TOKEN needs GITEA_HOST");
  let selected: any;
  if (env.INFOMARCHY_GITEA_LOGIN) {
    const matches = logins.filter(x => x.name === env.INFOMARCHY_GITEA_LOGIN);
    if (matches.length !== 1) return unavailable("configuration", "select an existing tea login");
    selected = matches[0];
    if (host && giteaBaseUrl(selected.url) !== host) return unavailable("configuration", "GITEA_HOST and tea login differ");
  } else if (!(host && env.GITEA_TOKEN)) {
    const matches = host ? logins.filter(x => giteaBaseUrl(x.url) === host) : logins;
    const defaults = matches.filter(x => x.default === true);
    selected = defaults.length === 1 ? defaults[0] : matches.length === 1 ? matches[0] : null;
    if (!selected && matches.length) return unavailable("configuration", "set INFOMARCHY_GITEA_LOGIN to a tea login name");
  }
  const url = host || giteaBaseUrl(selected?.url);
  const token = env.GITEA_TOKEN || selected?.token;
  if (!url || typeof token !== "string" || !token || token.length > 4096 || /[\s\x00-\x1f]/.test(token)) {
    return unavailable(logins.length || host ? "configuration" : "missing", "run tea login add");
  }
  // Changing accounts or rotating a token invalidates the old private rows.
  const key = createHash("sha256").update(JSON.stringify([url, selected?.name || "", token])).digest("hex");
  return { state: "ready", url, token, key, error: "" };
}

export function emptyGiteaStore(key = ""): GiteaStore {
  return { key, login: "", loginCheckedAt: 0, attemptedAt: 0, fetchedAt: 0, okAt: 0, failCount: 0,
    error: "", coveredFrom: 0, reconciledAt: 0, head: "", walk: null, events: {} };
}
function stamp(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0; }
function loginName(value: unknown): string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) ? value : ""; }
function eventId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  return /^[0-9]{1,24}$/.test(String(value)) ? String(value) : "";
}
function repoName(value: unknown): string {
  return typeof value === "string" && value.length <= 240 && /^[^\s/\x00-\x1f]+\/[^\s/\x00-\x1f]+$/.test(value) ? value : "";
}
const ERRORS = ["authentication failed", "fetch failed", "invalid response", "response too large", "activity limit reached"];

export function parseGiteaStore(text: string | null, key: string): GiteaStore {
  const store = emptyGiteaStore(key);
  if (!key || !text || text.length > GITEA_MAX_BYTES) return store;
  try {
    const raw = JSON.parse(text);
    if (raw?.key !== key) return store;
    store.login = loginName(raw.login);
    for (const field of ["loginCheckedAt", "attemptedAt", "fetchedAt", "okAt", "coveredFrom", "reconciledAt"] as const) store[field] = stamp(raw[field]);
    store.failCount = Math.min(16, Math.floor(stamp(raw.failCount)));
    store.error = ERRORS.includes(raw.error) ? raw.error : "";
    store.head = eventId(raw.head);
    const w = raw.walk;
    if (w && Number.isInteger(w.page) && w.page >= 1 && w.page <= 60 && stamp(w.from)) {
      store.walk = { page: w.page, stop: eventId(w.stop), head: eventId(w.head), from: w.from };
    }
    if (raw.events && typeof raw.events === "object" && !Array.isArray(raw.events)) {
      for (const [id, row] of Object.entries(raw.events).slice(0, MAX_ROWS)) {
        if (eventId(id) && Array.isArray(row) && stamp(row[0]) && GITEA_KINDS.includes(row[1]) && repoName(row[2])) store.events[id] = [row[0], row[1], row[2]];
      }
    }
  } catch { return emptyGiteaStore(key); }
  return store;
}

export function giteaEventKind(type: unknown): GiteaKind | "" {
  switch (type) {
    // Gitea records pushes; one push may contain several commits.
    case "commit_repo": return "push";
    case "create_pull_request": case "merge_pull_request": case "close_pull_request": case "reopen_pull_request":
    case "pull_request_ready_for_review": case "auto_merge_pull_request": return "pr";
    case "approve_pull_request": case "reject_pull_request": case "pull_review_dismissed": return "review";
    case "create_issue": case "close_issue": case "reopen_issue": return "issue";
    case "comment_issue": case "comment_pull": return "comment";
    case "create_repo": case "rename_repo": case "star_repo": case "watch_repo": case "transfer_repo":
    case "push_tag": case "delete_tag": case "delete_branch": case "publish_release": return "other";
    default: return ""; // mirror sync and unknown events are not user activity
  }
}

export function giteaRefreshDue(store: GiteaStore, now: number): boolean {
  const interval = store.failCount ? Math.min(5, 2 ** (store.failCount - 1)) * 60_000 : store.walk ? 60_000 : 5 * 60_000;
  return !store.attemptedAt || now < store.attemptedAt || now - store.attemptedAt >= interval;
}

export type GiteaFetch = (url: string, init: RequestInit) => Promise<Response>;
async function api(config: GiteaConfig, path: string, fetcher: GiteaFetch): Promise<any> {
  const response = await fetcher(config.url + "/api/v1" + path, {
    headers: { Authorization: "token " + config.token, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 401 || response.status === 403 ? "authentication failed" : "fetch failed");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid response");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > GITEA_MAX_BYTES) throw new Error("response too large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid response"); }
}

// Walk two pages per attempt. Advance the saved high-water mark only once a
// walk finishes, so a busy interval does not disappear between refreshes.
export async function refreshGiteaActivity(store: GiteaStore, config: GiteaConfig, now: number, fetcher: GiteaFetch = fetch): Promise<void> {
  if (config.state !== "ready") return;
  if (store.key !== config.key) Object.assign(store, emptyGiteaStore(config.key));
  store.attemptedAt = now;
  try {
    if (!store.login || now < store.loginCheckedAt || now - store.loginCheckedAt >= 86400_000) {
      const user = await api(config, "/user", fetcher);
      const login = loginName(user?.login);
      if (!login) throw new Error("invalid response");
      if (store.login && store.login !== login) Object.assign(store, emptyGiteaStore(config.key), { attemptedAt: now });
      store.login = login; store.loginCheckedAt = now;
    }
    const floor = now - WINDOW_MS;
    if (!store.walk) {
      const reconcile = !store.coveredFrom || now - store.reconciledAt >= 6 * 3600_000;
      store.walk = { page: 1, stop: reconcile ? "" : store.head, head: "", from: floor };
    }
    for (let pages = 0; pages < 2 && store.walk; pages++) {
      const walk = store.walk;
      const rows = await api(config, `/users/${encodeURIComponent(store.login)}/activities/feeds?only-performed-by=true&limit=${PAGE_SIZE}&page=${walk.page}`, fetcher);
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error("invalid response");
      let ended = rows.length === 0;
      // An explicit empty page (not a short page) also supports servers that
      // enforce a page size below the requested limit.
      for (const row of rows) {
        const id = eventId(row?.id), ts = Date.parse(row?.created);
        if (!id || !Number.isFinite(ts)) throw new Error("invalid response");
        if (!walk.head) walk.head = id;
        if (id === walk.stop || ts < walk.from) ended = true;
        const kind = giteaEventKind(row.op_type), repo = repoName(row.repo?.full_name);
        if (ts >= floor && ts <= now && kind && repo && loginName(row.act_user?.login).toLowerCase() === store.login.toLowerCase()) store.events[id] = [ts, kind, repo];
      }
      store.fetchedAt = now;
      if (ended) {
        store.head = walk.head || store.head;
        if (!walk.stop) { store.coveredFrom = walk.from; store.reconciledAt = now; }
        store.walk = null;
      } else if (walk.page >= 60) {
        store.walk = null; store.coveredFrom = 0;
        throw new Error("activity limit reached");
      } else walk.page++;
    }
    store.error = ""; store.failCount = 0; store.okAt = now;
  } catch (error) {
    const message = error instanceof Error && ERRORS.includes(error.message) ? error.message : "fetch failed";
    if (message === "authentication failed") Object.assign(store, emptyGiteaStore(config.key), { attemptedAt: now, failCount: store.failCount });
    store.error = message; store.failCount = Math.min(16, store.failCount + 1);
  }
  const recent = Object.entries(store.events).filter(([, row]) => row[0] >= now - WINDOW_MS && row[0] <= now).sort((a, b) => b[1][0] - a[1][0]);
  // A busy forward walk can overflow the cache even within the page limit.
  // Keep the newest rows, but never claim coverage for rows we discarded.
  if (recent.length > MAX_ROWS) store.coveredFrom = recent[MAX_ROWS - 1][1][0];
  store.events = Object.fromEntries(recent.slice(0, MAX_ROWS));
}

export function giteaSnapshot(store: GiteaStore, config: GiteaConfig, now: number, days: number[], cellIndex: (ts: number, days: number[]) => number) {
  if (config.state !== "ready" || store.key !== config.key) store = emptyGiteaStore(config.key);
  let state: string = config.state === "ready" ? "ok" : config.state;
  if (state === "ok") {
    if (store.error === "authentication failed") state = "unauthenticated";
    else if (!store.fetchedAt) state = store.error ? "unavailable" : "pending";
    else if (store.error && (!store.okAt || now - store.okAt >= 15 * 60_000)) state = "stale";
  }
  const cells: [number, Record<string, number>, Record<string, number>][] = Array.from({ length: 168 }, () => [0, {}, {}]);
  const counts = Object.fromEntries(GITEA_KINDS.map(kind => [kind, { today: 0, week: 0 }]));
  if (config.state === "ready" && store.key === config.key) for (const [ts, kind, repo] of Object.values(store.events)) {
    const index = cellIndex(ts, days);
    if (ts > now || index < 0 || index >= 168) continue;
    const cell = cells[index];
    cell[0]++; cell[1][kind] = (cell[1][kind] || 0) + 1; cell[2][repo] = (cell[2][repo] || 0) + 1;
    counts[kind].week++; if (ts >= days[6]) counts[kind].today++;
  }
  return { state, login: store.login, fetchedAt: store.fetchedAt, error: config.error || store.error,
    coverage: store.coveredFrom && store.coveredFrom <= days[0] ? "complete" : "partial", days, cells, counts };
}
