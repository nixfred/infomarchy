import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_CRITICAL_SEC, DEFAULT_STALE_SEC, demoHermesHosts, hermesHostsFromEnv, hermesHostsRefreshDue, hermesHostsSnapshot, levelForAge,
  parseHermesHostsStoreText, parseHermesProbe, refreshHermesHosts, safeText, thresholdsFromEnv, type HermesHostsStore,
} from "./hermes-hosts";

// Every host, label and task below is invented. Nothing here names a real machine.
const NOW = 1_800_000_000;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();
function probe(opts: { remoteNow?: number; beatAgo?: number | null; gateway?: string; active?: number; session?: any; pending?: any[] | string[] } = {}) {
  const remoteNow = opts.remoteNow ?? NOW;
  const beat = opts.beatAgo === null ? "" : JSON.stringify({ pid: 1, updated_at: iso(remoteNow - (opts.beatAgo ?? 5)) });
  const state = JSON.stringify({ gateway_state: opts.gateway ?? "running", active_agents: opts.active ?? 1 });
  const session = opts.session === undefined ? JSON.stringify([{ title: "Draft the weekly digest", activity: "calling tool", at: remoteNow - 30 }]) : opts.session;
  const files = (opts.pending || []).map(p => `___HERMES_FILE___\n${typeof p === "string" ? p : JSON.stringify(p)}\n`).join("");
  return `___HERMES_HOSTS_OK___\n${remoteNow}\n___HERMES_HEARTBEAT___\n${beat}\n___HERMES_STATE___\n${state}\n___HERMES_SESSION___\n${session}\n___HERMES_PENDING___\n${files}`;
}
const thresholds = { staleSec: 300, criticalSec: 1800 };
const storeFrom = (output: string, now = NOW * 1000): HermesHostsStore => ({
  checkedAt: now,
  results: [{ label: "Alpha Mac", host: "alpha", status: "ok", checkedAt: now, lastGoodAt: now, facts: parseHermesProbe(output) }],
});

describe("parsing what a Hermes host reports", () => {
  test("reads gateway, task, age and pending approvals", () => {
    const facts = parseHermesProbe(probe({ pending: [{ subsystem: "skills", summary: "Update the digest skill", created_at: NOW - 600 }, { subsystem: "memory", summary: "Remember Friday", created_at: NOW - 60 }] }))!;
    expect(facts.gateway).toBe("running");
    expect(facts.activeAgents).toBe(1);
    expect(facts.task).toBe("Draft the weekly digest");
    expect(facts.activity).toBe("calling tool");
    expect(facts.taskAgeSec).toBe(30);
    expect(facts.heartbeatAgeSec).toBe(5);
    expect(facts.approvals.count).toBe(2);
    expect(facts.approvals.items[0]).toEqual({ kind: "skills", summary: "Update the digest skill", ageSec: 600 });
  });

  test("the count comes from the files, not from whether they parse", () => {
    const facts = parseHermesProbe(probe({ pending: ["{not json", { summary: "ok" }, "[]"] }))!;
    expect(facts.approvals.count).toBe(3);
    expect(facts.approvals.items).toHaveLength(3);
    expect(facts.approvals.items[0].summary).toBe("");
  });

  test("approval list is bounded but the count is not hidden", () => {
    const facts = parseHermesProbe(probe({ pending: Array.from({ length: 12 }, (_, i) => ({ summary: `n${i}` })) }))!;
    expect(facts.approvals.count).toBe(12);
    expect(facts.approvals.items).toHaveLength(5);
  });

  test("age is measured on the remote clock, so a skewed host cannot look fresh", () => {
    // The remote clock is a day ahead of ours; its own age arithmetic is still right.
    const facts = parseHermesProbe(probe({ remoteNow: NOW + 86_400, beatAgo: 900 }))!;
    expect(facts.heartbeatAgeSec).toBe(900);
  });

  test("a shell that answered but holds no Hermes state is null, never all-clear", () => {
    expect(parseHermesProbe("___HERMES_HOSTS_OK___\n1800000000\n___HERMES_HEARTBEAT___\n\n___HERMES_STATE___\n\n___HERMES_SESSION___\n\n___HERMES_PENDING___\n")).toBeNull();
    expect(parseHermesProbe("")).toBeNull();
    expect(parseHermesProbe("Microsoft Windows [Version 10]\r\nC:\\>")).toBeNull();
  });

  test("an empty pending list and an idle gateway read as zero, not as missing", () => {
    const facts = parseHermesProbe(probe({ active: 0, session: "[]" }))!;
    expect(facts.approvals.count).toBe(0);
    expect(facts.task).toBe("");
    expect(facts.activeAgents).toBe(0);
  });

  test("remote text is plain and bounded", () => {
    const facts = parseHermesProbe(probe({ session: JSON.stringify([{ title: "A\u0000B‮" + "x".repeat(500), activity: "line1\nline2", at: NOW }]) }))!;
    expect(facts.task).not.toMatch(/[\u0000‮]/);
    expect(facts.task.length).toBeLessThanOrEqual(80);
    expect(facts.activity).toBe("line1 line2");
    expect(safeText("\u0007bell\t tab", 20)).toBe("bell tab");
  });
});

