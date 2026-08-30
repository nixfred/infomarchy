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
  required property InfoSettings settings
  property bool interactive: true
  property int activityCellFilter: -1
  property string activityProviderFilter: ""
  property var inspectedSession: null
  property var selectedPrompt: null
  property string usageProviderFilter: ""
  property bool usageForecastMode: false
  property bool previewsEnabled: false
  property int keyboardSessionIndex: -1
  property string promptSearch: ""
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
  readonly property var visibleAttention: {
    var source = attention, stamp = Number(snap.ts || Date.now())
    return source.filter(function(item) { return settings.attentionVisible(attentionKey(item), stamp) })
  }
  readonly property var collisions: ai.collisions || []
  readonly property var usage: (ai && ai.usage) ? ai.usage : ({})
  readonly property bool activityFilterActive: sectionEnabled("activity") && (activityCellFilter >= 0 || activityProviderFilter !== "")
  readonly property var visibleRecentTasks: {
    var rows = ai.recent || []
    var chosen = !activityFilterActive ? rows : rows.filter(function(row) {
      return (activityCellFilter < 0 || Number(row.activityCell) === activityCellFilter) &&
        (!activityProviderFilter || String(row.provider) === activityProviderFilter)
    })
    var query = String(promptSearch || "").trim().toLowerCase()
    if (query) chosen = chosen.filter(function(row) {
      return (String(row.text || "") + " " + String(row.project || "") + " " + String(row.provider || "")).toLowerCase().indexOf(query) >= 0
    })
    var limit = query || activityFilterActive ? 200 : 80
    return chosen.slice(0, limit).sort(function(a, b) { return Number(settings.promptPinned(promptKey(b))) - Number(settings.promptPinned(promptKey(a))) || Number(b.ts || 0) - Number(a.ts || 0) })
  }
  readonly property int pad: Style.spacing.xl
  readonly property int gap: Style.spacing.lg
  readonly property int radius: Math.max(Style.cornerRadius, 0)
  readonly property color cardBg: Util.alpha(view.desk.themeBackground, 0.62)
  readonly property color cardBorder: Util.alpha(view.desk.themeForeground, 0.14)
  readonly property color textDim: Util.alpha(view.desk.themeForeground, 0.62)
  readonly property color textFaint: Util.alpha(view.desk.themeForeground, 0.38)
  readonly property string mono: Style.resolvedFontFamily

  component PlainText: Text { textFormat: Text.PlainText }

  function sectionEnabled(id) { return view.settings.sectionEnabled(id) }
  function attentionKey(item) { return String(item.provider || "") + ":" + String(item.pid || "") + ":" + String(item.attention || "") }
  function promptKey(item) { return String(item.provider || "") + ":" + String(item.session || "") + ":" + String(item.ts || "") }
  function usageWindowMs(label) { return /week|7-day/i.test(String(label || "")) ? 7 * 86400000 : /session|5-hour/i.test(String(label || "")) ? 5 * 3600000 : 0 }
  function usageProjection(limit) {
    var duration = usageWindowMs(limit.label || limit.title), remaining = Date.parse(limit.resetsAt || "") - Date.now(), elapsed = duration - remaining
    if (!duration || !isFinite(remaining) || remaining < 0 || elapsed < duration * 0.03) return null
    return Math.max(0, Number(limit.percent || 0) * duration / elapsed)
  }
  function keyboardStep(delta) {
    if (!sessions.length) { keyboardSessionIndex = -1; return }
    keyboardSessionIndex = (keyboardSessionIndex + Number(delta) + sessions.length) % sessions.length
  }
  function activateKeyboardSession() {
    var session = sessions[keyboardSessionIndex]
    if (session && session.window && session.window.address) navigateTo(session.window.address)
  }
  function toggleActivityCell(index) { activityCellFilter = activityCellFilter === index ? -1 : index }
  function toggleActivityProvider(provider) { activityProviderFilter = activityProviderFilter === provider ? "" : provider }
  function clearActivityFilter() { activityCellFilter = -1; activityProviderFilter = "" }
  function activityFilterLabel() {
    var parts = []
    if (activityCellFilter >= 0) {
      var days = (ai.heatmap || {}).days || []
      var day = Math.floor(activityCellFilter / 24), hour = activityCellFilter % 24
      var dt = new Date(days[day] || 0)
      if (Number(days[day] || 0) > 0) parts.push(Qt.formatDate(dt, "ddd d MMM") + " " + (hour < 10 ? "0" : "") + hour + ":00")
    }
    if (activityProviderFilter) parts.push(desk.providerLabel(activityProviderFilter))
    return parts.join(" · ")
  }

  // ---- reusable pieces -------------------------------------------------------
  component Card: Rectangle {
    id: card
    property string title: ""
    property string hint: ""
    property string moveId: ""
    property bool draggable: false
    property bool dragging: false
    property real dragOffset: 0
    property bool glow: false
    property color glowTone: view.desk.yellow
    default property alias content: body.data
    color: view.cardBg
    border.color: view.cardBorder
    border.width: 1
    radius: view.radius
    z: card.dragging ? 50 : 0
    transform: Translate { y: card.dragOffset }
    Behavior on dragOffset {
      enabled: !card.dragging
      NumberAnimation { duration: 170; easing.type: Easing.OutBack }
    }
    Rectangle {
      anchors { fill: parent; margins: -3 }
      z: -1
      visible: card.glow
      color: "transparent"
      radius: card.radius + 3
      border.width: 2
      border.color: card.glowTone
      SequentialAnimation on opacity {
        running: card.glow && card.visible
        loops: Animation.Infinite
        NumberAnimation { from: 0.12; to: 0.42; duration: 1200; easing.type: Easing.InOutSine }
        NumberAnimation { from: 0.42; to: 0.12; duration: 1200; easing.type: Easing.InOutSine }
      }
    }
    implicitHeight: col.implicitHeight + view.pad * 2
    // Swallow clicks on card chrome so the overlay's click-outside-to-close
    // only fires on the real backdrop.
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(m) { m.accepted = true } }
    ColumnLayout {
      id: col
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      Item {
        id: cardHeader
        Layout.fillWidth: true
        implicitHeight: cardHeaderRow.implicitHeight
        visible: card.title !== ""
        RowLayout {
          id: cardHeaderRow
          anchors.fill: parent
          PlainText { visible: card.draggable; text: "⋮⋮"; color: card.dragging ? view.desk.cyan : view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
          PlainText { text: card.title; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; font.letterSpacing: 1.5; font.bold: true }
          Item { Layout.fillWidth: true }
          PlainText { text: card.hint; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
        }
        MouseArea {
          anchors.fill: parent
          z: 2
          enabled: view.interactive && card.draggable
          hoverEnabled: true
          cursorShape: enabled ? (pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor) : Qt.ArrowCursor
          property real pressViewY: 0
          onPressed: function(mouse) {
            pressViewY = mapToItem(view, mouse.x, mouse.y).y
            card.dragging = true
            mouse.accepted = true
          }
          onPositionChanged: function(mouse) {
            if (!pressed) return
            var pointerY = mapToItem(view, mouse.x, mouse.y).y
            card.dragOffset = Math.max(-card.height * 0.7, Math.min(card.height * 0.7, pointerY - pressViewY))
          }
          onReleased: function(mouse) {
            var threshold = Math.min(card.height * 0.24, Math.round(46 * Style.fontScale))
            if (Math.abs(card.dragOffset) >= threshold) view.settings.moveRight(card.moveId, card.dragOffset > 0 ? 1 : -1)
            card.dragging = false
            card.dragOffset = 0
            mouse.accepted = true
          }
          onCanceled: { card.dragging = false; card.dragOffset = 0 }
        }
      }
      Item {
        id: body
        Layout.fillWidth: true
        Layout.fillHeight: true
        // Flexible cards such as Recent Tasks intentionally size their children
        // from this item. Only use a sole content item's implicit size here, so
        // that parent-sized children cannot form an implicit-height loop.
        implicitHeight: children.length === 1 ? Number(children[0].implicitHeight || 0) : 0
      }
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

  component SectionChip: Rectangle {
    id: sectionChip
    required property var section
    readonly property bool selected: view.settings.sectionEnabled(section.id)
    readonly property bool needsAttention: section.id === "needs" && view.visibleAttention.length > 0
    color: Util.alpha(selected ? view.desk.green : view.desk.themeForeground, selected ? 0.13 : 0.035)
    border.color: Util.alpha(selected ? view.desk.green : view.desk.themeForeground, selected ? 0.45 : 0.13)
    border.width: 1
    SequentialAnimation on opacity {
      running: sectionChip.needsAttention
      loops: Animation.Infinite
      NumberAnimation { from: 0.72; to: 1; duration: 1200; easing.type: Easing.InOutSine }
      NumberAnimation { from: 1; to: 0.72; duration: 1200; easing.type: Easing.InOutSine }
    }
    radius: view.radius
    implicitWidth: sectionLabel.implicitWidth + Style.spacing.lg * 2
    implicitHeight: sectionLabel.implicitHeight + Style.spacing.xs * 2
    PlainText {
      id: sectionLabel
      anchors.centerIn: parent
      text: (parent.selected ? "● " : "○ ") + parent.section.label
      color: parent.selected ? view.textDim : view.textFaint
      font.family: view.mono
      font.pixelSize: Style.font.caption
      font.bold: parent.selected
    }
    MouseArea {
      anchors.fill: parent
      enabled: view.interactive
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: view.settings.toggleSection(parent.section.id)
    }
  }

  // ---- layout ----------------------------------------------------------------
  Item {
    anchors { fill: parent; topMargin: view.topInset + view.gap; leftMargin: view.gap * 2; rightMargin: view.gap * 2; bottomMargin: view.gap * 2 }

    ColumnLayout {
      anchors.fill: parent
      spacing: Style.spacing.sm

      Flow {
        id: moduleStrip
        Layout.fillWidth: true
        Layout.preferredHeight: implicitHeight
        spacing: Style.spacing.sm
        Repeater {
          model: view.settings.definitions
          delegate: SectionChip { required property var modelData; section: modelData }
        }
        Tag { text: "1–7 MODULES · J/K SESSION · ENTER FOCUS · A CLEAR"; tone: view.textFaint }
      }

      RowLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        spacing: view.gap

      // LEFT COLUMN: sessions + heatmap + recent
      ColumnLayout {
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.preferredWidth: 3
        spacing: view.gap

        Card {
          Layout.fillWidth: true
          visible: view.sectionEnabled("needs") && (view.visibleAttention.length > 0 || view.collisions.length > 0)
          title: "NEEDS YOU"
          hint: view.visibleAttention.length + " signals · " + view.collisions.length + " shared repos"
          glow: view.visibleAttention.length > 0
          glowTone: view.desk.yellow
          Flow {
            width: parent.width
            spacing: Style.spacing.md
            Repeater {
              model: view.visibleAttention
              delegate: RowLayout {
                id: attentionRow
                required property var modelData
                readonly property color tone: modelData.attention === "blocked" ? view.desk.red : modelData.attention === "waiting" ? view.desk.yellow : view.desk.green
                spacing: Style.spacing.xs
                Tag {
                  text: (attentionRow.modelData.attention === "blocked" ? "⚠ BLOCKED" : attentionRow.modelData.attention === "waiting" ? "? WAITING" : "✓ REVIEW") + " · " + view.desk.providerLabel(attentionRow.modelData.provider) + " · " + attentionRow.modelData.project
                  tone: attentionRow.tone
                  MouseArea { anchors.fill: parent; enabled: view.interactive && !!(attentionRow.modelData.window && attentionRow.modelData.window.address); cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: view.navigateTo(attentionRow.modelData.window.address) }
                }
                Tag { text: "10M"; tone: view.textDim; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.snoozeAttention(view.attentionKey(attentionRow.modelData)) } }
                Tag { text: "×"; tone: view.textFaint; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.dismissAttention(view.attentionKey(attentionRow.modelData)) } }
              }
            }
            Repeater {
              model: view.collisions
              delegate: Tag { required property var modelData; text: "⚠ SHARED REPO · " + modelData.project + " · " + modelData.agents.length + " agents"; tone: view.desk.yellow }
            }
          }
        }

        // ---- live sessions ----
        Card {
          Layout.fillWidth: true
          visible: view.sectionEnabled("sessions")
          title: "LIVE AI SESSIONS"
          hint: view.sessions.length + " running · left focus · right inspect" + (view.desk.error ? " · ⚠ " + view.desk.error : "")
          Flow {
            id: sessionFlow
            width: parent.width
            spacing: Style.spacing.md
            readonly property int targetColumns: 4
            readonly property int minimumCardWidth: Math.round(210 * Style.fontScale)
            readonly property int fittedCardWidth: Math.floor((width - spacing * (targetColumns - 1)) / targetColumns)
            Repeater {
              model: view.sessions
              delegate: Rectangle {
                id: sc
                required property var modelData
                required property int index
                readonly property color tone: view.desk.providerColor(modelData.provider)
                // Prefer collector.busy (Grok's title sticks on 🧠 after the turn).
                // Fall back to the title regex for snapshots from an older collector.
                readonly property bool busy: modelData.busy === true || (modelData.busy !== false && modelData.window && /Processing|🧠|⚙|⏳|…/.test(String(modelData.window.title || "")))
                property string previewSource: ""
                // Fill four columns when they remain readable; narrower layouts
                // retain a minimum width and let Flow wrap naturally.
                width: Math.max(sessionFlow.minimumCardWidth, sessionFlow.fittedCardWidth); height: scol.implicitHeight + Style.spacing.lg * 2
                color: hover.containsMouse ? Util.alpha(tone, 0.16) : Util.alpha(tone, 0.08)
                border.color: view.keyboardSessionIndex === index ? tone : Util.alpha(tone, hover.containsMouse ? 0.9 : 0.45); border.width: view.keyboardSessionIndex === index ? 2 : 1; radius: view.radius
                Image { anchors.fill: parent; visible: hover.containsMouse && view.previewsEnabled && sc.previewSource !== ""; source: sc.previewSource; fillMode: Image.PreserveAspectCrop; opacity: 0.28 }
                Timer { interval: 600; running: hover.containsMouse && view.previewsEnabled && sc.previewSource === "" && !!(sc.modelData.window && sc.modelData.window.address); onTriggered: if (!previewProc.running) previewProc.running = true }
                Process {
                  id: previewProc
                  command: ["bun", Qt.resolvedUrl("window-preview.ts").toString().replace(/^file:\/\//, ""), (sc.modelData.window || {}).address || ""]
                  stdout: StdioCollector { onStreamFinished: { var path = String(text || "").trim(); if (path) sc.previewSource = "file://" + path + "?" + Date.now() } }
                }
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
                  PlainText { Layout.fillWidth: true; text: sc.modelData.project || "/"; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.subtitle; elide: Text.ElideMiddle }
                  PlainText {
                    Layout.fillWidth: true
                    text: sc.modelData.topic ? "↳ " + sc.modelData.topic : "↳ " + ((sc.modelData.window || {}).title || "topic unavailable")
                    color: sc.modelData.topic ? sc.tone : view.textDim
                    font.family: view.mono
                    font.pixelSize: Style.font.bodySmall
                    font.bold: !!sc.modelData.topic
                    wrapMode: Text.Wrap
                    maximumLineCount: 2
                    elide: Text.ElideRight
                  }
                  PlainText { Layout.fillWidth: true; text: sc.modelData.cwd || ""; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideMiddle }
                  PlainText { Layout.fillWidth: true; visible: !!sc.modelData.topic && !!(sc.modelData.window && sc.modelData.window.title); text: sc.modelData.window ? (sc.modelData.window.title || "") : ""; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                  PlainText { Layout.fillWidth: true; visible: !!sc.modelData.git; text: sc.modelData.git ? ("git " + sc.modelData.git.branch + (sc.modelData.git.dirty ? " · " + sc.modelData.git.dirty + " changed" : " · clean") + (sc.modelData.git.ahead ? " · ↑" + sc.modelData.git.ahead : "") + (sc.modelData.git.behind ? " · ↓" + sc.modelData.git.behind : "") + (sc.modelData.git.conflicts ? " · " + sc.modelData.git.conflicts + " conflicts" : "")) : ""; color: sc.modelData.git && sc.modelData.git.conflicts ? view.desk.red : sc.modelData.git && sc.modelData.git.dirty ? view.desk.yellow : view.desk.green; font.family: view.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
                  PlainText { Layout.fillWidth: true; text: "pid " + sc.modelData.pid + (sc.modelData.window ? "  ·  ws " + sc.modelData.window.workspace : "  ·  no window"); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                  PlainText { Layout.fillWidth: true; text: "cpu " + (sc.modelData.resources && sc.modelData.resources.cpuPct !== null ? sc.modelData.resources.cpuPct.toFixed(1) + "%" : "—") + " · ram " + view.desk.bytes((sc.modelData.resources || {}).rss) + " · " + ((sc.modelData.resources || {}).processes || 0) + " proc" + ((sc.modelData.resources || {}).gpuMemory ? " · gpu " + view.desk.bytes(sc.modelData.resources.gpuMemory) : ""); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                }
                MouseArea {
                  id: hover; anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
                  cursorShape: sc.modelData.window ? Qt.PointingHandCursor : Qt.ArrowCursor
                  acceptedButtons: Qt.LeftButton | Qt.RightButton
                  onClicked: function(mouse) {
                    if (mouse.button === Qt.RightButton) view.inspectedSession = sc.modelData
                    else if (sc.modelData.window) view.navigateTo(sc.modelData.window.address)
                  }
                }
              }
            }
            PlainText { visible: view.sessions.length === 0; text: view.desk.ready ? "no agents running — go start something" : "collecting…"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.body }
          }
        }

        // ---- heatmap ----
        Card {
          Layout.fillWidth: true
          visible: view.sectionEnabled("activity")
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
              function cellLabel(index) {
                if (index < 0) return ""
                var c = cells[index] || [0, {}], d = Math.floor(index / 24), h = index % 24
                var dt = new Date(dayTs(d)), parts = []
                for (var k in c[1]) parts.push(view.desk.providerLabel(k) + " " + c[1][k])
                return Qt.formatDate(dt, "ddd d MMM") + " " + (h < 10 ? "0" : "") + h + ":00 · " + c[0] + " prompts" + (parts.length ? " · " + parts.join(" · ") : "")
              }
              onCellsChanged: requestPaint()
              Connections { target: view; function onActivityCellFilterChanged() { heat.requestPaint() } }
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
                    if (idx === view.activityCellFilter) {
                      var selected = view.desk.providerColor(view.activityProviderFilter || "codex")
                      ctx.strokeStyle = Qt.rgba(selected.r, selected.g, selected.b, 1)
                      ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cw - 2, ch - 2)
                    } else if (idx === hoverIdx) {
                      ctx.strokeStyle = Qt.rgba(base.r, base.g, base.b, 0.9)
                      ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1)
                    }
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
                id: heatMouse
                property real pointerX: 0
                property real pointerY: 0
                anchors.fill: parent; hoverEnabled: true; enabled: view.interactive
                cursorShape: heat.hoverIdx >= 0 ? Qt.PointingHandCursor : Qt.ArrowCursor
                onPositionChanged: function(m) {
                  pointerX = m.x; pointerY = m.y
                  var labelW = Math.round(34 * Style.fontScale)
                  var cw = (heat.width - labelW) / 24, ch = heat.height / 7
                  var h = Math.floor((m.x - labelW) / cw), d = Math.floor(m.y / ch)
                  heat.hoverIdx = (h >= 0 && h < 24 && d >= 0 && d < 7) ? d * 24 + h : -1
                  heat.requestPaint()
                }
                onExited: { heat.hoverIdx = -1; heat.requestPaint() }
                onClicked: if (heat.hoverIdx >= 0) view.toggleActivityCell(heat.hoverIdx)
              }
              Rectangle {
                id: heatTooltip
                z: 20
                visible: heat.hoverIdx >= 0
                width: Math.min(implicitWidth, heat.width - Style.spacing.md * 2)
                implicitWidth: heatTooltipText.implicitWidth + Style.spacing.lg * 2
                height: heatTooltipText.implicitHeight + Style.spacing.md * 2
                x: Math.max(0, Math.min(heat.width - width, heatMouse.pointerX + 14))
                y: Math.max(0, Math.min(heat.height - height, heatMouse.pointerY - height - 10))
                radius: view.radius
                color: Util.alpha(view.desk.themeBackground, 0.96)
                border.color: Util.alpha(view.desk.themeForeground, 0.55)
                border.width: 1
                PlainText {
                  id: heatTooltipText
                  anchors.centerIn: parent
                  width: Math.min(implicitWidth, heat.width - Style.spacing.xl * 2)
                  text: heat.cellLabel(heat.hoverIdx)
                  color: view.desk.themeForeground
                  font.family: view.mono
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideRight
                }
              }
            }
            RowLayout {
              id: legend
              anchors { top: heat.bottom; topMargin: Style.spacing.md; left: parent.left; right: parent.right }
              spacing: Style.spacing.lg
              Repeater {
                model: ["claude", "codex", "grok", "opencode", "gemini", "ollama"]
                delegate: Rectangle {
                  id: providerFilter
                  required property string modelData
                  readonly property bool selected: view.activityProviderFilter === modelData
                  readonly property color tone: view.desk.providerColor(modelData)
                  implicitWidth: providerFilterRow.implicitWidth + Style.spacing.sm * 2
                  implicitHeight: providerFilterRow.implicitHeight + Style.spacing.xs * 2
                  radius: view.radius
                  color: selected ? Util.alpha(tone, 0.16) : "transparent"
                  border.color: selected ? Util.alpha(tone, 0.8) : "transparent"
                  border.width: selected ? 1 : 0
                  opacity: view.activityProviderFilter && !selected ? 0.34 : 1
                  RowLayout {
                    id: providerFilterRow
                    anchors.centerIn: parent
                    spacing: Style.spacing.xs
                    Rectangle { width: 8; height: 8; radius: 2; color: providerFilter.tone }
                    PlainText { text: view.desk.providerLabel(providerFilter.modelData); color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
                  }
                  MouseArea {
                    anchors.fill: parent
                    enabled: view.interactive
                    cursorShape: Qt.PointingHandCursor
                    onClicked: view.toggleActivityProvider(providerFilter.modelData)
                  }
                }
              }
              Item { Layout.fillWidth: true }
              PlainText {
                id: heatStatus
                text: {
                  if (heat.hoverIdx < 0) return view.activityFilterActive ? "filtered · " + view.activityFilterLabel() + " · clear" : "hover for details · click to filter · red tick = now"
                  return "click hovered cell to filter"
                }
                color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption
                MouseArea {
                  anchors.fill: parent
                  enabled: view.interactive && view.activityFilterActive && heat.hoverIdx < 0
                  cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: view.clearActivityFilter()
                }
              }
            }
          }
        }

        // ---- recent prompts / task history ----
        Card {
          Layout.fillWidth: true
          Layout.fillHeight: true
          visible: view.sectionEnabled("recent")
          title: "RECENT TASKS · WHAT GOT ASKED"
          hint: view.promptSearch ? (view.visibleRecentTasks.length + " matches") : view.activityFilterActive ? ("filtered · " + view.visibleRecentTasks.length + " shown") : "80 loaded · wheel anywhere · drag scrollbar"
          clip: true
          Rectangle {
            id: promptSearchBox
            width: parent.width
            height: Math.round(28 * Style.fontScale)
            radius: view.radius
            color: Util.alpha(view.desk.themeForeground, promptSearchInput.activeFocus ? 0.10 : 0.045)
            border.color: Util.alpha(promptSearchInput.activeFocus ? view.desk.cyan : view.desk.themeForeground, promptSearchInput.activeFocus ? 0.65 : 0.14)
            border.width: 1
            PlainText { anchors { left: parent.left; leftMargin: Style.spacing.md; verticalCenter: parent.verticalCenter } text: "⌕"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.body }
            TextInput {
              id: promptSearchInput
              anchors { left: parent.left; leftMargin: Style.spacing.xl * 2; right: clearSearch.left; rightMargin: Style.spacing.sm; verticalCenter: parent.verticalCenter }
              text: view.promptSearch
              color: view.desk.themeForeground
              selectionColor: Util.alpha(view.desk.cyan, 0.45)
              font.family: view.mono
              font.pixelSize: Style.font.bodySmall
              clip: true
              onTextChanged: view.promptSearch = text
              PlainText { visible: !parent.text && !parent.activeFocus; text: "search prompt, project, or provider…"; color: view.textFaint; font: parent.font }
            }
            PlainText {
              id: clearSearch
              anchors { right: parent.right; rightMargin: Style.spacing.md; verticalCenter: parent.verticalCenter }
              visible: view.promptSearch !== ""
              text: "×"
              color: view.textDim
              font.family: view.mono; font.pixelSize: Style.font.body
              MouseArea { anchors.fill: parent; anchors.margins: -Style.spacing.sm; cursorShape: Qt.PointingHandCursor; onClicked: { promptSearchInput.text = ""; promptSearchInput.forceActiveFocus() } }
            }
          }
          ListView {
            id: recentList
            function applyWheel(wheel) {
              var pixelY = wheel.pixelDelta ? Number(wheel.pixelDelta.y || 0) : 0
              var angleY = wheel.angleDelta ? Number(wheel.angleDelta.y || 0) : 0
              // Touchpads report tiny pixel deltas; mouse wheels report 120
              // units per notch. Give both enough travel to feel immediate.
              var delta = pixelY !== 0 ? pixelY * 2.75 : (angleY / 120) * Math.round(120 * Style.fontScale)
              if (!isFinite(delta) || delta === 0) { wheel.accepted = false; return }
              contentY = Math.max(0, Math.min(Math.max(0, contentHeight - height), contentY - delta))
              wheel.accepted = true
            }
            y: promptSearchBox.height + Style.spacing.sm
            width: parent.width - Math.round(14 * Style.fontScale)
            height: Math.max(0, (parent.height > 0 ? parent.height : 300) - y)
            model: view.visibleRecentTasks
            spacing: Style.spacing.xs
            clip: true
            interactive: view.interactive
            boundsBehavior: Flickable.StopAtBounds
            flickableDirection: Flickable.VerticalFlick
            maximumFlickVelocity: Math.round(6000 * Style.fontScale)
            flickDeceleration: Math.round(1500 * Style.fontScale)
            WheelHandler {
              enabled: view.interactive
              target: null
              onWheel: function(event) { recentList.applyWheel(event) }
            }
            delegate: Rectangle {
              id: ri
              required property var modelData
              readonly property bool live: modelData.live === true
              readonly property bool navigable: live && !!(modelData.window && modelData.window.address)
              readonly property bool resumable: !live && view.desk.canResume(modelData.provider, modelData.session)
              readonly property bool pinned: view.settings.promptPinned(view.promptKey(modelData))
              readonly property color tone: view.desk.providerColor(modelData.provider)
              width: recentList.width
              height: rrow.implicitHeight + Style.spacing.sm
              radius: view.radius
              color: (live || resumable) ? Util.alpha(tone, recentHover.hovered ? 0.16 : (live ? 0.07 : 0.025)) : "transparent"
              border.color: (live || (resumable && recentHover.hovered)) ? Util.alpha(tone, recentHover.hovered ? 0.65 : 0.22) : "transparent"
              border.width: live || (resumable && recentHover.hovered) ? 1 : 0
              opacity: live ? 1.0 : (resumable ? 0.62 : 0.40)
              RowLayout {
                id: rrow
                anchors {
                  left: parent.left
                  right: parent.right
                  verticalCenter: parent.verticalCenter
                  leftMargin: Style.spacing.sm
                  rightMargin: Style.spacing.sm
                }
                spacing: Style.spacing.md
                PlainText { text: (ri.pinned ? "★" : "") + view.desk.ago(ri.modelData.ts); color: ri.pinned ? ri.tone : view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(28 * Style.fontScale); horizontalAlignment: Text.AlignRight }
                Tag { text: view.desk.providerLabel(ri.modelData.provider); tone: view.desk.providerColor(ri.modelData.provider) }
                PlainText { text: (ri.modelData.project || "").replace(/^.*\//, "") ; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(110 * Style.fontScale); elide: Text.ElideLeft }
                PlainText { Layout.fillWidth: true; text: ri.modelData.text || ""; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight; maximumLineCount: 1 }
                PlainText {
                  visible: recentHover.hovered && (ri.navigable || ri.resumable)
                  text: ri.navigable ? "FOCUS" : "RESUME"
                  color: ri.tone
                  font.family: view.mono
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }
              }
              HoverHandler {
                id: recentHover
                enabled: view.interactive
                cursorShape: (ri.navigable || ri.resumable) ? Qt.PointingHandCursor : Qt.ArrowCursor
              }
              TapHandler {
                enabled: view.interactive
                acceptedButtons: Qt.LeftButton
                onTapped: {
                  if (ri.navigable) view.navigateTo(ri.modelData.window.address)
                  else if (ri.resumable && view.desk.resumeSession(ri.modelData.provider, ri.modelData.session, ri.modelData.project)) view.navigated()
                }
              }
              TapHandler {
                enabled: view.interactive
                acceptedButtons: Qt.RightButton
                onTapped: view.selectedPrompt = ri.modelData
              }
            }
          }
          Rectangle {
            id: recentScrollTrack
            visible: recentList.contentHeight > recentList.height && recentList.height > 0
            width: Math.max(12, Math.round(14 * Style.fontScale))
            radius: width / 2
            color: scrollTrackMouse.containsMouse ? Util.alpha(view.desk.themeForeground, 0.09) : "transparent"
            x: parent.width - width
            y: recentList.y
            height: recentList.height
            function seek(pointerY) {
              var usable = Math.max(1, height - recentScrollThumb.height)
              var ratio = Math.max(0, Math.min(1, (pointerY - recentScrollThumb.height / 2) / usable))
              recentList.contentY = ratio * Math.max(0, recentList.contentHeight - recentList.height)
            }
            Rectangle {
              id: recentScrollThumb
              width: Math.max(6, Math.round(8 * Style.fontScale))
              x: (parent.width - width) / 2
              radius: width / 2
              color: scrollTrackMouse.pressed ? view.desk.cyan : Util.alpha(view.desk.cyan, scrollTrackMouse.containsMouse ? 0.78 : 0.55)
              y: Math.max(0, Math.min(parent.height - height, (recentList.contentY / Math.max(1, recentList.contentHeight - recentList.height)) * Math.max(0, parent.height - height)))
              height: Math.max(Math.round(24 * Style.fontScale), parent.height * parent.height / Math.max(parent.height, recentList.contentHeight))
            }
            MouseArea {
              id: scrollTrackMouse
              anchors.fill: parent
              enabled: view.interactive
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onWheel: function(wheel) { recentList.applyWheel(wheel) }
              onPressed: function(mouse) { recentScrollTrack.seek(mouse.y) }
              onPositionChanged: function(mouse) { if (pressed) recentScrollTrack.seek(mouse.y) }
            }
          }
          PlainText {
            anchors.centerIn: parent
            visible: view.activityFilterActive && view.visibleRecentTasks.length === 0
            text: "no prompts in this filter"
            color: view.textFaint
            font.family: view.mono
            font.pixelSize: Style.font.bodySmall
          }
        }
      }

      // RIGHT COLUMN: usage + local AI + machine corner
      GridLayout {
        visible: view.sectionEnabled("usage") || view.sectionEnabled("localAi") || view.sectionEnabled("machine")
        Layout.fillHeight: true
        Layout.preferredWidth: Math.round(330 * Style.fontScale)
        Layout.maximumWidth: Math.round(380 * Style.fontScale)
        Layout.minimumWidth: Math.round(290 * Style.fontScale)
        columns: 1
        rowSpacing: view.gap
        columnSpacing: 0

        // ---- subscription usage (from omarchy.agents cache when present) ----
        Card {
          Layout.row: view.settings.rightIndex("usage")
          Layout.column: 0
          Layout.fillWidth: true
          visible: view.sectionEnabled("usage")
          moveId: "usage"
          draggable: true
          title: "USAGE & LIMITS"
          hint: {
            var keys = Object.keys(view.usage); return keys.length ? "via omarchy agents" : "enable the Agents bar widget"
          }
          ColumnLayout {
            width: parent.width
            spacing: Style.spacing.md
            Flow {
              Layout.fillWidth: true
              spacing: Style.spacing.xs
              Repeater {
                model: Object.keys(view.usage)
                delegate: Tag {
                  required property string modelData
                  text: view.desk.providerLabel(modelData)
                  tone: view.desk.providerColor(modelData)
                  opacity: !view.usageProviderFilter || view.usageProviderFilter === modelData ? 1 : 0.35
                  MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.usageProviderFilter = view.usageProviderFilter === parent.modelData ? "" : parent.modelData }
                }
              }
              Tag { text: view.usageForecastMode ? "FORECAST" : "PERCENT"; tone: view.desk.cyan; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.usageForecastMode = !view.usageForecastMode } }
            }
            Repeater {
              model: Object.keys(view.usage).filter(function(k) { return view.usage[k] && view.usage[k].ready !== false && (!view.usageProviderFilter || view.usageProviderFilter === k) })
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
                    readonly property var projection: view.usageProjection(modelData)
                    Layout.fillWidth: true
                    label: modelData.label || modelData.title || ""
                    value: (view.usageForecastMode ? (projection === null ? "learning" : "→ " + Math.round(projection * 100) + "% at reset") : Math.round((modelData.percent || 0) * 100) + "%") + (modelData.resetsAt ? "  ↻ " + view.desk.until(Date.parse(modelData.resetsAt)) : "")
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
          Layout.row: view.settings.rightIndex("localAi")
          Layout.column: 0
          Layout.fillWidth: true
          visible: view.sectionEnabled("localAi")
          moveId: "localAi"
          draggable: true
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
              Tag { visible: !!(provRow.ps.opencode && provRow.ps.opencode.present); text: "opencode " + (provRow.ps.opencode ? provRow.ps.opencode.sessions : 0) + " sess"; tone: view.desk.providerColor("opencode") }
              Item { Layout.fillWidth: true }
            }
          }
        }

        // ---- machine corner (the boring stats) ----
        Card {
          Layout.row: view.settings.rightIndex("machine")
          Layout.column: 0
          Layout.fillWidth: true
          visible: view.sectionEnabled("machine")
          moveId: "machine"
          draggable: true
          title: "MACHINE"
          hint: ((view.snap.user ? view.snap.user + "@" : "") + (view.snap.host || "")) + " · up " + view.desk.dur(view.machine.uptime)
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
              label: mc.net.wireless ? "WIFI " + (mc.net.ssid || "") : "NET " + (mc.net.dev || "—")
              value: (mc.net.signal !== null && mc.net.signal !== undefined ? mc.net.signal + " dBm" : "") + " · " + (mc.net.addr || "")
              // -30 dBm great … -90 dBm dead
              fraction: mc.net.signal !== null && mc.net.signal !== undefined ? Math.max(0, Math.min(1, (Number(mc.net.signal) + 90) / 60)) : (mc.net.dev ? 1 : 0)
              tone: mc.net.signal !== null && mc.net.signal !== undefined && Number(mc.net.signal) < -75 ? view.desk.yellow : view.desk.green
            }
            RowLayout {
              Layout.fillWidth: true
              PlainText { text: "WAN"; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
              Item { Layout.fillWidth: true }
              PlainText { text: view.machine.externalIp || "unavailable"; color: view.machine.externalIp ? view.desk.cyan : view.textFaint; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideMiddle }
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
        Item { Layout.row: 99; Layout.column: 0; Layout.fillHeight: true }
        }
      }
    }
  }

  Rectangle {
    id: sessionInspector
    z: 100
    anchors.centerIn: parent
    visible: !!view.inspectedSession && view.sectionEnabled("sessions")
    width: Math.min(parent.width - view.gap * 4, Math.round(620 * Style.fontScale))
    implicitHeight: inspectorColumn.implicitHeight + view.pad * 2
    radius: view.radius
    color: Util.alpha(view.desk.themeBackground, 0.97)
    border.color: Util.alpha(view.inspectedSession ? view.desk.providerColor(view.inspectedSession.provider) : view.desk.themeForeground, 0.8)
    border.width: 1
    readonly property var session: view.inspectedSession || ({})
    readonly property color tone: view.desk.providerColor(session.provider)

    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(mouse) { mouse.accepted = true } }
    ColumnLayout {
      id: inspectorColumn
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      RowLayout {
        Layout.fillWidth: true
        Rectangle { width: 9; height: 9; radius: 5; color: sessionInspector.tone }
        PlainText { text: view.desk.providerLabel(sessionInspector.session.provider) + " SESSION"; color: sessionInspector.tone; font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true }
        Item { Layout.fillWidth: true }
        PlainText { text: view.desk.dur(sessionInspector.session.uptimeSec) + " · pid " + (sessionInspector.session.pid || "—"); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.caption }
        Tag {
          text: "CLOSE"
          tone: view.textDim
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.inspectedSession = null }
        }
      }
      PlainText { Layout.fillWidth: true; text: sessionInspector.session.cwd || "unknown project"; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.subtitle; elide: Text.ElideMiddle }
      PlainText { Layout.fillWidth: true; text: (sessionInspector.session.window || {}).title || "no window title"; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight }
      PlainText { Layout.fillWidth: true; text: "CPU " + (sessionInspector.session.resources && sessionInspector.session.resources.cpuPct !== null ? sessionInspector.session.resources.cpuPct.toFixed(1) + "%" : "—") + "   ·   RAM " + view.desk.bytes((sessionInspector.session.resources || {}).rss) + "   ·   " + ((sessionInspector.session.resources || {}).processes || 0) + " PROCESSES" + ((sessionInspector.session.resources || {}).gpuMemory ? "   ·   GPU " + view.desk.bytes(sessionInspector.session.resources.gpuMemory) : ""); color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall }
      PlainText {
        Layout.fillWidth: true
        text: {
          var s = sessionInspector.session, w = s.window || {}, g = s.git || null
          var parts = ["workspace " + (w.workspace === null || w.workspace === undefined ? "—" : w.workspace)]
          if (s.session) parts.push("session " + String(s.session).slice(0, 13) + "…")
          if (g) parts.push("git " + g.branch + (g.dirty ? " · " + g.dirty + " changed" : " · clean") + (g.conflicts ? " · " + g.conflicts + " conflicts" : ""))
          return parts.join("   ·   ")
        }
        color: sessionInspector.session.git && sessionInspector.session.git.conflicts ? view.desk.red : view.textDim
        font.family: view.mono; font.pixelSize: Style.font.bodySmall; wrapMode: Text.Wrap
      }
      ColumnLayout {
        Layout.fillWidth: true
        visible: !!(sessionInspector.session.window && sessionInspector.session.window.address)
        spacing: Style.spacing.xs
        PlainText { text: "MOVE TO WORKSPACE"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
        Flow {
          Layout.fillWidth: true
          spacing: Style.spacing.xs
          Repeater {
            model: 10
            delegate: Tag {
              required property int modelData
              readonly property int workspaceNumber: modelData + 1
              text: String(workspaceNumber)
              tone: Number((sessionInspector.session.window || {}).workspace) === workspaceNumber ? sessionInspector.tone : view.textDim
              opacity: Number((sessionInspector.session.window || {}).workspace) === workspaceNumber ? 1 : 0.72
              MouseArea {
                anchors.fill: parent
                enabled: view.interactive && Number((sessionInspector.session.window || {}).workspace) !== parent.workspaceNumber
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: {
                  if (view.desk.moveWindowToWorkspace(sessionInspector.session.window.address, parent.workspaceNumber)) view.inspectedSession = null
                }
              }
            }
          }
        }
      }
      RowLayout {
        Layout.fillWidth: true
        spacing: Style.spacing.md
        Tag {
          visible: !!(sessionInspector.session.window && sessionInspector.session.window.address)
          text: "FOCUS WINDOW"
          tone: sessionInspector.tone
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.navigateTo(sessionInspector.session.window.address) }
        }
        Tag {
          visible: view.desk.canOpenProject(sessionInspector.session.cwd)
          text: "OPEN PROJECT TERMINAL"
          tone: view.desk.green
          MouseArea {
            anchors.fill: parent; cursorShape: Qt.PointingHandCursor
            onClicked: if (view.desk.openProject(sessionInspector.session.cwd)) view.inspectedSession = null
          }
        }
        Tag {
          text: view.previewsEnabled ? "PREVIEWS ON" : "PREVIEWS OFF"
          tone: view.previewsEnabled ? view.desk.green : view.textFaint
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.previewsEnabled = !view.previewsEnabled }
        }
        Item { Layout.fillWidth: true }
        PlainText { text: "right-click another card to inspect"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption }
      }
    }
  }

  Rectangle {
    id: promptDrawer
    z: 110
    anchors.centerIn: parent
    visible: !!view.selectedPrompt && view.sectionEnabled("recent")
    width: Math.min(parent.width - view.gap * 4, Math.round(720 * Style.fontScale))
    implicitHeight: promptColumn.implicitHeight + view.pad * 2
    radius: view.radius
    color: Util.alpha(view.desk.themeBackground, 0.97)
    border.color: Util.alpha(view.selectedPrompt ? view.desk.providerColor(view.selectedPrompt.provider) : view.textDim, 0.8)
    readonly property var prompt: view.selectedPrompt || ({})
    readonly property var group: (view.ai.recent || []).filter(function(item) { return item.provider === promptDrawer.prompt.provider && item.session && item.session === promptDrawer.prompt.session }).slice(0, 5)
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onClicked: function(mouse) { mouse.accepted = true } }
    ColumnLayout {
      id: promptColumn
      anchors { fill: parent; margins: view.pad }
      spacing: Style.spacing.md
      RowLayout {
        Layout.fillWidth: true
        PlainText { text: view.desk.providerLabel(promptDrawer.prompt.provider) + " PROMPT ACTIONS"; color: view.desk.providerColor(promptDrawer.prompt.provider); font.family: view.mono; font.pixelSize: Style.font.subtitle; font.bold: true }
        Item { Layout.fillWidth: true }
        Tag { text: "CLOSE"; tone: view.textDim; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.selectedPrompt = null } }
      }
      PlainText { Layout.fillWidth: true; text: promptDrawer.prompt.text || ""; color: view.desk.themeForeground; font.family: view.mono; font.pixelSize: Style.font.body; wrapMode: Text.Wrap }
      RowLayout {
        spacing: Style.spacing.sm
        Tag { text: "COPY PROMPT"; tone: view.desk.cyan; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.copyText(promptDrawer.prompt.text) } }
        Tag { text: view.settings.promptPinned(view.promptKey(promptDrawer.prompt)) ? "UNPIN" : "PIN"; tone: view.desk.yellow; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.settings.togglePromptPin(view.promptKey(promptDrawer.prompt)) } }
        Tag { visible: view.desk.canOpenProject(promptDrawer.prompt.project); text: "OPEN PROJECT"; tone: view.desk.green; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: view.desk.openProject(promptDrawer.prompt.project) } }
        Item { Layout.fillWidth: true }
      }
      PlainText { visible: promptDrawer.group.length > 1; text: "SAME SESSION · " + promptDrawer.group.length + " RECENT PROMPTS"; color: view.textFaint; font.family: view.mono; font.pixelSize: Style.font.caption; font.bold: true }
      Repeater {
        model: promptDrawer.group
        delegate: PlainText { required property var modelData; Layout.fillWidth: true; text: "• " + modelData.text; color: view.textDim; font.family: view.mono; font.pixelSize: Style.font.bodySmall; elide: Text.ElideRight }
      }
    }
  }
}
