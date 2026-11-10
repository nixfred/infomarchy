import QtQuick
import qs.Ui

// Omarchy's ScreenMoveRemap, in a file of its own so that an Omarchy that no
// longer ships it fails only this file's load. RemapGuard.qml reaches it by
// URL. `window` is a plain property here, handed in by the Loader after load,
// because the Omarchy type requires one at creation.
Item {
  id: root

  property var window: null
  readonly property bool remapping: guard.remapping

  ScreenMoveRemap {
    id: guard
    window: root.window
  }
}
