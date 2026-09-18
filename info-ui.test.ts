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
    expect(settings).toContain("property string ollamaHost: \"\"");
    expect(settings).toContain("function setOllamaHost");
    expect(settings).toContain("function normalizeOllamaHost");
    expect(model).toContain('ollamaControlPath: Qt.resolvedUrl("ollama-control.ts")');
    expect(model).toContain("ollamaProcess.pendingFrame");
    expect(model).toContain("write(JSON.stringify(pendingFrame)");
    expect(model).toContain("environment: root.ollamaHost !== \"\" ? ({ OLLAMA_HOST: root.ollamaHost }) : ({})");
    expect(service).toContain("function setOllamaHost(v: string): void { dashboardSettings.setOllamaHost(v) }");
    expect(overlay).toContain("ollamaHost: dashboardSettings.ollamaHost");
    expect(view).toContain("function needsConfirmation");
    expect(view).toContain('view.desk.controlOllama("load"');
    expect(view).toContain('view.desk.controlOllama("unload"');
    expect(view).toContain('"CONFIRM"');
    const source = settings.match(/function normalizeOllamaHost\([\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const normalizeOllamaHost = Function(`return (${source})`)();
    expect(normalizeOllamaHost("http://127.0.0.1:11435")).toBe("http://127.0.0.1:11435");
    expect(normalizeOllamaHost("127.0.0.1:11435")).toBe("http://127.0.0.1:11435");
    expect(normalizeOllamaHost("http://user:secret@127.0.0.1:11435")).toBe("");
    expect(normalizeOllamaHost("")).toBe("");
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
    expect(view).toContain("up.u.usageStatusText");
    expect(view).toContain("color: Util.alpha(up.tone, 0.07)");
    expect(view).toContain("border.color: Util.alpha(up.tone, 0.28)");
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
    // The desk can also be handed a live stream URL, which is a video no
    // matter what the wallpaper file is. The overlay has no stream of its
    // own, so it still asks the path and only the path.
    expect(wallpaper).toContain("readonly property bool videoBackground: root.streaming || root.isVideo(root.background)");
    expect(overlay).toContain("readonly property bool videoBackground: root.isVideo(root.background)");
    for (const source of [wallpaper, overlay]) {
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
    // Silence used to be hardcoded here. It moved to the host when the desk
    // gained a sound switch, so the guarantee is now asserted per surface
    // below rather than in the shared player.
    expect(player).not.toContain("audioEnabled: true");
    for (const source of [wallpaper, overlay]) {
      expect(source).toContain('source: "BackgroundWallpaper.qml"');
      expect(source).not.toContain("BackgroundMedia {");
    }
  });

  test("a wallpaper only makes sound where a switch says so", () => {
    // BackgroundMedia lives in Omarchy, not here, so its default for
    // audioEnabled is not observable from this repo. Neither surface may rely
    // on it. The desk binds the user's switch and gives the sound track to one
    // output; the overlay has no switch and must say false out loud.
    expect(wallpaper).toContain('property: "audioEnabled"');
    expect(wallpaper).toContain("value: dashboardSettings.videoAudio && panel.firstScreen && !panel.fullscreenHere");
    expect(overlay).toContain('property: "audioEnabled"');
    expect(overlay).toContain("value: false");
  });

  test("nothing decodes while nothing can see it", () => {
    // Qt's FFmpeg engine drives its own clock, so a covered wallpaper keeps
    // decoding until it is told to stop.
    expect(wallpaper).toContain("readonly property bool fullscreenHere: visibleWorkspace ? visibleWorkspace.hasFullscreen : false");
    expect(wallpaper).toContain("value: root.playbackWanted && !panel.fullscreenHere");
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

describe("module strip spacing matches the rest of the desk", () => {
  test("the gap under the chip row is view.gap, not the tighter chip-to-chip sm", () => {
    const start = view.indexOf("id: moduleStrip");
    const column = view.lastIndexOf("ColumnLayout {", start);
    const beforeFlow = view.slice(column, view.lastIndexOf("Flow {", start));
    expect(beforeFlow).toContain("spacing: view.gap");
    expect(beforeFlow).not.toContain("spacing: Style.spacing.sm");
    const flow = view.slice(view.lastIndexOf("Flow {", start), view.indexOf("Repeater {", start));
    expect(flow).toContain("spacing: Style.spacing.sm");
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

  test("a busy desk shrinks its session cards instead of burying everything below them", () => {
    // 25 sessions at six columns was five rows of eight-line cards — the whole
    // screen, with no ACTIVITY, RECENT TASKS or ops cards under it.
    expect(view).toContain("readonly property bool dense: view.displaySessions.length > 8");

    // Columns bound the number of ROWS, because rows are what push the desk off.
    const columns = view.match(/readonly property int targetColumns: dense[\s\S]*?\n              : [^\n]*/)?.[0];
    expect(columns).toBeTruthy();
    expect(columns).toContain("Math.ceil(view.displaySessions.length / 4)");

    const density = (n: number) => Math.max(6, Math.min(8, Math.ceil(n / 4)));
    // Measured on a real desk: left column 1327, card padding 13, gap 11.
    const rows = (n: number) => {
      const cols = density(n);
      const fitted = (1301 - 11 * (cols - 1)) / cols;
      const width = Math.max(112 * 1.3333, fitted);
      return Math.ceil(n / Math.floor((1301 + 11) / (width + 11)));
    };
    for (const n of [9, 12, 20, 25, 32]) expect(rows(n), `${n} sessions`).toBeLessThanOrEqual(4);

    // The minimum is multiplied by fontScale. A dense minimum of 138 came out
    // at 184 on a 1.33 desk, wider than the fitted width, so Flow fell back to
    // six per row and the extra columns bought nothing at all.
    expect(view).toContain("dense ? 112 :");
    expect(Math.max(112 * 1.3333, (1301 - 11 * 6) / 7)).toBeCloseTo((1301 - 11 * 6) / 7, 5);

    // A dense card drops what a glance does not need; the inspector keeps it.
    expect(view).toContain("maximumLineCount: sessionFlow.dense ? 1 : 2");
    expect((view.match(/visible: !sessionFlow\.dense && \(/g) || []).length).toBe(4);
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

describe("a project filter never makes the desk misreport the machine", () => {
  // Reported from two surfaces side by side: the wallpaper desk said
  // "1 running" while the overlay said "24 running". The filter is per-view by
  // design — the overlay is the unfiltered picture — but the desk was counting
  // its own filtered subset and presenting it as the machine's state.
  test("the header reports the real total and names the filter hiding the rest", () => {
    expect(view).toContain('" of " + view.allSessions.length + " running · filtered by "');
    // The unfiltered wording must stay exactly as it was.
    expect(view).toContain('view.sessions.length + " running"');
  });

  test("an empty list caused by a filter does not tell you to go start something", () => {
    // The advice has to match the reason. "go start something" while two dozen
    // agents run is worse than no message at all.
    const emptyState = view.match(/text: view\.desk\.bunChecked[\s\S]*?"collecting…"/)?.[0] || "";
    expect(emptyState).toContain("view.projectFilter && view.allSessions.length > 0");
    expect(emptyState).toContain("running elsewhere");
    // The filter branch must be tested BEFORE the ready branch, or the old
    // message wins and the fix is dead code.
    expect(emptyState.indexOf("view.projectFilter"))
      .toBeLessThan(emptyState.indexOf("no agents running"));
  });
});

describe("session card lines never spill into the neighbouring card", () => {
  const view = readFileSync(join(import.meta.dir, "InfoView.qml"), "utf8");
  const start = view.indexOf("hosted in \" + view.sessionHostLabel(sc.modelData)");
  // Anchored on `id: sc`: the grouped-roster list nests a second
  // `delegate: Rectangle {` inside this one, and a bare search finds that.
  const card = view.slice(view.lastIndexOf("delegate: Rectangle {\n                id: sc", start), view.indexOf("\n                MouseArea {", start));
  const block = view.slice(view.lastIndexOf("ColumnLayout", start), view.indexOf("\n                }", start));
  const tag = view.slice(view.indexOf("component Tag: Rectangle"), view.indexOf("component PowerToggle"));
  const stale = card.slice(card.indexOf("sc.modelData.stale === true"), card.indexOf("Item { Layout.fillWidth: true; Layout.minimumWidth: 0 }"));
  const topicMark = block.indexOf('sc.modelData.topic ? "↳ "');
  const topic = block.slice(block.lastIndexOf("PlainText {", topicMark), block.indexOf("maximumLineCount", topicMark));

  test("every fill-width single-line text in a session card elides", () => {
    // The merged pid/cpu line had no elide: the taller first card's line ran under its
    // neighbour's git line ("git mainc·uclean · ram 360M"). Fill-width, one line ⇒ elide.
    const lines = block.split("\n").filter(l => l.includes("PlainText {") && l.includes("Layout.fillWidth: true") && !l.includes("wrapMode"));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines)
      expect(line).toMatch(/elide: Text\.Elide(Right|Middle|Left)/);
  });

  test("fill-width session text can shrink below the unelided string", () => {
    // elide is a no-op until the layout may assign a width smaller than implicitWidth.
    // A STALE card's topic/git/pid then painted into the next card.
    const lines = block.split("\n").filter(l => l.includes("PlainText {") && l.includes("Layout.fillWidth: true"));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines)
      expect(line).toMatch(/Layout\.minimumWidth: 0/);
    expect(topic).toContain("Layout.minimumWidth: 0");
    expect(topic).toContain("wrapMode: Text.Wrap");
  });

  test("the STALE chip shares leftover header space and the Tag elides when squeezed", () => {
    expect(stale).toContain("Layout.fillWidth: true");
    expect(stale).toContain("Layout.minimumWidth: 0");
    expect(stale).toContain("Layout.maximumWidth: implicitWidth");
    expect(tag).toContain("clip: true");
    expect(tag).toContain("elide: Text.ElideRight");
    expect(card).toMatch(/clip: true/);
  });
});

describe("recent tasks keep quieter providers", () => {
  test("the default 80-row window still includes OpenCode and Pi when Claude dominates", () => {
    const source = view.match(/function fairRecentWindow\([\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const fairRecentWindow = Function(`return (${source})`)();
    const rows = [];
    for (let i = 0; i < 90; i++) rows.push({ provider: "claude", ts: 1000 - i, session: "c" + i, text: "c" + i });
    rows.push({ provider: "opencode", ts: 10, session: "o1", text: "oc" });
    rows.push({ provider: "pi", ts: 9, session: "p1", text: "pi" });
    const mixed = fairRecentWindow(rows, 80, 6);
    expect(mixed.some((row: any) => row.provider === "opencode")).toBe(true);
    expect(mixed.some((row: any) => row.provider === "pi")).toBe(true);
    expect(mixed).toHaveLength(80);
    expect(mixed.map((row: any) => row.ts)).toEqual(mixed.map((row: any) => row.ts).sort((a: number, b: number) => b - a));
  });

  test("provider reservations preserve pinned-first ordering even below the row limit", () => {
    const source = view.match(/function fairRecentWindow\([\s\S]*?\n  \}/)?.[0];
    const fairRecentWindow = Function(`return (${source})`)();
    const pinned = { provider: "pi", ts: 1, session: "pin", text: "pinned old prompt" };
    const recent = Array.from({ length: 10 }, (_, i) => ({ provider: "claude", ts: 100 - i, session: "c" + i, text: "c" + i }));
    const quiet = { provider: "opencode", ts: 2, session: "o", text: "older quiet prompt" };
    const rows = [pinned, ...recent, quiet];
    expect(fairRecentWindow(rows, 80, 6)).toEqual(rows);
    // Selection may drop rows, but must preserve the input's relative order.
    const limited = fairRecentWindow(rows, 8, 2);
    expect(limited[0]).toBe(pinned);
    expect(limited).toContain(quiet);
    expect(limited).toHaveLength(8);
    const positions = limited.map((row: any) => rows.indexOf(row));
    expect(positions).toEqual(positions.slice().sort((a: number, b: number) => a - b));
    expect(fairRecentWindow([...rows, quiet], 80, 6)).toEqual(rows);
  });
});

describe("github activity heatmap", () => {
  test("registers GITHUB as a removable module beside ACTIVITY and reaches it from the keyboard", () => {
    const ids = [...settings.matchAll(/\{ id: "([a-zA-Z]+)", label: "[^"]+" \}/g)].map(match => match[1]);
    expect(ids.indexOf("github")).toBe(ids.indexOf("activity") + 1);
    expect(ids).toHaveLength(12);
    expect(ids[11]).toBe("gitea");
    expect(ids[10]).toBe("media");
    expect(overlay).toContain("event.key >= Qt.Key_0 && event.key <= Qt.Key_9");
    expect(overlay).toContain("event.key === Qt.Key_0 ? 9 : event.key - Qt.Key_1");
    // Key n toggles definitions[n-1]; 0 is the tenth. Documented as 4 = GITHUB, 0 = PROJECTS.
    expect(ids[3]).toBe("github");
    expect(ids[9]).toBe("projects");
  });

  test("shares one HeatPanel across equally sized activity, GitHub and Gitea cards", () => {
    expect(view).toContain("component HeatPanel: Item");
    expect(view.match(/HeatPanel \{/g)).toHaveLength(3);
    expect(view).toContain('title: "GITEA · LAST 7 DAYS"');
    expect(view).toContain("cells: view.gitea.cells || []");
    expect(view).toContain("onCellClicked: function(index) { view.toggleGiteaCell(index) }");
    expect(view).toContain('title: "ACTIVITY · LAST 7 DAYS"');
    expect(view).toContain('title: "GITHUB · LAST 7 DAYS"');
    expect(view).toContain('visible: view.sectionEnabled("activity") || view.sectionEnabled("github") || view.sectionEnabled("gitea")');
    // Both cards ask for an equal share; neither may impose a minimum that pushes the other off screen.
    expect(view.match(/Layout\.preferredWidth: 1\n\s+Layout\.minimumWidth: 0\n\s+visible: view\.sectionEnabled\("(activity|github|gitea)"\)/g)).toHaveLength(3);
    expect(view).toContain("cells: view.github.cells || []");
    expect(view).toContain("kindFiltersCells: true");
    expect(view).toContain("showRepos: true");
    expect(view).toContain('kinds: ["claude", "codex", "grok", "hermes", "opencode", "pi", "cursor", "gemini", "ollama"]');
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


test("persisted Ollama origins reject credentials and request paths", () => {
  const source = settings.match(/function normalizeOllamaHost\([\s\S]*?\n  \}/)?.[0];
  const normalize = Function(`return (${source})`)();
  expect(normalize("127.0.0.1:11435")).toBe("http://127.0.0.1:11435");
  expect(normalize("https://ollama.example/")).toBe("https://ollama.example");
  expect(normalize("http://[::1]:11434")).toBe("http://[::1]:11434");
  for (const invalid of ["http://u:password@host", "http://host/api", "http://host?q=x", "http://host#x", "http://host:65536"]) expect(normalize(invalid)).toBe("");
});

describe("media controls card", () => {
  test("registers a reorderable lower-right MPRIS card with prev/play/next and a title line", () => {
    expect(settings).toContain('{ id: "media", label: "MEDIA" }');
    expect(settings).toContain('property var rightOrder: ["usage", "localAi", "machine", "media"]');
    expect(view).toContain('title: "MEDIA CONTROLS"');
    expect(view).toContain('moveId: "media"');
    expect(view).toContain("import Quickshell.Services.Mpris");
    expect(view).toContain('text: "PREV"');
    expect(view).toContain('text: mediaCard.playing ? "PAUSE" : "PLAY"');
    expect(view).toContain('text: "NEXT"');
    expect(view).toContain('onClicked: mediaCard.run("previous")');
    expect(view).toContain('onClicked: mediaCard.run("playPause")');
    expect(view).toContain('onClicked: mediaCard.run("next")');
    expect(view).toContain("mediaCard.displayTitle");
    expect(view).toContain("readonly property string displayTitle: rawTitle || (player || demo ? \"no title\" : \"no media player\")");
    expect(view).not.toContain("trackArtUrl");
    const mediaBlock = view.slice(view.indexOf('id: mediaCard'), view.indexOf("Legend"));
    expect(mediaBlock).not.toContain("Image {");
    expect(mediaBlock).not.toContain("privacyMode");
  });
});


test("media selection prefers playback and skips playerctld when another player exists", () => {
  const proxySource = view.match(/function mediaIsProxy\([\s\S]*?\n  \}/)?.[0];
  const mediaIsProxy = Function(`return (${proxySource})`)();
  const body = view.match(/readonly property var mediaPlayer: \{([\s\S]*?)\n  \}/)?.[1];
  const choose = Function("view", body || "");
  const proxy = { dbusName: "org.mpris.MediaPlayer2.playerctld", isPlaying: true };
  const paused = { dbusName: "org.mpris.MediaPlayer2.test", isPlaying: false };
  const playing = { dbusName: "org.mpris.MediaPlayer2.music", isPlaying: true };
  expect(choose({ mprisPlayers: [proxy, paused, playing], mediaIsProxy })).toBe(playing);
  expect(choose({ mprisPlayers: [proxy, paused], mediaIsProxy })).toBe(paused);
  expect(choose({ mprisPlayers: [proxy], mediaIsProxy })).toBe(proxy);
  expect(choose({ mprisPlayers: [], mediaIsProxy })).toBeNull();
});

// Grok Bot runs one Electron process and the collector expands its roster into
// one card per bot, so a nine-bot roster is nine cards and, on its own, trips
// the dense-layout threshold and shrinks every other card on the desk. The desk
// groups the quiet ones back into a single card, per provider and optionally.
describe("quiet sessions group into one card per provider", () => {
  const qml = (() => {
    const names = ["sessionActivityAt", "sessionIsQuiet", "sessionGroupRow", "groupQuietSessions"];
    const sources = names.map(name => {
      const source = view.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
      expect(source, `${name} is missing from InfoView.qml`).toBeTruthy();
      return source;
    });
    // Evaluated together: they call each other by bare name in QML, so they
    // have to share one scope here too.
    return Function(`${sources.join("\n")}\nreturn { sessionActivityAt, sessionIsQuiet, sessionGroupRow, groupQuietSessions }`)();
  })();

  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;
  const GROUPED = { "grok-bot": true };
  const bot = (project: string, agoMs: number, extra: Record<string, unknown> = {}) => ({
    provider: "grok-bot", name: "Grok Bot", project, pid: 4242,
    topicAt: NOW - agoMs, resources: { cpuPct: null, rss: null }, ...extra,
  });
  const claude = (project: string, agoMs: number) => ({
    provider: "claude", name: "claude", project, pid: 900 + agoMs, topicAt: NOW - agoMs,
  });
  const group = (rows: any[]) => qml.groupQuietSessions(rows, GROUPED, HOUR, 2, NOW);

  test("groups a provider's quiet sessions into one row after that provider's cards", () => {
    const rows = [claude("api", 0), bot("news", 4 * HOUR), bot("recipes", 9 * HOUR), claude("web", 0)];
    const grouped = group(rows);
    expect(grouped.length).toBe(3);
    // A group is taller than its neighbours and a Flow row is as tall as its
    // tallest card, so every group goes at the very end: the live cards stay
    // one uniform grid and the only overhang is at the bottom edge.
    expect(grouped[0]).toBe(rows[0]);
    expect(grouped[1]).toBe(rows[3]);
    expect(grouped[2].grouped).toBe(true);
    expect(grouped[2].provider).toBe("grok-bot");
    expect(grouped[2].members.map((m: any) => m.project)).toEqual(["news", "recipes"]);
    expect(grouped[2].project).toBe("2 quiet");
  });

  test("the group lands after the provider's loud cards, never in front of them", () => {
    const rows = [
      bot("news", 9 * HOUR),
      bot("asking", 9 * HOUR, { attention: "waiting" }),
      bot("recipes", 9 * HOUR),
      bot("broken", 9 * HOUR, { attention: "blocked" }),
      claude("api", 0),
    ];
    const grouped = group(rows);
    expect(grouped.map((r: any) => r.grouped === true ? "GROUP" : r.project))
      .toEqual(["asking", "broken", "api", "GROUP"]);
  });

  test("two grouped providers keep first-appearance order at the end", () => {
    const rows = [
      claude("api", 9 * HOUR), bot("news", 9 * HOUR), claude("web", 9 * HOUR),
      bot("recipes", 9 * HOUR), bot("live", 1000),
    ];
    const grouped = qml.groupQuietSessions(rows, { "grok-bot": true, claude: true }, HOUR, 2, NOW);
    expect(grouped.map((r: any) => r.grouped === true ? `GROUP:${r.provider}` : r.project))
      .toEqual(["live", "GROUP:claude", "GROUP:grok-bot"]);
  });

  test("a request never groups, however old; a stale notification does", () => {
    // attentionSignal has three states and they are not the same kind of thing.
    // "waiting" (blocked on your answer) and "blocked" (conflict, crash,
    // failure) are requests, and a request does not expire. "done" — ready for
    // review, or a bot holding unread replies — is a notification, and one
    // nobody has looked at for a month has stopped being news.
    const rows = [
      bot("news", 9 * HOUR),
      bot("asking", 400 * HOUR, { attention: "waiting", attentionReason: "asking is waiting for your answer" }),
      bot("broken", 400 * HOUR, { attention: "blocked" }),
      bot("stale-unread", 400 * HOUR, { attention: "done" }),
      bot("fresh-unread", 60_000, { attention: "done" }),
      bot("working", 400 * HOUR, { busy: true }),
      bot("recipes", 9 * HOUR),
    ];
    const grouped = group(rows);
    expect(grouped.map((row: any) => row.grouped === true ? "GROUP" : row.project))
      .toEqual(["asking", "broken", "fresh-unread", "working", "GROUP"]);
    expect(grouped[4].members.map((m: any) => m.project)).toEqual(["news", "stale-unread", "recipes"]);
    // Grouped-but-unseen is counted so the card can say so rather than hide it.
    expect(grouped[4].review).toBe(1);
  });

  test("a recently active session keeps its own card", () => {
    const rows = [bot("news", 9 * HOUR), bot("live", 2 * 60_000), bot("recipes", 9 * HOUR)];
    const grouped = group(rows);
    expect(grouped.length).toBe(2);
    expect(grouped[0].project).toBe("live");
    expect(grouped[1].members.map((m: any) => m.project)).toEqual(["news", "recipes"]);
  });

  test("grouping one card into one card is refused", () => {
    const rows = [bot("news", 9 * HOUR), bot("live", 60_000)];
    expect(group(rows)).toEqual(rows);
    // ...and the floor cannot be argued below two.
    expect(qml.groupQuietSessions(rows, GROUPED, HOUR, 1, NOW)).toEqual(rows);
    expect(qml.groupQuietSessions(rows, GROUPED, HOUR, 0, NOW)).toEqual(rows);
  });

  test("a provider with grouping off is passed through untouched", () => {
    const rows = [bot("news", 9 * HOUR), bot("recipes", 9 * HOUR), bot("chat", 9 * HOUR)];
    expect(qml.groupQuietSessions(rows, { "grok-bot": false }, HOUR, 2, NOW)).toEqual(rows);
    expect(qml.groupQuietSessions(rows, {}, HOUR, 2, NOW)).toEqual(rows);
    // Enabling one provider never groups another.
    const mixed = [claude("api", 9 * HOUR), claude("web", 9 * HOUR), ...rows];
    const grouped = qml.groupQuietSessions(mixed, GROUPED, HOUR, 2, NOW);
    expect(grouped.slice(0, 2)).toEqual([mixed[0], mixed[1]]);
    expect(grouped[2].grouped).toBe(true);
    expect(grouped.length).toBe(3);
  });

  test("a zero window groups every idle session whatever its age", () => {
    const rows = [bot("news", 1000), bot("recipes", 2000), bot("asking", 1000, { attention: "waiting" })];
    const grouped = qml.groupQuietSessions(rows, GROUPED, 0, 2, NOW);
    expect(grouped.length).toBe(2);
    expect(grouped[0].project).toBe("asking");
    expect(grouped[1].members.map((m: any) => m.project)).toEqual(["news", "recipes"]);
  });

  test("the group reports the app's real cost once instead of once per member", () => {
    const idle = bot("news", 9 * HOUR);
    const owner = bot("recipes", 4 * HOUR, {
      resources: { cpuPct: 12.5, rss: 900, processes: 14 },
      window: { address: "0xabc", title: "Grok Bot", workspace: 3 },
      uptimeSec: 7200, session: "bot-recipes",
    });
    const row = group([idle, owner])[0];
    // attachGrokBotRoster gives the real counters to exactly one bot and nulls
    // the rest, so the group has to pick that one rather than members[0].
    expect(row.resources.cpuPct).toBe(12.5);
    expect(row.window.address).toBe("0xabc");
    expect(row.uptimeSec).toBe(7200);
    expect(row.owner).toBe(owner);
    // A group is not a repo, a git branch or something to resume.
    expect(row.cwd).toBe("");
    expect(row.git).toBeNull();
    expect(row.sessionIds).toEqual([]);
    // And it never carries an attention state of its own — those stay as cards.
    expect(row.attention).toBe("");
    // topicAt is the freshest member, so the card ages from real activity.
    expect(row.topicAt).toBe(NOW - 4 * HOUR);
    // The pid line tests every counter against null, so a member with no
    // resources at all must still produce a shaped object, not a bare one.
    const bare = qml.sessionGroupRow("grok-bot", [{ project: "a" }, { project: "b" }]);
    expect(bare.resources).toEqual({ cpuPct: null, rss: null, processes: null, gpuMemory: null });
    expect(bare.uptimeSec).toBe(0);
  });

  test("activity falls back through topicAt, idleSince then startedAt", () => {
    expect(qml.sessionActivityAt({ topicAt: 3, idleSince: 2, startedAt: 1 })).toBe(3);
    expect(qml.sessionActivityAt({ idleSince: 2, startedAt: 1 })).toBe(2);
    expect(qml.sessionActivityAt({ startedAt: 1 })).toBe(1);
    expect(qml.sessionActivityAt(null)).toBe(0);
    // No timestamp at all reads as long-idle, not brand new.
    expect(qml.sessionIsQuiet({ provider: "grok-bot" }, HOUR, NOW)).toBe(true);
  });

  test("non-array input cannot crash the session card", () => {
    expect(qml.groupQuietSessions(null, GROUPED, HOUR, 2, NOW)).toEqual([]);
    expect(qml.groupQuietSessions(undefined, GROUPED, HOUR, 2, NOW)).toEqual([]);
    expect(qml.groupQuietSessions([bot("a", HOUR), bot("b", HOUR)], null, HOUR, 2, NOW).length).toBe(2);
  });

  test("grouping is per provider and defaults on only for the roster app", () => {
    const source = settings.match(/function sessionGroupEnabled\([\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const enabled = (sessionGroups: Record<string, unknown>) =>
      Function("sessionGroups", "sessionGroupDefaults", `${source}\nreturn sessionGroupEnabled`)(
        sessionGroups, { "grok-bot": true });
    expect(enabled({})("grok-bot")).toBe(true);
    expect(enabled({})("claude")).toBe(false);
    expect(enabled({})("")).toBe(false);
    expect(enabled({ "grok-bot": false })("grok-bot")).toBe(false);
    expect(enabled({ claude: true })("claude")).toBe(true);
    expect(enabled({ "grok-bot": "yes" })("grok-bot")).toBe(true);
    expect(settings).toContain('readonly property var sessionGroupDefaults: ({ "grok-bot": true })');
    expect(settings).toContain("property int sessionQuietMinutes: 60");
    expect(settings).toContain("sessionGroups: sessionGroups,");
    expect(settings).toContain("sessionQuietMinutes: sessionQuietMinutes,");
    expect(settings).toContain("function toggleSessionGroup(provider)");
  });

  test("a provider key is validated before it is written to dashboard.json", () => {
    const source = settings.match(/function setSessionGroup\([\s\S]*?\n  \}/)?.[0];
    expect(source).toBeTruthy();
    const state = { sessionGroups: {} as Record<string, boolean>, persists: 0 };
    const set = Function("state", "persist", `
      var sessionGroups = state.sessionGroups
      ${source}
      return function(provider, enabled) {
        var result = setSessionGroup(provider, enabled)
        state.sessionGroups = sessionGroups
        return result
      }`)(state, () => { state.persists++; });
    expect(set("grok-bot", false)).toBe(true);
    expect(state.sessionGroups).toEqual({ "grok-bot": false });
    expect(state.persists).toBe(1);
    expect(set("GROK-BOT", true)).toBe(true);
    expect(state.sessionGroups).toEqual({ "grok-bot": true });
    for (const bad of ["", "has space", "x".repeat(33), "semi;colon", "../etc"]) {
      expect(set(bad, true)).toBe(false);
    }
    expect(state.persists).toBe(2);
  });

  test("the desk draws, measures and navigates the grouped list, not the raw one", () => {
    // Drawing the group while sizing from the ungrouped count would leave the
    // desk dense for cards it no longer draws — which is the whole problem.
    expect(view).toContain("model: view.displaySessions");
    expect(view).toContain("readonly property bool dense: view.displaySessions.length > 8");
    expect(view).toContain("Math.ceil(view.displaySessions.length / 4)");
    expect(view).toContain("Math.max(4, Math.min(6, view.displaySessions.length))");
    expect(view).toContain("dense ? 112 : view.displaySessions.length > 4 ? 150 : 210");
    // The delegate rings the card whose index matches, so J/K has to walk the
    // same list the Repeater does or the ring lands on the wrong card.
    expect(view).toContain("keyboardSessionIndex = (keyboardSessionIndex + Number(delta) + displaySessions.length) % displaySessions.length");
    expect(view).toContain("var session = displaySessions[keyboardSessionIndex]");
    expect(view).not.toContain("model: view.sessions\n");
  });

  test("the group is announced, reversible and never silently under-reports", () => {
    // SESSIONS still counts every running agent; the group is stated separately.
    expect(view).toContain('view.sessions.length + " running"');
    expect(view).toContain('view.groupedSessionCount ? " · " + view.groupedSessionCount + " quiet grouped"');
    // The toggle lives on the card, not in the module strip. That strip lists
    // the panes below it, so a per-provider display rule does not belong there
    // — and it must stay untouched, SectionChip included.
    const strip = view.slice(view.indexOf("id: moduleStrip"), view.indexOf("RowLayout {", view.indexOf("id: moduleStrip")));
    expect(strip).not.toContain("SessionGroup");
    expect(strip).not.toContain("toggleSessionGroup");
    expect(strip).not.toContain("groupableProviders");
    const chipStart = view.indexOf("component SectionChip");
    const chip = view.slice(chipStart, view.indexOf("\n  component ", chipStart + 1));
    expect(chip).toContain("required property var section");
    expect(chip).toContain('text: (parent.selected ? "● " : "○ ") + parent.section.label');
    expect(chip).toContain("onClicked: view.settings.toggleSection(parent.section.id)");
    expect(chip).not.toContain("signal toggled()");

    // Grouping is a property of a provider, and the provider is named on every
    // one of its cards — including the group itself, so there is a way back.
    expect(view).toContain("function sessionGroupToggleable(provider)");
    expect(view).toContain("readonly property bool toggles: view.sessionGroupToggleable(sc.modelData.provider)");
    expect(view).toContain("view.settings.toggleSessionGroup(sc.modelData.provider)");
    expect(view).toContain("font.underline: providerToggle.toggles && groupToggle.containsMouse");
    expect(view).toContain('" · ▴▾ next to an agent name groups it"');
    // The caret is WHAT CHANGED's own disclosure glyph, not a new icon
    // language, and it means the same thing in both places: ▴ while the rows
    // are spread out, ▾ once they are collapsed.
    expect(view).toContain('text: changeRow.expanded ? "▴" : "▾"');
    expect(view).toContain('text: providerToggle.grouped ? "▾" : "▴"');
    const caret = view.slice(view.indexOf("id: providerToggle"), view.indexOf("id: groupToggle"));
    expect(caret).toContain("visible: providerToggle.toggles");
    expect(caret).toContain("color: groupToggle.containsMouse ? sc.tone : view.textFaint");
    expect(caret).toContain("font.pixelSize: Style.font.caption");
    // The card's own MouseArea is declared after this column, so without the
    // lift it sits on top and swallows every click inside the card.
    const cardStart = view.lastIndexOf("delegate: Rectangle {\n                id: sc");
    const column = view.slice(view.indexOf("id: scol", cardStart), view.indexOf("MouseArea {\n                  id: hover", cardStart));
    expect(column).toContain("z: 1");
    expect(view.indexOf("id: scol", cardStart)).toBeLessThan(view.indexOf("id: hover", cardStart));

    // The counts stay in the SESSIONS hint, in both states.
    expect(view).toContain('view.quietSessionCount + " quiet"');
    // The grouped roster stays readable and clickable, one line per member.
    expect(view).toContain("model: sc.grouped ? sc.members.slice(0, sc.memberLimit) : []");
    expect(view).toContain("view.inspectedSession = memberRow.modelData");
    // A member row's own MouseArea only ever fires because of the z lift above.
    expect(view).toContain("id: memberHover");
    // Grouped-but-unseen is stated on the card, in the slot the group's own
    // uptime (the host app's, shared by every member) would have wasted.
    expect(view).toContain('text: review ? sc.modelData.review + " to review" : view.desk.dur(sc.modelData.uptimeSec)');
    expect(view).toContain('text: "+ " + (sc.members.length - sc.memberLimit) + " more"');
    // A cap that hides exactly one member costs the same row it saves.
    const limit = Function("dense", "members", view.match(/readonly property int memberLimit: \{([\s\S]*?)\n                \}/)?.[1]
      ?.replace(/sessionFlow\.dense/g, "dense").replace(/sc\.members/g, "members") || "");
    expect(limit(true, { length: 2 })).toBe(2);
    expect(limit(true, { length: 3 })).toBe(3);
    expect(limit(true, { length: 8 })).toBe(2);
    expect(limit(false, { length: 5 })).toBe(5);
    expect(limit(false, { length: 10 })).toBe(4);
  });

  test("a provider needs two quiet sessions before the caret appears", () => {
    // A QML property body reads the root's own properties unqualified, so the
    // free names are bound as parameters here.
    const countsBody = view.match(/readonly property var quietProviderCounts: \{([\s\S]*?)\n  \}/)?.[1];
    const providersBody = view.match(/readonly property var groupableProviders: \{([\s\S]*?)\n  \}/)?.[1];
    expect(countsBody).toBeTruthy();
    expect(providersBody).toBeTruthy();
    const counts = Function("sessions", "snap", "sessionQuietMs", "sessionIsQuiet", countsBody || "");
    const providers = Function("quietProviderCounts", providersBody || "");
    const rows = [bot("news", 9 * HOUR), bot("recipes", 9 * HOUR), claude("api", 9 * HOUR), bot("live", 1000)];
    const tally = counts(rows, { ts: NOW }, HOUR, qml.sessionIsQuiet);
    expect(tally).toEqual({ "grok-bot": 2, claude: 1 });
    // claude has a quiet session but only one, so it gets no caret.
    expect(providers(tally)).toEqual(["grok-bot"]);
    expect(providers({})).toEqual([]);
  });

});

describe("the session inspector follows the session you opened", () => {
  test("a roster sharing one pid resolves to the right member", () => {
    const body = view.match(/readonly property var liveInspectedSession: \{([\s\S]*?)\n  \}/)?.[1];
    expect(body).toBeTruthy();
    const resolve = Function("inspectedSession", "sessions", body || "");
    const rows = [
      { pid: 42, provider: "grok-bot", session: "a", project: "news" },
      { pid: 42, provider: "grok-bot", session: "b", project: "recipes" },
    ];
    expect(resolve({ pid: 42, provider: "grok-bot", session: "b" }, rows)).toBe(rows[1]);
    // A provider that reports no session id still resolves on pid+provider.
    expect(resolve({ pid: 42, provider: "grok-bot" }, [rows[0]])).toBe(rows[0]);
    expect(resolve({ pid: 7, provider: "claude" }, rows)).toBeNull();
    expect(resolve(null, rows)).toBeNull();
  });
});

describe("hard refresh", () => {
  test("HARD REFRESH is the first module-strip control and forces a collector pass", () => {
    const strip = view.slice(view.indexOf("id: moduleStrip"), view.indexOf("id: leftColumn"));
    expect(strip.indexOf("HARD REFRESH")).toBeGreaterThan(-1);
    expect(strip.indexOf("HARD REFRESH")).toBeLessThan(strip.indexOf("Repeater {"));
    expect(view).toContain("onClicked: view.desk.hardRefresh()");
    expect(model).toContain("function hardRefresh()");
    expect(model).toContain('cmd.push("--force-refresh")');
    expect(service).toContain("function hardRefresh(): void { infoModel.hardRefresh() }");
    expect(overlay).toContain("function hardRefresh() { infoModel.hardRefresh() }");
  });
});
