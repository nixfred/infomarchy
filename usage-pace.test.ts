import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A limit bar at 86% means nothing on its own. The same card showed a solid red
// Weekly bar next to Burn Bar's "86% ON PACE", and it read as "out of Claude
// Code" when the number was identical in both: the cache, the collector and the
// live desk all said 0.86. What was missing is where EVEN PACE sits, so a bar
// can say "slightly ahead" instead of just "red". These tests pin the maths on
// the real numbers from that night, and render the real Meter component.
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");

// Lift one function out of the QML by counting braces, so a one-liner and a
// multi-line body both come out exactly as written.
function pickFunction(name: string): string {
  const start = view.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`InfoView.qml has no ${name}()`);
  let depth = 0, i = view.indexOf("{", start);
  for (; i < view.length; i++) {
    if (view[i] === "{") depth++;
    else if (view[i] === "}" && --depth === 0) break;
  }
  return view.slice(start, i + 1);
}
const usageWindowMs = new Function(`return (${pickFunction("usageWindowMs")})`)();
const usagePaceSource = pickFunction("usagePace");
const usagePace = (limit: any, snap: any) => new Function("usageWindowMs", "snap", `return (${usagePaceSource})`)(usageWindowMs, snap)(limit);

const HOUR = 3600_000;
const NOW = Date.parse("2026-10-10T03:50:00Z");

describe("where even pace sits on a limit bar", () => {
  test("the real Weekly reading: 30h of a 168h week left puts even pace at 82%", () => {
    // 2026-10-09 23:47 EDT: Weekly 86%, resets Sunday 06:00 EDT. Burn Bar drew
    // its tick at ~82% and so should this.
    const pace = usagePace({ label: "Weekly (7-day)", resetsAt: new Date(NOW + 30 * HOUR).toISOString() }, { ts: NOW });
    expect(pace).toBeCloseTo(1 - 30 / 168, 6);
    expect(Math.round(pace * 100)).toBe(82);
  });

  test("the 5-hour session window and the Fable weekly window use their own lengths", () => {
    expect(usagePace({ label: "Session (5-hour)", resetsAt: new Date(NOW + 1 * HOUR).toISOString() }, { ts: NOW })).toBeCloseTo(0.8, 6);
    expect(usagePace({ title: "Fable Weekly", label: "Fable Weekly", resetsAt: new Date(NOW + 84 * HOUR).toISOString() }, { ts: NOW })).toBeCloseTo(0.5, 6);
  });

  test("no marker when the pace cannot be known", () => {
    const at = (limit: any) => usagePace(limit, { ts: NOW });
    // A window we do not know the length of must not get a guessed tick.
    expect(at({ label: "Monthly credits", resetsAt: new Date(NOW + HOUR).toISOString() })).toBe(-1);
    // No reset time, an unparseable one, a reset already in the past, and a
    // reset further out than the window itself (a stale reading) all mean the
    // elapsed fraction would be wrong, so there is no tick rather than a lie.
    expect(at({ label: "Weekly (7-day)" })).toBe(-1);
    expect(at({ label: "Weekly (7-day)", resetsAt: "tomorrow-ish" })).toBe(-1);
    expect(at({ label: "Weekly (7-day)", resetsAt: new Date(NOW - HOUR).toISOString() })).toBe(-1);
    expect(at({ label: "Weekly (7-day)", resetsAt: new Date(NOW + 200 * HOUR).toISOString() })).toBe(-1);
    expect(usagePace(undefined, { ts: NOW })).toBe(-1);
  });

  test("it is read from the snapshot clock, so it moves with the data", () => {
    const limit = { label: "Weekly (7-day)", resetsAt: new Date(NOW + 30 * HOUR).toISOString() };
    const earlier = usagePace(limit, { ts: NOW - 12 * HOUR });
    const later = usagePace(limit, { ts: NOW });
    expect(later - earlier).toBeCloseTo(12 / 168, 6);
    expect(usagePaceSource).toContain("snap.ts");
  });

  test("the limit rows hand it to the meter, and the legend explains the tick", () => {
    expect(view).toContain("pace: view.usagePace(modelData)");
    expect(view).toContain("omarchy agents · grok/opencode local · | = even pace");
  });
});

