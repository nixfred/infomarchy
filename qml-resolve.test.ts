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
// Container additions: one Process exit-status metadata warning, plus
// dynamic Style properties and unqualified card/delegate accesses.
const CEILINGS: Record<string, number> = {
  "BackgroundWallpaper.qml": 2,
  "Infomarchy.qml": 26,
  "InfoModel.qml": 6,
  "InfoSettings.qml": 0,
  "InfoView.qml": 511,
  "Overlay.qml": 29,
  "WaveWallpaper.qml": 0,
};

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
        const findings = output.split("\n").filter(line => /\[[a-z0-9-]+\]$/.test(line.trim()));
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
