import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// Background-layer host. Replaces omarchy.background (manifest clonedFrom), so
// the theme's wallpaper is still shown — dimmed — behind the live dashboard,
// and `omarchy-theme-bg-set` / `omarchy-theme-set` keep working through the
// same IPC target. Omarchy's theme-set calls `background themeTransition`;
// without that function the wallpaper lags on the 5s symlink poll and the
// snapshot files theme-set deletes after 3s can win the race.
Scope {
  id: root

  // Match omarchy-theme-bg-set and Color.currentThemePath: $HOME/.local/state,
  // not XDG_STATE_HOME, which can point somewhere the CLI never writes.
  readonly property string home: Quickshell.env("HOME")
  readonly property string stateHome: home + "/.local/state"
  readonly property string currentBackgroundLink: stateHome + "/omarchy/current/background"
  property string background: ""
  // How much of the wallpaper survives under the glass. 0 = solid theme bg.
  property real wallpaperOpacity: 0.32
  // Transient sanitized sample data for public screenshots. Never persisted
  // across a login: the flag lives as a marker file under XDG_RUNTIME_DIR so
  // the overlay (a separate Scope with its own InfoModel) sees the same mode,
  // and the file is removed on every shell start.
  property bool demoMode: false
  readonly property string demoMarkerPath: (Quickshell.env("XDG_RUNTIME_DIR") || ("/run/user/" + Quickshell.env("UID"))) + "/infomarchy-demo"
  Process { id: demoMarkerWriter; property var pending: []; command: pending }
  function publishDemoMarker(on) {
    demoMarkerWriter.pending = on ? ["touch", root.demoMarkerPath] : ["rm", "-f", root.demoMarkerPath]
    demoMarkerWriter.running = true
  }
  Component.onCompleted: publishDemoMarker(false)

  // Collecting costs ~20 subprocesses a tick (/proc scan, df, ping, iw, hyprctl,
  // nvidia-smi, git per session, a full opencode.db scan). Do not pay it while
  // SUPER+I has the dashboard hidden.
  // Notifications are dispatched from THIS model's snapshots, so stopping it
  // outright while SUPER+I hides the desk would also silence every "agent
  // needs your answer" toast. Keep collecting at a quarter of the cadence
  // while hidden if alerts are on; stop entirely only when they are off too.
  InfoModel {
    id: infoModel
    refreshMs: dashboardSettings.dashboardVisible ? 4000 : 16000
    demoMode: root.demoMode
    active: dashboardSettings.ready && (dashboardSettings.dashboardVisible || dashboardSettings.notificationsEnabled)
  }
  InfoSettings { id: dashboardSettings }

  function imageUrl(path) { return Util.fileUrl(path) }
  function refreshBackground() { if (!readlinkProc.running) readlinkProc.running = true }
  function setBackground(path) { root.background = String(path || "").trim() }

  function dispatchNotifications() {
    if (root.demoMode || !dashboardSettings.ready || !infoModel.ready) return
    var events = (((infoModel.snap || {}).ai || {}).events || []).slice(0, 64)
    var stamp = Number((infoModel.snap || {}).ts || Date.now())
    for (var i = 0; i < events.length; i++) {
      var event = events[i] || {}, key = String(event.key || "")
      if (!dashboardSettings.claimNotificationEvent(key, stamp)) continue
      if (event.attentionKey && !dashboardSettings.attentionVisible(String(event.attentionKey), stamp)) continue
      if (!dashboardSettings.notificationsAllowed(String(event.provider || ""), stamp)) continue
      var title = infoModel.plainText(event.title || "Infomarchy", 100)
      var body = infoModel.plainText(event.body || "AI session changed", 240)
      var urgency = event.urgency === "normal" ? "normal" : "low"
      Quickshell.execDetached([
        "omarchy-notification-send", "--app-name", "Infomarchy", "-u", urgency, "-t", "8000",
        title, body, "--exec", "omarchy-shell", "shell", "toggle", "nixfred.infomarchy", "{}"
      ])
    }
  }

  Connections {
    target: infoModel
    function onSnapChanged() { root.dispatchNotifications() }
  }
  Connections {
    target: dashboardSettings
    function onReadyChanged() { if (dashboardSettings.ready) root.dispatchNotifications() }
  }

  function applyThemePayload(colorsB64, shellB64) {
    try { Color.loadColors(Util.decodeBase64(colorsB64)) } catch (e) {}
    try { Color.loadShell(Util.decodeBase64(shellB64)) } catch (e2) {}
    Style.scheduleRefresh()
  }

  // theme-set passes a 3s snapshot as `path` and the durable symlink target as
  // `finalPath`. We skip the stock wipe animation, so we must display
  // finalPath — pointing at the snapshot would 404 after the cleanup rm.
  function themeTransition(fromPath, path, finalPath, colorsB64, shellB64) {
    root.setBackground(finalPath || path)
    root.applyThemePayload(colorsB64, shellB64)
  }

  Process {
    id: readlinkProc
    command: ["readlink", "-f", root.currentBackgroundLink]
    stdout: StdioCollector { onStreamFinished: root.setBackground(String(text || "").trim()) }
  }
  Timer { interval: 5000; running: true; repeat: true; triggeredOnStart: true; onTriggered: root.refreshBackground() }

  Process {
    id: bgSwitchProc
    command: ["omarchy-theme-bg-switcher"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var selected = String(text || "").trim()
        if (selected.length > 0 && selected.length <= 4096 && selected.charAt(0) === "/" && !bgSetProc.running) {
          bgSetProc.command = ["omarchy-theme-bg-set", selected]
          bgSetProc.running = true
        }
      }
    }
  }

  Process {
    id: bgSetProc
    onExited: root.refreshBackground()
  }

  // Same contract as the built-in background plugin, so the CLI keeps working.
  IpcHandler {
    target: "background"
    function refresh(): void { root.refreshBackground() }
    function set(path: string): void { root.setBackground(path) }
    function setInstant(path: string): void { root.setBackground(path) }
    function transition(fromPath: string, path: string): void { root.setBackground(path) }
    function themeTransition(fromPath: string, path: string, finalPath: string, colorsB64: string, shellB64: string): void {
      root.themeTransition(fromPath, path, finalPath, colorsB64, shellB64)
    }
    function selector(): void { if (!bgSwitchProc.running) bgSwitchProc.running = true }
  }
  IpcHandler {
    target: "infomarchy"
    function refresh(): void { infoModel.refresh() }
    function setWallpaperOpacity(v: string): void { var n = Number(v); if (isFinite(n)) root.wallpaperOpacity = Math.max(0, Math.min(1, n)) }
    function setDashboardVisible(v: string): void { dashboardSettings.setDashboardVisible(["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0) }
    function toggleDashboard(): void { dashboardSettings.toggleDashboardVisible() }
    function getDashboardVisible(): string { return dashboardSettings.dashboardVisible ? "true" : "false" }
    function setSection(id: string, v: string): void { dashboardSettings.setSection(id, ["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0) }
    function toggleSection(id: string): void { dashboardSettings.toggleSection(id) }
    function setNotifications(v: string): void { dashboardSettings.setNotificationsEnabled(["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0) }
    function toggleNotifications(): void { dashboardSettings.toggleNotificationsEnabled() }
    function setQuietHours(v: string): void { dashboardSettings.setQuietHoursEnabled(["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0) }
    function toggleQuietHours(): void { dashboardSettings.toggleQuietHoursEnabled() }
    function setDemo(v: string): void {
      root.demoMode = ["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0
      root.publishDemoMarker(root.demoMode)
      infoModel.refresh()
    }
    function getDemo(): string { return root.demoMode ? "true" : "false" }
  }

  Variants {
    model: Quickshell.screens
    PanelWindow {
      id: panel
      required property var modelData
      screen: modelData
      // Hyprland leaves a mapped layer at its old global origin when a monitor
      // moves (undock). Pulse unmapped so the compositor re-places us.
      visible: !remapGuard.remapping
      anchors { top: true; bottom: true; left: true; right: true }
      color: infoModel.themeBackground
      WlrLayershell.namespace: "omarchy-background"
      WlrLayershell.layer: WlrLayer.Background
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore
      // A parked background layer has been seen to drop its buffer; keep rendering.
      updatesEnabled: true

      ScreenMoveRemap {
        id: remapGuard
        window: panel
      }

      Image {
        anchors.fill: parent
        source: root.imageUrl(root.background)
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        cache: true
        // Dimming belongs to the dashboard. When SUPER+I hides it, restore the
        // wallpaper to full brightness instead of leaving an invisible shade.
        opacity: dashboardSettings.ready && dashboardSettings.dashboardVisible ? root.wallpaperOpacity : 1.0
        Behavior on opacity { NumberAnimation { duration: 300 } }
      }

      // Empty-desk gestures: left double-click = wallpaper switcher (stock
      // omarchy.background behavior, restored 2026-08-22), right single-click =
      // wallpaper switcher (Infomarchy addition). Stock's right-double-click
      // theme switcher is intentionally not mirrored: it would race the
      // right single-click and open two menus.
      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onClicked: function(mouse) {
          if (mouse.button === Qt.RightButton && !bgSwitchProc.running) bgSwitchProc.running = true
        }
        onDoubleClicked: function(mouse) {
          if (mouse.button === Qt.LeftButton && !bgSwitchProc.running) bgSwitchProc.running = true
          mouse.accepted = true
        }
      }

      InfoView {
        anchors.fill: parent
        desk: infoModel
        settings: dashboardSettings
        interactive: true
        keyboardAvailable: false
        visible: dashboardSettings.ready && dashboardSettings.dashboardVisible
      }
    }
  }
}
