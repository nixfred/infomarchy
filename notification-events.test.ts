import { describe, expect, test } from "bun:test";
import { deriveNotificationEvents, sessionEventId } from "./notification-events";

describe("Infomarchy notification events", () => {
  const session = {
    provider: "codex", pid: 42, startedAt: 1000, session: "session_12345678",
    project: "atlas", topic: "Testing alert transitions", attention: "", attentionReason: "",
  };

  test("uses a stable session id and emits specific attention states", () => {
    expect(sessionEventId(session)).toBe("codex:session_12345678");
    const waiting = deriveNotificationEvents([], [{ ...session, attention: "waiting", attentionReason: "waiting for your permission" }]);
    expect(waiting.events).toEqual([expect.objectContaining({ title: "Agent needs your answer", provider: "codex", attentionKey: "codex:42:waiting:waiting for your permission" })]);
    const crashed = deriveNotificationEvents([], [{ ...session, attention: "blocked", attentionReason: "session appears to have crashed" }]);
    expect(crashed.events[0]).toMatchObject({ title: "Agent crashed", urgency: "normal" });
  });

  test("requires two missed polls before reporting an ended session", () => {
    const first = deriveNotificationEvents([], [session]);
    const missingOnce = deriveNotificationEvents(first.tracked, []);
    expect(missingOnce.events).toEqual([]);
    expect(missingOnce.tracked[0].misses).toBe(1);
    const missingTwice = deriveNotificationEvents(missingOnce.tracked, []);
    expect(missingTwice.events).toEqual([expect.objectContaining({ title: "AI session ended", provider: "codex" })]);
    expect(missingTwice.tracked).toEqual([]);
  });

  test("does not report a session that returns after one missed poll", () => {
    const first = deriveNotificationEvents([], [session]);
    const missing = deriveNotificationEvents(first.tracked, []);
    const returned = deriveNotificationEvents(missing.tracked, [session]);
    expect(returned.events).toEqual([]);
    expect(returned.tracked[0].misses).toBe(0);
  });
});
