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
    { id: "recent", label: "RECENT" },
    { id: "usage", label: "USAGE" },
    { id: "localAi", label: "LOCAL AI" },
    { id: "machine", label: "MACHINE" },
    { id: "changes", label: "CHANGES" },
    { id: "projects", label: "PROJECTS" }
  ]
  property var sections: ({})
  property var attentionMuted: ({})
  property var pinnedPrompts: ({})
  property var seenChanges: ({})
  // Stay hidden until the persisted value has loaded. This prevents a shell
  // restart from briefly re-enabling a dashboard the user turned off.
  property bool ready: false
  property bool dashboardVisible: false
  property var rightOrder: ["usage", "localAi", "machine"]
  property var opsOrder: ["changes", "needs", "projects"]

  function normalizedRightOrder(value) {
    var allowed = ["usage", "localAi", "machine"], result = []
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
      dashboardVisible = parsed && typeof parsed.dashboardVisible === "boolean" ? parsed.dashboardVisible : true
      rightOrder = normalizedRightOrder(parsed ? parsed.rightOrder : null)
      opsOrder = normalizedOpsOrder(parsed ? parsed.opsOrder : null)
    } catch (e) {
      sections = ({})
      attentionMuted = ({})
      pinnedPrompts = ({})
      seenChanges = ({})
      dashboardVisible = true
      rightOrder = normalizedRightOrder(null)
      opsOrder = normalizedOpsOrder(null)
    }
    ready = true
  }
  function persist() {
    configFile.setText(JSON.stringify({
      version: 3,
      sections: sections,
      attentionMuted: attentionMuted,
      pinnedPrompts: pinnedPrompts,
      seenChanges: seenChanges,
      dashboardVisible: dashboardVisible,
      rightOrder: normalizedRightOrder(rightOrder),
      opsOrder: normalizedOpsOrder(opsOrder)
    }, null, 2) + "\n")
  }
  function sectionEnabled(id) { return sections[id] !== false }
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
    for (var name in seenChanges) next[name] = seenChanges[name]
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
  function rightIndex(id) { var index = rightOrder.indexOf(id); return index < 0 ? 99 : index }
  function moveRight(id, direction) {
    var next = normalizedRightOrder(rightOrder), from = next.indexOf(id), to = Math.max(0, Math.min(next.length - 1, from + Number(direction)))
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
    var next = normalizedOpsOrder(opsOrder), from = next.indexOf(id), to = Math.max(0, Math.min(next.length - 1, from + Number(direction)))
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