describe("staleness and unreachable logic", () => {
  test("levels follow the two thresholds", () => {
    expect(levelForAge(0, thresholds)).toBe("fresh");
    expect(levelForAge(299, thresholds)).toBe("fresh");
    expect(levelForAge(300, thresholds)).toBe("stale");
    expect(levelForAge(1799, thresholds)).toBe("stale");
    expect(levelForAge(1800, thresholds)).toBe("critical");
    expect(levelForAge(null, thresholds)).toBe("critical");
  });

  test("a fresh host is connected and shows its task and approvals", () => {
    const [row] = hermesHostsSnapshot(storeFrom(probe({ pending: [{ summary: "x" }] })), NOW * 1000 + 4000, thresholds);
    expect(row).toMatchObject({ status: "ok", connected: true, working: true, task: "Draft the weekly digest", approvals: 1, level: "fresh" });
    expect(row.ageSec).toBe(9);
  });

  test("age keeps growing between probes and crosses stale then critical", () => {
    const store = storeFrom(probe());
    expect(hermesHostsSnapshot(store, NOW * 1000 + 6 * 60_000, thresholds)[0].level).toBe("stale");
    expect(hermesHostsSnapshot(store, NOW * 1000 + 45 * 60_000, thresholds)[0].level).toBe("critical");
  });

  test("a hung gateway (old heartbeat) is stale even though the probe just succeeded", () => {
    const [row] = hermesHostsSnapshot(storeFrom(probe({ beatAgo: 1200 })), NOW * 1000, thresholds);
    expect(row.level).toBe("stale");
    expect(row.ageSec).toBe(1200);
  });

  test("no heartbeat at all cannot prove freshness", () => {
    const [row] = hermesHostsSnapshot(storeFrom(probe({ beatAgo: null })), NOW * 1000, thresholds);
    expect(row.ageSec).toBeNull();
    expect(row.level).toBe("critical");
    expect(row.connected).toBe(false);
  });

  test("a stopped gateway is not connected", () => {
    const [row] = hermesHostsSnapshot(storeFrom(probe({ gateway: "stopped" })), NOW * 1000, thresholds);
    expect(row.connected).toBe(false);
    expect(row.gateway).toBe("stopped");
  });

  test("an idle host reports no task", () => {
    const [row] = hermesHostsSnapshot(storeFrom(probe({ active: 0 })), NOW * 1000, thresholds);
    expect(row).toMatchObject({ working: false, task: "", activity: "" });
  });

  test("unreachable never shows the last good state", async () => {
    const good = await refreshHermesHosts({ checkedAt: 0, results: [] }, NOW * 1000, [{ label: "Alpha Mac", host: "alpha" }], async () => probe({ pending: [{ summary: "private-looking" }] }));
    expect(hermesHostsSnapshot(good, NOW * 1000, thresholds)[0]).toMatchObject({ status: "ok", approvals: 1, working: true });
    const later = NOW * 1000 + 120_000;
    const down = await refreshHermesHosts(good, later, [{ label: "Alpha Mac", host: "alpha" }], async () => "");
    const [row] = hermesHostsSnapshot(down, later + 1000, thresholds);
    expect(row).toMatchObject({ status: "unreachable", connected: false, working: false, task: "", approvals: 0, approvalItems: [], level: "critical", ageSec: null });
    // Only the age of the last good read survives.
    expect(row.lastSeenSec).toBe(121);
    expect(JSON.stringify(row)).not.toContain("private-looking");
  });

  test("a probe that throws, or answers without the marker, is unreachable", async () => {
    for (const runner of [async () => { throw new Error("boom"); }, async () => "Permission denied (publickey)."]) {
      const store = await refreshHermesHosts({ checkedAt: 0, results: [] }, NOW * 1000, [{ label: "Beta Win", host: "beta" }], runner);
      expect(hermesHostsSnapshot(store, NOW * 1000, thresholds)[0]).toMatchObject({ status: "unreachable", lastSeenSec: null });
    }
  });

  test("reachable with nothing readable (wrong shell, no Hermes) is unreadable, not unreachable", async () => {
    const store = await refreshHermesHosts({ checkedAt: 0, results: [] }, NOW * 1000, [{ label: "Beta Win", host: "beta" }],
      async () => "___HERMES_HOSTS_OK___\nnot-a-date\n");
    const [row] = hermesHostsSnapshot(store, NOW * 1000 + 2000, thresholds);
    expect(row).toMatchObject({ status: "unreadable", connected: false, approvals: 0, working: false });
    expect(row.ageSec).toBe(2);
  });

  test("the probe is one fixed, read-only command per host", async () => {
    const calls: string[][] = [];
    await refreshHermesHosts({ checkedAt: 0, results: [] }, NOW * 1000, [{ label: "A", host: "alpha" }, { label: "B", host: "beta" }], async cmd => { calls.push(cmd); return ""; });
    expect(calls).toHaveLength(2);
    for (const cmd of calls) {
      expect(cmd[0]).toBe("ssh");
      expect(cmd).toContain("BatchMode=yes");
      const script = cmd.at(-1)!;
      expect(script).toContain("-readonly");
      // Nothing in the probe can write, delete, restart or approve.
      expect(script.replace(/2>\/dev\/null/g, "")).not.toMatch(/\b(rm|mv|cp|kill|tee|sudo|systemctl|approve|reject|touch|chmod)\b|>\s*\/|>>/);
    }
  });
});

