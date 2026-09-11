import QtQuick
import qs.Ui

// Video-capable wallpaper surface, kept in its own file and reached through a
// Loader by URL. `BackgroundMedia` only exists on an Omarchy that has video
// wallpaper support; compiling it into Infomarchy.qml would take the whole
// plugin down on one that does not, while an unloaded file resolves nothing.
// Sound is the host's call, not this file's. Infomarchy replaces the built-in
// background plugin outright — it re-exports the same `background` IPC target,
// so while the desk is running there is no other renderer to hand the sound
// track to, and a hardcoded `false` here makes an audio toggle impossible.
// The host binds `audioEnabled` per output and gives it to the first screen
// only: with one player per monitor, every output would layer its own copy.
BackgroundMedia {
}
