import QtQuick
import Quickshell
import Quickshell.Io

// Shared-on-disk dashboard preferences. Wallpaper and overlay each instantiate
// this lightweight object; FileView propagation keeps both views in sync.
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
    { id: "media", label: "MEDIA" },
    { id: "gitea", label: "GITEA" },
    { id: "apps", label: "APPS" }
  ]
  property var sections: ({})
  property var attentionMuted: ({})
  property var pinnedPrompts: ({})
  property var seenChanges: ({})
  property var notificationEvents: ({})
  property var notificationProviders: ({})
  property bool notificationsEnabled: true
  // Grouping quiet cards into one is a display rule keyed by provider, not a
  // Grok Bot special case: any app that fans one process out into a dozen
  // sessions gets the same treatment. Grok Bot is the only one that does that
  // today, so it is the only one on by default.
  readonly property var sessionGroupDefaults: ({ "grok-bot": true })
  property var sessionGroups: ({})
  // How long a session must sit untouched before it counts as quiet. 0 groups
  // every idle session whatever its age; a session that is busy or wants an
  // answer is never quiet, so the group can never hide something that needs you.
  property int sessionQuietMinutes: 60
  // What happens to a quiet session. Grouping was the first answer and it is
  // still right for an app that fans one process into a dozen sessions, where
  // you want the roster in view as one card. For an ordinary agent left idle in
  // a pane it is not: the desk is for what is happening now, and a session that
  // has done nothing for an hour is not. Those drop off instead, and come back
  // by themselves the moment that pane has a running agent again, because the
  // card list is rebuilt from live processes every tick. Nothing is killed and
  // nothing is forgotten: the count stays in the card hint. A provider you
  // explicitly asked to group keeps its group card, since asking to group it is
  // asking to keep seeing it.
  property bool hideQuietSessions: true
  // Sound for a video wallpaper. Off unless asked for: a wallpaper that
  // starts talking the moment it is set is a bug, not a feature.
  property bool videoAudio: false
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
  // OSS project names stay. Default off; persists until toggled.
  property bool privacyMode: false
  property int privacyUnlockCount: 0
  readonly property int privacyUnlockNeeded: 3
  readonly property int privacyUnlockMs: 2000
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

  function applyConfig(raw) {
    try {
      var parsed = JSON.parse(String(raw || "{}"))
      sections = parsed && parsed.sections && typeof parsed.sections === "object" ? parsed.sections : ({})
      attentionMuted = parsed && parsed.attentionMuted && typeof parsed.attentionMuted === "object" ? parsed.attentionMuted : ({})
      pinnedPrompts = parsed && parsed.pinnedPrompts && typeof parsed.pinnedPrompts === "object" ? parsed.pinnedPrompts : ({})
      seenChanges = parsed && parsed.seenChanges && typeof parsed.seenChanges === "object" ? parsed.seenChanges : ({})
      notificationEvents = parsed && parsed.notificationEvents && typeof parsed.notificationEvents === "object" ? parsed.notificationEvents : ({})
      notificationProviders = parsed && parsed.notificationProviders && typeof parsed.notificationProviders === "object" ? parsed.notificationProviders : ({})
      notificationsEnabled = !parsed || typeof parsed.notificationsEnabled !== "boolean" ? true : parsed.notificationsEnabled
      sessionGroups = parsed && parsed.sessionGroups && typeof parsed.sessionGroups === "object" ? parsed.sessionGroups : ({})
      sessionQuietMinutes = parsed && Number.isInteger(parsed.sessionQuietMinutes) ? Math.max(0, Math.min(10080, parsed.sessionQuietMinutes)) : 60
      hideQuietSessions = !parsed || parsed.hideQuietSessions !== false
      videoAudio = !!(parsed && parsed.videoAudio === true)
      quietHoursEnabled = !!(parsed && parsed.quietHoursEnabled === true)
      quietStartHour = parsed && Number.isInteger(parsed.quietStartHour) ? Math.max(0, Math.min(23, parsed.quietStartHour)) : 22
      quietEndHour = parsed && Number.isInteger(parsed.quietEndHour) ? Math.max(0, Math.min(23, parsed.quietEndHour)) : 8
      selectedOllamaModel = parsed && /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,255}$/.test(String(parsed.selectedOllamaModel || "")) ? String(parsed.selectedOllamaModel) : ""
      ollamaHost = parsed ? normalizeOllamaHost(parsed.ollamaHost) : ""
      dashboardVisible = parsed && typeof parsed.dashboardVisible === "boolean" ? parsed.dashboardVisible : true
      privacyMode = !!(parsed && parsed.privacyMode === true)
      privacyUnlockCount = 0
      rightOrder = normalizedRightOrder(parsed ? parsed.rightOrder : null)
      opsOrder = normalizedOpsOrder(parsed ? parsed.opsOrder : null)
    } catch (e) {
      sections = ({})
      attentionMuted = ({})
      pinnedPrompts = ({})
      seenChanges = ({})
      notificationEvents = ({})
      notificationProviders = ({})
      notificationsEnabled = true
      sessionGroups = ({})
      sessionQuietMinutes = 60
      hideQuietSessions = true
      videoAudio = false
      quietHoursEnabled = false
      quietStartHour = 22
      quietEndHour = 8
      selectedOllamaModel = ""
      ollamaHost = ""
      dashboardVisible = true
      privacyMode = false
      privacyUnlockCount = 0
      rightOrder = normalizedRightOrder(null)
      opsOrder = normalizedOpsOrder(null)
    }
    ready = true
  }
  // Both maps are keyed by values that age out of the snapshot (pid, prompt
  // timestamp) and nothing ever removed them, so dashboard.json grew forever.
  readonly property int maxPins: 200
  function prunedMuted(muted, now) {
    var next = {}, stamp = Number(now || Date.now())
    for (var key in muted) {
      var until = Number(muted[key])
      // A lapsed snooze is already visible again; only keep live snoozes and
      // explicit dismissals (-1).
      if (until < 0 || until > stamp) next[key] = until
    }
    return next
  }
  function prunedPins(pins) {
    var keys = []
    for (var key in pins) if (pins[key] === true) keys.push(key)
    if (keys.length <= maxPins) {
      var same = {}
      for (var k = 0; k < keys.length; k++) same[keys[k]] = true
      return same
    }
    // Key is provider:session:ts — keep the most recent pins.
    keys.sort(function(a, b) { return Number(b.split(":").pop()) - Number(a.split(":").pop()) })
    var next = {}
    for (var i = 0; i < maxPins; i++) next[keys[i]] = true
    return next
  }
  // seenChanges is keyed by repository path and was never pruned; every repo
  // an agent ever touched stayed forever. Keep a bounded, most-recent set.
  readonly property int maxSeenChanges: 64
  function prunedSeen(seen) {
    var keys = []
    for (var key in seen) if (typeof seen[key] === "string" && seen[key]) keys.push(key)
    var next = {}
    // Insertion order is preserved by JS engines for string keys; newest last.
    for (var i = Math.max(0, keys.length - maxSeenChanges); i < keys.length; i++) next[keys[i]] = seen[keys[i]]
    return next
  }
  function persist() {
    configFile.setText(JSON.stringify({
      version: 4,
      sections: sections,
      attentionMuted: prunedMuted(attentionMuted),
      pinnedPrompts: prunedPins(pinnedPrompts),
      seenChanges: prunedSeen(seenChanges),
      notificationEvents: notificationEvents,
      notificationProviders: notificationProviders,
      notificationsEnabled: notificationsEnabled,
      sessionGroups: sessionGroups,
      sessionQuietMinutes: sessionQuietMinutes,
      hideQuietSessions: hideQuietSessions,
      videoAudio: videoAudio,
      quietHoursEnabled: quietHoursEnabled,
      quietStartHour: quietStartHour,
      quietEndHour: quietEndHour,
      selectedOllamaModel: selectedOllamaModel,
      ollamaHost: ollamaHost,
      dashboardVisible: dashboardVisible,
      privacyMode: privacyMode,
      rightOrder: normalizedRightOrder(rightOrder),
      opsOrder: normalizedOpsOrder(opsOrder)
    }, null, 2) + "\n")
  }
  function sectionEnabled(id) { return id === "apps" ? sections[id] === true : sections[id] !== false }
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
    persist()
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
    persist()
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
    persist()
    return true
  }
  function toggleNotificationProvider(provider) { return setNotificationProvider(provider, !notificationProviderEnabled(provider)) }
  function sessionGroupEnabled(provider) {
    var key = String(provider || "").toLowerCase()
    // An explicit false has to survive, so test for the stored booleans rather
    // than falling through on a falsy value.
    if (sessionGroups[key] === true || sessionGroups[key] === false) return sessionGroups[key]
    return sessionGroupDefaults[key] === true
  }
  function setSessionGroup(provider, enabled) {
    var key = String(provider || "").toLowerCase()
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) return false
    var next = {}
    for (var name in sessionGroups) next[name] = sessionGroups[name]
    next[key] = !!enabled
    sessionGroups = next
    persist()
    return true
  }
  function toggleSessionGroup(provider) { return setSessionGroup(provider, !sessionGroupEnabled(provider)) }
  function setHideQuietSessions(enabled) { hideQuietSessions = !!enabled; persist() }
  function toggleHideQuietSessions() { setHideQuietSessions(!hideQuietSessions) }
  function setSessionQuietMinutes(minutes) {
    var value = Number(minutes)
    if (!isFinite(value) || value < 0 || value > 10080) return false
    sessionQuietMinutes = Math.round(value)
    persist()
    return true
  }
  function setNotificationsEnabled(enabled) { notificationsEnabled = !!enabled; persist() }
  function toggleNotificationsEnabled() { setNotificationsEnabled(!notificationsEnabled) }
  function setVideoAudio(enabled) { videoAudio = !!enabled; persist() }
  function toggleVideoAudio() { setVideoAudio(!videoAudio) }
  function setQuietHoursEnabled(enabled) { quietHoursEnabled = !!enabled; persist() }
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
    persist()
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
    persist()
    return true
  }
  function setSelectedOllamaModel(model) {
    var name = String(model || "")
    if (name && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,255}$/.test(name)) return false
    if (selectedOllamaModel === name) return true
    selectedOllamaModel = name
    persist()
    return true
  }
  function promptPinned(key) { return pinnedPrompts[key] === true }
  function togglePromptPin(key) {
    var next = {}
    for (var name in pinnedPrompts) next[name] = pinnedPrompts[name]
    if (next[key] === true) delete next[key]; else next[key] = true
    pinnedPrompts = next
    persist()
  }
  function changeSeen(key, fingerprint) { return !!fingerprint && seenChanges[key] === fingerprint }
  function markChangeSeen(key, fingerprint) {
    if (!key || !fingerprint || changeSeen(key, fingerprint)) return false
    var next = {}
    // Copy everything EXCEPT this key, then append it, so the just-updated
    // repository is newest in insertion order and survives prunedSeen().
    for (var name in seenChanges) if (name !== key) next[name] = seenChanges[name]
    next[key] = fingerprint
    seenChanges = next
    persist()
    return true
  }
  function setDashboardVisible(visible) {
    dashboardVisible = !!visible
    persist()
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
    persist()
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
  function rightIndex(id) { var index = rightOrder.indexOf(id); return index < 0 ? 99 : index }
  function moveRight(id, direction) {
    var next = normalizedRightOrder(rightOrder), from = next.indexOf(id), to = adjacentEnabledIndex(next, from, direction, sections)
    if (from < 0 || from === to) return false
    next.splice(from, 1); next.splice(to, 0, id)
    rightOrder = next
    persist()
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
    persist()
    return true
  }

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.applyConfig(text())
    onLoadFailed: root.applyConfig("{}")
    onFileChanged: reload()
  }
}
