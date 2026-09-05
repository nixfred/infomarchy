export type NotificationEvent = {
  key: string;
  provider: string;
  title: string;
  body: string;
  urgency: "low" | "normal";
  attentionKey?: string;
};

export type TrackedSession = {
  id: string;
  provider: string;
  pid: number;
  startedAt: number;
  session: string;
  project: string;
  topic: string;
  attention: string;
  attentionReason: string;
  misses: number;
};

function clean(value: unknown, limit = 120): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

export function sessionEventId(session: any): string {
  const provider = clean(session?.provider, 32).toLowerCase();
  const stable = clean(session?.session, 128);
  if (provider && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(stable)) return `${provider}:${stable}`;
  return `${provider}:${Math.max(0, Number(session?.pid) || 0)}:${Math.max(0, Number(session?.startedAt) || 0)}`;
}

function tracked(session: any): TrackedSession {
  return {
    id: sessionEventId(session),
    provider: clean(session?.provider, 32).toLowerCase(),
    pid: Math.max(0, Number(session?.pid) || 0),
    startedAt: Math.max(0, Number(session?.startedAt) || 0),
    session: clean(session?.session, 128),
    project: clean(session?.project || session?.cwd || "/", 120),
    topic: clean(session?.topic, 160),
    attention: clean(session?.attention, 24).toLowerCase(),
    attentionReason: clean(session?.attentionReason, 160),
    misses: 0,
  };
}

function attentionEvent(session: TrackedSession): NotificationEvent | null {
  if (!session.attention) return null;
  const crashed = /crash/i.test(session.attentionReason);
  const title = crashed ? "Agent crashed"
    : session.attention === "blocked" ? "Agent blocked"
    : session.attention === "waiting" ? "Agent needs your answer"
    : "Agent ready for review";
  const reason = session.attentionReason || "session needs attention";
  const attentionKey = `${session.provider}:${session.pid}:${session.attention}:${reason}`;
  return {
    key: `attention:${session.id}:${session.attention}:${reason}`,
    provider: session.provider,
    title,
    body: `${session.project} · ${reason}`,
    urgency: session.attention === "blocked" ? "normal" : "low",
    attentionKey,
  };
}

export function deriveNotificationEvents(previous: unknown, currentSessions: any[]): { events: NotificationEvent[]; tracked: TrackedSession[] } {
  const prior = Array.isArray(previous) ? previous.slice(0, 256).filter(item => item && typeof item === "object") as TrackedSession[] : [];
  const current = (Array.isArray(currentSessions) ? currentSessions : []).slice(0, 256).map(tracked);
  const currentIds = new Set(current.map(item => item.id));
  const events: NotificationEvent[] = [];

  for (const session of current) {
    const event = attentionEvent(session);
    if (event) events.push(event);
  }

  // Require two consecutive missed polls before declaring a session ended.
  // This avoids a transient /proc or compositor read creating a toast storm.
  for (const old of prior) {
    if (!old.id || currentIds.has(old.id)) continue;
    const misses = Math.max(0, Number(old.misses) || 0) + 1;
    if (misses < 2) current.push({ ...old, misses });
    else events.push({
      key: `ended:${old.id}:${old.startedAt}`,
      provider: clean(old.provider, 32).toLowerCase(),
      title: "AI session ended",
      body: `${clean(old.project || "/", 120)}${old.topic ? " · " + clean(old.topic, 160) : ""}`,
      urgency: "low",
    });
  }
  return { events: events.slice(0, 256), tracked: current.slice(0, 256) };
}
