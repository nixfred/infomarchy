import QtQuick

// The monitor-move guard, with Omarchy's type behind a Loader by URL.
// Omarchy pulses a layer surface unmapped when its monitor moves (undock),
// as `ScreenMoveRemap` in qs.Ui, because Hyprland 0.56 and older could leave a
// mapped layer at its old global origin. It removed the type for Hyprland
// 0.57, which moves layer surfaces with their monitor (basecamp/omarchy#17229).
// Naming the type in Infomarchy.qml or Overlay.qml would stop the whole plugin
// loading on an Omarchy without it ("ScreenMoveRemap is not a type"), while a
// file reached through a Loader only fails by itself and the guard has nothing
// left to do. Same contract as the Omarchy type: fold it into the window's
// binding as `visible: <shown> && !guard.remapping`.
Item {
  id: root

  required property var window
  // False when the Omarchy type is absent: there is nothing to pulse.
  readonly property bool remapping: loader.item ? loader.item.remapping : false

  visible: false

  Loader {
    id: loader
    source: "OmarchyScreenMoveRemap.qml"
    onLoaded: item.window = root.window
    onStatusChanged: {
      if (status === Loader.Error)
        console.warn("Infomarchy: this Omarchy has no ScreenMoveRemap; running without the monitor-move guard (Hyprland 0.57 moves layers itself)")
    }
  }
}