// Rendering. The Meter is an inline component, so it cannot be instantiated on
// its own; instead the REAL source text is lifted out of InfoView.qml and
// dropped into a generated fixture with the few names it reaches for supplied
// as stand-ins. Testing a hand-written copy would prove the copy.
function meterSource(): string {
  const start = view.indexOf("component Meter: Item {");
  if (start < 0) throw new Error("InfoView.qml has no Meter component");
  let depth = 0, i = view.indexOf("{", start);
  for (; i < view.length; i++) {
    if (view[i] === "{") depth++;
    else if (view[i] === "}" && --depth === 0) break;
  }
  return view.slice(start, i + 1);
}

const RUNNER = ["/usr/lib/qt6/bin/qmltestrunner", "/usr/bin/qmltestrunner"].find(path => existsSync(path)) || "";

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "infomarchy-pace-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "qmldir"), "singleton Style Style.qml\nsingleton Util Util.qml\nsingleton Color Color.qml\n");
  writeFileSync(join(dir, "Style.qml"), `pragma Singleton
import QtQuick
QtObject {
  readonly property var spacing: ({ xs: 3, sm: 4 })
  readonly property var font: ({ bodySmall: 12 })
  readonly property real fontScale: 1
}
`);
  writeFileSync(join(dir, "Util.qml"), `pragma Singleton
import QtQuick
QtObject { function alpha(c, a) { var k = Qt.color(c); return Qt.rgba(k.r, k.g, k.b, a) } }
`);
  writeFileSync(join(dir, "Color.qml"), `pragma Singleton
import QtQuick
QtObject { readonly property color accent: "#00ffff" }
`);
  const file = join(dir, "tst_pacetick.qml");
  writeFileSync(file, `import QtQuick
import QtQuick.Layouts
import QtTest
import "."

Item {
  id: view
  width: 400; height: 200
  property color textDim: "#999999"
  property string mono: "monospace"
  property var desk: ({ themeForeground: Qt.color("#ffffff") })
  component PlainText: Text {}

  ${meterSource()}

  // Same label and width everywhere, so the bar sits at the same y in each.
  // Each Meter sits on a black cell and the CELL is what gets grabbed, so a
  // pixel's brightness is read against black like on the real desk.
  Column {
    spacing: 8
    Rectangle { color: "black"; width: 400; height: childrenRect.height
      Meter { objectName: "behind";  label: "Weekly (7-day)"; value: "50%"; fraction: 0.50; pace: 0.90; tone: "#ff0000" } }
    Rectangle { color: "black"; width: 400; height: childrenRect.height
      Meter { objectName: "ahead";   label: "Weekly (7-day)"; value: "86%"; fraction: 0.86; pace: 0.82; tone: "#ff0000" } }
    Rectangle { color: "black"; width: 400; height: childrenRect.height
      Meter { objectName: "none";    label: "Weekly (7-day)"; value: "86%"; fraction: 0.86; pace: -1;   tone: "#ff0000" } }
    Rectangle { color: "black"; width: 400; height: childrenRect.height
      Meter { objectName: "outside"; label: "Weekly (7-day)"; value: "86%"; fraction: 0.86; pace: 1.7;  tone: "#ff0000" } }
    Rectangle { color: "black"; width: 400; height: childrenRect.height
      Meter { objectName: "start";   label: "Weekly (7-day)"; value: "10%"; fraction: 0.10; pace: 0.25; tone: "#ff0000" } }
  }

  TestCase {
    name: "PaceTick"
    when: windowShown

    function barRow(item) {
      var t = findChild(item, "paceTick")
      return t.mapToItem(item, 0, t.height / 2).y
    }
    // Pixel probes on a grabbed Meter, in that Meter's own coordinates. The
    // grab is opaque, so brightness (red/green) is what distinguishes a tick,
    // never alpha. 'row' lists a run of pixels for the failure message.
    function probe(objectName, x) {
      var m = findChild(view, objectName)
      wait(600)
      var img = grabImage(m.parent)
      var y = Math.round(barRow(m))
      var row = ""
      for (var dx = -8; dx <= 8; dx += 2) row += (x + dx) + ":" + img.red(x + dx, y) + "/" + img.green(x + dx, y) + " "
      return { r: img.red(x, y), g: img.green(x, y), y: y, row: row }
    }

    function test_tick_over_the_fill_is_bright_against_the_red() {
      // Bar is ahead of pace: the tick sits INSIDE the red fill. Red is
      // (255,0,0); a white tick over it lifts green far above zero.
      var on = probe("ahead", 328), beside = probe("ahead", 316)
      verify(on.g > 180, "tick over fill should be near white, got g=" + on.g + " at y=" + on.y + " row " + on.row)
      verify(beside.g < 40, "fill beside the tick should stay red, got g=" + beside.g)
    }

    function test_tick_beyond_the_fill_stands_out_of_the_empty_track() {
      // Bar is behind pace: the tick sits past the fill on the faint track.
      var on = probe("behind", 360), beside = probe("behind", 348)
      verify(on.r > 200, "tick on the track should be near white, got r=" + on.r + " row " + on.row)
      verify(beside.r < 80, "empty track beside it should stay dim, got r=" + beside.r)
    }

    function test_no_pace_draws_no_tick() {
      var m = findChild(view, "none")
      compare(findChild(m, "paceTick").visible, false)
      var at = probe("none", 328)
      verify(at.g < 40, "with no pace the fill must be plain red, got g=" + at.g)
    }

    function test_an_impossible_pace_draws_no_tick() {
      // A pace past 1 is a bad reading, not a bar that is somehow beyond full.
      compare(findChild(findChild(view, "outside"), "paceTick").visible, false)
    }

    function test_the_tick_lands_where_the_fraction_says() {
      // Even pace 25% of a 400px track is x=100, whatever the fill is doing.
      var m = findChild(view, "start")
      var t = findChild(m, "paceTick")
      var cx = t.mapToItem(m, t.width / 2, 0).x
      verify(Math.abs(cx - 100) <= 1, "tick centre " + cx + " should be at 100")
      compare(t.visible, true)
    }
  }
}
`);
  return file;
}

