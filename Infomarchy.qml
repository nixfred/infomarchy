import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons

// Background-layer host. Replaces omarchy.background (manifest clonedFrom), so
// the theme's wallpaper is still shown — dimmed — behind the live dashboard,
// and `omarchy-theme-bg-set` keeps working through the same IPC target.
Scope {
  id: root

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateHome: Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")
  readonly property string currentBackgroundLink: stateHome + "/omarchy/current/background"
  property string background: ""
  // How much of the wallpaper survives under the glass. 0 = solid theme bg.
  property real wallpaperOpacity: 0.32

  InfoModel { id: infoModel; refreshMs: 4000 }

  function imageUrl(path) { return path ? "file://" + path : "" }
  function refreshBackground() { if (!readlinkProc.running) readlinkProc.running = true }
  function setBackground(path) { root.background = String(path || "") }

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
    function selector(): void { if (!bgSwitchProc.running) bgSwitchProc.running = true }
  }
  IpcHandler {
    target: "infomarchy"
    function refresh(): void { infoModel.refresh() }
    function setWallpaperOpacity(v: string): void { var n = Number(v); if (isFinite(n)) root.wallpaperOpacity = Math.max(0, Math.min(1, n)) }
  }

  Variants {
    model: Quickshell.screens
    PanelWindow {
      id: panel
      required property var modelData
      screen: modelData
      anchors { top: true; bottom: true; left: true; right: true }
      color: infoModel.themeBackground
      WlrLayershell.namespace: "omarchy-background"
      WlrLayershell.layer: WlrLayer.Background
      WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore
      // A parked background layer has been seen to drop its buffer; keep rendering.
      updatesEnabled: true

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
      }
    }
  }
}
