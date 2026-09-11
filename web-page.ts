// Read-only HTML of the Infomarchy desk for Web Mode. Layout matches the
// SUPER+D overlay: module strip, two columns, glass cards. Wallpaper is
// CSS cover/center. Media controls stay off the page.

export function escapeHtml(value: unknown, max = 400): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtTokens(n: unknown): string {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v < 0) return "0";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(Math.round(v));
}

export function fmtMoney(n: unknown): string {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v < 0) return "$0.00";
  if (v >= 1000) return "$" + (v / 1000).toFixed(1) + "k";
  if (v >= 100) return "$" + v.toFixed(0);
  return "$" + v.toFixed(2);
}

export function fmtUntil(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const s = Math.max(0, (ts - now) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m";
  return Math.floor(s / 86400) + "d " + Math.floor(s % 86400 / 3600) + "h";
}

export function fmtBytes(n: unknown): string {
  let v = Number(n || 0);
  if (!Number.isFinite(v) || v < 0) return "0B";
  const units = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : 1)) + units[i];
}

export function fmtRate(n: unknown): string {
  if (n === null || n === undefined || n === "") return "—";
  let v = Number(n) * 8;
  if (!Number.isFinite(v) || v < 0) return "—";
  const units = ["b", "Kb", "Mb", "Gb"];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + units[i] + "/s";
}

export function fmtPct(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n) + "%";
}

export function fmtDur(sec: unknown): string {
  const s = Math.max(0, Math.floor(Number(sec || 0)));
  if (!Number.isFinite(s)) return "";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}

export function displayMount(path: unknown): string {
  return String(path || "").replace(/^\/home\/[^/]+/, "~").slice(0, 24);
}

export function wifiLabel(net: any): string {
  const n = net && typeof net === "object" ? net : {};
  if (!n.wireless) return ("NET " + String(n.dev || "—")).slice(0, 20);
  return "WIFI";
}

// A separate disclosure view: never mutate the collector's desktop snapshot.
// Session records also contain cwd, prompts, previews and action arguments;
// only the fields used on the web may cross the JSON boundary.
export function filterWebSnapshot(snapshot: any, privacy = true): any {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const pick = (row: any, keys: string[]) => Object.fromEntries(keys
    .filter(key => row && Object.hasOwn(row, key)).map(key => [key, row[key]]));
  const ai = snap.ai || {};
  const machine = { ...snap.machine, net: { ...snap.machine?.net } };
  machine.disks = take(machine.disks, 2).map(d => ({ ...d, mount: privacy ? displayMount(d.mount) : d.mount }));
  if (privacy) {
    machine.externalIp = null;
    machine.net.ssid = null;
    machine.net.addr = null;
  }
  const session = (row: any) => ({
    ...pick(row, ["provider", "project", "topic", "uptimeSec", "attention", "attentionReason"]),
    git: pick(row?.git, ["branch"]),
  });
  const usage = Object.fromEntries(Object.entries(ai.usage || {}).slice(0, 8).map(([key, row]: [string, any]) => [key, {
    ...pick(row, ["name", "ready", "tierLabel", "todayPrompts", "todaySessions", "todayTotalTokens", "hasTokenData", "totalSessions", "authHelpText", "usageStatusText"]),
    dailyTokens: take(row?.dailyTokens, 7),
    models: take(row?.models, 8).map(m => pick(m, ["id", "share", "todayTokens", "sessions"])),
    limits: take(row?.limits, 8).map(l => pick(l, ["label", "title", "percent", "resetsAt"])),
    value: { ...pick(row?.value, ["lifetime", "today"]), totals: pick(row?.value?.totals, ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) },
  }]));
  return {
    ...snap, media: undefined, containers: undefined,
    user: privacy ? null : snap.user, host: privacy ? null : snap.host, machine,
    ai: {
      ...ai, github: { ...ai.github, login: "" }, usage,
      sessions: take(ai.sessions, 12).map(session),
      attention: take(ai.attention, 8).map(session),
      recent: take(ai.recent, 24).map(row => ({
        ...pick(row, ["provider", "ts"]), project: folderName(row?.project),
        text: privacy ? obfuscatePrompt(row?.text) : String(row?.text || ""),
      })),
    },
  };
}

function usageKeysOf(usage: any): string[] {
  return Object.keys(usage || {}).filter(key => usage[key] && usage[key].ready !== false).slice(0, 8);
}

export function usageSeriesOf(usage: any, metric: "tokens" | "value"): { provider: string; points: number[] }[] {
  const out: { provider: string; points: number[] }[] = [];
  for (const key of usageKeysOf(usage)) {
    const row = usage[key] || {};
    const daily = Array.isArray(row.dailyTokens) ? row.dailyTokens.map((x: unknown) => Number(x) || 0) : [];
    if (!daily.some((x: number) => x > 0)) continue;
    if (metric === "tokens") {
      out.push({ provider: key, points: daily.slice(0, 7) });
      continue;
    }
    const totals = (row.value || {}).totals || {};
    const tokens = Number(totals.inputTokens || 0) + Number(totals.outputTokens || 0) + Number(totals.cacheReadInputTokens || 0) + Number(totals.cacheCreationInputTokens || 0);
    const lifetime = Number((row.value || {}).lifetime);
    if (!Number.isFinite(lifetime) || tokens <= 0) continue;
    const rate = lifetime / tokens;
    out.push({ provider: key, points: daily.slice(0, 7).map((x: number) => x * rate) });
  }
  return out;
}

