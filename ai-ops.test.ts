import { describe, expect, test } from "bun:test";
import { attentionSignal, attentionState, parseCommitSummary, parseDiffNumstat, parseGitStatus, projectHealth, repoCollisions, workspaceGroups, resourceDelta, forecastPercent, usageWindowMs, limitForecast } from "./ai-ops";

describe("AI operations signals", () => {
  test("parses branch readiness and conflicts", () => {
    const state = parseGitStatus("# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/file.ts\n1 M. N... 100644 100644 100644 a b staged.ts\n? new test.ts\nu UU N... 100644 100644 100644 100644 a b c conflict.ts\n");
    expect(state).toEqual({
      branch: "feature", upstream: "origin/feature", ahead: 2, behind: 1,
      dirty: 4, staged: 1, untracked: 1, conflicts: 1,
      files: ["src/file.ts", "staged.ts", "new test.ts", "conflict.ts"],
    });
  });

  test("summarizes bounded diff and commit metadata", () => {
    expect(parseDiffNumstat("12\t3\tsrc/a.ts\n-\t-\tasset.png\n4\t0\ttest/a.test.ts\n")).toEqual({ files: 3, additions: 16, deletions: 3 });
    expect(parseCommitSummary("abcdef0123456789\tabcdef0\t1787920000\tfeat: add operations intelligence\n")).toEqual({
      hash: "abcdef0123456789", short: "abcdef0", committedAt: 1787920000000, subject: "feat: add operations intelligence",
    });
    expect(parseCommitSummary("not-a-commit")).toBeNull();
    expect(parseCommitSummary("abcdef0\tabcdef0\t\tmissing timestamp")).toBeNull();
    expect(parseCommitSummary("abcdef0\tabcdef0\t-1\tpre-epoch timestamp")).toBeNull();
  });

  test("prioritizes blocked, waiting, and completed titles", () => {
    expect(attentionState("Permission required to continue")).toBe("waiting");
    expect(attentionState("✅ Ready for review")).toBe("done");
    expect(attentionState("working", 1)).toBe("blocked");
    expect(attentionSignal("Confirmation required")).toEqual({
      state: "waiting", reason: "waiting for your confirmation", action: "answer", detail: "Confirmation required",
    });
    expect(attentionSignal("working", 2)).toEqual({
      state: "blocked", reason: "2 merge conflicts need resolution", action: "resolve", detail: "working",
    });
    expect(attentionSignal("✅ Ready for review")?.action).toBe("review");
    expect(attentionSignal("Implement error handling")).toBeNull();
    expect(attentionSignal("Error: build stopped")?.state).toBe("blocked");
    expect(attentionSignal("actively editing files")).toBeNull();
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

  test("aggregates repository health and prioritizes actionable projects", () => {
    const projects = projectHealth([
      { repoRoot: "/work/clean", cwd: "/work/clean", project: "clean", provider: "codex", pid: 1, git: { branch: "main", dirty: 0, behind: 0, conflicts: 0 }, ci: { state: "success" }, changes: { headShort: "abc1234" } },
      { repoRoot: "/work/risk", cwd: "/work/risk", project: "risk", provider: "claude", pid: 2, git: { branch: "feature", dirty: 2, behind: 1, conflicts: 0 }, ci: { state: "in_progress" } },
      { repoRoot: "/work/risk", cwd: "/work/risk", project: "risk", provider: "opencode", pid: 3, git: { branch: "feature", dirty: 2, behind: 1, conflicts: 0 }, ci: { state: "in_progress" } },
      { repoRoot: "/work/broken", cwd: "/work/broken", project: "broken", provider: "grok", pid: 4, git: { branch: "main", dirty: 0, behind: 0, conflicts: 0 }, ci: { state: "failure" } },
    ]);
    expect(projects.map(project => [project.project, project.status])).toEqual([
      ["broken", "blocked"], ["risk", "running"], ["clean", "healthy"],
    ]);
    expect(projects[1].agents.map(agent => agent.provider)).toEqual(["claude", "opencode"]);
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

describe("usage forecast", () => {
  const stamp = Date.UTC(2026, 7, 30, 12, 0, 0);
  test("classifies limit windows", () => {
    expect(usageWindowMs("WEEKLY")).toBe(7 * 86400000);
    expect(usageWindowMs("7-day")).toBe(7 * 86400000);
    expect(usageWindowMs("5-HOUR")).toBe(5 * 3600000);
    expect(usageWindowMs("SESSION")).toBe(5 * 3600000);
    expect(usageWindowMs("mystery")).toBe(0);
  });
  test("projects a limit at its window pace", () => {
    const resetsAt = new Date(stamp + 2 * 3600000).toISOString();
    expect(limitForecast({ label: "SESSION", percent: 0.25, resetsAt }, stamp)).toBeCloseTo(0.4166, 3);
  });
  test("refuses unusable limits instead of guessing", () => {
    expect(limitForecast(null, stamp)).toBeNull();
    expect(limitForecast({ label: "unknown", percent: 0.5, resetsAt: new Date(stamp).toISOString() }, stamp)).toBeNull();
    // Barely into the window — too little signal to extrapolate.
    expect(limitForecast({ label: "SESSION", percent: 0.1, resetsAt: new Date(stamp + 4.99 * 3600000).toISOString() }, stamp)).toBeNull();
  });
});

describe("project health honesty", () => {
  test("missing git state is unknown, not healthy", () => {
    const [project] = projectHealth([{ provider: "claude", pid: 1, cwd: "~/x", repoRoot: "", git: null, ci: null, project: "x" }]);
    expect(project.status).toBe("unknown");
    const [clean] = projectHealth([{ provider: "claude", pid: 1, cwd: "~/y", repoRoot: "~/y", git: { dirty: 0, behind: 0, conflicts: 0 }, ci: null, project: "y" }]);
    expect(clean.status).toBe("healthy");
  });
});
