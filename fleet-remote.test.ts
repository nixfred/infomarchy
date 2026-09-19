import { describe, expect, test } from "bun:test";
import {
  emptyFleetStore, fleetEnabled, fleetHostsFromEnv, fleetRefreshDue, fleetSnapshot,
  parseAgents, parseFleetStoreText, refreshFleet, FLEET_REFRESH_MS, type FleetRunner,
} from "./fleet-remote";

const fakeProviderOf = (cmd: string[]): string | null => {
  const name = (cmd[0] || "").split("/").pop() || "";
  if (/^hermes(\.js|\.py)?$/.test(name)) return "hermes";
  if (/^claude$/.test(name)) return "claude";
  return null;
};

describe("fleetHostsFromEnv", () => {
  test("parses bare and labelled comma-separated entries", () => {
    expect(fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: "vps-hermes, Backup Box=other-host" }))
      .toEqual([{ label: "vps-hermes", host: "vps-hermes" }, { label: "Backup Box", host: "other-host" }]);
  });

  test("is empty when unset", () => {
    expect(fleetHostsFromEnv({})).toEqual([]);
  });

  test("rejects a bare entry that starts with a dash", () => {
    expect(fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: "-oProxyCommand,good-host" }))
      .toEqual([{ label: "good-host", host: "good-host" }]);
  });

  test("rejects a host value (after the label split) that looks like an ssh flag", () => {
    expect(fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: "label=-oProxyCommand=touch /tmp/pwned,good-host" }))
      .toEqual([{ label: "good-host", host: "good-host" }]);
  });

  test("rejects hosts with shell metacharacters", () => {
    expect(fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: "ok;rm -rf,good-host" }))
      .toEqual([{ label: "good-host", host: "good-host" }]);
  });

  test("accepts a plain IPv4 address", () => {
    expect(fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: "100.64.1.2" })).toEqual([{ label: "100.64.1.2", host: "100.64.1.2" }]);
  });

  test("dedupes and caps at 8 hosts", () => {
    const entries = Array.from({ length: 10 }, (_, i) => `host-${i % 3}`).join(",");
    const hosts = fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: entries });
    expect(hosts.length).toBe(3);
  });

  test("falls back to the host as label when the label half is invalid", () => {
    expect(fleetHostsFromEnv({ INFOMARCHY_FLEET_HOSTS: "$(evil)=safe-host" })).toEqual([{ label: "safe-host", host: "safe-host" }]);
  });
});

describe("fleetEnabled", () => {
  test("defaults on, off only when explicitly skipped", () => {
    expect(fleetEnabled({})).toBe(true);
    expect(fleetEnabled({ INFOMARCHY_SKIP_FLEET: "1" })).toBe(false);
  });
});

describe("parseAgents", () => {
  test("matches known launchers and ignores everything else", () => {
    const ps = [
      "  1 /sbin/init",
      "823 /usr/bin/hermes",
      "901 vim /tmp/hermes-notes.txt",
      "902 claude --resume abc123",
    ].join("\n");
    // "vim /tmp/hermes-notes.txt" must not match: only argv[0] identifies the
    // program, so a file merely named after a provider is never a phantom agent.
    expect(parseAgents(ps, fakeProviderOf)).toEqual([{ provider: "hermes", pid: 823 }, { provider: "claude", pid: 902 }]);
  });

  test("ignores unparseable lines without throwing", () => {
    expect(parseAgents("garbage\n\nnot-a-pid launcher", fakeProviderOf)).toEqual([]);
  });
});

describe("fleetRefreshDue", () => {
  test("due on a fresh store and after the interval elapses", () => {
    const store = emptyFleetStore();
    expect(fleetRefreshDue(store, 1000)).toBe(true);
    const checked = { checkedAt: 1000, results: [] };
    expect(fleetRefreshDue(checked, 1000 + FLEET_REFRESH_MS - 1)).toBe(false);
    expect(fleetRefreshDue(checked, 1000 + FLEET_REFRESH_MS)).toBe(true);
  });
});

describe("refreshFleet + fleetSnapshot", () => {
  test("probes every configured host and groups agents per provider", async () => {
    const hosts = [{ label: "vps-hermes", host: "vps-hermes" }, { label: "dead-box", host: "dead-box" }];
    const runner: FleetRunner = async (cmd) => {
      const host = cmd[cmd.length - 2];
      if (host === "vps-hermes") return "823 /usr/bin/hermes\n824 /usr/bin/hermes --daemon\n901 sshd: user@pts/0";
      return ""; // unreachable / timed out
    };
    const store = await refreshFleet(emptyFleetStore(), 5000, hosts, runner, fakeProviderOf);
    expect(store.checkedAt).toBe(5000);
    const snapshot = fleetSnapshot(store);
    expect(snapshot).toEqual([
      { label: "vps-hermes", host: "vps-hermes", ok: true, checkedAt: 5000, providers: [{ provider: "hermes", count: 2 }] },
      { label: "dead-box", host: "dead-box", ok: false, checkedAt: 5000, providers: [] },
    ]);
  });

  test("a runner that throws still degrades to a failed, not fabricated, result", async () => {
    const runner: FleetRunner = async () => { throw new Error("boom"); };
    const store = await refreshFleet(emptyFleetStore(), 5000, [{ label: "h", host: "h" }], runner, fakeProviderOf);
    expect(store.results).toEqual([expect.objectContaining({ ok: false, agents: [] })]);
  });

  test("no hosts configured means no probes and an empty snapshot", async () => {
    const runner: FleetRunner = async () => { throw new Error("should not be called"); };
    const store = await refreshFleet(emptyFleetStore(), 5000, [], runner, fakeProviderOf);
    expect(fleetSnapshot(store)).toEqual([]);
  });
});

describe("parseFleetStoreText", () => {
  test("round-trips a store written by refreshFleet", async () => {
    const runner: FleetRunner = async () => "823 /usr/bin/hermes";
    const store = await refreshFleet(emptyFleetStore(), 5000, [{ label: "vps", host: "vps" }], runner, fakeProviderOf);
    expect(parseFleetStoreText(JSON.stringify(store))).toEqual(store);
  });

  test("degrades to an empty store on missing, oversized, or malformed input", () => {
    expect(parseFleetStoreText(null)).toEqual(emptyFleetStore());
    expect(parseFleetStoreText("")).toEqual(emptyFleetStore());
    expect(parseFleetStoreText("not json")).toEqual(emptyFleetStore());
    expect(parseFleetStoreText("x".repeat(300_000))).toEqual(emptyFleetStore());
  });

  test("drops a result with an invalid host and agents with a bad shape rather than trusting the file", () => {
    const dirty = JSON.stringify({
      checkedAt: 1000,
      results: [
        { label: "ok", host: "-evil-flag", ok: true, agents: [], checkedAt: 1000, latencyMs: 5 },
        { label: "good", host: "good-host", ok: true, agents: [{ provider: "hermes", pid: 5 }, { provider: "", pid: 6 }, "garbage"], checkedAt: 1000, latencyMs: 5 },
      ],
    });
    expect(parseFleetStoreText(dirty)).toEqual({
      checkedAt: 1000,
      results: [{ label: "good", host: "good-host", ok: true, agents: [{ provider: "hermes", pid: 5 }], checkedAt: 1000, latencyMs: 5 }],
    });
  });
});