export function renderTrendSvg(series: { provider: string; points: number[] }[], days: string[], fmt: (n: number) => string, theme: ThemeColors = FALLBACK_THEME): string {
  if (!series.length) return "";
  const n = series[0].points.length;
  if (n < 1) return "";
  let max = 1;
  for (const row of series) for (const p of row.points) max = Math.max(max, p);
  const w = 276, h = 72, pad = 1;
  const xAt = (i: number) => pad + (n === 1 ? (w - pad * 2) / 2 : i * (w - pad * 2) / (n - 1));
  const yAt = (v: number) => (h - pad) - (v / max) * (h - pad * 2);
  const gridStroke = hexToRgba(themeRole(theme, "foreground"), 0.22);
  const grid: string[] = [];
  for (let t = 0; t < 3; t++) {
    const y = pad + (h - pad * 2) * t / 2;
    grid.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="${gridStroke}" stroke-width="1"/>`);
  }
  const lines: string[] = [];
  for (const row of series) {
    const color = providerColorHex(row.provider, theme);
    const pts = row.points.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
    const area = `${xAt(0).toFixed(1)},${h - pad} ${pts} ${xAt(n - 1).toFixed(1)},${h - pad}`;
    lines.push(`<polygon points="${area}" fill="${color}" fill-opacity="0.08"/>`);
    lines.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`);
  }
  const ticks = [max, max / 2, 0].map(v => `<span>${escapeHtml(fmt(v), 12)}</span>`).join("");
  let xLabels = "";
  if (n > 1) {
    const first = String(days[0] || "").slice(5);
    const last = String(days[n - 1] || "").slice(5);
    xLabels = `<div class="chart-x"><span>${escapeHtml(first, 8)}</span><span>${escapeHtml(last, 8)}</span></div>`;
  }
  return `<div class="chart-body"><div class="chart-y">${ticks}</div><svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" aria-hidden="true">${grid.join("")}${lines.join("")}</svg>${xLabels}</div>`;
}

export const DEFAULT_RIGHT_ORDER = ["usage", "localAi", "machine"];
export const DEFAULT_OPS_ORDER = ["changes", "needs", "projects"];
export const WEB_ALWAYS_HIDDEN = ["media"];
export const WEB_SECTION_IDS = ["needs", "sessions", "activity", "github", "recent", "usage", "localAi", "machine", "changes", "projects"] as const;
export const DEFAULT_NARROW_ORDER = ["sessions", "changes", "needs", "projects", "activity", "github", "recent", "usage", "localAi", "machine"];
export const WEB_SECTION_LABELS: Record<string, string> = {
  needs: "NEXT ACTIONS",
  sessions: "SESSIONS",
  activity: "ACTIVITY",
  github: "GITHUB",
  recent: "RECENT",
  usage: "USAGE",
  localAi: "LOCAL AI",
  machine: "MACHINE",
  changes: "CHANGES",
  projects: "PROJECTS",
};

export type DashPrefs = {
  privacyMode: boolean;
  sections: Record<string, boolean>;
  webSections: Record<string, boolean>;
  rightOrder: string[];
  opsOrder: string[];
  webNarrowOrder: string[];
};

export type ThemeColors = {
  background: string;
  foreground: string;
  accent: string;
  green: string;
  yellow: string;
  red: string;
  blue: string;
  magenta: string;
  cyan: string;
};

export const FALLBACK_THEME: ThemeColors = {
  background: "#1f1f28",
  foreground: "#dcd7ba",
  accent: "#61afef",
  green: "#98c379",
  yellow: "#e5c07b",
  red: "#e06c75",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
};

function hexColor(value: string, fallback: string): string {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

function themeRole(theme: ThemeColors, role: keyof ThemeColors): string {
  return hexColor(theme[role], FALLBACK_THEME[role]);
}

export function parseThemeColors(raw: string): ThemeColors {
  const pick = (keys: string[], fallback: string) => {
    for (const key of keys) {
      const match = raw.match(new RegExp(`(?:^|\\n)${key}\\s*=\\s*"?(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))"?`, "i"));
      if (match && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(match[1])) return match[1];
    }
    return fallback;
  };
  const accent = pick(["accent"], FALLBACK_THEME.accent);
  const foreground = pick(["foreground"], FALLBACK_THEME.foreground);
  return {
    background: pick(["background"], FALLBACK_THEME.background),
    foreground,
    accent,
    green: pick(["green", "color2"], accent),
    yellow: pick(["yellow", "color3"], foreground),
    red: pick(["red", "urgent", "color1"], FALLBACK_THEME.red),
    blue: pick(["blue", "color4"], accent),
    magenta: pick(["magenta", "color5"], accent),
    cyan: pick(["cyan", "color6"], accent),
  };
}

export function providerColorHex(provider: string, theme: ThemeColors = FALLBACK_THEME): string {
  switch (String(provider || "").toLowerCase()) {
    case "claude":
    case "aider":
      return themeRole(theme, "yellow");
    case "codex":
      return themeRole(theme, "cyan");
    case "grok":
    case "grok-bot":
    case "copilot":
      return themeRole(theme, "magenta");
    case "gemini":
    case "opencode":
      return themeRole(theme, "blue");
    case "hermes":
    case "ollama":
      return themeRole(theme, "green");
    default:
      return themeRole(theme, "accent");
  }
}

export function normalizeOrder(value: unknown, allowed: string[]): string[] {
  const result: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = String(item || "");
      if (allowed.includes(id) && !result.includes(id)) result.push(id);
    }
  }
  for (const id of allowed) if (!result.includes(id)) result.push(id);
  return result;
}

export function parseDashPrefs(raw: unknown): DashPrefs {
  const parsed = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const sections = parsed.sections && typeof parsed.sections === "object" ? parsed.sections as Record<string, boolean> : {};
  const webSections = parsed.webSections && typeof parsed.webSections === "object" ? parsed.webSections as Record<string, boolean> : {};
  return {
    privacyMode: parsed.privacyMode !== false,
    sections,
    webSections,
    rightOrder: normalizeOrder(parsed.rightOrder, DEFAULT_RIGHT_ORDER),
    opsOrder: normalizeOrder(parsed.opsOrder, DEFAULT_OPS_ORDER),
    webNarrowOrder: normalizeOrder(parsed.webNarrowOrder, DEFAULT_NARROW_ORDER),
  };
}

export function webSectionEnabled(id: string, prefs: DashPrefs): boolean {
  if (WEB_ALWAYS_HIDDEN.includes(id)) return false;
  if (prefs.webSections && prefs.webSections[id] === false) return false;
  if (prefs.webSections && prefs.webSections[id] === true) return true;
  return prefs.sections[id] !== false;
}

export function obfuscatePrompt(text: unknown): string {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const words = s.split(" ");
  if (words.length <= 4) return s;
  return words.slice(0, 4).join(" ") + " ···";
}

export function stackOrder(id: string, prefs: DashPrefs): number {
  const index = prefs.webNarrowOrder.indexOf(id);
  return index < 0 ? 50 : index + 1;
}

