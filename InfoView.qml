import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons

// The dashboard itself. Hosted by Infomarchy.qml (background layer) and Overlay.qml
// (summoned fullscreen). Everything is sized from Style.* and colored from the
// active theme via InfoModel, so it follows whatever Omarchy theme is set.
Item {
  id: view
  required property InfoModel desk
  property bool interactive: true
  property bool privacyMode: false
  signal navigated()

  function navigateTo(address) {
    if (!address) return
    view.desk.focusWindow(address)
    view.navigated()
  }
  // Room for the bar. The background layer ignores exclusion zones on purpose,
  // so we leave a top strip free instead of drawing under the bar.
  property int topInset: Math.round(40 * Style.fontScale)

  readonly property var snap: (desk && desk.snap) ? desk.snap : ({})
  readonly property var machine: snap.machine || ({})
  readonly property var ai: snap.ai || ({})
  readonly property var sessions: ai.sessions || []
  readonly property var attention: ai.attention || []
  readonly property var collisions: ai.collisions || []
  readonly property var usage: (ai && ai.usage) ? ai.usage : ({})
  readonly property int pad: Style.spacing.xl
  readonly property int gap: Style.spacing.lg
  readonly property int radius: Math.max(Style.cornerRadius, 0)
  readonly property color cardBg: Util.alpha(view.desk.themeBackground, 0.62)
  readonly property color cardBorder: Util.alpha(view.desk.themeForeground, 0.14)
  readonly property color textDim: Util.alpha(view.desk.themeForeground, 0.62)
  readonly property color textFaint: Util.alpha(view.desk.themeForeground, 0.38)
  readonly property string mono: Style.resolvedFontFamily

  component PlainText: Text { textFormat: Text.PlainText }

  // ---- reusable pieces -------------------------------------------------------
  component Card: Rectangle {
    id: card
    property string title: ""
    property string hint: ""
    default property alias content: body.data
    color: view.cardBg
    border.color: view.cardBorder
    border.width: 1
    radius: view.radius
    implicitHeight: col.implicitHeight + view.pad * 2
    // Swallow clicks on card chrome so the overlay's click-outside-to-close
    // only fires on the real backdrop.
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(m) { m.accepted = true } }
    ColumnLayout {
      id: col
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      RowLayout {
        Layout.fillWidth: true
        visible: card.title !== ""
        PlainText { text: card.title; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; font.letterSpacing: 1.5; font.bold: true }
        Item { Layout.fillWidth: true }
        PlainText { text: card.hint; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
      }
      Item { id: body; Layout.fillWidth: true; Layout.fillHeight: true; implicitHeight: childrenRect.height }
    }
  }

  component Meter: Item {
    property string label: ""
    property string value: ""
    property real fraction: 0
    property color tone: Color.accent
    implicitHeight: mrow.implicitHeight + bar.height + Style.spacing.xs
    width: parent ? parent.width : 200
    RowLayout {
      id: mrow
      width: parent.width
      PlainText { text: label; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
      Item { Layout.fillWidth: true }
      PlainText { text: value; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
    }
    Rectangle {
      id: bar
      anchors { top: mrow.bottom; topMargin: Style.spacing.xs; left: parent.left; right: parent.right }
      height: Math.max(3, Math.round(4 * Style.fontScale))
      radius: height / 2
      color: Util.alpha(view.desk.themeForeground, 0.10)
      Rectangle {
        width: parent.width * Math.max(0, Math.min(1, fraction))
        height: parent.height; radius: parent.radius; color: tone
        Behavior on width { NumberAnimation { duration: 400; easing.type: Easing.OutCubic } }
      }
    }
  }

  component Tag: Rectangle {
    property string text: ""
    property color tone: Color.accent
    color: Util.alpha(tone, 0.18)
    border.color: Util.alpha(tone, 0.5)
    border.width: 1
    radius: view.radius
    implicitWidth: tl.implicitWidth + Style.spacing.md * 2
    implicitHeight: tl.implicitHeight + Style.spacing.xs * 2
    PlainText { id: tl; anchors.centerIn: parent; text: parent.text; color: tone; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
  }

  // ---- layout ----------------------------------------------------------------
  Item {
    anchors { fill: parent; topMargin: view.topInset + view.gap; leftMargin: view.gap * 2; rightMargin: view.gap * 2; bottomMargin: view.gap * 2 }

    RowLayout {
      anchors.fill: parent
      spacing: view.gap

      // LEFT COLUMN: sessions + heatmap + recent
      ColumnLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.preferredWidth: 3
        spacing: view.gap

        Card {
          Layout.fillWidth: true
          visible: view.attention.length > 0 || view.collisions.length > 0 || view.privacyMode
          title: "NEEDS YOU"
          hint: view.privacyMode ? "PRIVACY MODE · sensitive details hidden" : view.attention.length + " signals · " + view.collisions.length + " shared repos"
          Flow {
            width: parent.width
            spacing: Style.spacing.md
            Repeater {
              model: view.attention
              delegate: Tag {
                required property var modelData
                text: (modelData.attention === "blocked" ? "⚠ BLOCKED" : modelData.attention === "waiting" ? "? WAITING" : "✓ REVIEW") + " · " + view.desk.providerLabel(modelData.provider) + " · " + (view.privacyMode ? "private" : modelData.project)
                tone: modelData.attention === "blocked" ? view.desk.red : modelData.attention === "waiting" ? view.desk.yellow : view.desk.green
                MouseArea {
                  anchors.fill: parent
                  enabled: view.interactive && !!(parent.modelData.window && parent.modelData.window.address)
                  cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: view.navigateTo(parent.modelData.window.address)
                }
              }
            }
            Repeater {
              model: view.collisions
              delegate: Tag { required property var modelData; text: "⚠ SHARED REPO · " + (view.privacyMode ? "private" : modelData.project) + " · " + modelData.agents.length + " agents"; tone: view.desk.yellow }
            }
            Tag { visible: view.privacyMode && view.attention.length === 0 && view.collisions.length === 0; text: "PRIVACY ON"; tone: view.desk.cyan }
          }
        }

        // ---- live sessions ----
        Card {
          Layout.fillWidth: true
          title: "LIVE AI SESSIONS"
          hint: view.sessions.length + " running · " + (view.privacyMode ? "private host" : (view.snap.host || "")) + (view.desk.error ? " · ⚠ " + view.desk.error : "")
          Flow {
            width: parent.width
            spacing: Style.spacing.md
            Repeater {
              model: view.sessions
              delegate: Rectangle {
                id: sc
                required property var modelData
                readonly property color tone: view.desk.providerColor(modelData.provider)
                // Prefer collector.busy (Grok's title sticks on 🧠 after the turn).
                // Fall back to the title regex for snapshots from an older collector.
                readonly property bool busy: modelData.busy === true || (modelData.busy !== false && modelData.window && /Processing|🧠|⚙|⏳|…/.test(String(modelData.window.title || "")))
                width: Math.round(250 * Style.fontScale); height: scol.implicitHeight + Style.spacing.lg * 2
                color: hover.containsMouse ? Util.alpha(tone, 0.16) : Util.alpha(tone, 0.08)
                border.color: Util.alpha(tone, hover.containsMouse ? 0.9 : 0.45); border.width: 1; radius: view.radius
                ColumnLayout {
                  id: scol
                  anchors { fill: parent; margins: Style.spacing.lg }
                  spacing: Style.spacing.xs
                  RowLayout {
                    Layout.fillWidth: true
                    Rectangle { id: dot; width: 8; height: 8; radius: 4; color: sc.tone
                      SequentialAnimation { running: sc.busy; loops: Animation.Infinite
                        onRunningChanged: if (!running) dot.opacity = 1
                        NumberAnimation { target: dot; property: "opacity"; from: 1; to: 0.2; duration: 700 }
                        NumberAnimation { target: dot; property: "opacity"; from: 0.2; to: 1; duration: 700 } } }
                    PlainText { text: view.desk.providerLabel(sc.modelData.provider); color: sc.tone; font.family: view.mono; font.bold: true; font.pixelSize: Style.font.body }
                    Item { Layout.fillWidth: true }
                    PlainText { text: view.desk.dur(sc.modelData.uptimeSec); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                  }
                  PlainText { Layout.fillWidth: true; text: view.privacyMode ? "private project" : (sc.modelData.project || "/"); color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.subtitle; elide: Text.ElideMiddle }
                  PlainText { Layout.fillWidth: true; text: view.privacyMode ? "path hidden" : (sc.modelData.cwd || ""); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideMiddle }
                  PlainText { Layout.fillWidth: true; visible: !!(sc.modelData.window && sc.modelData.window.title); text: view.privacyMode ? "task hidden" : (sc.modelData.window ? (sc.modelData.window.title || "") : ""); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                  PlainText { Layout.fillWidth: true; visible: !!sc.modelData.git; text: sc.modelData.git ? ("git " + sc.modelData.git.branch + (sc.modelData.git.dirty ? " · " + sc.modelData.git.dirty + " changed" : " · clean") + (sc.modelData.git.ahead ? " · ↑" + sc.modelData.git.ahead : "") + (sc.modelData.git.behind ? " · ↓" + sc.modelData.git.behind : "") + (sc.modelData.git.conflicts ? " · " + sc.modelData.git.conflicts + " conflicts" : "")) : ""; color: sc.modelData.git && sc.modelData.git.conflicts ? view.desk.red : sc.modelData.git && sc.modelData.git.dirty ? view.desk.yellow : view.desk.green; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                  PlainText { Layout.fillWidth: true; text: "pid " + sc.modelData.pid + (sc.modelData.window ? "  ·  ws " + sc.modelData.window.workspace : "  ·  no window"); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                }
                MouseArea {
                  id: hover; anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
                  cursorShape: sc.modelData.window ? Qt.PointingHandCursor : Qt.ArrowCursor
                  acceptedButtons: Qt.LeftButton
                  onClicked: if (sc.modelData.window) view.navigateTo(sc.modelData.window.address)
                }
              }
            }
            PlainText { visible: view.sessions.length === 0; text: view.desk.ready ? "no agents running — go start something" : "collecting…"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.body }
          }
        }

        // ---- heatmap ----
        Card {
          Layout.fillWidth: true
          title: "ACTIVITY · LAST 7 DAYS"
          hint: {
            var c = view.ai.counts || {}; var parts = []
            for (var k in c) parts.push(view.desk.providerLabel(k) + " " + c[k].today + "/" + c[k].week)
            return parts.length ? "today/week · " + parts.join(" · ") : ""
          }
          Item {
            width: parent.width
            implicitHeight: heat.height + Style.spacing.md + legend.implicitHeight
            Canvas {
              id: heat
              width: parent.width
              height: Math.round(7 * 16 * Style.fontScale)
              property var cells: (view.ai.heatmap || {}).cells || []
              property real startTs: (view.ai.heatmap || {}).start || 0
              property var days: (view.ai.heatmap || {}).days || []
              property int hoverIdx: -1
              function dayTs(index) { return days[index] || (startTs + index * 86400000) }
              onCellsChanged: requestPaint()
              Connections { target: view.desk; function onGreenChanged() { heat.requestPaint() } function onThemeForegroundChanged() { heat.requestPaint() } }
              onPaint: {
                var ctx = getContext("2d"); ctx.reset()
                var labelW = Math.round(34 * Style.fontScale)
                var cw = (width - labelW) / 24, ch = height / 7
                var maxN = 1
                for (var i = 0; i < cells.length; i++) if (cells[i][0] > maxN) maxN = cells[i][0]
                ctx.font = Style.font.caption + "px \"" + view.mono + "\""
                ctx.textBaseline = "middle"
                var days = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
                for (var d = 0; d < 7; d++) {
                  var dt = new Date(dayTs(d))
                  ctx.fillStyle = Qt.rgba(view.textFaint.r, view.textFaint.g, view.textFaint.b, view.textFaint.a)
                  ctx.fillText(days[dt.getDay()], 0, d * ch + ch / 2)
                  for (var h = 0; h < 24; h++) {
                    var idx = d * 24 + h
                    var c = cells[idx] || [0, {}]
                    var n = c[0], x = labelW + h * cw, y = d * ch
                    var base = view.desk.themeForeground
                    ctx.fillStyle = Qt.rgba(base.r, base.g, base.b, 0.05)
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2)
                    if (n > 0) {
                      // dominant provider colors the cell; intensity = count
                      var best = "", bn = 0
                      for (var k in c[1]) if (c[1][k] > bn) { bn = c[1][k]; best = k }
                      var col = view.desk.providerColor(best)
                      var a = 0.25 + 0.75 * Math.min(1, n / maxN)
                      ctx.fillStyle = Qt.rgba(col.r, col.g, col.b, a)
                      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2)
                    }
                    if (idx === hoverIdx) { ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, 0.9); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1) }
                  }
                }
                // "now" marker
                var nowD = new Date(), nd = -1
                for (var di = 0; di < 7; di++) {
                  var markerDay = new Date(dayTs(di))
                  if (markerDay.getFullYear() === nowD.getFullYear() && markerDay.getMonth() === nowD.getMonth() && markerDay.getDate() === nowD.getDate()) { nd = di; break }
                }
                if (nd >= 0 && nd < 7) {
                  var nx = labelW + (nowD.getHours() + nowD.getMinutes() / 60) * cw
                  ctx.strokeStyle = Qt.rgba(view.desk.red.r, view.desk.red.g, view.desk.red.b, 0.8)
                  ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(nx, nd * ch); ctx.lineTo(nx, nd * ch + ch); ctx.stroke()
                }
              }
              MouseArea {
                anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
                onPositionChanged: function(m) {
                  var labelW = Math.round(34 * Style.fontScale)
                  var cw = (heat.width - labelW) / 24, ch = heat.height / 7
                  var h = Math.floor((m.x - labelW) / cw), d = Math.floor(m.y / ch)
                  heat.hoverIdx = (h >= 0 && h < 24 && d >= 0 && d < 7) ? d * 24 + h : -1
                  heat.requestPaint()
                }
                onExited: { heat.hoverIdx = -1; heat.requestPaint() }
              }
            }
            RowLayout {
              id: legend
              anchors { top: heat.bottom; topMargin: Style.spacing.md; left: parent.left; right: parent.right }
              spacing: Style.spacing.lg
              Repeater {
                model: ["claude", "codex", "grok", "gemini", "ollama"]
                delegate: RowLayout { required property string modelData; spacing: Style.spacing.xs
                  Rectangle { width: 8; height: 8; radius: 2; color: view.desk.providerColor(modelData) }
                  PlainText { text: view.desk.providerLabel(modelData); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption } }
              }
              Item { Layout.fillWidth: true }
              PlainText {
                text: {
                  if (heat.hoverIdx < 0) return "hover a cell · red tick = now"
                  var c = heat.cells[heat.hoverIdx] || [0, {}]
                  var d = Math.floor(heat.hoverIdx / 24), h = heat.hoverIdx % 24
                  var dt = new Date(heat.dayTs(d))
                  var parts = []; for (var k in c[1]) parts.push(view.desk.providerLabel(k) + " " + c[1][k])
                  return Qt.formatDate(dt, "ddd d MMM") + " " + (h < 10 ? "0" : "") + h + ":00 · " + c[0] + " prompts" + (parts.length ? " (" + parts.join(", ") + ")" : "")
                }
                color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption
              }
            }
          }
        }

        // ---- recent prompts / task history ----
        Card {
          Layout.fillWidth: true
          Layout.fillHeight: true
          title: "RECENT TASKS · WHAT GOT ASKED"
          hint: view.privacyMode ? "hidden · press P in overlay to reveal" : "newest first"
          clip: true
          ListView {
            id: recentList
            width: parent.width
            height: parent.height > 0 ? parent.height : 300
            model: view.ai.recent || []
            spacing: Style.spacing.xs
            clip: true
            interactive: view.interactive
            delegate: Item {
              id: ri
              required property var modelData
              width: recentList.width
              height: rrow.implicitHeight + Style.spacing.sm
              RowLayout {
                id: rrow; width: parent.width; spacing: Style.spacing.md
                PlainText { text: view.desk.ago(ri.modelData.ts); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(28 * Style.fontScale); horizontalAlignment: Text.AlignRight }
                Tag { text: view.desk.providerLabel(ri.modelData.provider); tone: view.desk.providerColor(ri.modelData.provider) }
                PlainText { text: view.privacyMode ? "private" : (ri.modelData.project || "").replace(/^.*\//, "") ; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(110 * Style.fontScale); elide: Text.ElideLeft }
                PlainText { Layout.fillWidth: true; text: view.privacyMode ? "prompt hidden" : (ri.modelData.text || ""); color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight; maximumLineCount: 1 }
              }
            }
          }
        }
      }

      // RIGHT COLUMN: usage + local AI + machine corner
      ColumnLayout {
        Layout.fillHeight: true
        Layout.preferredWidth: Math.round(330 * Style.fontScale)
        Layout.maximumWidth: Math.round(380 * Style.fontScale)
        Layout.minimumWidth: Math.round(290 * Style.fontScale)
        spacing: view.gap

        // ---- subscription usage (from omarchy.agents cache when present) ----
        Card {
          Layout.fillWidth: true
          title: "USAGE & LIMITS"
          hint: {
            var keys = Object.keys(view.usage); return keys.length ? "via omarchy agents" : "enable the Agents bar widget"
          }
          ColumnLayout {
            width: parent.width
            spacing: Style.spacing.md
            Repeater {
              model: Object.keys(view.usage).filter(function(k) { return view.usage[k] && view.usage[k].ready !== false })
              delegate: ColumnLayout {
                id: up
                required property string modelData
                readonly property var u: view.usage[modelData] || ({})
                readonly property color tone: view.desk.providerColor(modelData)
                Layout.fillWidth: true
                spacing: Style.spacing.xs
                RowLayout {
                  Layout.fillWidth: true
                  PlainText { text: up.u.name || up.modelData; color: up.tone; font.family: view.mono; font.bold: true; font.pixelSize: Style.font.body }
                  PlainText { text: up.u.tierLabel || ""; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                  Item { Layout.fillWidth: true }
                  PlainText { text: "today " + (up.u.todayPrompts || 0) + "p · " + view.desk.tokens(up.u.todayTotalTokens) + " tok"; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption }
                }
                Repeater {
                  model: up.u.limits || []
                  delegate: Meter {
                    required property var modelData
                    Layout.fillWidth: true
                    label: modelData.label || modelData.title || ""
                    value: Math.round((modelData.percent || 0) * 100) + "%" + (modelData.resetsAt ? "  ↻ " + view.desk.until(Date.parse(modelData.resetsAt)) : "")
                    fraction: modelData.percent || 0
                    tone: (modelData.percent || 0) > 0.85 ? view.desk.red : (modelData.percent || 0) > 0.6 ? view.desk.yellow : up.tone
                  }
                }
              }
            }
            PlainText { visible: Object.keys(view.usage).length === 0; text: "no usage cache yet"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
          }
        }

        // ---- local AI ----
        Card {
          Layout.fillWidth: true
          title: "LOCAL AI"
          readonly property var ol: (view.ai.providers || {}).ollama || ({})
          hint: ol.up ? "ollama up · " + (ol.modelCount || 0) + " models" : "ollama down"
          ColumnLayout {
            width: parent.width
            spacing: Style.spacing.sm
            Repeater {
              model: ((view.ai.providers || {}).ollama || {}).loaded || []
              delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                Rectangle { width: 8; height: 8; radius: 4; color: view.desk.green }
                PlainText { text: modelData.name; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; Layout.fillWidth: true; elide: Text.ElideRight }
                PlainText { text: "vram " + view.desk.bytes(modelData.vram); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption }
              }
            }
            PlainText { visible: !((((view.ai.providers || {}).ollama || {}).loaded || []).length); text: "no model loaded"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
            Meter {
              visible: !!view.machine.gpu
              Layout.fillWidth: true
              label: view.machine.gpu ? "GPU " + String(view.machine.gpu.name).replace(/NVIDIA |GeForce |Laptop GPU/g, "") : "GPU"
              value: view.machine.gpu ? view.machine.gpu.util + "% · " + view.desk.bytes(view.machine.gpu.memUsed) + "/" + view.desk.bytes(view.machine.gpu.memTotal) + " · " + view.machine.gpu.temp + "°" : ""
              fraction: view.machine.gpu ? view.machine.gpu.memUsed / Math.max(1, view.machine.gpu.memTotal) : 0
              tone: view.desk.green
            }
            RowLayout {
              id: provRow
              Layout.fillWidth: true
              readonly property var ps: view.ai.providers || ({})
              Tag { visible: !!(provRow.ps.claude && provRow.ps.claude.present); text: "claude " + (provRow.ps.claude ? provRow.ps.claude.prompts : 0) + "p"; tone: view.desk.providerColor("claude") }
              Tag { visible: !!(provRow.ps.codex && provRow.ps.codex.present); text: "codex " + (provRow.ps.codex ? provRow.ps.codex.threadCount : 0) + " threads"; tone: view.desk.providerColor("codex") }
              Tag { visible: !!(provRow.ps.grok && provRow.ps.grok.present); text: "grok " + (provRow.ps.grok ? provRow.ps.grok.sessions : 0) + " sess"; tone: view.desk.providerColor("grok") }
              Item { Layout.fillWidth: true }
            }
          }
        }

        Item { Layout.fillHeight: true }

        // ---- machine corner (the boring stats) ----
        Card {
          Layout.fillWidth: true
          title: "MACHINE"
          hint: (view.privacyMode ? "private host" : ((view.snap.user ? view.snap.user + "@" : "") + (view.snap.host || ""))) + " · up " + view.desk.dur(view.machine.uptime)
          readonly property var net: view.machine.net || ({})
          readonly property var mem: view.machine.mem || ({})
          readonly property var cpu: view.machine.cpu || ({})
          readonly property var ping: view.machine.ping || ({})
          readonly property var disks: view.machine.disks || []
          readonly property var bat: view.machine.battery
          id: mc
          ColumnLayout {
            width: parent.width
            spacing: Style.spacing.md
            Meter { Layout.fillWidth: true; label: "CPU"; value: view.desk.pct(mc.cpu.pct) + "  load " + ((mc.cpu.load || [0])[0] || 0).toFixed(2) + (view.machine.temp ? "  " + Math.round(view.machine.temp) + "°" : ""); fraction: (mc.cpu.pct || 0) / 100; tone: (mc.cpu.pct || 0) > 85 ? view.desk.red : view.desk.blue }
            Meter { Layout.fillWidth: true; label: "RAM"; value: view.desk.bytes(mc.mem.used) + " / " + view.desk.bytes(mc.mem.total) + "  " + view.desk.pct(mc.mem.pct); fraction: (mc.mem.pct || 0) / 100; tone: (mc.mem.pct || 0) > 90 ? view.desk.red : view.desk.green }
            Repeater {
              model: mc.disks
              delegate: Meter { required property var modelData; Layout.fillWidth: true; label: "DISK " + modelData.mount; value: view.desk.bytes(modelData.used) + " / " + view.desk.bytes(modelData.size) + "  " + view.desk.pct(modelData.pct); fraction: (modelData.pct || 0) / 100; tone: (modelData.pct || 0) > 90 ? view.desk.red : view.desk.yellow }
            }
            Meter {
              Layout.fillWidth: true
              label: mc.net.wireless ? "WIFI " + (view.privacyMode ? "private" : (mc.net.ssid || "")) : "NET " + (mc.net.dev || "—")
              value: (mc.net.signal !== null && mc.net.signal !== undefined ? mc.net.signal + " dBm" : "") + (view.privacyMode ? "" : " · " + (mc.net.addr || ""))
              // -30 dBm great … -90 dBm dead
              fraction: mc.net.signal !== null && mc.net.signal !== undefined ? Math.max(0, Math.min(1, (Number(mc.net.signal) + 90) / 60)) : (mc.net.dev ? 1 : 0)
              tone: mc.net.signal !== null && mc.net.signal !== undefined && Number(mc.net.signal) < -75 ? view.desk.yellow : view.desk.green
            }
            RowLayout {
              Layout.fillWidth: true
              spacing: Style.spacing.lg
              PlainText { text: "↓ " + view.desk.rate(mc.net.rxRate); color: view.desk.green; font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true }
              PlainText { text: "↑ " + view.desk.rate(mc.net.txRate); color: view.desk.green; font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true }
              Item { Layout.fillWidth: true }
              PlainText {
                text: "⇄ " + (mc.ping.ok ? mc.ping.ms.toFixed(0) + " ms" : "timeout") + " cf"
                color: !mc.ping.ok ? view.desk.red : mc.ping.ms > 80 ? view.desk.yellow : view.desk.green
                font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true
              }
            }
            RowLayout {
              Layout.fillWidth: true
              visible: !!mc.bat
              PlainText { text: "BAT"; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
              Item { Layout.fillWidth: true }
              PlainText { text: mc.bat ? mc.bat.pct + "% · " + mc.bat.status : ""; color: mc.bat && mc.bat.pct < 20 && mc.bat.status !== "Charging" ? view.desk.red : view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
            }
          }
        }
      }
    }
  }
}
