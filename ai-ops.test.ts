import { describe, expect, test } from "bun:test";
import { attentionState, parseGitStatus, repoCollisions, workspaceGroups, resourceDelta, forecastPercent } from "./ai-ops";

describe("AI operations signals", () => {
  test("parses branch readiness and conflicts", () => {
    const state = parseGitStatus("# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b file\nu UU N... 100644 100644 100644 100644 a b c file2\n");
    expect(state).toEqual({ branch: "feature", upstream: "origin/feature", ahead: 2, behind: 1, dirty: 2, conflicts: 1 });
  });

  test("prioritizes blocked, waiting, and completed titles", () => {
    expect(attentionState("Permission required to continue")).toBe("waiting");
    expect(attentionState("✅ Ready for review")).toBe("done");
    expect(attentionState("working", 1)).toBe("blocked");
  });

  test("reports agents sharing a repository", () => {
    const collisions = repoCollisions([
      { repoRoot: "/work/a", project: "a", provider: "claude", pid: 1 },
      { repoRoot: "/work/a", project: "a", provider: "codex", pid: 2 },
      { repoRoot: "/work/b", project: "b", provider: "grok", pid: 3 },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].agents).toHaveLength(2);
  });

  test("groups addressable agents by workspace and puts the newest first", () => {
    expect(workspaceGroups([
      { provider: "codex", pid: 1, startedAt: 10, window: { workspace: 3, address: "0xabc" } },
      { provider: "claude", pid: 2, startedAt: 20, window: { workspace: 3, address: "0xdef" } },
      { provider: "grok", pid: 3, startedAt: 30, window: { workspace: 1, address: "0x123" } },
      { provider: "codex", pid: 4, window: null },
      { provider: "codex", pid: 5, window: { workspace: "bad", address: "oops" } },
    ])).toEqual([
      { workspace: 1, agents: [{ provider: "grok", address: "0x123", pid: 3, startedAt: 30 }] },
      { workspace: 3, agents: [
        { provider: "claude", address: "0xdef", pid: 2, startedAt: 20 },
        { provider: "codex", address: "0xabc", pid: 1, startedAt: 10 },
      ] },
    ]);
  });

  test("computes process-tree CPU deltas and rejects stale samples", () => {
    expect(resourceDelta(250, 100, 1.5)).toBe(100);
    expect(resourceDelta(90, 100, 2)).toBeNull();
    expect(resourceDelta(250, 100, 0.2)).toBeNull();
  });

  test("projects usage to reset and refuses immature or malformed windows", () => {
    expect(forecastPercent(0.25, 2 * 3600000, 4 * 3600000)).toBe(0.5);
    expect(forecastPercent(0.1, 3.95 * 3600000, 4 * 3600000)).toBeNull();
    expect(forecastPercent("bad", 1, 2)).toBeNull();
  });
});