describe("configuration", () => {
  test("hosts use the shared grammar and reject anything that is not an ssh alias", () => {
    expect(hermesHostsFromEnv({ INFOMARCHY_HERMES_HOSTS: "Studio Mac=alpha, beta, alpha, $(id)=x, a;rm -rf /, user@host" })).toEqual([
      { label: "Studio Mac", host: "alpha" }, { label: "beta", host: "beta" },
      // A label that is not plain text is dropped, the alias after it still has to be a valid one.
      { label: "x", host: "x" },
    ]);
    expect(hermesHostsFromEnv({})).toEqual([]);
    expect(hermesHostsFromEnv({ INFOMARCHY_HERMES_HOSTS: "  " })).toEqual([]);
  });

  test("thresholds default sanely and fall back on bad values", () => {
    expect(thresholdsFromEnv({})).toEqual({ staleSec: DEFAULT_STALE_SEC, criticalSec: DEFAULT_CRITICAL_SEC });
    expect(thresholdsFromEnv({ INFOMARCHY_HERMES_STALE_SECS: "60", INFOMARCHY_HERMES_CRITICAL_SECS: "600" })).toEqual({ staleSec: 60, criticalSec: 600 });
    expect(thresholdsFromEnv({ INFOMARCHY_HERMES_STALE_SECS: "abc", INFOMARCHY_HERMES_CRITICAL_SECS: "-5" })).toEqual({ staleSec: DEFAULT_STALE_SEC, criticalSec: DEFAULT_CRITICAL_SEC });
    // Critical can never sit below stale, or a row would skip its warning.
    expect(thresholdsFromEnv({ INFOMARCHY_HERMES_STALE_SECS: "900", INFOMARCHY_HERMES_CRITICAL_SECS: "60" })).toEqual({ staleSec: 900, criticalSec: 900 });
  });

  test("refresh is throttled and a corrupt store reads as empty", () => {
    const store = storeFrom(probe());
    expect(hermesHostsRefreshDue(store, NOW * 1000 + 5_000)).toBe(false);
    expect(hermesHostsRefreshDue(store, NOW * 1000 + 31_000)).toBe(true);
    expect(hermesHostsRefreshDue({ checkedAt: 0, results: [] }, NOW * 1000)).toBe(true);
    for (const text of ["", "{", "[]", "null", "x".repeat(300_000)]) expect(parseHermesHostsStoreText(text).results).toEqual([]);
  });

  test("a stored result survives a round trip and a hostile one is cleaned", () => {
    const round = parseHermesHostsStoreText(JSON.stringify(storeFrom(probe({ pending: [{ summary: "x" }] }))));
    expect(hermesHostsSnapshot(round, NOW * 1000, thresholds)[0]).toMatchObject({ status: "ok", approvals: 1 });
    const hostile = parseHermesHostsStoreText(JSON.stringify({ checkedAt: NOW, results: [
      { label: "<b>", host: "evil; reboot", status: "ok", facts: { task: "t" } },
      { label: "Fine", host: "gamma", status: "pwned", facts: { task: "should vanish", approvals: { count: 9e9 } } },
    ] }));
    expect(hostile.results.map(r => r.host)).toEqual(["gamma"]);
    expect(hostile.results[0].status).toBe("unreachable");
    expect(hostile.results[0].facts).toBeNull();
  });
});

