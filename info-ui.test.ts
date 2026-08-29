import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const settings = readFileSync(join(import.meta.dir, "InfoSettings.qml"), "utf8");
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");

describe("interactive information modules", () => {
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
    expect(overlay).toContain("event.key <= Qt.Key_9");
  });

  test("shows multiplexer hosting context on live cards and the inspector", () => {
    expect(view).toContain("function sessionHostLabel");
    expect(view).toContain("function sessionHostDetail");
    expect(view).toContain('text: "hosted in " + view.sessionHostLabel');
    expect(view).toContain("view.sessionHostDetail(sessionInspector.session)");
  });
});