function take(list: unknown, n: number): any[] {
  return Array.isArray(list) ? list.slice(0, n) : [];
}

function hexToRgba(value: string, alpha: number): string {
  let hex = hexColor(value, FALLBACK_THEME.background).slice(1);
  if (hex.length === 3) hex = hex.split("").map(ch => ch + ch).join("");
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderMeterBar(label: string, value: string, fraction: number, fill: string, rawLabel = false, theme: ThemeColors = FALLBACK_THEME): string {
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0));
  const width = Math.round(pct * 1000) / 10;
  const color = /^#[0-9a-fA-F]{6}$/.test(fill) ? fill : themeRole(theme, "foreground");
  const shown = rawLabel ? label : escapeHtml(label, 32);
  return `<div class="meter"><div class="meter-row"><span>${shown}</span><span>${escapeHtml(value, 48)}</span></div><div class="track"><div class="fill" style="width:${width}%;background:${color}"></div></div></div>`;
}

function renderLimit(limit: any, tone: string, theme: ThemeColors = FALLBACK_THEME): string {
  const pct = Math.max(0, Math.min(1, Number(limit.percent) || 0));
  const width = Math.round(pct * 1000) / 10;
  const until = limit.resetsAt ? "  ↻ " + fmtUntil(String(limit.resetsAt)) : "";
  const fill = pct > 0.85 ? themeRole(theme, "red") : pct > 0.6 ? themeRole(theme, "yellow") : tone;
  return `<div class="meter"><div class="meter-row"><span>${escapeHtml(limit.label || limit.title, 32)}</span><span>${escapeHtml(Math.round(pct * 100) + "%" + until, 40)}</span></div><div class="track"><div class="fill" style="width:${width}%;background:${fill}"></div></div></div>`;
}

function card(title: string, body: string, hint = "", id = "", on = true, order = 50): string {
  const sid = /^[A-Za-z][A-Za-z]{0,31}$/.test(id) ? id : "";
  const cls = "card block" + (on ? "" : " off");
  const data = sid ? ` data-section="${sid}"` : "";
  const orderStyle = sid ? ` style="--stack-order:${Math.max(1, Math.min(99, Math.floor(Number(order) || 50)))}"` : "";
  const move = sid
    ? `<span class="move"><button type="button" class="icon-btn" data-move="-1" data-section="${sid}">UP</button><button type="button" class="icon-btn" data-move="1" data-section="${sid}">DOWN</button></span>`
    : "";
  return `<section class="${cls}"${data}${orderStyle}><header class="card-head"><span class="card-title">${title}</span>${hint ? `<span class="card-hint">${escapeHtml(hint, 80)}</span>` : ""}${move}</header>${body}</section>`;
}

