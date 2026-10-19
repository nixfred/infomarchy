import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons

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
  property string ollamaControlPath: Qt.resolvedUrl("ollama-control.ts").toString().replace(/^file:\/\//, "")
  property string containerControlPath: Qt.resolvedUrl("container-control.ts").toString().replace(/^file:\/\//, "")
  property string previewPath: Qt.resolvedUrl("window-preview.ts").toString().replace(/^file:\/\//, "")
  property string herdrFocusPath: Qt.resolvedUrl("herdr-focus.ts").toString().replace(/^file:\/\//, "")
  property string orcaFocusPath: Qt.resolvedUrl("orca-focus.ts").toString().replace(/^file:\/\//, "")
  property string stopPath: Qt.resolvedUrl("stop-session.ts").toString().replace(/^file:\/\//, "")
  // Read from manifest.json so the About panel can never drift from the
  // version the plugin actually ships as.
  property string version: ""
  readonly property string repoUrl: "https://github.com/nixfred/infomarchy"
  readonly property string authorUrl: "https://nixfred.com"
  property bool ollamaBusy: false
  property string ollamaStatus: ""
  property string ollamaError: ""
  property string ollamaModel: ""
  property string ollamaAction: ""
  property bool containerBusy: false
  property string containerStatus: ""
  property string containerError: ""
  property string containerName: ""
  property string containerAction: ""
  // Omarchy does not ship bun (verified against omarchy-base.packages and
  // omarchy-other.packages, 2026-09-04). Without it every helper here is dead
  // and the desk used to sit on "collecting…" forever with a one-word hint.
  // Probe on every refresh so installing bun later heals without a restart.
  property bool bunAvailable: true
  property bool bunChecked: false
  readonly property string missingDependencyHint: "bun is not installed — run:  sudo pacman -S bun   then the desk fills in on the next refresh"
  // Explicit, transient screenshot/demo data. It never persists and defaults
  // off on every shell start; normal operation always displays live data.
  property bool demoMode: false
  // Wallpaper and overlay each run a collector; --id keeps their rate
  // baselines apart (see collector.ts prev-${id}.json).
  property string instance: "bg"
  // Origin only, e.g. http://127.0.0.1:11435. Empty inherits OLLAMA_HOST.
  property string ollamaHost: ""
  // True only while a desk showing the USAGE card is on screen. The opt-in
  // outbound usage calls (Grok billing, Claude refresh) never run without it.
  property bool usageVisible: false

  // HARD REFRESH: next collector pass bypasses GitHub / billing / usage TTLs.
  property bool forceRefreshArmed: false
  property bool hardRefreshing: false
  property int dataGeneration: 0

  // --- theme ---------------------------------------------------------------
  // Omarchy's Color singleton gives fg/bg/accent/urgent/muted. The ANSI roles
  // (green/yellow/red/blue…) live in the theme's colors.toml; read them here
  // with fallbacks so any theme works even if it omits a key.
  property color green: Commons.Color.accent
  property color yellow: Commons.Color.foreground
  property color red: Commons.Color.urgent
  property color blue: Commons.Color.accent
  property color magenta: Commons.Color.accent
  property color cyan: Commons.Color.accent
  property color themeBackground: Commons.Color.background
  property color themeForeground: Commons.Color.foreground

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
    green = pick(["green", "color2"], Commons.Color.accent)
    yellow = pick(["yellow", "color3"], Commons.Color.foreground)
    red = pick(["red", "color1"], Commons.Color.urgent)
    blue = pick(["blue", "color4"], Commons.Color.accent)
    magenta = pick(["magenta", "color5"], Commons.Color.accent)
    cyan = pick(["cyan", "color6"], Commons.Color.accent)
    themeBackground = pick(["background"], Commons.Color.background)
    themeForeground = pick(["foreground"], Commons.Color.foreground)
  }

  FileView {
    id: manifestFile
    path: Qt.resolvedUrl("manifest.json").toString().replace(/^file:\/\//, "")
    // `omarchy plugin update` rewrites manifest.json under a running shell.
    // Read once and the desk keeps reporting the version it started with,
    // which is the one number that must never be stale.
    watchChanges: true
    onFileChanged: reload()
    printErrors: false
    onLoaded: {
      try {
        var parsed = JSON.parse(text())
        root.version = String(parsed && parsed.version ? parsed.version : "")
      } catch (e) { root.version = "" }
    }
  }
  FileView {
    id: colorsFile
    path: Commons.Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onLoaded: root.parseColors(text())
    onFileChanged: reload()
  }
  // The theme dir is a symlink swap; watching the file alone can miss it.
  // Color.* changes when the shell learns about a new theme → re-read.
  Connections {
    target: Commons.Color
    function onAccentChanged() { colorsFile.reload() }
    function onBackgroundChanged() { colorsFile.reload() }
    function onForegroundChanged() { colorsFile.reload() }
  }

  function providerColor(p) {
    switch (String(p)) {
      case "claude": return root.yellow
      case "kimi": return root.blue
      case "codex": return root.cyan
      case "grok": return root.magenta
      case "grok-bot": return root.magenta
      case "gemini": return root.blue
      case "hermes": return root.green
      case "muse": return root.cyan
      case "antigravity": return root.blue
      case "ollama": return root.green
      case "opencode": return root.blue
      case "pi": return root.green
      case "cursor": return root.cyan
      case "aider": return root.yellow
      case "remote": return root.cyan
      case "copilot": return root.magenta
      default: return Commons.Color.accent
    }
  }
  // Only the two addresses this plugin ships. Nothing user- or snapshot-derived
  // ever reaches a browser, so there is no URL to sanitize at the call site.
  function openUrl(url) {
    var target = String(url || "")
    if (target !== root.repoUrl && target !== root.authorUrl) return false
    Quickshell.execDetached(["xdg-open", target])
    return true
  }
  function plainText(value, limit) {
    return String(value || "").slice(0, limit).replace(/[<>&]/g, function(character) {
      return character === "<" ? "‹" : character === ">" ? "›" : "＆"
    }).replace(/[\u0000-\u001f\u007f]/g, " ")
  }
  function providerLabel(p) {
    switch (String(p)) {
      case "claude": return "Claude"
      case "kimi": return "Kimi"
      case "codex": return "Codex"
      case "grok": return "Grok"
      case "grok-bot": return "Grok Bot"
      case "gemini": return "Gemini"
      case "hermes": return "Hermes"
      case "muse": return "Muse"
      case "antigravity": return "Antigravity"
      case "ollama": return "Ollama"
      case "opencode": return "opencode"
      case "pi": return "Pi"
      case "cursor": return "Cursor"
      case "aider": return "Aider"
      case "remote": return "Remote"
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
    property bool forceRun: false
    // A binding, never an assignment: every start, including a future plain
    // `collector.running = true`, gets --demo while demo mode is on. A change
    // while running applies to the next start (Quickshell Process.command).
    command: {
      var cmd = ["bun", root.collectorPath, "--id", root.instance]
      if (root.demoMode) return cmd.concat(["--demo"])
      if (root.forceRefreshArmed) cmd.push("--force-refresh")
      if (root.usageVisible) cmd.push("--usage-visible")
      return cmd
    }
    environment: root.ollamaHost !== "" ? ({ OLLAMA_HOST: root.ollamaHost }) : ({})

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
        // ready first: onSnapChanged consumers (notification dispatch) check
        // it, and the first snapshot after a restart carried events that were
        // dropped because ready flipped a line too late.
        var parsed = JSON.parse(outputBuffer)
        root.ready = true
        root.snap = parsed
        root.error = ""
        root.dataGeneration += 1
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
      forceRun = root.forceRefreshArmed
      root.forceRefreshArmed = false
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
      if (collector.forceRun && !root.forceRefreshArmed) root.hardRefreshing = false
      if (collector.protocolFailed) {
        if (root.forceRefreshArmed) root.startCollector()
        return
      }
      if (!collector.frameComplete) root.error = collector.lastStderr || (exitCode === 0 ? "collector ended without a complete snapshot" : "collector exited " + exitCode)
      if (root.forceRefreshArmed) root.startCollector()
    }
  }
  function startCollector() {
    if (collector.running || bunProbe.running) return
    collector.running = true
  }
  function hardRefresh() {
    if (!root.active) return
    root.forceRefreshArmed = true
    root.hardRefreshing = true
    if (collector.running || bunProbe.running) return
    if (!root.bunChecked) { bunProbe.running = true; return }
    if (root.bunAvailable) root.startCollector()
    else {
      root.hardRefreshing = false
      root.forceRefreshArmed = false
      root.error = root.missingDependencyHint
    }
  }
  Process {
    id: bunProbe
    command: ["sh", "-c", "command -v bun >/dev/null 2>&1"]
    onExited: function(exitCode) {
      root.bunChecked = true
      root.bunAvailable = exitCode === 0
      if (root.bunAvailable) { if (!collector.running) root.startCollector() }
      else {
        root.error = root.missingDependencyHint
        root.hardRefreshing = false
        root.forceRefreshArmed = false
      }
    }
  }

  // --- refresh ---------------------------------------------------------------
  // A repeating poll, restored. It had been replaced by FileView watches that
  // named one contributor's own home directory literally (three absolute paths
  // under another user's home), so on every other machine no watch ever fired
  // and the only refresh left was a single one-shot 750 ms after start. The
  // desk populated once and then froze until you toggled it — which is exactly
  // what made it look alive, because toggling re-armed the one-shot.
  //
  // refreshMs was left set by Infomarchy.qml (4 s visible, 16 s hidden) and by
  // Overlay.qml (3 s) with nothing reading it, so the documented cadence did
  // not exist either. triggeredOnStart covers the first tick, so no separate
  // initial timer is needed.
  //
  // Event-driven refresh is a good idea and is welcome back, but it has to
  // build its paths from HOME and keep a timer as the floor, so the desk stays
  // live when nothing it watches happens to change.
  Timer {
    interval: root.refreshMs
    running: root.active
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // --- event-driven refresh (on top of the floor) -----------------------------
  // The timer above is the floor; a change that means "the desk has something
  // new to say" pulls the next collect forward. Paths are built from HOME /
  // HERMES_HOME / XDG_STATE_HOME, the same resolution collector.ts uses,
  // never a literal home directory, so the watches fire on any machine.
  // FileView watches single files (a directory errors in a tight loop), and a
  // file that does not exist simply never fires. The 250 ms debounce
  // coalesces bursts: an agent commits to the DB and its WAL together.
  // preload: false keeps these as pure watches. FileView otherwise reads the
  // whole file into memory at startup, and state.db runs to megabytes; the
  // change signal fires without the contents ever being loaded.
  readonly property string hermesDir: Quickshell.env("HERMES_HOME") || (Quickshell.env("HOME") + "/.hermes")
  readonly property string stateRoot: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")
  FileView {
    path: root.hermesDir + "/state.db"
    preload: false
    watchChanges: true
    printErrors: false
    onFileChanged: debounceTimer.restart()
  }
  FileView {
    path: root.hermesDir + "/state.db-wal"
    preload: false
    watchChanges: true
    printErrors: false
    onFileChanged: debounceTimer.restart()
  }
  FileView {
    path: root.stateRoot + "/infomarchy/dashboard.json"
    preload: false
    watchChanges: true
    printErrors: false
    onFileChanged: debounceTimer.restart()
  }
  Timer {
    id: debounceTimer
    interval: 250
    repeat: false
    onTriggered: root.refresh()
  }

  function refresh() {
    if (!root.active || collector.running || bunProbe.running) return
    if (root.bunChecked && root.bunAvailable) root.startCollector()
    else bunProbe.running = true
  }

  function focusWindow(address) {
    var addr = String(address || "").replace(/^0x/, "")
    if (!/^[0-9A-Fa-f]{1,32}$/.test(addr)) return
    if (root.snap && root.snap.hyprLua)
      Quickshell.execDetached(["hyprctl", "dispatch", 'hl.dsp.focus({ window = "address:0x' + addr + '" })'])
    else
      Quickshell.execDetached(["hyprctl", "dispatch", "focuswindow", "address:0x" + addr])
  }

  // A fleet session runs on another machine, so its jump is the local one
  // displaced by one hop: open a terminal, ssh to the host, and run the same
  // tmux select over there. The alias and the tmux names were validated by
  // fleet-sessions.ts on the way in and are validated again here, because
  // this is where they become a command line. An id that fails either check
  // costs the jump, never a shell escape.
  function focusFleetSession(host, tmux) {
    var alias = String(host || "")
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(alias)) return false
    var handle = tmux || {}
    var name = /^[A-Za-z0-9_.:@%+=-]{1,64}$/
    var session = String(handle.session || "")
    if (!name.test(session)) return false
    var win = String(handle.window || ""), pane = String(handle.pane || "")
    if (win && !name.test(win)) win = ""
    if (pane && !name.test(pane)) pane = ""
    var target = win ? session + ":" + win : session
    // ssh carries the local TERM to the remote, and a terminal newer than the
    // remote's terminfo database kills tmux outright: Ghostty's xterm-ghostty
    // on a host that has never heard of it makes attach exit with "terminal
    // does not support clear", so the window opens and vanishes. Keep the real
    // TERM when the remote knows it, fall back when it does not.
    var term = 'infocmp "$TERM" >/dev/null 2>&1 || TERM=xterm-256color; export TERM'
    // select first, attach last: attach is what blocks, and `exec` leaves the
    // terminal showing tmux rather than a shell sitting behind it.
    var remote = term + "; tmux select-window -t '" + target + "'"
    if (win && pane) remote += "; tmux select-pane -t '" + target + "." + pane + "'"
    remote += "; exec tmux attach-session -t '" + session + "'"
    // No "--" before the command: xdg-terminal-exec takes it directly, the way
    // resume-session.ts already launches a provider CLI.
    Quickshell.execDetached(["uwsm-app", "--", "xdg-terminal-exec", "ssh", "-t", alias, remote])
    return true
  }

  // Focus a Hyprland workspace by number, on both dispatch syntaxes. Used only
  // by the REMOTE card, whose agents have no window here to focus.
  function focusWorkspace(workspace) {
    var ws = String(workspace || "")
    if (!/^[1-9][0-9]?$/.test(ws)) return
    if (root.snap && root.snap.hyprLua)
      Quickshell.execDetached(["hyprctl", "dispatch", 'hl.dsp.focus({ workspace = ' + ws + ' })'])
    else
      Quickshell.execDetached(["hyprctl", "dispatch", "workspace", ws])
  }

  // An agent inside tmux may live on a window/pane the client is not showing.
  // After focusing the terminal, select that pane so the agent is on screen.
  // Both values come from the collector and are validated here again.
  function focusTmuxPane(server, paneId) {
    var pane = String(paneId || ""), sock = String(server || "")
    if (!/^%\d{1,9}$/.test(pane)) return false
    if (sock && !/^\/[A-Za-z0-9_.\/-]{1,255}$/.test(sock)) return false
    var prefix = sock ? ["tmux", "-S", sock] : ["tmux"]
    // Window, then pane, then bring the attached client onto it. Each command
    // resolves the session from the pane id, so order only matters for feel.
    Quickshell.execDetached(prefix.concat(["select-window", "-t", pane]))
    Quickshell.execDetached(prefix.concat(["select-pane", "-t", pane]))
    Quickshell.execDetached(prefix.concat(["switch-client", "-t", pane]))
    return true
  }
  // Herdr ids look like wM, wM:t1, wM:p1. The socket, when the agent's
  // environment named one, targets the same Herdr session the agent runs in.
  function herdrId(value, kind) {
    var id = String(value || "")
    var shape = kind === "workspace" ? /^w[A-Za-z0-9_-]{1,32}$/ : kind === "tab" ? /^w[A-Za-z0-9_-]{1,32}:t[A-Za-z0-9_-]{1,32}$/ : /^w[A-Za-z0-9_-]{1,32}:p[A-Za-z0-9_-]{1,32}$/
    return shape.test(id) ? id : ""
  }
  // Herdr's CLI has no focus-pane-by-id; its socket API does (pane.focus).
  // herdr-focus.ts sends workspace.focus → tab.focus → pane.focus over the
  // agent's own session socket, re-validating every id.
  // Orca keeps its agents in tabs inside one window, so there is no separate
  // window to raise: `orca terminal switch <handle>` brings the right tab
  // forward, and the handle came from the agent's own environment.
  function focusOrcaTerminal(host) {
    var handle = String((host || {}).handle || "")
    if (!/^term_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(handle)) return false
    Quickshell.execDetached(["bun", root.orcaFocusPath, handle])
    return true
  }

  function focusHerdrPane(host) {
    var h = host || {}
    var workspace = herdrId(h.workspaceId, "workspace"), tab = herdrId(h.tabId, "tab"), pane = herdrId(h.paneId, "pane")
    if (!workspace && !tab && !pane) return false
    var sock = String(h.socket || "")
    if (sock && !/^\/[A-Za-z0-9_.\/-]{1,255}\.sock$/.test(sock)) sock = ""
    Quickshell.execDetached(["bun", root.herdrFocusPath, sock, workspace, tab, pane])
    return true
  }
  // Boomux: `boomux open <shell-id> --workspace <id>` is documented to show the
  // shell's Workspace layer and place or REUSE the requested terminal, which
  // is the "jump to it" we want. Best effort — not verified against a live
  // Boomux shell on the development machine. Ids are shape-checked; argv only.
  function focusBoomuxShell(host) {
    var h = host || {}
    // Verified live (Boomux 1.9.7): `open <shell-id> --workspace <NAME>` shows the
    // Workspace and re-focuses the existing terminal; the BOOMUX_WORKSPACE_ID
    // uuid is a Node-local id that `--workspace` does not accept, and a bare
    // `open` neither moves focus nor opens a duplicate. The Hyprland focus of
    // the mapped window (done by focusSession before this) is the primary jump.
    var shell = String(h.shellId || ""), workspace = String(h.workspace || "")
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/.test(shell)) return false
    var command = ["boomux", "open", shell]
    if (/^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/.test(workspace)) command.push("--workspace", workspace)
    Quickshell.execDetached(command)
    return true
  }
  // Focus the terminal window, then ask the multiplexer inside it to show the
  // agent's own pane. Herdr, tmux and (best effort) Boomux are handled; a host
  // we cannot address still gets the window focused.
  // Explicit, two-click cleanup of a stale session. Graceful when Claude's
  // daemon owns it (`claude stop`, conversation kept); otherwise SIGTERM the
  // exact process the card described (pid + start time re-verified by the helper).
  function canStopSession(session) {
    var item = session || {}
    return item.provider === "claude" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(String(item.jobId || "")) &&
      (item.hosts || []).some(function(h) { return h && h.kind === "background" })
  }
  function stopSession(session) {
    var item = session || {}
    if (!canStopSession(item)) return false
    Quickshell.execDetached(["bun", root.stopPath, "claude-stop", String(item.jobId)])
    return true
  }
  function canEndProcess(session) {
    var item = session || {}
    return Number.isInteger(Number(item.pid)) && Number(item.pid) > 1 && Number(item.startedAt) > 0
  }
  function endProcess(session) {
    var item = session || {}
    if (!canEndProcess(item)) return false
    Quickshell.execDetached(["bun", root.stopPath, "term", String(Number(item.pid)), String(Math.round(Number(item.startedAt)))])
    return true
  }
  // A background (daemon-hosted) Claude session has no terminal at all; open
  // one attached to it. Returns false when there is nothing to attach to.
  // `no-mistakes attach` joins the active pipeline run for a repository, so
  // the jump is a terminal opened in the worker's own directory.
  function attachDaemonRun(host, session) {
    var owner = String((host || {}).attach || "")
    if (owner !== "no-mistakes") return false
    var cwd = String((session || {}).cwd || "")
    if (!canOpenProject(cwd)) return false
    Quickshell.execDetached(["bun", root.resumePath, "daemon-attach", owner, cwd])
    return true
  }

  function attachBackground(session) {
    var item = session || {}
    var host = (item.hosts || []).filter(function(h) { return h && h.kind === "background" && h.attachId })[0]
    var id = host ? String(host.attachId) : String(item.session || "")
    if (!canResume("claude-attach", id)) return false
    Quickshell.execDetached(["bun", root.resumePath, "claude-attach", id, String(item.cwd || "")])
    return true
  }
  function focusSession(session) {
    var item = session || {}
    if (!(item.window && item.window.address)) {
      // No window we can point at: Boomux can (re)open the shell's own terminal,
      // and a background Claude session can be attached in a new terminal.
      // Orca first: its agents have no window of their own to point at, the
      // window belongs to Orca and the agent lives in a tab inside it.
      var orca = (item.hosts || []).filter(function(host) { return host && host.kind === "orca" && host.handle })[0]
      if (orca) return focusOrcaTerminal(orca)
      // Herdr belongs here too. Its client draws every workspace inside ONE
      // window, so a session whose client window could not be resolved still
      // has a real address: the workspace/tab/pane triple. Without this the
      // click fell through to `return false` and a herdr card reading
      // "no client window found" did nothing at all when clicked.
      var herdr = (item.hosts || []).filter(function(host) { return host && host.kind === "herdr" })[0]
      if (herdr && focusHerdrPane(herdr)) return true
      // A supervisor-run agent has no terminal anywhere on this machine. If
      // its owner ships an attach, open one; otherwise there is genuinely
      // nothing to jump to and the card says so rather than ignoring clicks.
      var daemon = (item.hosts || []).filter(function(host) { return host && host.kind === "daemon" && host.attach })[0]
      if (daemon) return attachDaemonRun(daemon, item)
      var boomux = (item.hosts || []).filter(function(host) { return host && host.kind === "boomux" && host.shellId })[0]
      if (boomux) return focusBoomuxShell(boomux)
      if (item.provider === "claude" && (item.hosts || []).some(function(h) { return h && h.kind === "background" })) return attachBackground(item)
      return false
    }
    focusWindow(item.window.address)
    var hosts = item.hosts || []
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i] || {}
      if (host.kind === "tmux" && host.paneId && host.attached && !host.activePane) focusTmuxPane(host.server, host.paneId)
      // Not gated on `attached`: Herdr draws every workspace inside ONE window,
      // so an agent's own ancestry resolves that window directly and the
      // collector's client-window lookup never runs. Gating here meant the
      // click focused Herdr and then left it on whatever workspace was already
      // showing. focusHerdrPane re-validates the ids and does nothing without.
      else if (host.kind === "orca") focusOrcaTerminal(host)
      else if (host.kind === "herdr") focusHerdrPane(host)
      else if (host.kind === "boomux" && host.shellId) focusBoomuxShell(host)
    }
    return true
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
    var supported = ["claude", "codex", "grok", "opencode", "claude-attach"]
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
  // Delete one successful preview artifact. The helper re-checks ownership,
  // parent directory, name shape and contents before touching anything; the
  // shell only hands it the path it was given by the capture.
  function removePreview(source) {
    var path = String(source || "").replace(/^file:\/\//, "").replace(/\?.*$/, "")
    if (!/^\/[^\0]{1,512}\/infomarchy-preview-[A-Za-z0-9]{6}\/preview\.png$/.test(path)) return false
    Quickshell.execDetached(["bun", root.previewPath, "--remove", path])
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

  function controlOllama(action, model) {
    var operation = String(action || ""), name = String(model || "")
    if (root.ollamaBusy || ["load", "unload"].indexOf(operation) < 0 || !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,255}$/.test(name)) return false
    root.ollamaBusy = true
    root.ollamaAction = operation
    root.ollamaModel = name
    root.ollamaError = ""
    root.ollamaStatus = (operation === "load" ? "loading " : "unloading ") + name + "…"
    ollamaProcess.pendingFrame = ({ action: operation, model: name })
    ollamaProcess.running = true
    return true
  }

  function acceptOllamaResult(raw) {
    var result
    try { result = JSON.parse(String(raw || "")) } catch (e) { result = null }
    ollamaProcess.responded = true
    if (!result || result.ok !== true) {
      root.ollamaError = root.plainText(result && result.message ? result.message : "Invalid Ollama control response", 160)
      root.ollamaStatus = ""
      return
    }
    root.ollamaError = ""
    root.ollamaStatus = root.plainText(result.message || "Ollama model updated", 160)
  }

  // Model names are framed over stdin and validated again by the helper
  // against Ollama's live inventory before any API state change is attempted.
  Process {
    id: ollamaProcess
    property var pendingFrame: ({})
    property bool responded: false
    command: ["bun", root.ollamaControlPath]
    environment: root.ollamaHost !== "" ? ({ OLLAMA_HOST: root.ollamaHost }) : ({})
    stdinEnabled: true
    onRunningChanged: if (running) responded = false
    onStarted: {
      write(JSON.stringify(pendingFrame) + "\n")
      pendingFrame = ({})
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.acceptOllamaResult(text)
    }
    onExited: function(exitCode) {
      if (!responded) {
        root.ollamaError = "Ollama control helper exited " + exitCode
        root.ollamaStatus = ""
      }
      root.ollamaBusy = false
      root.refresh()
    }
  }

  function controlContainer(action, name) {
    var operation = String(action || ""), id = String(name || "")
    if (root.containerBusy || ["start", "stop"].indexOf(operation) < 0 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(id)) return false
    root.containerBusy = true
    root.containerAction = operation
    root.containerName = id
    root.containerError = ""
    root.containerStatus = (operation === "start" ? "starting " : "stopping ") + id + "…"
    containerProcess.pendingFrame = ({ action: operation, name: id })
    containerProcess.running = true
    return true
  }

  function acceptContainerResult(raw) {
    var result
    try { result = JSON.parse(String(raw || "")) } catch (e) { result = null }
    containerProcess.responded = true
    if (!result || result.ok !== true) {
      root.containerError = root.plainText(result && result.message ? result.message : "Invalid container control response", 160)
      root.containerStatus = ""
      return
    }
    root.containerError = ""
    root.containerStatus = root.plainText(result.message || "Container updated", 160)
  }

  Process {
    id: containerProcess
    property var pendingFrame: ({})
    property bool responded: false
    command: ["bun", root.containerControlPath]
    stdinEnabled: true
    onRunningChanged: if (running) responded = false
    onStarted: {
      write(JSON.stringify(pendingFrame) + "\n")
      pendingFrame = ({})
    }
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.acceptContainerResult(text)
    }
    onExited: function(exitCode) {
      if (!responded) {
        root.containerError = "Container control helper exited " + exitCode
        root.containerStatus = ""
      }
      root.containerBusy = false
      root.refresh()
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
