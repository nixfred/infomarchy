import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons

// Summonable fullscreen twin of the desk, for when windows cover the
// wallpaper. Bind e.g. SUPER+D → `omarchy-shell shell toggle nixfred.desk`.
// Esc or a click outside the cards closes it.
Scope {
  id: root
  property bool opened: false

  DeskModel { id: model; refreshMs: 3000; active: root.opened }

  function open(payload) { root.opened = true; model.refresh() }
  function close() { root.opened = false }
  function toggle(payload) { if (root.opened) close(); else open(payload) }

  Variants {
    model: Quickshell.screens
    PanelWindow {
      id: panel
      required property var modelData
      screen: modelData
      visible: root.opened
      anchors { top: true; bottom: true; left: true; right: true }
      color: "transparent"
      WlrLayershell.namespace: "omarchy-desk-overlay"
      WlrLayershell.layer: WlrLayer.Overlay
      WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
      exclusionMode: ExclusionMode.Ignore

      Rectangle {
        anchors.fill: parent
        color: Util.alpha(model.themeBackground, 0.88)
        focus: root.opened
        Keys.onEscapePressed: root.close()
        MouseArea { anchors.fill: parent; onClicked: root.close() }
        DeskView {
          anchors.fill: parent
          model: model
          interactive: true
          topInset: Style.spacing.xl
        }
      }
    }
  }
}
