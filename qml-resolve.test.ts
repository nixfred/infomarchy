import { describe, expect, test } from "bun:test";
import { readdirSync, existsSync, mkdtempSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// qml-syntax.test.ts proves each file PARSES. That is a weaker guarantee than
// it looks: a property bound to an id that does not exist is perfectly valid
// syntax and still fails on the desk. Verified — injecting
// `nonexistentThing.value` into InfoSettings produced zero syntax findings.
//
// This gate resolves the real imports instead (`qs.Commons`, `qs.Ui` and the
// Quickshell modules) so qmllint can tell whether a name actually exists.
//
// It gates on a per-file CEILING rather than zero, because the codebase carries
// hundreds of findings that are idiomatic or unmodellable rather than wrong:
// `[unqualified]` is how QML reads its own root properties, `PanelWindow` is
// created by the Quickshell runtime so qmllint calls it uncreatable, and
// BackgroundWallpaper.qml deliberately names `BackgroundMedia`, which only
// exists on an Omarchy with video wallpaper support — that file is loaded by
// URL precisely so its absence stays survivable.
//
// A ceiling still catches the case that matters: one new unresolvable
// reference moves the count, which is exactly what a bad merge introduces.
// Verified — the same injection took InfoModel from 5 to 6.
// Privacy adds unqualified bindings for the status chip and overlay hotkey.
// Container additions: one Process exit-status metadata warning, plus
// dynamic Style properties and unqualified card/delegate accesses.
// Usage (#16) adds the refresh chip and provider-block bindings.
const CEILINGS: Record<string, number> = {
  "Apps.qml": 6,
  "BackgroundWallpaper.qml": 0,
  // +4: each edge reads root.barEdgeInsets from inside the per-screen
  // PanelWindow. qmllint counts every outer-id read as unqualified, the
  // same false positive root.deskView already produces in this file.
  // +2 (#38): deskWorkspaceMatches reads dashboardSettings from inside the
  // same PanelWindow, the same false positive again.
  // +1 (#25): the Web Mode listener Process has an onExited handler, the
  // same exit-status metadata warning every other Process handler produces.
  "Infomarchy.qml": 33,
  "InfoModel.qml": 6,
  // 3 (#25): the settings writer, the RETRY SETUP launcher and the WEB
  // prerequisite check are Processes with onExited handlers, which qmllint
  // cannot type without QProcess.
  "InfoSettings.qml": 3,
  // 509 came in with privacy mode (#17). The two above it are the topic mask
  // folded into that merge: qmllint cannot resolve a view-scoped function, so
  // each call site of displayTopic reads as a missing property, exactly like
  // the displayTitle calls already counted here. 607 folds in the FLEET
  // card's delegate (Repeater + required property + outer-scope
  // references), the same false-positive shape the LOCAL AI delegate
  // already produces ~26 of — see docs/fleet-remote-hosts.md.
  // 593 folds in the FLEET card's per-session rows: a second nested Repeater
  // with its own required property, so every outer-scope reference inside it
  // (view.desk, Style.spacing, the host delegate's own modelData) reads as
  // unqualified, plus the two layout-positioning warnings the existing status
  // dot already produces, for the session dot beside it. Same false-positive
  // shape as the row above it, counted twice because there are now two rows.
  // +6 (#16): the HARD REFRESH chip and the tinted provider blocks: dynamic
  // Style properties and unqualified delegate accesses, the same
  // false-positive shape counted above.
  // +3 (#25): the SETTINGS drawer panel reads Style.spacing.md (twice) and
  // Style.font.subtitle, dynamic Style properties qmllint sees as QObject.
  // +7 (#13): the REMOTE card's delegate reads view.desk, view.settings and
  // Style through the outer scope, the same unqualified false positive every
  // other card in this file contributes.
  // +2: the inspector's CLOSE tag reads view.desk and view.textDim from the
  // outer scope for its hover tint, the same unqualified false positive the
  // rest of this count is made of.
  // +1: sessionFactLine() reads view.desk for the duration formatter, the
  // same outer-scope false positive as every other helper in this file.
  // +1: jumpHint() reads the session's hosts through the outer scope, the
  // same unqualified false positive as every other helper here.
  // +4: sessionReachable(), sortedSessions and the two group counts read the
  // session list and view.settings through the outer scope, the same
  // unqualified false positive the rest of this count is made of.
  // +5: usagePace() reads the snapshot clock and the Meter's even-pace tick
  // reads view.desk, all outer-scope reads that qmllint reports as
  // [unqualified]. Diffed against the previous file: no missing-property or
  // unresolved-name finding, only that same pattern.
  "InfoView.qml": 622,
  "Overlay.qml": 29,
  "WaveWallpaper.qml": 0,
  // Settings drawer (#25): dynamic Style properties qmllint sees as QObject,
  // modelData reads inside nested delegate children, and Process exit-status
  // metadata. ComponentBehavior: Bound keeps outer-id reads resolvable.
  // Covered by real offscreen QML tests too. +5: the bounded token and CIDR
  // list (ScrollList) reads Style.spacing.md four times and Style.font.caption.
  "SettingsBody.qml": 100,
};

// Findings that exist only because the plugin deliberately survives an Omarchy
// without video wallpaper support. They appear against Omarchy 4.0.3 and vanish
// against a tree that has the feature, so counting them made the ceilings
// depend on which Omarchy ran the test: 4.0.3 measured 28 in Infomarchy.qml
// against a ceiling of 26 and failed every stock install. Each one is the
// fallback working as designed, not a defect:
//   - `Util.isVideoPath` is only called behind `typeof ... === "function"`.
//   - `BackgroundMedia` is reached through a Loader by URL so its absence
//     cannot take the plugin down; with it unresolved, that file's `qs.Ui`
//     import then reads as unused.
// Matched narrowly (exact member, exact type, one file for the import) so an
// unrelated missing member or unused import still counts.
const VERSION_DEPENDENT: [RegExp, string | null][] = [
  [/Member "isVideoPath" not found on type "Util" \[missing-property\]$/, null],
  [/BackgroundMedia was not found\..*\[import\]$/, "BackgroundWallpaper.qml"],
  [/Unused import \[unused-imports\]$/, "BackgroundWallpaper.qml"],
];
function versionDependent(file: string, line: string): boolean {
  return VERSION_DEPENDENT.some(([re, only]) => (only === null || only === file) && re.test(line.trim()));
}

const QMLLINT = ["/usr/lib/qt6/bin/qmllint", "/usr/bin/qmllint"].find(p => existsSync(p)) || "";
// `qs.X` resolves to <shell root>/X, so the import root must contain a "qs".
const SHELL_ROOT = [process.env.OMARCHY_PATH ? join(process.env.OMARCHY_PATH, "shell") : "", "/usr/share/omarchy/shell"]
  .find(p => p && existsSync(join(p, "Commons", "qmldir"))) || "";
const QT_QML = ["/usr/lib/qt6/qml"].find(p => existsSync(p)) || "";

const files = readdirSync(import.meta.dir).filter(n => n.endsWith(".qml")).sort();

describe("QML resolves against its real imports", () => {
  // Unlike the syntax gate, this one needs Omarchy itself installed. Announce
  // the skip rather than passing silently, so a green run is never mistaken
  // for a run that happened.
  const runnable = !!QMLLINT && !!SHELL_ROOT && !!QT_QML;

  test("the resolved-import gate can run here", () => {
    if (!runnable) {
      console.warn(`qml-resolve: SKIPPED (qmllint=${!!QMLLINT} omarchyShell=${!!SHELL_ROOT} qtQml=${!!QT_QML})`);
    }
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    test(`${name} introduces no new unresolved names`, () => {
      if (!runnable) return;
      const root = mkdtempSync(join(tmpdir(), "infomarchy-qml-"));
      try {
        symlinkSync(SHELL_ROOT, join(root, "qs"));
        const run = Bun.spawnSync([QMLLINT, "-I", root, "-I", QT_QML, join(import.meta.dir, name)]);
        const output = run.stdout.toString() + run.stderr.toString();
        const findings = output.split("\n")
          .filter(line => /\[[a-z0-9-]+\]$/.test(line.trim()))
          .filter(line => !versionDependent(name, line));
        const ceiling = CEILINGS[name];
        // A file nobody recorded a ceiling for must not slip through unchecked.
        expect(ceiling, `${name} has no recorded ceiling; add one`).toBeDefined();
        expect(findings.length, `${name}: ${findings.length} findings, ceiling ${ceiling}\n${findings.slice(0, 12).join("\n")}`)
          .toBeLessThanOrEqual(ceiling);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
