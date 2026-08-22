import { describe, expect, test } from "bun:test";
import { attentionState, parseGitStatus, repoCollisions } from "./ai-ops";

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
});
