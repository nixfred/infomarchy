import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { patchDashboard } from "./dashboard-state";

const settings = readFileSync(join(import.meta.dir, "InfoSettings.qml"), "utf8");
const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");
const state = readFileSync(join(import.meta.dir, "dashboard-state.ts"), "utf8");

function qmlFunction(source: string, name: string): string {
  const body = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
  expect(body, name).toBeTruthy();
  return body || "";
}

const defs = [
  { id: "sessions", label: "SESSIONS" },
  { id: "machine", label: "MACHINE" },
  { id: "apps", label: "APPS" },
];

describe("module strip mode", () => {
  test("accepts the five modes, ignores case, and refuses anything else", () => {
    const box = { moduleStrip: "always", moduleStrips: ["always", "compact", "overlay", "hover", "never"], persists: 0 };
    const set = Function("box", "persist", `
      var moduleStrip = box.moduleStrip
      var moduleStrips = box.moduleStrips
      ${qmlFunction(settings, "setModuleStrip")}
      return function(mode) {
        moduleStrip = box.moduleStrip
        var result = setModuleStrip(mode)
        box.moduleStrip = moduleStrip
        return result
      }
    `)(box, () => { box.persists++; });
    expect(set("compact")).toBe(true);
    expect(box.moduleStrip).toBe("compact");
    expect(box.persists).toBe(1);
    // Same mode again is a no-op, so a click that lands where it started does not write.
    expect(set("COMPACT")).toBe(true);
    expect(box.persists).toBe(1);
    expect(set("  Hover ")).toBe(true);
    expect(box.moduleStrip).toBe("hover");
    for (const bad of ["", "hovering", "on", "nevermore"]) expect(set(bad)).toBe(false);
    expect(box.moduleStrip).toBe("hover");
    expect(box.persists).toBe(2);
    expect(set("always")).toBe(true);
    expect(box.moduleStrip).toBe("always");
  });

  test("cycles always, compact, overlay, hover, never, and back", () => {
    const box = { moduleStrip: "always", seen: [] as string[] };
    const cycle = Function("box", `
      var moduleStrip = box.moduleStrip
      var moduleStrips = ["always", "compact", "overlay", "hover", "never"]
      function setModuleStrip(mode) { moduleStrip = mode; box.seen.push(mode); return true }
      ${qmlFunction(settings, "cycleModuleStrip")}
      return function() { var result = cycleModuleStrip(); box.moduleStrip = moduleStrip; return result }
    `)(box);
    for (let i = 0; i < 5; i++) expect(cycle()).toBe(true);
    expect(box.seen).toEqual(["compact", "overlay", "hover", "never", "always"]);
  });

  test("compact keeps enabled sections and leaves apps off until asked", () => {
    const entries = Function(`return (${qmlFunction(settings, "moduleStripEntries")})`)();
    expect(entries("always", defs, { machine: true, sessions: false })).toEqual(defs);
    expect(entries("overlay", defs, { sessions: false })).toEqual(defs);
    expect(entries("compact", defs, {})).toEqual([defs[0], defs[1]]);
    expect(entries("compact", defs, { sessions: false, apps: true })).toEqual([defs[1], defs[2]]);
    expect(entries("compact", null, {})).toEqual([]);
  });

  test("overlay and never leave the wallpaper, hover waits for the pointer", () => {
    const shown = Function(`return (${qmlFunction(settings, "moduleStripShown")})`)();
    expect(shown("always", false, false)).toBe(true);
    expect(shown("compact", false, false)).toBe(true);
    expect(shown("overlay", false, true)).toBe(false);
    expect(shown("overlay", true, false)).toBe(true);
    expect(shown("hover", false, false)).toBe(false);
    expect(shown("hover", false, true)).toBe(true);
    expect(shown("hover", true, false)).toBe(true);
    expect(shown("never", true, true)).toBe(false);
  });

  test("a missing or unknown saved mode loads as always, and the patch writer agrees", () => {
    expect(settings).toContain('property string moduleStrip: "always"');
    expect(settings).toContain('moduleStrip = parsed && moduleStrips.indexOf(String(parsed.moduleStrip)) >= 0 ? String(parsed.moduleStrip) : "always"');
    expect(settings).toContain('moduleStrip = "always"');
    expect(settings).toContain("persist({ moduleStrip: moduleStrip })");
    expect(state).toContain('if (key === "moduleStrip") return value === "always" || value === "compact" || value === "overlay" || value === "hover" || value === "never";');
    const dir = join(mkdtempSync(join(tmpdir(), "infomarchy-strip-")), "infomarchy");
    for (const mode of ["always", "compact", "overlay", "hover", "never"]) {
      expect(patchDashboard(dir, { moduleStrip: mode })).toBe(true);
    }
    for (const bad of ["hovering", "ALWAYS", "", "always "]) {
      expect(patchDashboard(dir, { moduleStrip: bad })).toBe(false);
    }
    const saved = JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8"));
    expect(saved.moduleStrip).toBe("never");
  });

  test("the row hides without reserving height, and compact drops the shortcut hints", () => {
    expect(view).toContain("model: view.moduleStripSections");
    expect(view).toContain("visible: view.moduleStripShown");
    expect(view).toContain("Layout.preferredHeight: view.moduleStripShown ? moduleStrip.implicitHeight : 0");
    expect(view).toContain('text: "STRIP · " + view.settings.moduleStrip.toUpperCase()');
    expect(view).toContain("onClicked: view.settings.cycleModuleStrip()");
    expect(view).toContain('visible: view.settings.moduleStrip !== "compact"');
    expect(view).toContain('visible: view.keyboardAvailable && view.settings.moduleStrip !== "compact"');
    // HoverHandler, not a MouseArea: the top edge has to reveal the row
    // without taking the wallpaper's clicks.
    const edge = view.slice(view.indexOf("id: stripEdge"), view.indexOf("Connections {", view.indexOf("id: stripEdge")));
    expect(edge).toContain("HoverHandler { onHoveredChanged: view.stripEdgeHot = hovered }");
    expect(edge).toContain('visible: view.settings.moduleStrip === "hover" && !view.keyboardAvailable');
    expect(edge).not.toContain("MouseArea");
    const strip = view.slice(view.indexOf("id: moduleStrip"), view.indexOf("id: leftColumn"));
    expect(strip.indexOf("HARD REFRESH")).toBeGreaterThan(-1);
    expect(strip.indexOf("HARD REFRESH")).toBeLessThan(strip.indexOf("Repeater {"));
    expect(strip).toContain('text: "SETTINGS"');
  });

  test("IPC persists the mode and can open the drawer when the strip is gone", () => {
    expect(service).toContain('function setModuleStrip(v: string): string { return dashboardSettings.setModuleStrip(v) ? "ok" : "usage: setModuleStrip always|compact|overlay|hover|never" }');
    expect(service).toContain("function getModuleStrip(): string { return dashboardSettings.moduleStrip }");
    expect(service).toContain("root.deskView.settingsOpen = true");
    expect(service).toContain('return "open"');
    expect(overlay).toContain('function openSettings() { settingsRequest = settingsRequest + 1; return "open" }');
    expect(overlay).toContain("function onSettingsRequestChanged() { infoView.settingsOpen = true }");
  });
});
