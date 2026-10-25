import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// "Did it kill on the first click?" is not answerable by matching source. The
// `if (armed)` branch reads correctly either way, and the things that would
// actually break it are runtime: a second pointer event in one gesture, or the
// 4 s disarm racing the operator, or the drawer re-resolving its session every
// tick and clearing the armed flag so the second click silently re-arms.
// qmltestrunner drives real clicks and counts the kills.
const RUNNER = ["/usr/lib/qt6/bin/qmltestrunner", "/usr/bin/qmltestrunner"].find(path => existsSync(path)) || "";
const FIXTURE = join(import.meta.dir, "qmltests", "tst_stopconfirm.qml");
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");

describe("ending a session takes two clicks, proven with real ones", () => {
  test("qmltestrunner is available to gate this", () => {
    expect(RUNNER, "install qt6-declarative for qmltestrunner").not.toBe("");
    expect(existsSync(FIXTURE)).toBe(true);
  });

  test("the fixture still matches how the real tag is wired", () => {
    // If the real control stops being a single MouseArea that toggles `armed`,
    // this fixture is testing something the desk no longer does.
    const end = view.slice(view.indexOf("id: endTag"), view.indexOf("Item { Layout.fillWidth: true }", view.indexOf("id: endTag")));
    expect(end).toContain("property bool armed: false");
    expect(end).toContain("if (endTag.armed) { view.desk.endProcess(sessionInspector.session)");
    expect(end).toContain("else endTag.armed = true");
    expect(end).toContain("Timer { interval: 4000; running: endTag.armed; onTriggered: endTag.armed = false }");
    expect(end.match(/MouseArea/g), "exactly one pointer target, or a click could fire twice").toHaveLength(1);
  });

  test("one click arms, two clicks kill exactly once, a tick does neither", () => {
    const result = Bun.spawnSync([RUNNER, "-input", FIXTURE], {
      env: { ...process.env, QT_QPA_PLATFORM: process.env.WAYLAND_DISPLAY ? "wayland" : "offscreen" },
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output, output).toContain("PASS   : qmltestrunner::EndProcessNeedsTwoClicks::test_one_click_only_arms()");
    expect(output, output).toContain("PASS   : qmltestrunner::EndProcessNeedsTwoClicks::test_second_click_kills_once()");
    expect(output, output).toContain("PASS   : qmltestrunner::EndProcessNeedsTwoClicks::test_a_snapshot_tick_does_not_fire_it()");
    expect(output, output).toContain("PASS   : qmltestrunner::EndProcessNeedsTwoClicks::test_arming_expires_on_its_own()");
    expect(result.exitCode, output).toBe(0);
    // The fixture waits out the real 4 s disarm, so it needs ~4.3 s offscreen and
    // ~10 s when Qt has to open a Wayland connection first: past bun's 5 s default.
  }, 60_000);
});

describe("the inspector's own controls clear the panel's rounded corners", () => {
  test("content is inset past the corner arc, not just by pad", () => {
    // CLOSE sits in the top-right corner and the action row in the bottom-left.
    // With a plain `pad` inset on a rounded theme both land inside the curve
    // and read as crammed against the border. radius 0 makes this a no-op.
    const column = view.slice(view.indexOf("id: inspectorColumn"), view.indexOf("spacing: Style.spacing.md", view.indexOf("id: inspectorColumn")));
    expect(column).toContain("margins: view.pad + Math.round(view.radius * 0.5)");
  });

  test("CLOSE is a dismiss control, not another action chip", () => {
    const close = view.slice(view.indexOf("id: closeTag"), view.indexOf("PlainText { Layout.fillWidth: true; text: view.displayPath", view.indexOf("id: closeTag")));
    // The QML carries the escape sequence, not a literal glyph, so the source
    // file stays ASCII and no encoding step can mangle it.
    expect(close).toContain("\\u2715");
    // Hover feedback has to come from a MouseArea: declarative pointer
    // handlers receive nothing on this Quickshell/Wayland stack.
    expect(close).toContain("hoverEnabled: true");
    expect(close).toContain("closeMouse.containsMouse");
    expect(close).not.toContain("HoverHandler {");
    expect(close).toContain("view.inspectedSession = null");
  });
});
