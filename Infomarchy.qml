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
  property bool privacyMode: false
  property bool dashboardVisible: true

  InfoModel { id: infoModel; refreshMs: 4000 }

  function imageUrl(path) { return Util.fileUrl(path) }
  function refreshBackground() { if (!readlinkProc.running) readlinkProc.running = true }
  function setBackground(path) { root.background = String(path || "").trim() }

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
    command: ["bash", "-c", "background=$(omarchy-theme-bg-switcher); [[ -n $background ]] && omarchy-theme-bg-set \"$background\""]
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
    function setPrivacy(v: string): void { root.privacyMode = ["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0 }
    function togglePrivacy(): void { root.privacyMode = !root.privacyMode }
    function setDashboardVisible(v: string): void { root.dashboardVisible = ["1", "true", "on", "yes"].indexOf(String(v).toLowerCase()) >= 0 }
    function toggleDashboard(): void { root.dashboardVisible = !root.dashboardVisible }
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
        opacity: root.wallpaperOpacity
        Behavior on opacity { NumberAnimation { duration: 300 } }
      }

      // Right-click on empty desk = wallpaper switcher, like stock Omarchy.
      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.RightButton
        onClicked: if (!bgSwitchProc.running) bgSwitchProc.running = true
      }

      InfoView {
        anchors.fill: parent
        desk: infoModel
        interactive: true
        privacyMode: root.privacyMode
        visible: root.dashboardVisible
      }
    }
  }
}
