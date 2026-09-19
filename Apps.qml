pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import qs.Commons

// Infomarchy Apps owns app registration; systemd owns processes. This view only
// requests actions and reads status, so unloading the desk cannot stop apps.
Item {
  id: root
  required property InfoModel desk
  property bool interactive: true
  property bool privacyMode: false
  readonly property bool masked: root.privacyMode || root.desk.demoMode
  onMaskedChanged: { root.apps = []; root.logText = ""; root.selectedLog = ""; root.registering = false; root.feedback = ""; root.error = ""; root.refresh() }
  property var apps: []
  property string error: ""
  property string feedback: ""
  property string selectedLog: ""
  property string logText: ""
  property string busyId: ""
  property bool registering: false
  readonly property var cli: ["bun", decodeURIComponent(Qt.resolvedUrl("app-services.ts").toString().replace(/^file:\/\//, ""))]
  readonly property color foreground: root.desk.themeForeground
  readonly property real gapSmall: Style.spacing.sm
  readonly property real gapLarge: Style.spacing.lg
  readonly property real gapTiny: Style.spacing.xs
  readonly property real captionSize: Style.font.caption
  readonly property real bodySize: Style.font.body
  implicitHeight: content.implicitHeight

  function refresh() {
    if (root.visible && root.desk.active && !root.masked && !poll.running && !action.running) poll.running = true
  }
  function act(operation, app) {
    if (action.running || !root.interactive || root.masked) return
    root.error = ""
    root.feedback = ""
    root.busyId = app.id
    action.operation = operation
    action.appId = app.id
    action.command = root.cli.concat([operation, app.id, "--json", "--shared"])
    action.running = true
  }
  function tone(state) {
    return state === "running" ? root.desk.green : state === "conflict" || state === "failed" || state === "unhealthy" || state === "unavailable" ? root.desk.red : root.desk.yellow
  }
  function registerApp() {
    if (action.running || !root.interactive || root.masked) return
    root.error = ""
    root.feedback = ""
    var name = appName.value.trim()
    var id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    var registration = { id: id, name: name, path: appFolder.value.trim(), command: appCommand.value.trim(), port: Number(appPort.value), healthPath: appHealth.value.trim() || "/" }
    action.operation = "register"
    action.command = root.cli.concat(["register", "--registration", JSON.stringify(registration), "--json"])
    action.running = true
  }
  Component.onCompleted: refresh()
  onVisibleChanged: refresh()
  Connections {
    target: root.desk
    function onActiveChanged() { root.refresh() }
  }
  Timer { interval: 5000; repeat: true; running: root.visible && root.desk.active && !root.masked; onTriggered: root.refresh() }
  Process {
    id: poll
    command: root.cli.concat(["status", "--json"])
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          if (root.masked) return
          var data = JSON.parse(text)
          if (!root.masked && data.ok) { root.apps = data.services; root.error = "" }
          else if (!data.ok) root.error = data.error || "Unable to read app status"
        } catch (e) { root.error = "App services unavailable. Check that Bun is installed." }
      }
    }
    stderr: StdioCollector { onStreamFinished: if (!root.masked && text.trim()) root.error = text.trim().slice(0, 500) }
  }
  Process {
    id: action
    property string operation: ""
    property string appId: ""
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          if (root.masked) return
          var data = JSON.parse(text)
          if (!data.ok) root.error = data.error || "App action failed"
          else if (action.operation === "logs") { root.selectedLog = action.appId; root.logText = data.log || "No logs yet." }
          else { root.feedback = data.message || "Done"; if (action.operation === "register") root.registering = false }
        } catch (e) { root.error = "Infomarchy Apps returned an invalid response" }
      }
    }
    stderr: StdioCollector { onStreamFinished: if (!root.masked && text.trim()) root.error = text.trim().slice(0, 500) }
    onExited: { root.busyId = ""; root.refresh() }
  }

  component Label: Text {
    textFormat: Text.PlainText
    color: root.foreground
    font.family: Style.resolvedFontFamily
    font.pixelSize: root.captionSize
    elide: Text.ElideRight
  }
  component Button: Rectangle {
    id: button
    property string label: ""
    signal clicked()
    implicitWidth: caption.implicitWidth + root.gapLarge * 2
    implicitHeight: caption.implicitHeight + root.gapSmall * 2
    radius: root.gapTiny
    color: Util.alpha(root.desk.cyan, mouse.containsMouse ? 0.22 : 0.09)
    border.color: Util.alpha(root.desk.cyan, 0.4)
    opacity: enabled ? 1 : 0.4
    Label { id: caption; anchors.centerIn: parent; text: button.label; color: root.desk.cyan }
    MouseArea { id: mouse; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: button.clicked() }
  }
  component Field: Rectangle {
    id: field
    property string placeholder: ""
    property alias value: input.text
    implicitHeight: 32 * Style.fontScale
    color: Util.alpha(root.desk.themeBackground, 0.8)
    radius: root.gapTiny
    border.color: Util.alpha(root.desk.cyan, input.activeFocus ? 0.8 : 0.3)
    TextInput {
      id: input
      anchors { fill: parent; margins: root.gapSmall }
      color: root.foreground
      font.family: Style.resolvedFontFamily
      font.pixelSize: root.captionSize
      clip: true
      selectByMouse: true
      maximumLength: 1024
      Label { anchors.fill: parent; text: field.placeholder; visible: input.text === ""; opacity: 0.5 }
    }
  }
  ColumnLayout {
    id: content
    width: root.width
    spacing: root.gapSmall
    RowLayout {
      Layout.fillWidth: true
      Label { Layout.fillWidth: true; text: root.masked ? "App details are hidden in privacy/demo mode" : root.apps.length + " registered apps · " + root.apps.filter(function(app) { return app.ready }).length + " ready"; opacity: 0.7 }
      Button { label: root.registering ? "CANCEL" : "ADD APP"; visible: root.interactive && !root.masked; enabled: !action.running; onClicked: root.registering = !root.registering }
    }
    ColumnLayout {
      visible: root.registering && !root.masked
      Layout.fillWidth: true
      spacing: root.gapSmall
      RowLayout {
        Layout.fillWidth: true
        Field { id: appName; Layout.fillWidth: true; placeholder: "App name" }
        Field { id: appFolder; Layout.fillWidth: true; placeholder: "Project folder, e.g. ~/Work/my-app" }
      }
      RowLayout {
        Layout.fillWidth: true
        Field { id: appCommand; Layout.fillWidth: true; placeholder: "Command, e.g. mise exec -- npm run dev" }
        Field { id: appPort; Layout.preferredWidth: 90 * Style.fontScale; placeholder: "Port" }
        Field { id: appHealth; Layout.preferredWidth: 100 * Style.fontScale; placeholder: "Health: /" }
        Button { label: "REGISTER"; enabled: !action.running && appName.value.trim() !== "" && appFolder.value.trim() !== "" && appCommand.value.trim() !== "" && Number(appPort.value) >= 1024 && Number(appPort.value) <= 65535; onClicked: root.registerApp() }
      }
      Label { Layout.fillWidth: true; text: "Saved on this machine. Repos stay unchanged. The command must use this port and fail if occupied. Registration does not start the app."; wrapMode: Text.Wrap; elide: Text.ElideNone; opacity: 0.7 }
    }
    Flickable {
      Layout.fillWidth: true
      Layout.preferredHeight: Math.min(tiles.implicitHeight, 205 * Style.fontScale)
      contentWidth: width
      contentHeight: tiles.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      Flow {
      id: tiles
      width: parent.width
      spacing: root.gapLarge
      Repeater {
        model: root.apps
        delegate: Rectangle {
          id: tile
          required property var modelData
          width: tiles.width >= 700 ? (tiles.width - tiles.spacing) / 2 : tiles.width
          height: row.implicitHeight + root.gapLarge * 2
          color: Util.alpha(root.foreground, 0.035)
          radius: root.gapSmall
          border.color: Util.alpha(root.tone(modelData.state), 0.35)
          ColumnLayout {
            id: row
            anchors { left: parent.left; right: parent.right; top: parent.top; margins: root.gapLarge }
            spacing: root.gapSmall
            RowLayout {
              Layout.fillWidth: true
              Label { Layout.fillWidth: true; font.bold: true; font.pixelSize: root.bodySize; text: tile.modelData.name }
              Label { text: root.busyId === tile.modelData.id ? "WORKING…" : tile.modelData.state.toUpperCase(); color: root.tone(tile.modelData.state) }
            }
            Label { Layout.fillWidth: true; text: tile.modelData.url + " · " + tile.modelData.branch + " · " + (tile.modelData.changes ? tile.modelData.changes + " changed" : "clean") + " · " + (tile.modelData.autostart ? "starts at login" : "on demand"); opacity: 0.75 }
            Label { Layout.fillWidth: true; text: tile.modelData.path; opacity: 0.55 }
            Label {
              Layout.fillWidth: true
              visible: !!tile.modelData.detail
              color: root.tone(tile.modelData.state)
              text: tile.modelData.detail || ""
              wrapMode: Text.WrapAnywhere
              elide: Text.ElideNone
            }
            Flow {
              Layout.fillWidth: true
              Layout.preferredHeight: implicitHeight
              spacing: root.gapSmall
              enabled: root.interactive && !action.running && !root.masked
              Button { label: "OPEN"; enabled: tile.modelData.state !== "conflict"; onClicked: root.act("open", tile.modelData) }
              Button { label: tile.modelData.active ? "STOP" : "START"; enabled: tile.modelData.active || tile.modelData.state !== "conflict"; onClicked: root.act(tile.modelData.active ? "stop" : "ensure", tile.modelData) }
              Button { label: "RESTART"; enabled: tile.modelData.active && tile.modelData.state !== "conflict"; onClicked: root.act("restart", tile.modelData) }
              Button { label: "LOGS"; onClicked: root.act("logs", tile.modelData) }
            }
          }
        }
      }
      }
    }
    Label { Layout.fillWidth: true; visible: root.error !== "" || root.feedback !== ""; text: root.error || root.feedback; color: root.error ? root.desk.red : root.desk.green; wrapMode: Text.Wrap; elide: Text.ElideNone }
    RowLayout {
      visible: root.selectedLog !== ""
      Layout.fillWidth: true
      Label { Layout.fillWidth: true; text: root.selectedLog + " · latest 100 lines"; font.bold: true }
      Button { label: "REFRESH"; enabled: !action.running; onClicked: root.act("logs", {id: root.selectedLog}) }
      Button { label: "CLEAR VIEW"; onClicked: root.logText = "" }
      Button { label: "CLOSE"; onClicked: root.selectedLog = "" }
    }
    Rectangle {
      visible: root.selectedLog !== ""
      Layout.fillWidth: true
      Layout.preferredHeight: 170 * Style.fontScale
      color: Util.alpha(root.desk.themeBackground, 0.8)
      radius: root.gapSmall
      Flickable {
        anchors { fill: parent; margins: root.gapSmall }
        clip: true
        contentWidth: width
        contentHeight: logLabel.height
        Label { id: logLabel; width: parent.width; text: root.logText; wrapMode: Text.WrapAnywhere; elide: Text.ElideNone }
      }
    }
  }
}
