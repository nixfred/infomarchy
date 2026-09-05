export type RepoState = {
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: number;
  staged: number;
  untracked: number;
  conflicts: number;
  files: string[];
};

export type DiffSummary = { files: number; additions: number; deletions: number };
export type CommitSummary = { hash: string; short: string; committedAt: number; subject: string };
export type AttentionSignal = {
  state: "blocked" | "waiting" | "done";
  reason: string;
  action: "resolve" | "answer" | "review";
  detail: string;
};

function boundedPath(value: unknown): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 180).trim();
}

export function parseGitStatus(text: string): RepoState | null {
  if (!text.trim()) return null;
  const state: RepoState = { branch: "", upstream: "", ahead: 0, behind: 0, dirty: 0, staged: 0, untracked: 0, conflicts: 0, files: [] };
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) state.branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) state.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) { state.ahead = +match[1]; state.behind = +match[2]; }
    } else if (/^[12] /.test(line)) {
      state.dirty++;
      const fields = line.split(" "), xy = fields[1] || "..";
      if (xy[0] !== ".") state.staged++;
      const path = boundedPath(fields.slice(line[0] === "2" ? 9 : 8).join(" ").split("\t")[0]);
      if (path && state.files.length < 12 && !state.files.includes(path)) state.files.push(path);
    } else if (/^\? /.test(line)) {
      state.dirty++; state.untracked++;
      const path = boundedPath(line.slice(2));
      if (path && state.files.length < 12 && !state.files.includes(path)) state.files.push(path);
    } else if (/^u /.test(line)) {
      state.dirty++; state.conflicts++;
      const path = boundedPath(line.split(" ").slice(10).join(" "));
      if (path && state.files.length < 12 && !state.files.includes(path)) state.files.push(path);
    }
  }
  return state.branch || state.dirty ? state : null;
}

export function parseDiffNumstat(text: string): DiffSummary {
  const summary: DiffSummary = { files: 0, additions: 0, deletions: 0 };
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    summary.files++;
    if (match[1] !== "-") summary.additions += Number(match[1]);
    if (match[2] !== "-") summary.deletions += Number(match[2]);
  }
  return summary;
}

export function parseCommitSummary(text: string): CommitSummary | null {
  const [hash, short, seconds, ...subjectParts] = String(text || "").trim().split("\t");
  const committedAt = Number(seconds) * 1000;
  if (!/^[0-9a-f]{7,64}$/i.test(hash || "") || !/^[0-9a-f]{7,16}$/i.test(short || "") ||
      !/^\d+$/.test(seconds || "") || !Number.isSafeInteger(committedAt) || committedAt <= 0) return null;
  return { hash, short, committedAt, subject: String(subjectParts.join(" ") || "").slice(0, 120) };
}

export function attentionSignal(title: unknown, conflicts = 0): AttentionSignal | null {
  const detail = String(title || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 180).trim();
  if (conflicts > 0) return {
    state: "blocked",
    reason: `${conflicts} merge conflict${conflicts === 1 ? "" : "s"} need resolution`,
    action: "resolve",
    detail,
  };
  if (/\b(crashed|crash)\b/i.test(detail)) return { state: "blocked", reason: "session appears to have crashed", action: "resolve", detail };
  if (/\b(denied|permission denied)\b/i.test(detail)) return { state: "blocked", reason: "an operation was denied", action: "resolve", detail };
  if (/\b(failed|failure|blocked|conflict)\b/i.test(detail) || /\berror\s*:/i.test(detail)) return { state: "blocked", reason: "session reports a failure", action: "resolve", detail };
  if (/\b(permission|approve|approval)\b/i.test(detail)) return { state: "waiting", reason: "waiting for your permission", action: "answer", detail };
  if (/\b(confirm|confirmation)\b/i.test(detail)) return { state: "waiting", reason: "waiting for your confirmation", action: "answer", detail };
  if (/\b(question|answer|input required|needs input)\b/i.test(detail)) return { state: "waiting", reason: "waiting for your answer", action: "answer", detail };
  if (/\bwaiting\b/i.test(detail)) return { state: "waiting", reason: "session is waiting for input", action: "answer", detail };
  if (/✅|\b(done|complete|completed|finished|ready for review)\b/i.test(detail)) return { state: "done", reason: "work appears ready for review", action: "review", detail };
  return null;
}

export function attentionState(title: unknown, conflicts = 0): "blocked" | "waiting" | "done" | "" {
  return attentionSignal(title, conflicts)?.state || "";
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

export function projectHealth(sessions: any[]): any[] {
  const groups = new Map<string, any[]>();
  for (const session of sessions || []) {
    const key = String(session?.repoRoot || session?.cwd || "");
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(session);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const first = group[0] || {}, git = first.git || null, ci = first.ci || null;
    const ciState = String(ci?.state || "").toLowerCase();
    // No git state (not a repository, git missing, timed out, or beyond the
    // per-tick cap) is UNKNOWN, never "healthy · clean".
    const status = !git ? "unknown" :
      (git.conflicts || /failure|failed|cancelled|timed_out|action_required/.test(ciState)) ? "blocked" :
      /queued|in_progress|pending|requested|waiting/.test(ciState) ? "running" :
      Number(git.behind || 0) > 0 ? "behind" :
      Number(git.dirty || 0) > 0 ? "changed" : "healthy";
    return {
      key,
      project: first.project || key.split("/").pop() || key,
      cwd: first.cwd || key,
      repoRoot: first.repoRoot || key,
      provider: first.provider || "",
      git,
      changes: first.changes || null,
      ci,
      status,
      agents: group.map(session => ({
        provider: session.provider,
        pid: session.pid,
        window: session.window ? { address: session.window.address, workspace: session.window.workspace } : null,
      })),
    };
  }).sort((a, b) => {
    const rank: Record<string, number> = { blocked: 0, running: 1, behind: 2, changed: 3, healthy: 4, unknown: 5 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.project.localeCompare(b.project);
  });
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