function fmtAgo(ts: unknown, now = Date.now()): string {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function folderName(path: unknown): string {
  const raw = String(path || "").replace(/\/+$/, "");
  const base = raw.replace(/^.*\//, "");
  return base || raw;
}

function cellCount(cell: unknown): number {
  if (Array.isArray(cell)) return Number(cell[0] || 0) || 0;
  if (cell && typeof cell === "object") return Number((cell as any).n || 0) || 0;
  return Number(cell || 0) || 0;
}

function cellKinds(cell: unknown): Record<string, number> {
  if (Array.isArray(cell) && cell[1] && typeof cell[1] === "object") return cell[1] as Record<string, number>;
  return {};
}

function dominantKind(kinds: Record<string, number>): string {
  let best = "", n = 0;
  for (const key of Object.keys(kinds)) {
    const v = Number(kinds[key] || 0);
    if (v > n) { n = v; best = key; }
  }
  return best;
}

function heatColor(kind: string, activity: boolean, theme: ThemeColors): string {
  if (!activity) {
    if (kind === "commit") return themeRole(theme, "green");
    if (kind === "pr") return themeRole(theme, "magenta");
    if (kind === "review") return themeRole(theme, "cyan");
    if (kind === "issue") return themeRole(theme, "yellow");
    if (kind === "comment") return themeRole(theme, "blue");
    return hexToRgba(themeRole(theme, "foreground"), 0.62);
  }
  return providerColorHex(kind, theme);
}

function renderHeat(cells: unknown, days: unknown, kinds: string[], activity: boolean, theme: ThemeColors = FALLBACK_THEME): string {
  const list = Array.isArray(cells) ? cells.slice(0, 168) : [];
  let max = 1;
  for (const cell of list) max = Math.max(max, cellCount(cell));
  const dayStarts = Array.isArray(days) ? days.map(Number) : [];
  const names = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const rows: string[] = [];
  for (let d = 0; d < 7; d++) {
    const ts = Number(dayStarts[d] || 0);
    const label = Number.isFinite(ts) && ts > 0 ? names[new Date(ts).getDay()] : names[d % 7];
    const cellsHtml: string[] = [];
    for (let h = 0; h < 24; h++) {
      const cell = list[d * 24 + h];
      const n = cellCount(cell);
      const kind = dominantKind(cellKinds(cell));
      const a = n > 0 ? (0.18 + 0.82 * Math.min(1, n / max)).toFixed(2) : "0.06";
      const color = n > 0 ? heatColor(kind || kinds[0] || "", activity, theme) : "var(--fg)";
      cellsHtml.push(`<i class="heat-cell" style="background:${color};opacity:${a}"></i>`);
    }
    rows.push(`<div class="heat-row"><span class="heat-day">${escapeHtml(label, 2)}</span>${cellsHtml.join("")}</div>`);
  }
  return `<div class="heat">${rows.join("")}</div>`;
}

function meta(id: string, prefs: DashPrefs): { on: boolean; order: number } {
  return { on: webSectionEnabled(id, prefs), order: stackOrder(id, prefs) };
}

export function renderUsageSection(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const usage = snap.ai?.usage && typeof snap.ai.usage === "object" ? snap.ai.usage : {};
  const keys = usageKeysOf(usage);
  const m = meta("usage", prefs);
  if (!keys.length) return card("USAGE &amp; LIMITS", `<p class="meta">no usage cache yet</p>`, "", "usage", m.on, m.order);
  const chips = keys.map(key => `<span class="chip" style="color:${providerColorHex(key, theme)};border-color:${providerColorHex(key, theme)}">${escapeHtml(usage[key].name || key, 24)}</span>`).join("");
  const tokenSeries = usageSeriesOf(usage, "tokens");
  const days = Array.isArray(snap.ai?.usageDays) ? snap.ai.usageDays.map(String) : [];
  const charts: string[] = [];
  if (tokenSeries.length) charts.push(`<div class="chart"><div class="chart-label">TOKENS · 7 days</div>${renderTrendSvg(tokenSeries, days, n => fmtTokens(n), theme)}</div>`);
  const blocks: string[] = [`<div class="chips">${chips}</div>`, ...charts];
  for (const key of keys) {
    const row = usage[key] || {};
    const tone = providerColorHex(key, theme);
    const v = row.value || {}, t = v.totals || {};
    const all = Number(t.inputTokens || 0) + Number(t.outputTokens || 0) + Number(t.cacheReadInputTokens || 0) + Number(t.cacheCreationInputTokens || 0);
    const life: string[] = [];
    if (all > 0) life.push("lifetime " + fmtTokens(all) + " tok");
    if (all > 0) life.push(Math.round(100 * Number(t.cacheReadInputTokens || 0) / all) + "% cache reads");
    if (v.lifetime !== null && v.lifetime !== undefined) life.push("≈" + fmtMoney(v.lifetime) + " est.");
    else if (all > 0) life.push("unpriced");
    if (row.totalSessions) life.push(row.totalSessions + " sessions");
    const hasTok = row.hasTokenData === true;
    const todayValue = hasTok && v.today !== null && v.today !== undefined ? " · ≈" + fmtMoney(v.today) : "";
    const todayBits = ["today " + String(row.todayPrompts || 0) + "p"];
    if (row.todaySessions) todayBits.push(String(row.todaySessions) + " sess");
    if (hasTok) todayBits.push(fmtTokens(row.todayTotalTokens) + " tok" + todayValue);
    const limits = take(row.limits, 8).map((limit: any) => renderLimit(limit, tone, theme)).join("");
    const help = row.authHelpText ? `<div class="meta">${escapeHtml(row.authHelpText, 200)}</div>` : "";
    const status = row.usageStatusText && !(row.limits || []).length ? `<div class="meta">${escapeHtml(row.usageStatusText, 200)}</div>` : "";
    const models = take(row.models, 8).filter((m: any) => m && ((m.share || 0) > 0 || (m.sessions || 0) > 0)).map((m: any) => {
      const value = hasTok
        ? fmtTokens(m.todayTokens) + " tok  ·  " + Math.round((m.share || 0) * 100) + "%"
        : String(m.sessions || 0) + " sess";
      return renderMeterBar(String(m.id || ""), value, hasTok ? Number(m.share) || 0 : 0, tone, false, theme);
    }).join("");
    blocks.push(`<div class="subcard" style="border-color:${tone}44"><div class="usage-head"><span class="tag" style="color:${tone}">${escapeHtml(row.name || key, 40)}</span> <span class="meta">${escapeHtml(row.tierLabel, 32)}</span></div><div class="meta">${escapeHtml(todayBits.join(" · "), 80)}</div>${help}${life.length ? `<div class="meta">${escapeHtml(life.join(" · "), 220)}</div>` : ""}${models}${status}${limits}</div>`);
  }
  return card("USAGE &amp; LIMITS", blocks.join(""), "", "usage", m.on, m.order);
}

export function renderMachineSection(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const machine = snap && snap.machine && typeof snap.machine === "object" ? snap.machine : {};
  const cpu = machine.cpu && typeof machine.cpu === "object" ? machine.cpu : {};
  const mem = machine.mem && typeof machine.mem === "object" ? machine.mem : {};
  const net = machine.net && typeof machine.net === "object" ? machine.net : {};
  const ping = machine.ping && typeof machine.ping === "object" ? machine.ping : {};
  const bat = machine.battery && typeof machine.battery === "object" ? machine.battery : null;
  const disks = take(machine.disks, 2);
  const cpuPct = Number(cpu.pct);
  const ramPct = Number(mem.pct);
  const load = Array.isArray(cpu.load) ? Number(cpu.load[0]) : NaN;
  const temp = Number(machine.temp);
  const cpuBits = [fmtPct(cpu.pct)];
  if (Number.isFinite(load)) cpuBits.push(load.toFixed(2));
  if (Number.isFinite(temp)) cpuBits.push(Math.round(temp) + "°");
  const ramBits: string[] = [];
  if (mem.used && mem.total) ramBits.push(fmtBytes(mem.used) + "/" + fmtBytes(mem.total));
  ramBits.push(fmtPct(mem.pct));
  const parts: string[] = [`<div class="grid">`];
  parts.push(renderMeterBar("CPU", cpuBits.join(" · "), (Number.isFinite(cpuPct) ? cpuPct : 0) / 100, cpuPct > 85 ? themeRole(theme, "red") : themeRole(theme, "blue"), false, theme));
  parts.push(renderMeterBar("RAM", ramBits.join(" · "), (Number.isFinite(ramPct) ? ramPct : 0) / 100, ramPct > 90 ? themeRole(theme, "red") : themeRole(theme, "green"), false, theme));
  for (const disk of disks) {
    const d = disk && typeof disk === "object" ? disk : {};
    const pct = Number(d.pct);
    const rawMount = String(d.mount || "/").slice(0, 24);
    const labelHtml = escapeHtml("DISK " + rawMount, 32);
    const value = (d.used && d.size ? fmtBytes(d.used) + "/" + fmtBytes(d.size) + " · " : "") + fmtPct(d.pct);
    parts.push(renderMeterBar(labelHtml, value, (Number.isFinite(pct) ? pct : 0) / 100, pct > 90 ? themeRole(theme, "red") : themeRole(theme, "yellow"), true, theme));
  }
  const hasSignal = net.signal !== null && net.signal !== undefined && net.signal !== "";
  const signal = hasSignal ? Number(net.signal) : NaN;
  const wifiFrac = Number.isFinite(signal) ? Math.max(0, Math.min(1, (signal + 90) / 60)) : (net.dev ? 1 : 0);
  const wifiVal = Number.isFinite(signal) ? signal + " dBm" : (net.dev ? "up" : "—");
  const wifiFill = Number.isFinite(signal) && signal < -75 ? themeRole(theme, "yellow") : themeRole(theme, "green");
  const ssid = String(net.ssid || "").slice(0, 32);
  const wifiLabelHtml = escapeHtml(net.wireless ? "WIFI" + (ssid ? " " + ssid : "") : wifiLabel(net), 40);
  parts.push(renderMeterBar(wifiLabelHtml, wifiVal, wifiFrac, wifiFill, true, theme));
  const pingOk = !!ping.ok;
  const pingMs = Number(ping.ms);
  const pingText = pingOk && Number.isFinite(pingMs) ? Math.round(pingMs) + " ms" : "timeout";
  const pingClass = !pingOk ? "bad" : pingMs > 80 ? "warn" : "ok";
  const batText = bat ? "BAT " + fmtPct(bat.pct) + " " + String(bat.status || "").toLowerCase() : "";
  const batHot = !!(bat && Number(bat.pct) < 20 && String(bat.status || "") !== "Charging");
  const up = machine.uptime ? "up " + fmtDur(machine.uptime) : "";
  const wan = String(machine.externalIp || "").slice(0, 40);
  const lan = String(net.addr || "").slice(0, 40);
  const who = [snap.user, snap.host].filter(Boolean).join("@");
  const openBits = [up, who, wan ? "WAN " + wan : "", lan ? "LAN " + lan : ""].filter(Boolean);
  parts.push(`<div class="span foot"><span class="ok">${escapeHtml("↓" + fmtRate(net.rxRate) + " ↑" + fmtRate(net.txRate), 40)}</span><span class="${pingClass}">${escapeHtml("⇄ " + pingText, 24)}</span>${batText ? `<span class="${batHot ? "bad" : "meta"}">${escapeHtml(batText, 40)}</span>` : ""}</div>`);
  parts.push(`<div class="span meta">${escapeHtml(prefs.privacyMode ? [up, "WAN/LAN/SSID hidden"].filter(Boolean).join(" · ") : openBits.join(" · ") || "up", 120)}</div>`);
  parts.push(`</div>`);
  const machineMeta = meta("machine", prefs);
  return card("MACHINE", parts.join(""), "", "machine", machineMeta.on, machineMeta.order);
}

function renderSessions(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const sessions = take(snap.ai?.sessions, 12);
  const m = meta("sessions", prefs);
  if (!sessions.length) return card("LIVE AI SESSIONS", `<p class="meta">none</p>`, "0 running", "sessions", m.on, m.order);
  const cards = sessions.map((item: any) => {
    const tone = providerColorHex(item.provider, theme);
    const git = item.git && typeof item.git === "object" ? item.git : {};
    const branch = git.branch ? "git " + git.branch : "";
    return `<div class="session" style="border-color:${tone}73;background:${tone}14"><div class="session-head"><span class="tag" style="color:${tone}">${escapeHtml(item.provider, 24)}</span><span class="meta">${escapeHtml(fmtDur(item.uptimeSec), 12)}</span></div><div class="session-project">${escapeHtml(item.project || "/", 80)}</div><div class="session-topic">${escapeHtml(item.topic ? "↳ " + item.topic : "↳ topic unavailable", 160)}</div>${branch ? `<div class="meta">${escapeHtml(branch, 80)}</div>` : ""}</div>`;
  }).join("");
  return card("LIVE AI SESSIONS", `<div class="sessions">${cards}</div>`, sessions.length + " running", "sessions", m.on, m.order);
}

function renderNeeds(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const attention = take(snap.ai?.attention, 8);
  const m = meta("needs", prefs);
  if (!attention.length) return card("NEXT ACTIONS", `<p class="ok">nothing waiting — all sessions can continue</p>`, "", "needs", m.on, m.order);
  const rows = attention.map((item: any) => {
    const kind = String(item.attention || "");
    const tone = kind === "blocked" ? themeRole(theme, "red") : kind === "waiting" ? themeRole(theme, "yellow") : themeRole(theme, "green");
    const label = kind === "blocked" ? "⚠ BLOCKED" : kind === "waiting" ? "? WAITING" : "✓ REVIEW";
    return `<div class="row" style="border-color:${tone}59"><span class="tag" style="color:${tone}">${escapeHtml(label, 16)}</span> <span>${escapeHtml(item.project, 80)}</span><div class="prompt">${escapeHtml(item.attentionReason || item.attention, 240)}</div></div>`;
  }).join("");
  return card("NEXT ACTIONS", rows, attention.length + " signals", "needs", m.on, m.order);
}

function changeSummary(item: any): string {
  const c = item && item.changes && typeof item.changes === "object" ? item.changes : {};
  const files = Array.isArray(c.files) ? c.files.length : Number(c.fileCount || 0);
  const ahead = Number(item.git?.ahead || 0);
  const behind = Number(item.git?.behind || 0);
  const bits = [];
  if (files) bits.push(files + " files");
  if (ahead) bits.push("↑" + ahead);
  if (behind) bits.push("↓" + behind);
  if (c.commitSubject) bits.push(String(c.commitSubject));
  return bits.join(" · ") || "changed";
}

function renderChanges(snap: any, prefs: DashPrefs = parseDashPrefs({})): string {
  const projects = take(snap.ai?.projects, 8).filter((item: any) => item && item.changes);
  const m = meta("changes", prefs);
  if (!projects.length) return card("WHAT CHANGED", `<p class="meta">no active repositories</p>`, "", "changes", m.on, m.order);
  const rows = projects.slice(0, 4).map((item: any) => {
    return `<div class="row"><strong>${escapeHtml(item.project || item.repo || "/", 80)}</strong><div class="meta">${escapeHtml(changeSummary(item), 160)}</div></div>`;
  }).join("");
  return card("WHAT CHANGED", rows, "", "changes", m.on, m.order);
}

function projectStatus(item: any, theme: ThemeColors = FALLBACK_THEME): { label: string; tone: string } {
  const status = String(item.status || "");
  if (status === "blocked") return { label: "BLOCKED", tone: themeRole(theme, "red") };
  if (status === "running") return { label: "RUNNING", tone: themeRole(theme, "blue") };
  if (status === "behind" || status === "changed") return { label: status.toUpperCase(), tone: themeRole(theme, "yellow") };
  if (status === "unknown") return { label: "UNKNOWN", tone: hexToRgba(themeRole(theme, "foreground"), 0.38) };
  return { label: "CLEAN", tone: themeRole(theme, "green") };
}

function renderProjects(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const projects = take(snap.ai?.projects, 8);
  const m = meta("projects", prefs);
  if (!projects.length) return card("PROJECT HEALTH", `<p class="meta">no active repositories</p>`, "", "projects", m.on, m.order);
  const rows = projects.slice(0, 4).map((item: any) => {
    const st = projectStatus(item, theme);
    const git = item.git || {};
    const bits = [git.branch || "no branch"];
    if (git.dirty) bits.push(git.dirty + " changed");
    else bits.push("clean");
    if (git.ahead) bits.push("↑" + git.ahead);
    if (git.behind) bits.push("↓" + git.behind);
    return `<div class="row"><span class="tag" style="color:${st.tone}">${escapeHtml(st.label, 12)}</span> <strong>${escapeHtml(item.project || "/", 80)}</strong><div class="meta">${escapeHtml(bits.join(" · "), 160)}</div></div>`;
  }).join("");
  return card("PROJECT HEALTH", rows, projects.length + " repos", "projects", m.on, m.order);
}

function renderActivity(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const heat = snap.ai?.heatmap && typeof snap.ai.heatmap === "object" ? snap.ai.heatmap : {};
  const counts = snap.ai?.counts && typeof snap.ai.counts === "object" ? snap.ai.counts : {};
  const parts: string[] = [];
  for (const key of Object.keys(counts).slice(0, 8)) {
    const row = counts[key] || {};
    parts.push(String(key) + " " + Number(row.today || 0) + "/" + Number(row.week || 0));
  }
  const hint = parts.length ? "today/week · " + parts.join(" · ") : "";
  const kinds = ["claude", "codex", "grok", "hermes", "opencode", "gemini", "ollama"];
  const m = meta("activity", prefs);
  return card("ACTIVITY · LAST 7 DAYS", renderHeat(heat.cells, heat.days, kinds, true, theme), hint, "activity", m.on, m.order);
}

function renderGithub(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const github = snap.ai?.github && typeof snap.ai.github === "object" ? snap.ai.github : {};
  const kinds = ["commit", "pr", "review", "issue", "comment", "other"];
  const counts = github.counts && typeof github.counts === "object" ? github.counts : {};
  const parts: string[] = [];
  for (const kind of kinds) {
    const row = counts[kind] || {};
    if (Number(row.week || 0) > 0 || Number(row.today || 0) > 0) parts.push(kind + " " + Number(row.today || 0) + "/" + Number(row.week || 0));
  }
  const hint = parts.length ? "today/week · " + parts.join(" · ") : "";
  const body = renderHeat(github.cells, github.days, kinds, false, theme);
  const m = meta("github", prefs);
  return card("GITHUB · LAST 7 DAYS", body, hint, "github", m.on, m.order);
}

function renderRecent(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const recent = take(snap.ai?.recent, 24);
  const m = meta("recent", prefs);
  if (!recent.length) return card("RECENT TASKS · WHAT GOT ASKED", `<p class="meta">none</p>`, "", "recent", m.on, m.order);
  const rows = recent.map((item: any) => {
    const tone = providerColorHex(item.provider, theme);
    const full = String(item.text || "");
    const textHtml = escapeHtml(full, 200);
    const project = folderName(item.project);
    return `<div class="recent-row"><span class="recent-ago">${escapeHtml(fmtAgo(item.ts), 8)}</span><span class="tag" style="color:${tone}">${escapeHtml(item.provider, 16)}</span><span class="recent-project">${escapeHtml(project, 80)}</span><span class="recent-text">${textHtml}</span></div>`;
  }).join("");
  return card("RECENT TASKS · WHAT GOT ASKED", `<div class="recent">${rows}</div>`, "", "recent", m.on, m.order);
}

function renderLocalAi(snap: any, prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME): string {
  const ol = snap.ai?.providers?.ollama && typeof snap.ai.providers.ollama === "object" ? snap.ai.providers.ollama : {};
  const m = meta("localAi", prefs);
  if (!ol.present) return card("LOCAL AI", `<p class="meta">ollama not reachable</p>`, "", "localAi", m.on, m.order);
  const loaded = take(ol.loaded, 8).map((m: any) => String(m.name || "")).filter(Boolean);
  const models = take(ol.models, 12);
  const chips = loaded.length
    ? loaded.map(name => `<span class="chip" style="color:${themeRole(theme, "green")};border-color:${themeRole(theme, "green")}">${escapeHtml(name, 48)}</span>`).join("")
    : `<span class="meta">no model loaded</span>`;
  const list = models.length
    ? models.map((m: any) => `<div class="row"><span>${escapeHtml(m.name, 64)}</span><span class="meta">${escapeHtml(m.parameterSize || fmtBytes(m.size), 24)}</span></div>`).join("")
    : `<p class="meta">no installed models</p>`;
  return card("LOCAL AI", `<div class="chips">${chips}</div>${list}`, ol.up ? "up" : "down", "localAi", m.on, m.order);
}



export const LIVE_SCRIPT = '(function(){function scale(){try{var n=Number(sessionStorage.getItem("im-scale"));return isFinite(n)&&n>=0.6&&n<=1.6?Math.round(n*10)/10:1}catch(e){return 1}}function setScale(n){n=Math.min(1.6,Math.max(0.6,Math.round(Number(n)*10)/10));try{sessionStorage.setItem("im-scale",String(n))}catch(e){}apply()}function apply(){var s=scale();document.documentElement.style.setProperty("--scale",String(s));var lab=document.getElementById("zoom-label");if(lab)lab.textContent=Math.round(s*100)+"%"}function prefsUrl(){var path=location.pathname;if(path.charAt(path.length-1)!=="/")path+="/";return path+"prefs"}function collect(){var sections={},order=[],chips=document.querySelectorAll("[data-toggle-section]");for(var i=0;i<chips.length;i++){var id=chips[i].getAttribute("data-toggle-section");if(id)sections[id]=!chips[i].classList.contains("off")}var blocks=document.querySelectorAll(".block[data-section]"),items=[];for(var j=0;j<blocks.length;j++)items.push({id:blocks[j].getAttribute("data-section"),order:Number((blocks[j].style.getPropertyValue("--stack-order")||j))});items.sort(function(a,b){return a.order-b.order});for(var k=0;k<items.length;k++)if(items[k].id)order.push(items[k].id);return{webSections:sections,webNarrowOrder:order}}function save(){fetch(prefsUrl(),{method:"POST",cache:"no-store",credentials:"omit",headers:{"content-type":"application/json"},body:JSON.stringify(collect())}).catch(function(){})}document.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest)return;if(t.id==="zoom-in"){setScale(scale()+0.1);return}if(t.id==="zoom-out"){setScale(scale()-0.1);return}if(t.id==="zoom-label"){setScale(1);return}var chip=t.closest("[data-toggle-section]");if(chip){var sid=chip.getAttribute("data-toggle-section"),on=chip.classList.contains("off"),label=chip.getAttribute("data-label")||"";chip.classList.toggle("off",!on);chip.textContent=(on?"\\u25cf ":"\\u25cb ")+label;var block=document.querySelector(\'.block[data-section="\'+sid+\'"]\');if(block)block.classList.toggle("off",!on);save();return}var mv=t.closest("[data-move]");if(!mv)return;var dir=Number(mv.getAttribute("data-move")),msid=mv.getAttribute("data-section"),list=Array.prototype.slice.call(document.querySelectorAll(".block[data-section]"));list.sort(function(a,b){return Number(a.style.getPropertyValue("--stack-order"))-Number(b.style.getPropertyValue("--stack-order"))});var idx=-1;for(var n=0;n<list.length;n++)if(list[n].getAttribute("data-section")===msid)idx=n;var swap=idx+dir;if(idx<0||swap<0||swap>=list.length)return;var ao=list[idx].style.getPropertyValue("--stack-order"),bo=list[swap].style.getPropertyValue("--stack-order");list[idx].style.setProperty("--stack-order",bo);list[swap].style.setProperty("--stack-order",ao);save()});apply();var busy=0;function g(){if(busy)return;busy=1;fetch(location.pathname,{cache:"no-store",credentials:"omit"}).then(function(r){return r.ok?r.text():Promise.reject()}).then(function(h){var d=new DOMParser().parseFromString(h,"text/html");var n=d.getElementById("view"),c=document.getElementById("view");if(!n||!c)return;var ns=d.querySelector("style"),cs=document.querySelector("style");if(ns&&cs)cs.replaceWith(document.importNode(ns,true));var y=scrollY;c.replaceWith(document.importNode(n,true));scrollTo(0,y);apply()}).catch(function(){}).then(function(){busy=0})}setInterval(g,5000)})();';

function backgroundImg(hasBackground: boolean, revision = ""): string {
  if (!hasBackground) return "";
  const rev = /^[0-9]{1,16}-[0-9]{1,16}$/.test(revision) ? "?v=" + revision : "";
  return `<img class="wall" src="bg${rev}" alt="" aria-hidden="true">`;
}

function pageCss(theme: ThemeColors, hasBackground: boolean, bgRev = ""): string {
  const bg = themeRole(theme, "background");
  const fg = themeRole(theme, "foreground");
  const green = themeRole(theme, "green");
  const yellow = themeRole(theme, "yellow");
  const red = themeRole(theme, "red");
  const blue = themeRole(theme, "blue");
  const magenta = themeRole(theme, "magenta");
  const cyan = themeRole(theme, "cyan");
  const accent = themeRole(theme, "accent");
  return `
:root { color-scheme: dark; --bg:${bg}; --fg:${fg}; --green:${green}; --yellow:${yellow}; --red:${red}; --blue:${blue}; --magenta:${magenta}; --cyan:${cyan}; --accent:${accent}; --card:${hexToRgba(bg, 0.62)}; --border:${hexToRgba(fg, 0.14)}; --dim:${hexToRgba(fg, 0.62)}; --faint:${hexToRgba(fg, 0.38)}; --gap:8px; --pad:16px; --radius:6px; --scale:1; }
html, body { margin:0; min-height:100%; background:var(--bg); color:var(--fg); font:13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
.stage { position:relative; isolation:isolate; min-height:100vh; box-sizing:border-box; padding:12px 16px 16px; zoom:var(--scale); background:var(--bg); }
.wall { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center; opacity:0.32; pointer-events:none; z-index:0; }
.desk { position:relative; z-index:1; display:flex; flex-direction:column; gap:var(--gap); min-height:calc(100vh - 28px); max-width:1920px; margin:0 auto; }
.strip { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.chip, .strip-chip, .icon-btn { font:11px ui-monospace, monospace; border:1px solid; border-radius:6px; padding:2px 7px; letter-spacing:0.04em; }
.strip-chip { color:var(--dim); border-color:var(--border); background:transparent; cursor:pointer; font-family:inherit; }
.strip-chip.off { opacity:0.45; }
.icon-btn { color:var(--blue); border-color:var(--border); background:transparent; cursor:pointer; font-family:inherit; font-weight:700; }
.zoom { display:inline-flex; gap:4px; align-items:center; }
.block.off { display:none; }
.move { display:none; }
.columns { display:grid; grid-template-columns:minmax(0,1fr) minmax(300px,28%); gap:var(--gap); flex:1; min-height:0; align-items:start; }
.left, .right { display:flex; flex-direction:column; gap:var(--gap); min-width:0; }
.ops { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:var(--gap); }
.heats { display:grid; grid-template-columns:1fr 1fr; gap:var(--gap); }
.card { background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:12px 14px; }
.card-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; }
.card-title { font-size:11px; letter-spacing:0.12em; color:var(--dim); font-weight:700; }
.card-hint { font-size:11px; color:var(--faint); text-align:right; }
.meta { color:var(--faint); font-size:12px; }
.prompt { color:var(--fg); margin-top:4px; }
.tag { display:inline-block; font-size:11px; letter-spacing:0.04em; font-weight:700; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 8px; }
.usage-head { display:flex; gap:8px; align-items:baseline; }
.subcard { border:1px solid var(--border); border-radius:var(--radius); padding:8px 10px; margin:8px 0 0; }
.meter { margin-top:8px; }
.meter-row { display:flex; justify-content:space-between; font:12px ui-monospace, monospace; color:var(--dim); }
.track { height:7px; background:${hexToRgba(fg, 0.10)}; border-radius:4px; margin-top:4px; overflow:hidden; }
.fill { height:100%; border-radius:4px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:12px 16px; }
.grid .meter { margin-top:0; }
.span { grid-column:1 / -1; }
.foot { display:flex; flex-wrap:wrap; gap:10px 14px; font:12px ui-monospace, monospace; }
.ok { color:var(--green); }
.warn { color:var(--yellow); }
.bad { color:var(--red); }
.sessions { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; }
.session { border:1px solid; border-radius:var(--radius); padding:8px 10px; min-width:0; }
.session-head { display:flex; justify-content:space-between; gap:8px; }
.session-project { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.session-topic { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.row { border:1px solid var(--border); border-radius:var(--radius); padding:6px 8px; margin:0 0 6px; }
.row:last-child { margin-bottom:0; }
.recent { display:grid; grid-template-columns:max-content max-content max-content minmax(0,1fr); column-gap:8px; align-items:baseline; max-height:42vh; overflow:auto; }
.recent-row { display:grid; grid-template-columns:subgrid; grid-column:1 / -1; align-items:baseline; padding:3px 0; border-bottom:1px solid var(--border); }
.recent-ago { color:var(--faint); font-size:12px; text-align:right; white-space:nowrap; }
.recent-row .tag { white-space:nowrap; }
.recent-project { color:var(--dim); font-size:12px; white-space:nowrap; }
.recent-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.heat { display:flex; flex-direction:column; gap:2px; }
.heat-row { display:grid; grid-template-columns:22px repeat(24,minmax(0,1fr)); gap:2px; height:14px; }
.heat-day { font-size:9px; color:var(--faint); }
.heat-cell { display:block; border-radius:2px; }
.chart { padding:4px 0 8px; }
.chart-body { display:grid; grid-template-columns:auto minmax(0,1fr); grid-template-rows:72px auto; column-gap:8px; row-gap:4px; align-items:stretch; }
.chart-y { display:flex; flex-direction:column; justify-content:space-between; align-items:flex-end; font-size:12px; line-height:1; color:var(--faint); }
.chart-x { grid-column:2; display:flex; justify-content:space-between; font-size:12px; line-height:1; color:var(--faint); }
.chart svg { display:block; width:100%; height:72px; }
.chart-label { font-size:12px; color:var(--dim); letter-spacing:0.06em; margin-bottom:4px; }
a.refresh, span.privacy-status { color:var(--blue); font-size:11px; font-weight:700; letter-spacing:0.06em; text-decoration:none; background:none; border:0; padding:2px 7px; font-family:inherit; cursor:pointer; }
span.privacy-status.on { color:var(--yellow); }

@media (max-width:1100px) {
  .stage { padding:8px; }
  .board { display:flex; flex-direction:column; gap:var(--gap); }
  .columns, .left, .right, .ops, .heats { display:contents; }
  .block { order:var(--stack-order, 50); }
  .move { display:inline-flex; gap:4px; margin-left:8px; }
  .recent { max-height:none; }
}
@media (max-width:640px) {
  .grid { grid-template-columns:1fr; }
  .sessions { grid-template-columns:1fr; }
}
`;
}

export function renderPage(snap: any, refreshPath: string, nonce = "", prefs: DashPrefs = parseDashPrefs({}), theme: ThemeColors = FALLBACK_THEME, hasBackground = false, bgRev = ""): string {
  snap = filterWebSnapshot(snap, prefs.privacyMode);
  const n = /^[0-9a-f]{32}$/.test(nonce) ? nonce : "";
  const strip: string[] = [];
  for (const id of WEB_SECTION_IDS) {
    const label = WEB_SECTION_LABELS[id] || id;
    const on = webSectionEnabled(id, prefs);
    strip.push(`<button type="button" class="strip-chip${on ? "" : " off"}" data-toggle-section="${id}" data-label="${escapeHtml(label, 24)}">${on ? "●" : "○"} ${escapeHtml(label, 24)}</button>`);
  }
  strip.push(`<span class="zoom"><button type="button" class="icon-btn" id="zoom-out">-</button><button type="button" class="icon-btn" id="zoom-label">100%</button><button type="button" class="icon-btn" id="zoom-in">+</button></span>`);
  const opsHtml = prefs.opsOrder.map(id => {
    if (id === "changes") return renderChanges(snap, prefs);
    if (id === "needs") return renderNeeds(snap, prefs, theme);
    if (id === "projects") return renderProjects(snap, prefs, theme);
    return "";
  }).join("");
  const rightHtml = prefs.rightOrder.map(id => {
    if (id === "usage") return renderUsageSection(snap, prefs, theme);
    if (id === "localAi") return renderLocalAi(snap, prefs, theme);
    if (id === "machine") return renderMachineSection(snap, prefs, theme);
    return "";
  }).join("");

  const rows: string[] = [];
  rows.push(`<!doctype html><html lang="en"><head><meta charset="utf-8">`);
  rows.push(`<meta name="viewport" content="width=device-width,initial-scale=1">`);
  rows.push(`<title>Infomarchy</title><style>${pageCss(theme, hasBackground, bgRev)}</style></head>`);
  rows.push(`<body>`);
  rows.push(`<div id="view" class="stage">${backgroundImg(hasBackground, bgRev)}<div class="desk">`);
  rows.push(`<div class="strip">${strip.join("")}<span id="privacy" class="privacy-status${prefs.privacyMode ? " on" : ""}">PRIVACY ${prefs.privacyMode ? "ON" : "OFF"} · controlled on desktop</span><a class="refresh" href="${escapeHtml(refreshPath, 200)}">Refresh</a></div>`);
  rows.push(`<div class="board"><div class="columns"><div class="left">`);
  rows.push(renderSessions(snap, prefs, theme));
  rows.push(`<div class="ops">${opsHtml}</div>`);
  rows.push(`<div class="heats">${renderActivity(snap, prefs, theme)}${renderGithub(snap, prefs, theme)}</div>`);
  rows.push(renderRecent(snap, prefs, theme));
  rows.push(`</div><div class="right">${rightHtml}</div></div></div></div></div>`);
  if (n) rows.push(`<script nonce="${n}">${LIVE_SCRIPT}</script>`);
  rows.push(`</body></html>`);
  return rows.join("");
}
