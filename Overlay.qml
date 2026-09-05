import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// Summonable fullscreen twin of the desk, for when windows cover the
// wallpaper. Bind e.g. SUPER+D → `omarchy-shell shell toggle nixfred.infomarchy`.
// Esc or a click outside the cards closes it.
Scope {
  id: root
  property bool opened: false

  InfoModel { id: infoModel; refreshMs: 3000; active: root.opened; instance: "overlay"; demoMode: demoMarker.present }
  InfoSettings { id: dashboardSettings }
  // Demo mode is set on the wallpaper service; a screenshot taken with the
  // overlay open must not leak live prompts. Mirror the runtime marker.
  FileView {
    id: demoMarker
    property bool present: false
    path: (Quickshell.env("XDG_RUNTIME_DIR") || ("/run/user/" + Quickshell.env("UID"))) + "/infomarchy-demo"
    watchChanges: true
    printErrors: false
    onLoaded: present = true
    onLoadFailed: present = false
    onFileChanged: reload()
  }

  // SUPER+D means "show me the desktop": the real wallpaper, dimmed exactly as
  // the background layer dims it, with the dashboard on top only when SUPER+I
  // has it visible. The old 88% theme-colour scrim hid the wallpaper photo and
  // ignored SUPER+I, so toggling the dashboard while the overlay was open
  // changed the desk underneath without changing what was on screen.
  property string background: ""
  readonly property real wallpaperOpacity: 0.32
  Process {
    id: backgroundLink
    command: ["readlink", "-f", Quickshell.env("HOME") + "/.local/state/omarchy/current/background"]
    stdout: StdioCollector { onStreamFinished: root.background = String(text || "").trim() }
  }
  function open(payload) {
    root.opened = true
    backgroundLink.running = true
    demoMarker.reload()
    infoModel.refresh()
  }
  function close() { root.opened = false }
  function toggle(payload) { if (root.opened) close(); else open(payload) }
  // `omarchy-shell shell call nixfred.infomarchy refresh` hits the overlay
  // loader, not the wallpaper IpcHandler.
  function refresh() { infoModel.refresh() }

  Variants {
    model: Quickshell.screens
    PanelWindow {
      id: panel
      required property var modelData
      screen: modelData
      visible: root.opened && !remapGuard.remapping
      anchors { top: true; bottom: true; left: true; right: true }
      color: "transparent"
      WlrLayershell.namespace: "infomarchy-overlay"
      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore

      ScreenMoveRemap {
        id: remapGuard
        window: panel
      }

      Rectangle {
        id: keyCatcher
        anchors.fill: parent
        color: infoModel.themeBackground
        Image {
          anchors.fill: parent
          source: Util.fileUrl(root.background)
          fillMode: Image.PreserveAspectCrop
          asynchronous: true
          cache: true
          opacity: dashboardSettings.ready && dashboardSettings.dashboardVisible ? root.wallpaperOpacity : 1.0
          Behavior on opacity { NumberAnimation { duration: 300 } }
        }
        focus: root.opened
        Keys.onEscapePressed: root.close()
        Keys.onPressed: function(event) {
          if (event.key >= Qt.Key_1 && event.key <= Qt.Key_9) { var i = event.key - Qt.Key_1; var def = dashboardSettings.definitions[i]; if (def) dashboardSettings.toggleSection(def.id); event.accepted = true; return }
          if (event.key === Qt.Key_J || event.key === Qt.Key_Down) { infoView.keyboardStep(1); event.accepted = true; return }
          if (event.key === Qt.Key_K || event.key === Qt.Key_Up) { infoView.keyboardStep(-1); event.accepted = true; return }
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { infoView.activateKeyboardSession(); event.accepted = true; return }
          if (event.key === Qt.Key_A) { infoView.clearActivityFilter(); event.accepted = true }
        }
        // Exclusive keyboard focus on the layer is not enough — Qt still
        // needs an item with activeFocus or Esc never fires.
        onVisibleChanged: if (visible) Qt.callLater(function() { keyCatcher.forceActiveFocus() })
        MouseArea { anchors.fill: parent; onClicked: root.close() }
        InfoView {
          id: infoView
          anchors.fill: parent
          desk: infoModel
          settings: dashboardSettings
          interactive: true
          topInset: Style.spacing.xl
          // SUPER+I applies here too: hidden dashboard = plain wallpaper, same as the desk.
          visible: dashboardSettings.ready && dashboardSettings.dashboardVisible
          onNavigated: root.close()
        }
      }
    }
  }
}
