import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

// One data model per view: runs collector.ts on a timer, parses the snapshot,
// and exposes theme colors (ANSI roles from the active Omarchy theme) so the
// dashboard restyles itself on every theme switch.
Item {
  id: root

  property int refreshMs: 4000
  property bool active: true
  property var snap: ({})
  property bool ready: false
  property string error: ""
  // Resolve the script itself so a missing trailing slash on a directory URL
  // cannot produce ".../nixfred.infomarchicollector.ts".
  property string collectorPath: Qt.resolvedUrl("collector.ts").toString().replace(/^file:\/\//, "")
  // Wallpaper and overlay each run a collector; --id keeps their rate
  // baselines apart (see collector.ts prev-${id}.json).
  property string instance: "bg"

  // --- theme ---------------------------------------------------------------
  // Omarchy's Color singleton gives fg/bg/accent/urgent/muted. The ANSI roles
  // (green/yellow/red/blue…) live in the theme's colors.toml; read them here
  // with fallbacks so any theme works even if it omits a key.
  property color green: Color.accent
  property color yellow: Color.foreground
  property color red: Color.urgent
  property color blue: Color.accent
  property color magenta: Color.accent
  property color cyan: Color.accent
  property color themeBackground: Color.background
  property color themeForeground: Color.foreground

  function parseColors(text) {
    var map = {}
    var lines = String(text || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?(#[0-9A-Fa-f]{6,8})"?/)
      if (m) map[m[1].toLowerCase()] = m[2]
    }
    function pick(keys, fallback) {
      for (var k = 0; k < keys.length; k++) if (map[keys[k]]) return map[keys[k]]
      return fallback
    }
    green = pick(["green", "color2"], Color.accent)
    yellow = pick(["yellow", "color3"], Color.foreground)
    red = pick(["red", "color1"], Color.urgent)
    blue = pick(["blue", "color4"], Color.accent)
    magenta = pick(["magenta", "color5"], Color.accent)
    cyan = pick(["cyan", "color6"], Color.accent)
    themeBackground = pick(["background"], Color.background)
    themeForeground = pick(["foreground"], Color.foreground)
  }

  FileView {
    id: colorsFile
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.parseColors(text())
    onFileChanged: reload()
  }
  // The theme dir is a symlink swap; watching the file alone can miss it.
  // Color.* changes when the shell learns about a new theme → re-read.
  Connections {
    target: Color
    function onAccentChanged() { colorsFile.reload() }
    function onBackgroundChanged() { colorsFile.reload() }
    function onForegroundChanged() { colorsFile.reload() }
  }

  function providerColor(p) {
    switch (String(p)) {
      case "claude": return root.yellow
      case "codex": return root.cyan
      case "grok": return root.magenta
      case "gemini": return root.blue
      case "ollama": return root.green
      case "opencode": return root.blue
      case "aider": return root.yellow
      case "copilot": return root.magenta
      default: return Color.accent
    }
  }
  function plainText(value, limit) {
    return String(value || "").slice(0, limit).replace(/[<>&]/g, function(character) {
      return character === "<" ? "‹" : character === ">" ? "›" : "＆"
    }).replace(/[\u0000-\u001f\u007f]/g, " ")
  }
  function providerLabel(p) {
    switch (String(p)) {
      case "claude": return "Claude"
      case "codex": return "Codex"
      case "grok": return "Grok"
      case "gemini": return "Gemini"
      case "ollama": return "Ollama"
      case "opencode": return "opencode"
      case "aider": return "Aider"
      case "copilot": return "Copilot"
      default: return plainText(p, 64)
    }
  }

  // --- collector -----------------------------------------------------------
  Process {
    id: collector
    property string lastStderr: ""
    command: ["bun", root.collectorPath, "--id", root.instance]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var t = String(text || "").trim()
        if (!t) { root.error = "collector produced no output"; return }
        if (t.length > 2 * 1024 * 1024) { root.error = "collector output exceeded 2 MiB"; return }
        try {
          root.snap = JSON.parse(t)
          root.ready = true
          root.error = ""
        } catch (e) {
          root.error = "bad snapshot: " + root.plainText(e, 256)
        }
      }
    }
    stderr: StdioCollector {
      // bun / libraries may warn on stderr even when the snapshot is valid.
      // Stash it; only promote to the desk error banner if the process fails.
      waitForEnd: true
      onStreamFinished: { collector.lastStderr = root.plainText(String(text || "").trim(), 512) }
    }
    onExited: function(exitCode) {
      if (exitCode !== 0 && collector.lastStderr)
        root.error = collector.lastStderr.split("\n")[0]
    }
  }
  function refresh() { if (root.active && !collector.running) collector.running = true }

  Timer {
    interval: root.refreshMs
    running: root.active
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // Focus a Hyprland window by address, on both dispatch syntaxes.
  function focusWindow(address) {
    var addr = String(address || "").replace(/^0x/, "")
    if (!/^[0-9A-Fa-f]{1,32}$/.test(addr)) return
    if (root.snap && root.snap.hyprLua)
      Quickshell.execDetached(["hyprctl", "dispatch", 'hl.dsp.focus({ window = "address:0x' + addr + '" })'])
    else
      Quickshell.execDetached(["hyprctl", "dispatch", "focuswindow", "address:0x" + addr])
  }

  // --- formatting helpers ----------------------------------------------------
  function bytes(n) {
    n = Number(n || 0)
    var u = ["B", "K", "M", "G", "T"], i = 0
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : 1)) + u[i]
  }
  function rate(n) {
    if (n === null || n === undefined) return "—"
    n = Number(n) * 8
    var u = ["b", "Kb", "Mb", "Gb"], i = 0
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++ }
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + u[i] + "/s"
  }
  function dur(sec) {
    sec = Math.max(0, Math.floor(Number(sec || 0)))
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60)
    if (d > 0) return d + "d " + h + "h"
    if (h > 0) return h + "h " + m + "m"
    return m + "m"
  }
  function ago(ts) {
    if (!ts) return ""
    var s = Math.max(0, (Date.now() - Number(ts)) / 1000)
    if (s < 60) return Math.floor(s) + "s"
    if (s < 3600) return Math.floor(s / 60) + "m"
    if (s < 86400) return Math.floor(s / 3600) + "h"
    return Math.floor(s / 86400) + "d"
  }
  function until(ts) {
    if (!ts) return ""
    var s = Math.max(0, (Number(ts) - Date.now()) / 1000)
    if (s < 60) return "now"
    if (s < 3600) return Math.floor(s / 60) + "m"
    if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor(s % 3600 / 60) + "m"
    return Math.floor(s / 86400) + "d " + Math.floor(s % 86400 / 3600) + "h"
  }
  function pct(v) { return (v === null || v === undefined) ? "—" : Math.round(Number(v)) + "%" }
  function tokens(n) {
    n = Number(n || 0)
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B"
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "K"
    return String(n)
  }
}
