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

describe("attention episodes", () => {
  test("the same request made again after clearing notifies again", () => {
    const live = (attention: string) => [{ provider: "claude", pid: 7, startedAt: 1, session: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", project: "p", attention, attentionReason: attention ? "waiting for your permission" : "" }];
    const first = deriveNotificationEvents([], live("waiting"));
    expect(first.events.length).toBe(1);
    const cleared = deriveNotificationEvents(first.tracked, live(""));
    expect(cleared.events.length).toBe(0);
    const again = deriveNotificationEvents(cleared.tracked, live("waiting"));
    expect(again.events.length).toBe(1);
    expect(again.events[0].key).not.toBe(first.events[0].key);
    // Still waiting on the next poll: same episode, same key, so dedup holds.
    const still = deriveNotificationEvents(again.tracked, live("waiting"));
    expect(still.events[0].key).toBe(again.events[0].key);
  });
});
