import QtQuick
import Quickshell
import Quickshell.Io

// Shared-on-disk dashboard preferences. Wallpaper and overlay each instantiate
// this lightweight object; field patches merge under a shared process lock.
// FileView propagation keeps readers in sync; it never writes stale snapshots.
Item {
  id: root

  readonly property string stateRoot: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")
  readonly property string configPath: stateRoot + "/infomarchy/dashboard.json"
  readonly property var definitions: [
    { id: "needs", label: "NEXT ACTIONS" },
    { id: "sessions", label: "SESSIONS" },
    { id: "activity", label: "ACTIVITY" },
    { id: "github", label: "GITHUB" },
    { id: "recent", label: "RECENT" },
    { id: "usage", label: "USAGE" },
    { id: "localAi", label: "LOCAL AI" },
    { id: "machine", label: "MACHINE" },
    { id: "changes", label: "CHANGES" },
    { id: "projects", label: "PROJECTS" },
    { id: "media", label: "MEDIA" }
  ]
  property var sections: ({})
  property var attentionMuted: ({})
  property var pinnedPrompts: ({})
  property var seenChanges: ({})
  property var notificationEvents: ({})
  property var notificationProviders: ({})
  property bool notificationsEnabled: true
  property bool quietHoursEnabled: false
  property int quietStartHour: 22
  property int quietEndHour: 8
  property string selectedOllamaModel: ""
  // Empty means inherit OLLAMA_HOST, else the collector default (127.0.0.1:11434).
  property string ollamaHost: ""
  // Stay hidden until the persisted value has loaded. This prevents a shell
  // restart from briefly re-enabling a dashboard the user turned off.
  property bool ready: false
  property bool dashboardVisible: false
  // Stream/screenshot mask: hide WAN, LAN, SSID, user@host, GitHub login.
  // OSS project names stay. Missing or invalid settings default to privacy on.
  property bool privacyMode: true
  property int privacyUnlockCount: 0
  readonly property int privacyUnlockNeeded: 3
  readonly property int privacyUnlockMs: 2000
  property bool webEnabled: false
  property bool webReady: false
  property bool webStarting: false
  readonly property bool webFailed: webEnabled && !webReady && !webStarting
  property bool webModeInvalid: false
  property string webAccessMode: "lan"
  property var manualHttps: ({})
  property string webStatusText: ""
  property var webSections: ({})
  property var webNarrowOrder: ["sessions", "changes", "needs", "projects", "activity", "github", "recent", "usage", "localAi", "machine"]
  readonly property string webServerPath: Qt.resolvedUrl("web-server.ts").toString().replace(/^file:\/\//, "")
  property var rightOrder: ["usage", "localAi", "machine", "media"]
  property var opsOrder: ["changes", "needs", "projects"]

  function normalizedRightOrder(value) {
    var allowed = ["usage", "localAi", "machine", "media"], result = []
    if (Array.isArray(value)) for (var i = 0; i < value.length; i++) if (allowed.indexOf(value[i]) >= 0 && result.indexOf(value[i]) < 0) result.push(value[i])
    for (var j = 0; j < allowed.length; j++) if (result.indexOf(allowed[j]) < 0) result.push(allowed[j])
    return result
  }
  function normalizedOpsOrder(value) {
    var allowed = ["changes", "needs", "projects"], result = []
    if (Array.isArray(value)) for (var i = 0; i < value.length; i++) if (allowed.indexOf(value[i]) >= 0 && result.indexOf(value[i]) < 0) result.push(value[i])
    for (var j = 0; j < allowed.length; j++) if (result.indexOf(allowed[j]) < 0) result.push(allowed[j])
    return result
  }
  function normalizedWebNarrowOrder(value) {
    var allowed = ["sessions", "changes", "needs", "projects", "activity", "github", "recent", "usage", "localAi", "machine"], result = []
    if (Array.isArray(value)) for (var i = 0; i < value.length; i++) if (allowed.indexOf(value[i]) >= 0 && result.indexOf(value[i]) < 0) result.push(value[i])
    for (var j = 0; j < allowed.length; j++) if (result.indexOf(allowed[j]) < 0) result.push(allowed[j])
    return result
  }

  function applyConfig(raw) {
    if (settingsWriting) return
    try {
      var parsed = JSON.parse(String(raw || "{}"))
      sections = parsed && parsed.sections && typeof parsed.sections === "object" ? parsed.sections : ({})
      attentionMuted = parsed && parsed.attentionMuted && typeof parsed.attentionMuted === "object" ? parsed.attentionMuted : ({})
      pinnedPrompts = parsed && parsed.pinnedPrompts && typeof parsed.pinnedPrompts === "object" ? parsed.pinnedPrompts : ({})
      seenChanges = parsed && parsed.seenChanges && typeof parsed.seenChanges === "object" ? parsed.seenChanges : ({})
      notificationEvents = parsed && parsed.notificationEvents && typeof parsed.notificationEvents === "object" ? parsed.notificationEvents : ({})
      notificationProviders = parsed && parsed.notificationProviders && typeof parsed.notificationProviders === "object" ? parsed.notificationProviders : ({})
      notificationsEnabled = !parsed || typeof parsed.notificationsEnabled !== "boolean" ? true : parsed.notificationsEnabled
      quietHoursEnabled = !!(parsed && parsed.quietHoursEnabled === true)
      quietStartHour = parsed && Number.isInteger(parsed.quietStartHour) ? Math.max(0, Math.min(23, parsed.quietStartHour)) : 22
      quietEndHour = parsed && Number.isInteger(parsed.quietEndHour) ? Math.max(0, Math.min(23, parsed.quietEndHour)) : 8
      selectedOllamaModel = parsed && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,255}$/.test(String(parsed.selectedOllamaModel || "")) ? String(parsed.selectedOllamaModel) : ""
      ollamaHost = parsed ? normalizeOllamaHost(parsed.ollamaHost) : ""
      dashboardVisible = parsed && typeof parsed.dashboardVisible === "boolean" ? parsed.dashboardVisible : true
      privacyMode = !(parsed && parsed.privacyMode === false)
      privacyUnlockCount = 0
      // Only a missing mode is a legacy LAN setting. Unknown explicit values
      // must never turn an intended HTTPS listener into plaintext HTTP.
      webModeInvalid = !!parsed && Object.prototype.hasOwnProperty.call(parsed, "webAccessMode") && ["lan", "tailscale", "manual"].indexOf(parsed.webAccessMode) < 0
      webAccessMode = webModeInvalid ? "" : (parsed && parsed.webAccessMode ? parsed.webAccessMode : "lan")
      if (webModeInvalid) webStatusText = "Unknown saved access mode. Select an access mode before enabling WEB."
      manualHttps = parsed && parsed.manualHttps && typeof parsed.manualHttps === "object" ? parsed.manualHttps : ({})
      webEnabled = !webModeInvalid && !!(parsed && parsed.webEnabled === true)
      webSections = parsed && parsed.webSections && typeof parsed.webSections === "object" ? parsed.webSections : ({})
      if (webEnabled) Qt.callLater(refreshWebStatus)
      else { webReady = false; webStarting = false }
      rightOrder = normalizedRightOrder(parsed ? parsed.rightOrder : null)
      opsOrder = normalizedOpsOrder(parsed ? parsed.opsOrder : null)
      webNarrowOrder = normalizedWebNarrowOrder(parsed ? parsed.webNarrowOrder : null)
    } catch (e) {
      sections = ({})
      attentionMuted = ({})
      pinnedPrompts = ({})
      seenChanges = ({})
      notificationEvents = ({})
      notificationProviders = ({})
      notificationsEnabled = true
      quietHoursEnabled = false
      quietStartHour = 22
      quietEndHour = 8
      selectedOllamaModel = ""
      ollamaHost = ""
      dashboardVisible = true
      privacyMode = true
      privacyUnlockCount = 0
      webModeInvalid = false
      webAccessMode = "lan"
      manualHttps = ({})
      webEnabled = false
      webReady = false
      webSections = ({})
      rightOrder = normalizedRightOrder(null)
      opsOrder = normalizedOpsOrder(null)
      webNarrowOrder = normalizedWebNarrowOrder(null)
    }
    ready = true
  }
  property var pendingPatch: ({})
  property string settingsError: ""
  property bool settingsWriteInFlight: false
  readonly property bool settingsWriting: settingsWriteInFlight || Object.keys(pendingPatch).length > 0
  function persist(patch) {
    var next = JSON.parse(JSON.stringify(pendingPatch))
    for (var key in patch) {
      if (patch[key] && typeof patch[key] === "object" && !Array.isArray(patch[key])) {
        var merged = next[key] || {}
        for (var entry in patch[key]) merged[entry] = patch[key][entry]
        next[key] = merged
      } else next[key] = patch[key]
    }
    pendingPatch = next
    startSettingsWrite()
  }
  function persistEntry(field, key, value) {
    var entries = {}, patch = {}
    entries[key] = value
    patch[field] = entries
    persist(patch)
  }
  function startSettingsWrite() {
    if (settingsWriteInFlight || !Object.keys(pendingPatch).length) return
    settingsWriteInFlight = true
    settingsWriter.frame = JSON.stringify(pendingPatch)
    pendingPatch = ({})
    settingsError = ""
    settingsLaunchWatch.start()
    settingsWriter.running = true
  }
  function settingsWriteFailed() {
    settingsLaunchWatch.stop()
    settingsWriteInFlight = false
    pendingPatch = ({})
    settingsWriter.frame = ""
    settingsError = "Settings could not be saved. Check that Bun is installed, then try again."
    Qt.callLater(function() { configFile.reload() })
  }
  // Quickshell Process exposes no launch-error signal. Failed launches do not
  // emit exited; a bounded startup check restores the saved UI state instead.
  Timer {
    id: settingsLaunchWatch
    interval: 1000
    onTriggered: if (root.settingsWriteInFlight && !settingsWriter.running) root.settingsWriteFailed()
  }
  Process {
    id: settingsWriter
    property string frame: ""
    command: ["/usr/bin/bun", Qt.resolvedUrl("dashboard-state.ts").toString().replace(/^file:\/\//, "")]
    stdinEnabled: true
    onStarted: { settingsLaunchWatch.stop(); write(frame + "\n"); frame = "" }
    onExited: function(code) {
      settingsLaunchWatch.stop()
      root.settingsWriteInFlight = false
      if (code !== 0) { root.settingsWriteFailed(); return }
      Qt.callLater(function() {
        if (Object.keys(root.pendingPatch).length) root.startSettingsWrite()
        else configFile.reload()
      })
    }
  }
  function sectionEnabled(id) { return sections[id] !== false }
  function webSectionEnabled(id) {
    if (String(id) === "media") return false
    if (webSections[id] === false) return false
    if (webSections[id] === true) return true
    return sectionEnabled(id)
  }
  function setWebSection(id, enabled) {
    if (String(id) === "media") return false
    var next = {}
    for (var key in webSections) next[key] = webSections[key]
    next[id] = !!enabled
    webSections = next
    persistEntry("webSections", id, !!enabled)
    return true
  }
  function toggleWebSection(id) { return setWebSection(id, !webSectionEnabled(id)) }
  function adjacentEnabledIndex(order, from, direction, sectionState) {
    var step = Number(direction) < 0 ? -1 : Number(direction) > 0 ? 1 : 0
    if (!step || from < 0 || from >= order.length) return from
    for (var index = from + step; index >= 0 && index < order.length; index += step)
      if (!sectionState || sectionState[order[index]] !== false) return index
    return from
  }
  function setSection(id, enabled) {
    var next = {}
    for (var key in sections) next[key] = sections[key]
    next[id] = !!enabled
    sections = next
    persistEntry("sections", id, !!enabled)
  }
  function toggleSection(id) { setSection(id, !sectionEnabled(id)) }
  function attentionVisible(key, now) {
    var until = Number(attentionMuted[key] || 0)
    return until === 0 || (until > 0 && until <= Number(now || Date.now()))
  }
  function muteAttention(key, until) {
    var next = {}
    for (var name in attentionMuted) next[name] = attentionMuted[name]
    next[key] = Number(until)
    attentionMuted = next
    persistEntry("attentionMuted", key, Number(until))
  }
  function snoozeAttention(key) { muteAttention(key, Date.now() + 10 * 60 * 1000) }
  function dismissAttention(key) { muteAttention(key, -1) }
  function notificationProviderEnabled(provider) {
    var key = String(provider || "").toLowerCase()
    return notificationProviders[key] !== false
  }
  function setNotificationProvider(provider, enabled) {
    var key = String(provider || "").toLowerCase()
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) return false
    var next = {}
    for (var name in notificationProviders) next[name] = notificationProviders[name]
    next[key] = !!enabled
    notificationProviders = next
    persistEntry("notificationProviders", key, !!enabled)
    return true
  }
  function toggleNotificationProvider(provider) { return setNotificationProvider(provider, !notificationProviderEnabled(provider)) }
  function setNotificationsEnabled(enabled) { notificationsEnabled = !!enabled; persist({ notificationsEnabled: notificationsEnabled }) }
  function toggleNotificationsEnabled() { setNotificationsEnabled(!notificationsEnabled) }
  function setQuietHoursEnabled(enabled) { quietHoursEnabled = !!enabled; persist({ quietHoursEnabled: quietHoursEnabled }) }
  function toggleQuietHoursEnabled() { setQuietHoursEnabled(!quietHoursEnabled) }
  function inQuietHours(stamp) {
    if (!quietHoursEnabled) return false
    var hour = new Date(Number(stamp || Date.now())).getHours(), start = quietStartHour, end = quietEndHour
    if (start === end) return false
    return start < end ? hour >= start && hour < end : hour >= start || hour < end
  }
  function notificationsAllowed(provider, stamp) {
    return notificationsEnabled && notificationProviderEnabled(provider) && !inQuietHours(stamp)
  }
  function claimNotificationEvent(key, stamp) {
    var eventKey = String(key || ""), now = Number(stamp || Date.now())
    if (!eventKey || eventKey.length > 512 || !isFinite(now)) return false
    var cutoff = now - 7 * 86400000
    // A key older than the window is expired, not claimed — otherwise a
    // stored key outlived its seven days until some other event pruned it.
    var seenAt = Number(notificationEvents[eventKey] || 0)
    if (seenAt > 0 && seenAt >= cutoff && seenAt <= now) return false
    var recent = []
    for (var name in notificationEvents) {
      var at = Number(notificationEvents[name] || 0)
      if (name.length <= 512 && isFinite(at) && at >= cutoff && at <= now) recent.push({ key: name, at: at })
    }
    recent.sort(function(a, b) { return b.at - a.at })
    var next = {}
    for (var i = 0; i < Math.min(255, recent.length); i++) next[recent[i].key] = recent[i].at
    next[eventKey] = now
    notificationEvents = next
    persistEntry("notificationEvents", eventKey, now)
    return true
  }
  function normalizeOllamaHost(raw) {
    var value = String(raw || "").trim()
    if (!value) return ""
    if (value.indexOf("http://") !== 0 && value.indexOf("https://") !== 0) value = "http://" + value
    if (value.indexOf("@") >= 0 || value.indexOf("?") >= 0 || value.indexOf("#") >= 0) return ""
    var match = value.match(/^(https?):\/\/(\[[0-9a-fA-F:]+\]|localhost|[A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?\/?$/)
    if (!match) return ""
    var port = match[3] ? Number(match[3]) : (match[1] === "https" ? 443 : 80)
    if (!isFinite(port) || port < 1 || port > 65535) return ""
    return match[1] + "://" + match[2] + (match[3] ? ":" + match[3] : "")
  }
  function setOllamaHost(host) {
    var trimmed = String(host || "").trim()
    var next = normalizeOllamaHost(trimmed)
    if (trimmed && !next) return false
    if (ollamaHost === next) return true
    ollamaHost = next
    persist({ ollamaHost: ollamaHost })
    return true
  }
  function setSelectedOllamaModel(model) {
    var name = String(model || "")
    if (name && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,255}$/.test(name)) return false
    if (selectedOllamaModel === name) return true
    selectedOllamaModel = name
    persist({ selectedOllamaModel: selectedOllamaModel })
    return true
  }
  function promptPinned(key) { return pinnedPrompts[key] === true }
  function togglePromptPin(key) {
    var next = {}
    for (var name in pinnedPrompts) next[name] = pinnedPrompts[name]
    if (next[key] === true) delete next[key]; else next[key] = true
    pinnedPrompts = next
    persistEntry("pinnedPrompts", key, next[key] === true ? true : null)
  }
  function changeSeen(key, fingerprint) { return !!fingerprint && seenChanges[key] === fingerprint }
  function markChangeSeen(key, fingerprint) {
    if (!key || !fingerprint || changeSeen(key, fingerprint)) return false
    var next = {}
    // Copy everything EXCEPT this key, then append it, so the just-updated
    // repository is newest in insertion order and survives the bounded seen-change map.
    for (var name in seenChanges) if (name !== key) next[name] = seenChanges[name]
    next[key] = fingerprint
    seenChanges = next
    persistEntry("seenChanges", key, fingerprint)
    return true
  }
  function setDashboardVisible(visible) {
    dashboardVisible = !!visible
    persist({ dashboardVisible: dashboardVisible })
  }
  function toggleDashboardVisible() { setDashboardVisible(!dashboardVisible) }
  function privacyUnlockStep(on, count, needed) {
    if (!on) return { on: true, count: 0 }
    var next = Math.max(0, Math.floor(Number(count) || 0)) + 1
    if (next >= Math.max(1, Math.floor(Number(needed) || 3))) return { on: false, count: 0 }
    return { on: true, count: next }
  }
  Timer {
    id: privacyUnlockReset
    interval: root.privacyUnlockMs
    repeat: false
    onTriggered: root.privacyUnlockCount = 0
  }
  function setPrivacyMode(enabled) {
    privacyUnlockCount = 0
    privacyUnlockReset.stop()
    privacyMode = !!enabled
    persist({ privacyMode: privacyMode })
  }
  function togglePrivacyMode() {
    var step = privacyUnlockStep(privacyMode, privacyUnlockCount, privacyUnlockNeeded)
    privacyUnlockCount = step.count
    if (step.on !== privacyMode) {
      privacyUnlockReset.stop()
      setPrivacyMode(step.on)
      return
    }
    if (privacyUnlockCount > 0) privacyUnlockReset.restart()
    else privacyUnlockReset.stop()
  }
  function setManualHttps(config) {
    manualHttps = config
    if (webAccessMode === "manual") { webEnabled = false; webReady = false; webStarting = false }
    persist({ manualHttps: config })
  }
  function setWebAccessMode(mode) {
    if ((mode !== "lan" && mode !== "tailscale" && mode !== "manual") || mode === webAccessMode) return
    webEnabled = false
    webReady = false
    webStarting = false
    webAccessMode = mode
    webModeInvalid = false
    webStatusText = ""
    persist({ webAccessMode: webAccessMode, webEnabled: false })
  }
  function setWebEnabled(enabled) {
    if (enabled && webModeInvalid) return
    webStarting = !!enabled
    webStatusText = ""
    webEnabled = !!enabled
    if (!webEnabled) webReady = false
    else Qt.callLater(refreshWebStatus)
    persist({ webEnabled: webEnabled })
  }
  function toggleWebEnabled() { setWebEnabled(!webEnabled) }
  function retryWebSetup() {
    if (!webFailed || webRetryProc.running) return
    webStatusReader.running = false
    webStarting = true
    webStatusText = "Retrying setup…"
    webRetryProc.running = true
  }
  Process {
    id: webRetryProc
    command: ["omarchy-shell", "infomarchy", "retryWeb"]
    onExited: function(code) { if (code !== 0) { root.webStarting = false; root.webStatusText = "Could not retry setup. Check that the shell is running." } }
  }
  function refreshWebStatus() {
    if (!webEnabled) { webReady = false; return }
    webStatusReader.running = false
    webStatusReader.running = true
  }
  Process {
    id: webStatusReader
    command: ["bun", root.webServerPath, "status"]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        var raw = String(line || "")
        if (raw.length > 1024) return
        try {
          var parsed = JSON.parse(raw)
          if (parsed && parsed.ok === true) {
            root.webReady = parsed.ready === true
            root.webStarting = parsed.running === true && !root.webReady
            root.webStatusText = String(parsed.message || "").slice(0, 400)
          }
        } catch (e) {}
      }
    }
  }
  Timer {
    interval: 3000
    running: root.ready && root.webEnabled
    repeat: true
    onTriggered: root.refreshWebStatus()
  }
  function rightIndex(id) { var index = rightOrder.indexOf(id); return index < 0 ? 99 : index }
  function moveRight(id, direction) {
    var next = normalizedRightOrder(rightOrder), from = next.indexOf(id), to = adjacentEnabledIndex(next, from, direction, sections)
    if (from < 0 || from === to) return false
    next.splice(from, 1); next.splice(to, 0, id)
    rightOrder = next
    persist({ rightOrder: rightOrder })
    return true
  }
  function opsIndex(id) { var index = opsOrder.indexOf(id); return index < 0 ? 99 : index }
  function enabledOpsCount() {
    var count = 0, order = normalizedOpsOrder(opsOrder)
    for (var i = 0; i < order.length; i++) if (sectionEnabled(order[i])) count++
    return count
  }
  function opsVisibleIndex(id) {
    var index = 0, order = normalizedOpsOrder(opsOrder)
    for (var i = 0; i < order.length; i++) {
      if (order[i] === id) return index
      if (sectionEnabled(order[i])) index++
    }
    return 99
  }
  function moveOps(id, direction) {
    var next = normalizedOpsOrder(opsOrder), from = next.indexOf(id), to = adjacentEnabledIndex(next, from, direction, sections)
    if (from < 0 || from === to) return false
    next.splice(from, 1); next.splice(to, 0, id)
    opsOrder = next
    persist({ opsOrder: opsOrder })
    return true
  }

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onLoadFailed: root.applyConfig("{}")
    onFileChanged: reload()
  }
}
