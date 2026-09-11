// Field patches only: no caller may publish a cached dashboard snapshot.
// The desktop helper and HTTP prefs endpoint share this transaction boundary.
import { parseManualHttps } from "./web-manual";
import { lstatSync } from "fs";
import { join } from "path";
import { parseJsonBounded, readRegularFileLimited, writePrivateStateFile } from "./collector";
import { withStateLock } from "./state-lock";

const MAPS = ["sections", "webSections", "attentionMuted", "pinnedPrompts", "seenChanges", "notificationEvents", "notificationProviders"];
const BOOLS = ["notificationsEnabled", "quietHoursEnabled", "dashboardVisible", "privacyMode", "webEnabled"];
const STRINGS = ["selectedOllamaModel", "ollamaHost"];
const ORDERS = ["rightOrder", "opsOrder", "webNarrowOrder"];
const BAD_KEYS = ["__proto__", "prototype", "constructor", "toJSON", "toString", "valueOf"];
const object = (v: any) => v && typeof v === "object" && !Array.isArray(v);

function validPatch(patch: any): boolean {
  if (!object(patch) || !Object.keys(patch).length || Buffer.byteLength(JSON.stringify(patch)) > 65536) return false;
  return Object.entries(patch).every(([key, value]: [string, any]) => {
    if (BAD_KEYS.includes(key)) return false;
    if (key === "manualHttps") return !!parseManualHttps(value);
    if (MAPS.includes(key)) return object(value) && Object.entries(value).length <= 256 && Object.entries(value).every(([k, v]) =>
      k.length > 0 && k.length <= 512 && !BAD_KEYS.includes(k) &&
      (v === null || (key === "attentionMuted" || key === "notificationEvents" ? typeof v === "number" && Number.isFinite(v) :
        key === "seenChanges" ? typeof v === "string" && v.length <= 2048 : typeof v === "boolean")));
    if (BOOLS.includes(key)) return typeof value === "boolean";
    if (STRINGS.includes(key)) return typeof value === "string" && value.length <= 2048;
    if (ORDERS.includes(key)) return Array.isArray(value) && value.length <= 16 && value.every(v => typeof v === "string" && /^[a-zA-Z]+$/.test(v));
    if (key === "webAccessMode") return value === "lan" || value === "tailscale" || value === "manual";
    if (key === "quietStartHour" || key === "quietEndHour") return Number.isInteger(value) && value >= 0 && value <= 23;
    return false;
  });
}

export function patchDashboard(directory: string, patch: unknown): boolean {
  try {
    if (!validPatch(patch)) return false;
    return withStateLock(directory, "dashboard.lock", () => {
      const path = join(directory, "dashboard.json");
      const raw = readRegularFileLimited(path, 256 * 1024);
      let current: any = {};
      if (raw === null) {
        try { lstatSync(path); return false; } catch (e: any) { if (e.code !== "ENOENT") return false; }
      } else {
        current = parseJsonBounded(raw, 20000, 16);
        if (!object(current)) return false;
      }
      for (const [key, value] of Object.entries(patch as Record<string, any>)) {
        if (!MAPS.includes(key)) { current[key] = value; continue; }
        const next = Object.assign(Object.create(null), object(current[key]) ? current[key] : {});
        for (const [k, v] of Object.entries(value)) {
          delete next[k]; // updated entries become newest for bounded maps
          if (v !== null) next[k] = v;
        }
        if (key === "attentionMuted") for (const k of Object.keys(next)) if (!(next[k] < 0 || next[k] > Date.now())) delete next[k];
        if (key === "pinnedPrompts") for (const k of Object.keys(next)) if (next[k] !== true) delete next[k];
        if (key === "notificationEvents") for (const k of Object.keys(next)) if (next[k] < Date.now() - 7 * 86400000 || next[k] > Date.now()) delete next[k];
        const limit = key === "seenChanges" ? 64 : key === "pinnedPrompts" ? 200 : 256;
        let entries = Object.entries(next);
        if (key === "pinnedPrompts") entries.sort(([a], [b]) => Number(a.split(":").pop()) - Number(b.split(":").pop()));
        if (key === "notificationEvents") entries.sort(([, a], [, b]) => Number(a) - Number(b));
        current[key] = Object.fromEntries(entries.slice(-limit));
      }
      // A mode-only patch shuts sharing off. QML includes false on a mode
      // choice; a later explicit enable may be coalesced into the same batch.
      if (Object.hasOwn(patch as object, "webAccessMode") && !Object.hasOwn(patch as object, "webEnabled")) current.webEnabled = false;
      if (Object.hasOwn(patch as object, "manualHttps") && current.webAccessMode === "manual") current.webEnabled = false;
      current.version = 4;
      const text = JSON.stringify(current, null, 2) + "\n";
      return Buffer.byteLength(text) <= 256 * 1024 && writePrivateStateFile(directory, "dashboard.json", text);
    });
  } catch { return false; }
}

if (import.meta.main) {
  let raw = "", bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const timer = setTimeout(() => process.exit(1), 5000);
  try {
    for await (const chunk of Bun.stdin.stream()) {
      bytes += chunk.length;
      if (bytes > 65536) process.exit(1);
      raw += decoder.decode(chunk, { stream: true });
      if (raw.includes("\n")) { raw = raw.slice(0, raw.indexOf("\n")); break; }
    }
    const directory = join(process.env.XDG_STATE_HOME || join(process.env.HOME || "/", ".local/state"), "infomarchy");
    process.exit(patchDashboard(directory, JSON.parse(raw)) ? 0 : 1);
  } catch { process.exit(1); }
  finally { clearTimeout(timer); }
}
