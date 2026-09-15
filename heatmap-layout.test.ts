import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("heatmaps fit wide, medium and narrow layouts and recover when modules toggle", () => {
  const runner = "/usr/lib/qt6/bin/qmltestrunner";
  if (!existsSync(runner)) { console.warn("heatmap-layout: SKIPPED (qmltestrunner not installed)"); return; }
  const source = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
  const block = source.slice(source.indexOf("        // ---- heatmaps:"), source.indexOf("        // ---- recent prompts"));
  // Exercise the real GridLayout and each card's real attached layout
  // properties in Qt. Only the card contents are replaced with fixed-height
  // rectangles: this test needs no desktop services or Quickshell process.
  const header = block.slice(block.indexOf("GridLayout {"), block.indexOf("          Card {"));
  const cards = [...block.matchAll(/Card \{([\s\S]*?)\n\s+title:/g)].map(match => "Rectangle {" + match[1] + "\nimplicitHeight: 160\n}");
  expect(cards).toHaveLength(3);
  const layout = (header + cards.join("\n") + "\n}").replaceAll("Style.fontScale", "view.fontScale");
  const directory = mkdtempSync(join(tmpdir(), "infomarchy-heatmap-layout-"));
  try {
    writeFileSync(join(directory, "tst_heatmap.qml"), `
import QtQuick
import QtQuick.Layouts
import QtTest
Item {
  id: view
  width: 2800; height: 1000
  property real fontScale: 1
  property int gap: 9
  property var sections: ({})
  function sectionEnabled(id) { return sections[id] !== false }
  ColumnLayout { width: parent.width; ${layout} }
  TestCase {
    name: "HeatmapLayout"
    when: windowShown
    function test_fit_data() {
      return [
        {tag: "ultrawide", width: 2800, columns: 3},
        {tag: "desktop", width: 1300, columns: 2},
        {tag: "narrow", width: 900, columns: 1},
        {tag: "scaled", width: 1300, columns: 1, scale: 1.5}
      ]
    }
    function test_fit(data) {
      view.sections = ({})
      view.fontScale = data.scale || 1
      view.width = data.width
      tryCompare(heatmapGrid, "columns", data.columns)
      wait(30)
      var cards = [activityCard, githubCard, giteaCard]
      for (var i = 0; i < cards.length; i++) {
        verify(cards[i].width > 0)
        verify(cards[i].x >= 0)
        verify(cards[i].x + cards[i].width <= data.width + 1)
        for (var j = i + 1; j < cards.length; j++) {
          var a = cards[i], b = cards[j]
          verify(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, "cards overlap")
        }
      }
      if (data.columns === 2) {
        compare(activityCard.width, heatmapGrid.width)
        compare(githubCard.y, giteaCard.y)
      }
    }
    function test_toggle() {
      view.fontScale = 1; view.width = 1300
      view.sections = ({activity: false})
      tryCompare(activityCard, "visible", false)
      wait(30)
      compare(githubCard.y, giteaCard.y)
      view.sections = ({activity: false, github: false})
      tryCompare(heatmapGrid, "columns", 1)
      wait(30)
      compare(giteaCard.width, heatmapGrid.width)
      view.sections = ({activity: false, github: false, gitea: false})
      tryCompare(heatmapGrid, "visible", false)
      view.sections = ({})
      tryCompare(heatmapGrid, "visible", true)
      tryCompare(heatmapGrid, "columns", 2)
    }
  }
}
`);
    const result = Bun.spawnSync([runner, "-platform", "offscreen", "-input", directory], { timeout: 15_000 });
    expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
