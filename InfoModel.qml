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
  property string resumePath: Qt.resolvedUrl("resume-session.ts").toString().replace(/^file:\/\//, "")
  property string sessionActionsPath: Qt.resolvedUrl("session-actions.ts").toString().replace(/^file:\/\//, "")
  property string copyTextPath: Qt.resolvedUrl("copy-text.ts").toString().replace(/^file:\/\//, "")
  // Explicit, transient screenshot/demo data. It never persists and defaults
  // off on every shell start; normal operation always displays live data.
  property bool demoMode: false
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
      case "hermes": return root.green
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
      case "hermes": return "Hermes"
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
    property string outputBuffer: ""
    property int outputBytes: 0
    property int stderrBytes: 0
    property bool protocolFailed: false
    property bool frameComplete: false
    readonly property int maxOutputBytes: 2 * 1024 * 1024
    readonly property int maxStderrBytes: 4096
    command: root.demoMode ? ["bun", root.collectorPath, "--id", root.instance, "--demo"] : ["bun", root.collectorPath, "--id", root.instance]

    function fail(message) {
      protocolFailed = true
      outputBuffer = ""
      outputBytes = 0
      root.error = root.plainText(message, 256)
      if (running) running = false
    }
    function acceptStdout(rawLine) {
      if (protocolFailed || frameComplete) return
      var line = String(rawLine || "")
      // Producer frames are 12 KiB; refuse a malformed line before parsing it.
      if (line.length > 65536) { fail("collector frame exceeded 64 KiB"); return }
      var frame
      try { frame = JSON.parse(line) }
      catch (e) { fail("bad collector frame"); return }
      if (!frame || frame.v !== 1) { fail("unsupported collector protocol"); return }
      if (frame.type === "error") { fail(frame.message || "collector failed safely"); return }
      if (frame.type === "chunk" && typeof frame.data === "string") {
        // QString is UTF-16. Counting two bytes per code unit is a hard cap on
        // the shell-side accumulation, independent of collector input.
        var added = frame.data.length * 2
        if (outputBytes + added > maxOutputBytes) { fail("collector output exceeded 2 MiB"); return }
        outputBuffer += frame.data
        outputBytes += added
        return
      }
      if (frame.type !== "end" || Number(frame.chars) !== outputBuffer.length) { fail("incomplete collector snapshot"); return }
      try {
        root.snap = JSON.parse(outputBuffer)
        root.ready = true
        root.error = ""
        frameComplete = true
        outputBuffer = ""
        outputBytes = 0
      } catch (e2) { fail("bad snapshot: " + root.plainText(e2, 160)) }
    }
    function acceptStderr(rawLine) {
      if (stderrBytes >= maxStderrBytes) return
      var line = root.plainText(String(rawLine || ""), 512)
      var added = Math.min(maxStderrBytes - stderrBytes, line.length * 2)
      if (added <= 0) return
      lastStderr += line.slice(0, Math.floor(added / 2))
      stderrBytes += added
    }
    onRunningChanged: if (running) {
      outputBuffer = ""
      outputBytes = 0
      stderrBytes = 0
      lastStderr = ""
      protocolFailed = false
      frameComplete = false
    }
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { collector.acceptStdout(line) }
    }
    stderr: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { collector.acceptStderr(line) }
    }
    onExited: function(exitCode) {
      if (collector.protocolFailed) return
      if (!collector.frameComplete) root.error = collector.lastStderr || (exitCode === 0 ? "collector ended without a complete snapshot" : "collector exited " + exitCode)
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

  function moveWindowToWorkspace(address, workspace) {
    var addr = String(address || "").replace(/^0x/, "")
    var target = Number(workspace)
    if (!/^[0-9a-f]+$/i.test(addr) || !Number.isInteger(target) || target < 1 || target > 99) return false
    if (root.snap && root.snap.hyprLua)
      Quickshell.execDetached(["hyprctl", "dispatch", 'hl.dsp.window.move({ window = "address:0x' + addr + '", workspace = "' + target + '", follow = false })'])
    else
      Quickshell.execDetached(["hyprctl", "dispatch", "movetoworkspacesilent", target + ",address:0x" + addr])
    return true
  }

  function canResume(provider, sessionId) {
    var supported = ["claude", "codex", "grok", "opencode"]
    return supported.indexOf(String(provider || "").toLowerCase()) >= 0 &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(String(sessionId || ""))
  }

  function resumeSession(provider, sessionId, cwd) {
    if (!canResume(provider, sessionId)) return false
    Quickshell.execDetached(["bun", root.resumePath, String(provider), String(sessionId), String(cwd || "")])
    return true
  }

  function canOpenProject(cwd) {
    var path = String(cwd || "")
    return path === "~" || path.indexOf("~/") === 0 || path.indexOf("/") === 0
  }

  function openProject(cwd) {
    if (!canOpenProject(cwd)) return false
    Quickshell.execDetached(["bun", root.sessionActionsPath, String(cwd)])
    return true
  }
  function copyText(text) {
    var value = String(text || "")
    if (!value || value.length > 10000 || clipboardProcess.running) return false
    clipboardProcess.pendingText = value
    clipboardProcess.running = true
    return true
  }

  // Prompt text is framed over stdin so it never appears in /proc/*/cmdline.
  Process {
    id: clipboardProcess
    property string pendingText: ""
    command: ["bun", root.copyTextPath]
    stdinEnabled: true
    onStarted: {
      write(JSON.stringify(pendingText) + "\n")
      pendingText = ""
    }
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
