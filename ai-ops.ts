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

export function workspaceGroups(sessions: any[]): any[] {
  const groups = new Map<number, any[]>();
  for (const session of sessions || []) {
    const workspace = Number(session?.window?.workspace);
    const address = String(session?.window?.address || "");
    if (!Number.isInteger(workspace) || workspace < 1 || !/^0x[0-9a-f]+$/i.test(address)) continue;
    const group = groups.get(workspace) || [];
    group.push({ provider: session.provider, address, pid: session.pid, startedAt: Number(session.startedAt || 0) });
    groups.set(workspace, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([workspace, agents]) => ({
    workspace,
    agents: agents.sort((a, b) => b.startedAt - a.startedAt),
  }));
}

export function resourceDelta(currentTicks: unknown, previousTicks: unknown, elapsedSec: unknown): number | null {
  const current = Number(currentTicks), previous = Number(previousTicks), elapsed = Number(elapsedSec);
  if (![current, previous, elapsed].every(Number.isFinite) || current < previous || elapsed < 1) return null;
  return 100 * ((current - previous) / 100) / elapsed;
}

// Kept beside forecastPercent so the window rule and the projection are tested
// together; the QML dashboard consumes the result rather than re-deriving it.
export function usageWindowMs(label: unknown): number {
  const value = String(label || "");
  if (/week|7-day/i.test(value)) return 7 * 86400000;
  if (/session|5-hour/i.test(value)) return 5 * 3600000;
  return 0;
}
export function limitForecast(limit: any, stamp = Date.now()): number | null {
  if (!limit || typeof limit !== "object") return null;
  const duration = usageWindowMs(limit.label ?? limit.title);
  const remaining = Date.parse(String(limit.resetsAt || "")) - stamp;
  return duration ? forecastPercent(limit.percent, remaining, duration) : null;
}
export function forecastPercent(percent: unknown, remainingMs: unknown, windowMs: unknown): number | null {
  const used = Number(percent), remaining = Number(remainingMs), duration = Number(windowMs);
  const elapsed = duration - remaining;
  if (![used, remaining, duration].every(Number.isFinite) || used < 0 || remaining < 0 || duration <= 0 || elapsed < duration * 0.03) return null;
  return Math.max(0, used * duration / elapsed);
}
