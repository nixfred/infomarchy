export type RepoState = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: number;
  conflicts: number;
};

export function parseGitStatus(text: string): RepoState | null {
  if (!text.trim()) return null;
  const state: RepoState = { branch: "", upstream: "", ahead: 0, behind: 0, dirty: 0, conflicts: 0 };
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) state.branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) state.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) { state.ahead = +match[1]; state.behind = +match[2]; }
    } else if (/^[12?] /.test(line)) state.dirty++;
    else if (/^u /.test(line)) { state.dirty++; state.conflicts++; }
  }
  return state.branch || state.dirty ? state : null;
}

export function attentionState(title: unknown, conflicts = 0): "blocked" | "waiting" | "done" | "" {
  const value = String(title || "");
  if (conflicts > 0 || /\b(error|failed|blocked|conflict|denied|crashed)\b/i.test(value)) return "blocked";
  if (/\b(waiting|permission|approve|approval|confirm|input required|needs input)\b/i.test(value)) return "waiting";
  if (/✅|\b(done|complete|completed|finished|ready for review)\b/i.test(value)) return "done";
  return "";
}

export function repoCollisions(sessions: any[]): any[] {
  const byRoot = new Map<string, any[]>();
  for (const session of sessions) {
    if (!session.repoRoot) continue;
    const group = byRoot.get(session.repoRoot) || [];
    group.push(session); byRoot.set(session.repoRoot, group);
  }
  return [...byRoot.entries()].filter(([, group]) => group.length > 1).map(([repo, group]) => ({
    repo,
    project: group[0].project,
    agents: group.map(s => ({ provider: s.provider, pid: s.pid })),
  }));
}
