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
    const migrated = ["usage", "localAi", "remoteRoster", "machine"];
    expect(adjacentEnabledIndex(migrated, 1, 1, {})).toBe(3);
    expect(adjacentEnabledIndex(migrated, 3, -1, {})).toBe(1);
    expect(adjacentEnabledIndex(migrated, 3, -1, { localAi: false })).toBe(0);
    expect(adjacentEnabledIndex(migrated, 1, 1, { machine: false })).toBe(1);
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
    expect(view).toContain('text: "1–9, 0 MODULES');
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
    expect(overlay).toContain('source: root.videoBackground ? "" : Util.fileUrl(root.background)');
    expect(overlay).toContain("opacity: dashboardSettings.ready && dashboardSettings.dashboardVisible ? root.wallpaperOpacity : 1.0");
    expect(overlay).toContain("visible: dashboardSettings.ready && dashboardSettings.dashboardVisible\n          onNavigated: root.close()");
    expect(overlay).not.toContain("Util.alpha(infoModel.themeBackground, 0.88)");
  });
});

describe("a video wallpaper plays instead of showing nothing", () => {
  // An Image cannot decode a video: it logs "Unsupported image format" and
  // leaves the desk on the flat theme colour, which is what selecting an
  // Omarchy video background used to do.
  const wallpaper = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
  const overlay = readFileSync(join(import.meta.dir, "Overlay.qml"), "utf8");
  const player = readFileSync(join(import.meta.dir, "BackgroundWallpaper.qml"), "utf8");

  test("each surface is handed only its own kind of file", () => {
    for (const source of [wallpaper, overlay]) {
      expect(source).toContain("readonly property bool videoBackground: root.isVideo(root.background)");
      // Both the still and the player test the path itself. Deriving one from
      // the other lets a URL evaluate against the stale flag and hand the
      // wrong file over for a pass.
      expect(source).toContain("when: videoWallpaper.item !== null && root.videoBackground");
    }
    expect(wallpaper).toContain('source: root.videoBackground ? "" : root.imageUrl(root.background)');
    expect(overlay).toContain('source: root.videoBackground ? "" : Util.fileUrl(root.background)');
  });

  test("Omarchy decides what a video is, and an older one still gets an answer", () => {
    // Both surfaces paint the wallpaper, so both must agree on what a video is
    // — and agree with the Omarchy they are running on.
    for (const [name, source] of [["Infomarchy.qml", wallpaper], ["Overlay.qml", overlay]] as const) {
      const fn = source.match(/function isVideo\(path\) \{[\s\S]*?\n  \}/)?.[0];
      expect(fn, name).toBeTruthy();

      // A format added to Omarchy is understood here without a change.
      const withUtil = Function("Util", `return (${fn})`)({ isVideoPath: (p: string) => /\.(mp4|gif)$/i.test(String(p || "")) });
      expect(withUtil("/bg/matrix-vortex.mp4"), name).toBe(true);
      expect(withUtil("/bg/added-later.gif"), name).toBe(true);
      expect(withUtil("/bg/still.png"), name).toBe(false);

      // An Omarchy whose Util predates video wallpapers has no such function.
      // Calling it anyway would take the plugin down on exactly the desktops
      // the fallback exists for.
      const noUtil = Function("Util", `return (${fn})`)({});
      expect(() => noUtil("/bg/still.png"), name).not.toThrow();
      expect(noUtil("/bg/matrix-vortex.mp4"), name).toBe(true);
      expect(noUtil("/bg/clip.WEBM"), name).toBe(true);
      expect(noUtil("/bg/still.png"), name).toBe(false);
      expect(noUtil(""), name).toBe(false);
      expect(noUtil(null), name).toBe(false);
    }
  });

  test("the player is reached by URL so an Omarchy without video support still loads", () => {
    // Naming BackgroundMedia in Infomarchy.qml would fail the whole plugin to
    // compile where the type does not exist; an unloaded file resolves nothing.
    expect(player).toContain("BackgroundMedia {");
    expect(player).toContain("audioEnabled: false");
    for (const source of [wallpaper, overlay]) {
      expect(source).toContain('source: "BackgroundWallpaper.qml"');
      expect(source).not.toContain("BackgroundMedia {");
    }
  });

  test("nothing decodes while nothing can see it", () => {
    // Qt's FFmpeg engine drives its own clock, so a covered wallpaper keeps
    // decoding until it is told to stop.
    expect(wallpaper).toContain("readonly property bool fullscreenHere: visibleWorkspace ? visibleWorkspace.hasFullscreen : false");
    expect(wallpaper).toContain("value: !panel.fullscreenHere");
    expect(overlay).toContain("active: root.videoBackground && root.opened");
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
  test("the per-model rows name no model, so a new one needs no edit here", () => {
    const block = view.match(/Repeater \{\s*\n\s*model: \(up\.u\.models[\s\S]*?\n                \}/)?.[0];
    expect(block).toBeTruthy();
    // Driven entirely by what the provider reported.
    expect(block).toContain("label: modelData.id");
    expect(block).toContain("fraction: up.u.hasTokenData ? (modelData.share || 0) : 0");
    // No model name may be hardcoded in the CODE. Prose may name one to
    // explain where the behaviour came from; a branch on one is the bug.
    const code = view.split("\n").filter(line => !line.trim().startsWith("//")).join("\n").toLowerCase();
    for (const name of ["fable", "opus", "astra", "gpt-", "grok-4", "sonnet", "haiku"])
      expect(code, name).not.toContain(name);
  });

  test("a Herdr card jumps to its own pane, not just the Herdr window", () => {
    // Herdr draws every workspace inside ONE window, so an agent's ancestry
    // resolves that window directly and the collector's client-window lookup
    // never runs. Gating the pane focus on `attached` meant every ordinary
    // Herdr card focused Herdr and left it on whatever was already showing.
    const branch = model.match(/else if \(host\.kind === "herdr".*?\) focusHerdrPane\(host\)/)?.[0];
    expect(branch).toBeTruthy();
    expect(branch).not.toContain("attached");
    expect(branch).toBe('else if (host.kind === "herdr") focusHerdrPane(host)');

    // The card promises this in its own label whenever there is a window, so
    // the promise and the behaviour have to agree.
    expect(view).toContain('" · click jumps to the pane"');

    // focusHerdrPane is the guard now: no valid ids, no request.
    const source = model.match(/function focusHerdrPane\(host\) \{[\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    expect(source).toContain('if (!workspace && !tab && !pane) return false');
  });

  test("a provider with no token data says so instead of reporting zero", () => {
    // Grok publishes prompts and sessions but no token totals or rate-limit
    // windows. "0 tok" would read as a measurement it never made.
    expect(view).toContain("up.u.hasTokenData ?");
    expect(view).toContain('(up.u.todaySessions ? " · " + up.u.todaySessions + " sess" : "")');
    // usageStatusText reached the QML for months and was never drawn; it is
    // the only place a provider can explain why it has no limit bars.
    expect(view).toContain("visible: !!up.u.usageStatusText && !(up.u.limits || []).length");
    expect(view).toContain('text: up.u.usageStatusText || ""');
  });

  test("ABOUT carries the version, the repo and the author, and the version is read from the manifest", () => {
    // A hardcoded version string drifts from the one the plugin ships as.
    expect(model).toContain('id: manifestFile');
    expect(model).toContain('Qt.resolvedUrl("manifest.json")');
    expect(model).toContain("root.version = String(parsed && parsed.version");
    // An in-place plugin update rewrites manifest.json under a running shell.
    expect(model).toContain("watchChanges: true");
    expect(model).toContain("onFileChanged: reload()");
    expect(model).toContain('readonly property string repoUrl: "https://github.com/nixfred/infomarchy"');
    expect(model).toContain('readonly property string authorUrl: "https://nixfred.com"');

    // The version is on the desk itself, at the quiet end of the legend line.
    expect(view).toContain('text: "Infomarchy v" + view.desk.version');
    expect(view).toContain("onClicked: view.aboutOpen = true");

    // All three required entries appear in the panel.
    expect(view).toContain('AboutLink { label: "REPOSITORY"; url: view.desk.repoUrl');
    expect(view).toContain('AboutLink { label: "AUTHOR"; url: view.desk.authorUrl');
    expect(view).toContain('text: "v" + view.desk.version');

    // Esc closes the panel before it closes the whole desk.
    expect(overlay).toContain("if (infoView.aboutOpen) infoView.aboutOpen = false; else root.close()");
  });

  test("openUrl refuses any address the plugin does not itself ship", () => {
    const source = model.match(/function openUrl\(url\) \{[\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const calls: string[][] = [];
    const root = { repoUrl: "https://github.com/nixfred/infomarchy", authorUrl: "https://nixfred.com" };
    const Quickshell = { execDetached: (argv: string[]) => { calls.push(argv); } };
    const openUrl = Function("root", "Quickshell", `return (${source})`)(root, Quickshell);

    expect(openUrl(root.repoUrl)).toBe(true);
    expect(openUrl(root.authorUrl)).toBe(true);
    expect(calls).toEqual([["xdg-open", root.repoUrl], ["xdg-open", root.authorUrl]]);

    // Anything else — including a lookalike host — never reaches xdg-open.
    for (const hostile of ["https://nixfred.com.evil.test", "file:///etc/passwd", "https://github.com/attacker/x", "", null, undefined])
      expect(openUrl(hostile as any)).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("MACHINE is a two-column grid with a one-line footer, and the SUPER legend sits under it", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    expect(view).toContain("// Cockpit density: two meters per row");
    expect(view).toContain('text: "WAN " + (view.machine.externalIp || "—")');
    expect(view).toContain('"SUPER+I hide desk  ·  SUPER+D show desktop") + "  ·  right-click a card to inspect"');
    expect(view).toContain("readonly property int metaWidth");
  });
});

describe("LOCAL AI rows stay inside the card body", () => {
  const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
  test("the provider chips are a Flow, so no rigid row can raise the column minimum above the body width", () => {
    // Four rigid Tags in a RowLayout gave the column a 514 px minimum in a 512 px body: every
    // row then laid out 2 px past the clip and lost its right border. A Flow has no minimum.
    const start = view.indexOf("id: provRow");
    const opener = view.lastIndexOf("{", start);
    const type = view.slice(view.lastIndexOf("\n", opener) + 1, opener).trim();
    expect(type).toBe("Flow");
    expect(view.slice(start, view.indexOf("\n            }", start))).not.toContain("Item { Layout.fillWidth: true }");
  });
  test("the live geometry report is exposed over IPC for measuring, not guessing", () => {
    expect(view).toContain("function geometryReport(): string");
    const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
    expect(service).toContain("function geometry(): string { return root.deskView ? root.deskView.geometryReport() : \"{}\" }");
  });
});

describe("session card lines never spill into the neighbouring card", () => {
  test("every fill-width single-line text in a session card elides", () => {
    const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
    const start = view.indexOf("hosted in \" + view.sessionHostLabel(sc.modelData)");
    const block = view.slice(view.lastIndexOf("ColumnLayout", start), view.indexOf("\n                }", start));
    // The merged pid/cpu line had no elide: the taller first card's line ran under its
    // neighbour's git line ("git mainc·uclean · ram 360M"). Fill-width, one line ⇒ elide.
    for (const line of block.split("\n").filter(l => l.includes("PlainText {") && l.includes("Layout.fillWidth: true") && !l.includes("wrapMode")))
      expect(line).toMatch(/elide: Text\.Elide(Right|Middle|Left)/);
  });
});

describe("github activity heatmap", () => {
  test("registers GITHUB as a removable module beside ACTIVITY and reaches it from the keyboard", () => {
    const ids = [...settings.matchAll(/\{ id: "([a-zA-Z]+)", label: "[^"]+" \}/g)].map(match => match[1]);
    expect(ids.indexOf("github")).toBe(ids.indexOf("activity") + 1);
    expect(ids).toHaveLength(10);
    expect(overlay).toContain("event.key >= Qt.Key_0 && event.key <= Qt.Key_9");
    expect(overlay).toContain("event.key === Qt.Key_0 ? 9 : event.key - Qt.Key_1");
    // Key n toggles definitions[n-1]; 0 is the tenth. Documented as 4 = GITHUB, 0 = PROJECTS.
    expect(ids[3]).toBe("github");
    expect(ids[9]).toBe("projects");
  });

  test("splits the activity row into two half-width heatmap cards sharing one HeatPanel", () => {
    expect(view).toContain("component HeatPanel: Item");
    expect(view.match(/HeatPanel \{/g)).toHaveLength(2);
    expect(view).toContain('title: "ACTIVITY · LAST 7 DAYS"');
    expect(view).toContain('title: "GITHUB · LAST 7 DAYS"');
    expect(view).toContain('visible: view.sectionEnabled("activity") || view.sectionEnabled("github")');
    // Both cards ask for an equal share; neither may impose a minimum that pushes the other off screen.
    expect(view.match(/Layout\.preferredWidth: 1\n\s+Layout\.minimumWidth: 0\n\s+visible: view\.sectionEnabled\("(activity|github)"\)/g)).toHaveLength(2);
    expect(view).toContain("cells: view.github.cells || []");
    expect(view).toContain("kindFiltersCells: true");
    expect(view).toContain("showRepos: true");
  });

  test("explains every GitHub feed state and keeps the AI activity filter wiring intact", () => {
    for (const state of ["missing", "unauthenticated", "pending", "unavailable", "stale", "ok"]) expect(view).toContain(`case "${state}":`);
    expect(view).toContain("run gh auth login");
    expect(view).toContain("onCellClicked: function(index) { view.toggleActivityCell(index) }");
    expect(view).toContain("onKindClicked: function(kind) { view.toggleActivityProvider(kind) }");
    expect(view).toContain("onCellClicked: function(index) { view.toggleGithubCell(index) }");
    expect(view).toContain('githubCellFilter = -1; githubKindFilter = ""');
    // A pinned GitHub cell keeps its breakdown in the status line once the pointer leaves it.
    expect(view).toContain("pinnedBreakdown: true");
    expect(view).toContain('"pinned · " + panel.cellLabel(panel.selectedCell)');
  });
});

describe("external roster presentation", () => {
  const start = view.indexOf("id: remoteRosterCard");
  const card = view.slice(start, view.indexOf("// ---- machine corner", start));
  test("migrates persisted order next to LOCAL AI without adding an eleventh module", () => {
    const normalize = Function(`return (${settings.match(/function normalizedRightOrder\([\s\S]*?\n  \}/)![0]})`)();
    expect(normalize(["usage", "localAi", "machine"])).toEqual(["usage", "localAi", "remoteRoster", "machine"]);
    expect(normalize(null)).toEqual(["usage", "localAi", "remoteRoster", "machine"]);
    expect(normalize(["machine", "usage", "localAi"])).toEqual(["machine", "usage", "localAi", "remoteRoster"]);
    expect(normalize(["remoteRoster", "machine", "localAi", "usage", "remoteRoster"])).toEqual(["remoteRoster", "machine", "localAi", "usage"]);
    expect(settings.slice(settings.indexOf("readonly property var definitions"), settings.indexOf("property var sections"))).not.toContain("remoteRoster");
    expect(view).toContain('|| !!view.ai.remoteRoster');
    expect(card).toContain('rightIndex("remoteRoster")');
    expect(card).toContain('title: "REMOTE"');
    expect(card).not.toMatch(/moveId:|draggable:|focusSession|inspect|resume|STOP|END/);
    expect(model).toContain('case "remote": return "Remote"');
  });
  test("the card's one action is a workspace, opt-in, and inert without one", () => {
    // Exactly one MouseArea: no per-row actions, no drag target, nothing that
    // reaches an agent — a remote agent has no window on this machine.
    expect(card.match(/MouseArea/g)).toHaveLength(1);
    expect(card).toContain("enabled: view.interactive && !!remoteRosterCard.roster.workspace");
    expect(card).toContain("onClicked: view.desk.focusWorkspace(remoteRosterCard.roster.workspace)");
    expect(card).toContain('(roster.workspace ? " · click to open" : "")');
    const guard = model.match(/function focusWorkspace\(workspace\)[\s\S]*?\n  \}/)![0];
    expect(guard).toContain("if (!/^[1-9][0-9]?$/.test(ws)) return");
    expect(guard).toContain("hl.dsp.focus({ workspace = ");
    expect(guard).toContain('"hyprctl", "dispatch", "workspace", ws');
    expect(guard).not.toMatch(/exec_cmd|killactive|exit|movetoworkspace/);
  });
  test("two-row overflow includes emitted rows that do not fit", () => {
    const limit = card.match(/rowLimit: (.+)/)![1];
    const remaining = card.match(/remaining: (.+)/)![1];
    const rowLimit = Function("view", "Style", `return ${limit}`)({ height: 1080 }, { fontScale: 1 });
    const roster = { needsYou: [{}, {}, {}, {}], overflow: 2 };
    expect(rowLimit).toBe(2);
    expect(Function("roster", "rows", `return ${remaining}`)(roster, roster.needsYou.slice(0, rowLimit))).toBe(4);
    expect(Function("view", "Style", `return ${limit}`)({ height: 1440 }, { fontScale: 1 })).toBe(4);
    expect(card).toContain("delegate: PlainText");
  });
  test("1080p differential: local Flow geometry and RECENT layout bindings ignore roster", () => {
    // Source/binding regression, not a rendered-height measurement. Nine local
    // sessions intentionally exercise wrapping; roster presence must not alter it.
    const left = view.slice(view.indexOf("// LEFT COLUMN:"), view.indexOf("// RIGHT COLUMN:"));
    expect(left).not.toContain("remoteRoster");
    const expr = (pattern: RegExp) => view.match(pattern)![1];
    const evaluate = (source: string, fixture: any, extra = {}) => Function("view", "Style", ...Object.keys(extra), `return ${source}`)(fixture, { fontScale: 1 }, ...Object.values(extra));
    const fixture = { width: 1920, height: 1080, gap: 12, sessions: Array.from({ length: 9 }, (_, id) => ({ id })), ai: {}, sectionEnabled: () => true };
    function layout(ai: any) {
      const v = { ...fixture, ai };
      const rightColumnWidth = evaluate(expr(/rightColumnWidth: (.+)/), v, { width: v.width });
      const targetColumns = evaluate(expr(/targetColumns: (.+)/), v);
      const minimumCardWidth = evaluate(expr(/minimumCardWidth: (.+)/), v);
      const width = evaluate(expr(/Layout.maximumWidth: (view.width - view.rightColumnWidth[^\n]+)/), { ...v, rightColumnWidth });
      const fittedCardWidth = evaluate(expr(/fittedCardWidth: (.+)/), v, { width, spacing: 12, targetColumns });
      const recent = left.slice(left.indexOf("// ---- recent prompts"));
      return { targetColumns, minimumCardWidth, fittedCardWidth,
        rows: Math.ceil(v.sessions.length / targetColumns),
        recentEnabled: evaluate(recent.match(/visible: (.+)/)![1], v),
        recentMinimumHeight: evaluate(recent.match(/Layout.minimumHeight: (.+)/)![1], v) };
    }
    const absent = layout({ sessions: fixture.sessions });
    const populated = layout({ sessions: fixture.sessions, remoteRoster: { counts: { busy: 100 }, needsYou: [{}, {}, {}, {}], overflow: 96 } });
    expect(populated).toEqual(absent);
    expect(absent).toMatchObject({ targetColumns: 6, rows: 2, recentEnabled: true, recentMinimumHeight: 150 });
    // RECENT's enabled/minimum-height bindings are what this helper can assert;
    // actual on-desk visibility still needs a renderer with real font metrics.
  });
});
