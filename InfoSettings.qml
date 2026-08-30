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
    { id: "needs", label: "NEEDS YOU" },
    { id: "sessions", label: "SESSIONS" },
    { id: "activity", label: "ACTIVITY" },
    { id: "recent", label: "RECENT" },
    { id: "usage", label: "USAGE" },
    { id: "localAi", label: "LOCAL AI" },
    { id: "machine", label: "MACHINE" }
  ]
  property var sections: ({})
  property var attentionMuted: ({})
  property var pinnedPrompts: ({})
  // Stay hidden until the persisted value has loaded. This prevents a shell
  // restart from briefly re-enabling a dashboard the user turned off.
  property bool ready: false
  property bool dashboardVisible: false
  property var rightOrder: ["usage", "localAi", "machine"]

  function normalizedRightOrder(value) {
    var allowed = ["usage", "localAi", "machine"], result = []
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
      dashboardVisible = parsed && typeof parsed.dashboardVisible === "boolean" ? parsed.dashboardVisible : true
      rightOrder = normalizedRightOrder(parsed ? parsed.rightOrder : null)
    } catch (e) {
      sections = ({})
      attentionMuted = ({})
      pinnedPrompts = ({})
      dashboardVisible = true
      rightOrder = normalizedRightOrder(null)
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
  function persist(nextSections, nextMuted, nextPins, nextDashboardVisible, nextRightOrder) {
    configFile.setText(JSON.stringify({
      version: 2,
      sections: nextSections,
      attentionMuted: prunedMuted(nextMuted),
      pinnedPrompts: prunedPins(nextPins),
      dashboardVisible: nextDashboardVisible,
      rightOrder: normalizedRightOrder(nextRightOrder)
    }, null, 2) + "\n")
  }
  function sectionEnabled(id) { return sections[id] !== false }
  function setSection(id, enabled) {
    var next = {}
    for (var key in sections) next[key] = sections[key]
    next[id] = !!enabled
    sections = next
    persist(next, attentionMuted, pinnedPrompts, dashboardVisible, rightOrder)
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
    persist(sections, next, pinnedPrompts, dashboardVisible, rightOrder)
  }
  function snoozeAttention(key) { muteAttention(key, Date.now() + 10 * 60 * 1000) }
  function dismissAttention(key) { muteAttention(key, -1) }
  function promptPinned(key) { return pinnedPrompts[key] === true }
  function togglePromptPin(key) {
    var next = {}
    for (var name in pinnedPrompts) next[name] = pinnedPrompts[name]
    if (next[key] === true) delete next[key]; else next[key] = true
    pinnedPrompts = next
    persist(sections, attentionMuted, next, dashboardVisible, rightOrder)
  }
  function setDashboardVisible(visible) {
    dashboardVisible = !!visible
    persist(sections, attentionMuted, pinnedPrompts, dashboardVisible, rightOrder)
  }
  function toggleDashboardVisible() { setDashboardVisible(!dashboardVisible) }
  function rightIndex(id) { var index = rightOrder.indexOf(id); return index < 0 ? 99 : index }
  function moveRight(id, direction) {
    var next = normalizedRightOrder(rightOrder), from = next.indexOf(id), to = Math.max(0, Math.min(next.length - 1, from + Number(direction)))
    if (from < 0 || from === to) return false
    next.splice(from, 1); next.splice(to, 0, id)
    rightOrder = next
    persist(sections, attentionMuted, pinnedPrompts, dashboardVisible, next)
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