describe("demo data", () => {
  test("shows a fresh, a stale and an unreachable host, all invented", () => {
    const rows = demoHermesHosts();
    expect(rows.map(r => r.level)).toEqual(["fresh", "stale", "critical"]);
    expect(rows.some(r => r.status === "unreachable")).toBe(true);
    expect(rows.some(r => r.label.includes("Mac"))).toBe(true);
    expect(rows.some(r => r.label.includes("Windows"))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/\/home\/|\/Users\/|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});

describe("the shipped collector", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-hosts-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  async function snapshot(args: string[], extra: Record<string, string>) {
    const proc = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "tests/collector-offline.ts"), join(import.meta.dir, "collector.ts"), ...args], {
      // PATH has no ssh, so a configured host can only come back unreachable. No network is touched.
      env: { HOME: root, XDG_STATE_HOME: join(root, "state"), PATH: "/nonexistent", INFOMARCHY_SKIP_GITHUB: "1", INFOMARCHY_SKIP_EXTERNAL_IP: "1", ...extra }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const frames = output.trim().split("\n").map(line => JSON.parse(line));
    expect(frames.at(-1).type).toBe("end");
    return JSON.parse(frames.filter(f => f.type === "chunk").map(f => f.data).join(""));
  }

  test("zero hosts configured: the snapshot has no hermesHosts and nothing breaks", async () => {
    const snap = await snapshot(["--id", "bg"], {});
    expect(snap.ai).not.toHaveProperty("hermesHosts");
    expect(snap.ai.sessions).toBeDefined();
  });

  test("configured but unreachable: the row says so and carries no state", async () => {
    const snap = await snapshot(["--id", "bg"], { INFOMARCHY_HERMES_HOSTS: "Studio Mac=alpha,Office Win=beta" });
    expect(snap.ai.hermesHosts.map((r: any) => r.label)).toEqual(["Studio Mac", "Office Win"]);
    for (const row of snap.ai.hermesHosts) expect(row).toMatchObject({ status: "unreachable", connected: false, approvals: 0, task: "", level: "critical" });
  });

  test("the skip switch removes it", async () => {
    const snap = await snapshot(["--id", "bg"], { INFOMARCHY_HERMES_HOSTS: "alpha", INFOMARCHY_SKIP_HERMES_HOSTS: "1" });
    expect(snap.ai).not.toHaveProperty("hermesHosts");
  });

  test("demo mode carries the demo hosts and ignores configuration", async () => {
    const snap = await snapshot(["--demo"], { INFOMARCHY_HERMES_HOSTS: "alpha" });
    expect(snap.ai.hermesHosts.map((r: any) => r.label)).toEqual(demoHermesHosts().map(r => r.label));
  });

  test("the overlay reads the store and never probes", async () => {
    const state = join(root, "state");
    await snapshot(["--id", "bg"], { INFOMARCHY_HERMES_HOSTS: "alpha" });
    const overlay = await snapshot(["--id", "overlay"], { INFOMARCHY_HERMES_HOSTS: "alpha" });
    expect(overlay.ai.hermesHosts).toHaveLength(1);
    expect(state).toContain("state");
  });
});

describe("the panel is read-only and loud about age", () => {
  const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
  const start = view.indexOf("id: hermesHostsCard");
  const card = view.slice(start, view.indexOf("id: remoteRosterCard"));

  test("the card exists, hides with zero hosts and can be turned off", () => {
    expect(start).toBeGreaterThan(0);
    expect(card).toContain("view.sectionEnabled(\"hermesHosts\") && view.hermesHosts.length > 0");
  });

  test("every view.* the card reads is actually defined", () => {
    expect(view).toContain("readonly property var hermesHosts:");
    expect(view).toContain("readonly property int hermesApprovals:");
    expect(view).toContain("function hermesAge(sec)");
  });

  test("no control on the card can act on a remote host", () => {
    for (const forbidden of ["MouseArea", "TapHandler", "onClicked", "onTapped", "Button", "TextField", "Process", "desk.run", "approve", "reject", "deny"]) {
      expect(card, forbidden).not.toContain(forbidden);
    }
  });

  test("every row shows its age, stale rows dim, unreachable rows never show state", () => {
    expect(card).toContain("view.hermesAge(hermesHost.modelData.ageSec)");
    expect(card).toContain("opacity: modelData.level === \"fresh\" || unreachable ? 1 : 0.55");
    expect(card).toContain("view.desk.red");
    expect(card).toContain("visible: hermesHost.unreachable; text: \"unreachable\"");
    expect(card).toContain("!hermesHost.unreachable && !hermesHost.unreadable && hermesHost.modelData.connected");
  });

  test("privacy mode hides task text and the approval list", () => {
    expect(card).toContain("view.privacyMode ? \"working\"");
    expect(card).toContain("view.privacyMode || hermesHost.unreachable");
  });

  test("web viewers never receive it: the filtered web view names its fields", () => {
    const page = readFileSync(join(import.meta.dir, "web-page.ts"), "utf8");
    expect(page).not.toContain("hermesHosts");
  });
});