describe("the real Meter draws the even-pace tick", () => {
  test("qmltestrunner is available to gate this", () => {
    expect(RUNNER, "install qt6-declarative for qmltestrunner").not.toBe("");
  });

  test("the Meter keeps the tick as an optional, off-by-default marker", () => {
    const meter = meterSource();
    expect(meter).toContain("property real pace: -1");
    expect(meter).toContain('objectName: "paceTick"');
    expect(meter).toContain("visible: pace >= 0 && pace <= 1");
    // Every other Meter in the desk (model shares, machine gauges) passes no
    // pace, so none of them grows a tick.
    const uses = view.match(/\n\s+delegate: Meter \{|\n\s+Meter \{/g) || [];
    const withPace = view.match(/pace: view\.usagePace\(modelData\)/g) || [];
    expect(withPace.length).toBe(1);
    expect(uses.length).toBeGreaterThan(withPace.length);
  });

  test("pixels: ahead of pace, behind pace, no pace, bad pace, and position", () => {
    const file = writeFixture();
    const result = Bun.spawnSync([RUNNER, "-input", file], {
      env: { ...process.env, QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software" },
    });
    const output = result.stdout.toString() + result.stderr.toString();
    for (const name of [
      "test_tick_over_the_fill_is_bright_against_the_red",
      "test_tick_beyond_the_fill_stands_out_of_the_empty_track",
      "test_no_pace_draws_no_tick",
      "test_an_impossible_pace_draws_no_tick",
      "test_the_tick_lands_where_the_fraction_says",
    ]) expect(output, output).toContain(`PASS   : qmltestrunner::PaceTick::${name}()`);
    expect(result.exitCode, output).toBe(0);
  }, 60_000);
});
