import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const settings = readFileSync(join(import.meta.dir, "InfoSettings.qml"), "utf8");
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");
const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");

describe("interactive information modules", () => {
  test("reordering skips hidden cards instead of producing a visual no-op", () => {
    const source = settings.match(/function adjacentEnabledIndex\([\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const adjacentEnabledIndex = Function(`return (${source})`)();
    expect(adjacentEnabledIndex(["usage", "localAi", "machine"], 0, 1, { localAi: false })).toBe(2);
    expect(adjacentEnabledIndex(["changes", "needs", "projects"], 2, -1, { needs: false })).toBe(0);
    expect(adjacentEnabledIndex(["usage", "localAi", "machine"], 0, -1, {})).toBe(0);
    expect(settings).toContain("adjacentEnabledIndex(next, from, direction, sections)");
  });

  test("persists seen change fingerprints and exposes the optional change module", () => {
    expect(settings).toContain('{ id: "changes", label: "CHANGES" }');
    expect(settings).toContain("property var seenChanges");
    expect(settings).toContain("function markChangeSeen");
    expect(view).toContain('title: "WHAT CHANGED"');
    expect(view).toContain("view.settings.markChangeSeen");
    expect(view).toContain("changeRow.change.files");
  });

  test("renders specific next-action reasons and contextual controls", () => {
    expect(settings).toContain('{ id: "needs", label: "NEXT ACTIONS" }');
    expect(view).toContain('title: "NEXT ACTIONS"');
    expect(view).toContain("attentionReason");
    expect(view).toContain("attentionPrimaryLabel");
    expect(view).toContain('text: "COPY DETAIL"');
    expect(view).toContain("activateAttention");
  });

  test("renders removable, reorderable project health with dashboard filtering", () => {
    expect(settings).toContain('{ id: "projects", label: "PROJECTS" }');
    expect(settings).toContain('property var opsOrder: ["changes", "needs", "projects"]');
    expect(settings).toContain("function enabledOpsCount");
    expect(settings).toContain("function opsVisibleIndex");
    expect(settings).toContain("function moveOps");
    expect(view).toContain('title: "PROJECT HEALTH"');
    expect(view).toContain('moveGroup: "ops"');
    expect(view).toContain('dragAxis: "horizontal"');
    expect(view).toContain("property string projectFilter");
    expect(view).toContain("function projectMatches");
    expect(view).toContain("readonly property var visibleCollisions");
    expect(view).toContain("view.projectFilter === projectRow.key");
    expect(view).toContain('text: "1–9 MODULES');
    expect(view).toContain('"SUPER+I HIDE DESK · SUPER+D SHOW OVER WINDOWS"');
    expect(view).toContain('"SUPER+I HIDE DESK · SUPER+D / ESC CLOSE"');
    expect(overlay).toContain("event.key <= Qt.Key_9");
  });

  test("shows multiplexer hosting context on live cards and the inspector", () => {
    expect(view).toContain("function sessionHostLabel");
    expect(view).toContain("function sessionHostDetail");
    expect(view).toContain('text: "hosted in " + view.sessionHostLabel');
    expect(view).toContain("view.sessionHostDetail(sessionInspector.session)");
  });

  test("offers safe selectable Ollama load and unload controls", () => {
    expect(settings).toContain("property string selectedOllamaModel");
    expect(settings).toContain("function setSelectedOllamaModel");
    expect(model).toContain('ollamaControlPath: Qt.resolvedUrl("ollama-control.ts")');
    expect(model).toContain("ollamaProcess.pendingFrame");
    expect(model).toContain("write(JSON.stringify(pendingFrame)");
    expect(view).toContain("function needsConfirmation");
    expect(view).toContain('view.desk.controlOllama("load"');
    expect(view).toContain('view.desk.controlOllama("unload"');
    expect(view).toContain('"CONFIRM"');
  });

  test("deduplicates configurable attention and lifecycle notifications", () => {
    expect(settings).toContain("property var notificationEvents");
    expect(settings).toContain("function claimNotificationEvent");
    expect(settings).toContain("function notificationsAllowed");
    expect(settings).toContain("function toggleNotificationProvider");
    expect(view).toContain('text: "ALERTS "');
    // The chip must reflect the configured window, not a hardcoded 22–08.
    expect(view).toContain('text: "QUIET " + (view.settings.quietStartHour < 10 ? "0" : "") + view.settings.quietStartHour');
    expect(view).not.toContain('"QUIET 22–08 "');
    expect(service).toContain('"omarchy-notification-send"');
    expect(service).toContain("dashboardSettings.claimNotificationEvent");
    expect(service).toContain('"nixfred.infomarchy", "{}"');
  });
});

describe("usage trend chart", () => {
  test("renders a per-provider 7-day series with a tokens / value toggle and estimated value lines", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain('property string usageMetric: "tokens"');
    expect(view).toContain("readonly property var usageSeries");
    expect(view).toContain("id: trendCanvas");
    expect(view).toContain('text: view.usageMetric === "value" ? "≈ $ VALUE" : "TOKENS"');
    expect(view).toContain("usageTrend.hovered");
    expect(view).toContain('"% cache reads"');
    expect(view).toContain('"unpriced"');
  });
});

describe("multiplexer-aware focus", () => {
  test("cards, attention rows and the inspector jump into the hosting multiplexer", () => {
    const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(model).toContain("function focusHerdrPane(host)");
    expect(model).toContain('["bun", root.herdrFocusPath, sock, workspace, tab, pane]');
    expect(model).toContain('["select-window", "-t", pane]');
    expect(model).not.toContain('["pane", "focus", "--pane", pane]');
    expect(view).toContain("else if (view.desk.focusSession(sc.modelData)) view.navigated()");
    expect(model).toContain("function focusBoomuxShell(host)");
    expect(model).toContain('["boomux", "open", shell]');
    expect(view).toContain("view.desk.focusSession(item); view.navigated(); return true");
    expect(view).toContain("view.desk.focusSession(sessionInspector.session)");
  });
});

describe("overlay shows the real desktop", () => {
  test("SUPER+D paints the wallpaper, and SUPER+I applies inside the overlay", () => {
    const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");
    expect(overlay).toContain("source: Util.fileUrl(root.background)");
    expect(overlay).toContain("opacity: dashboardSettings.ready && dashboardSettings.dashboardVisible ? root.wallpaperOpacity : 1.0");
    expect(overlay).toContain("visible: dashboardSettings.ready && dashboardSettings.dashboardVisible\n          onNavigated: root.close()");
    expect(overlay).not.toContain("Util.alpha(infoModel.themeBackground, 0.88)");
  });
});

describe("background sessions are reachable", () => {
  test("a card with a background host attaches a terminal on click", () => {
    const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(model).toContain("function attachBackground(session)");
    expect(model).toContain('["bun", root.resumePath, "claude-attach", id, String(item.cwd || "")]');
    expect(view).toContain('" · click attaches a terminal"');
  });
});

describe("zombie cleanup is explicit and two-click", () => {
  test("cards flag STALE and the inspector offers STOP SESSION / END PROCESS with confirmation", () => {
    const model = readFileSync(join(import.meta.dir, "InfoModel.qml"), "utf8");
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain('text: "STALE · idle "');
    expect(view).toContain('text: armed ? "CONFIRM STOP" : "STOP SESSION"');
    expect(view).toContain('text: armed ? "CONFIRM END (SIGTERM)" : "END PROCESS"');
    expect(model).toContain('["bun", root.stopPath, "claude-stop", String(item.jobId)]');
    expect(model).toContain('["bun", root.stopPath, "term", String(Number(item.pid)), String(Math.round(Number(item.startedAt)))]');
  });
});

describe("right column fits a 1080p desk", () => {
  test("MACHINE is a two-column grid with a one-line footer, and the SUPER legend sits under it", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain("// Cockpit density: two meters per row");
    expect(view).toContain('text: "WAN " + (view.machine.externalIp || "—")');
    expect(view).toContain('"SUPER+I hide desk  ·  SUPER+D show desktop") + "  ·  right-click a card to inspect"');
    expect(view).toContain("readonly property int metaWidth");
  });
});
