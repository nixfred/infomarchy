pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons

// Web Mode / desk settings, hosted by the overlay drawer.
ColumnLayout {
  id: root
  required property InfoSettings settings
  property var desk: null
  spacing: Style.spacing.md

  readonly property color fg: desk && desk.themeForeground ? desk.themeForeground : Commons.Color.foreground
  readonly property color dim: Qt.rgba(fg.r, fg.g, fg.b, 0.62)
  readonly property color faint: Qt.rgba(fg.r, fg.g, fg.b, 0.38)
  readonly property color green: desk && desk.green ? desk.green : Commons.Color.accent
  readonly property color yellow: desk && desk.yellow ? desk.yellow : Commons.Color.foreground
  readonly property color cyan: desk && desk.cyan ? desk.cyan : Commons.Color.accent
  readonly property color red: desk && desk.red ? desk.red : Commons.Color.urgent
  readonly property string mono: Style.resolvedFontFamily
  readonly property string webServerPath: settings.webServerPath
  property var tokens: []
  property var extraCidrs: []
  property var defaultCidrs: []
  property string selectedTokenId: ""
  onSelectedTokenIdChanged: hideQr()
  property var qrRows: []
  property int qrSize: 0
  property bool qrRevealed: false
  property string tokenLabelDraft: ""
  property string cidrDraft: ""
  property string statusText: ""
  property var manualDraft: ({})
  property bool manualDirty: false
  property string manualMessage: "Save your certificate settings, then check the certificate before enabling HTTPS."
  function resetManualDraft() {
    var c = settings.manualHttps || {}
    manualDraft = { hostname: c.hostname || "", bind: c.bind || "127.0.0.1", port: String(c.port || 8789), certPath: c.certPath || "", keyPath: c.keyPath || "", fingerprint: c.fingerprint || "" }
    manualDirty = false
  }
  function saveManual() {
    var d = manualDraft
    settings.setManualHttps({hostname:d.hostname, bind:d.bind, port:Number(d.port), certPath:d.certPath, keyPath:d.keyPath, fingerprint:d.fingerprint})
    manualDirty = false
    manualMessage = "Settings submitted. CHECK CERTIFICATE after saving finishes."
    hideQr()
  }
  function checkManual() { if (!settings.settingsWriting && !manualDirty && !manualCheck.running) manualCheck.running = true }
  Process {
    id: manualCheck
    command: ["bun", Qt.resolvedUrl("web-manual.ts").toString().replace(/^file:\/\//, "")]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (line.length > 1024) return
        try { var result = JSON.parse(line); root.manualMessage = root.plain(result.message, 400) }
        catch (e) { root.manualMessage = "Certificate check failed." }
      }
    }
  }

  function plain(value, max) {
    return String(value || "").replace(/[<>&]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max || 64)
  }
  function copyValue(text) {
    if (desk && typeof desk.copyText === "function") return desk.copyText(text)
    var value = String(text || "")
    if (!value || value.length > 10000 || copyProc.running) return false
    copyProc.pendingText = value
    copyProc.running = true
    return true
  }
  function refreshMeta() {
    metaProc.running = false
    metaProc.running = true
  }
  function copySelectedUrl() {
    urlProc.pendingId = selectedTokenId
    urlProc.running = false
    urlProc.running = true
  }
  function hideQr() { qrRevealed = false; if (qrProc) qrProc.running = false; qrRows = []; qrSize = 0 }
  function refreshQr() {
    if (!settings.webEnabled || !settings.webReady) return
    statusText = ""
    qrRevealed = true
    qrProc.running = false
    qrProc.running = true
  }
  function addToken() {
    addTokenProc.pending = tokenLabelDraft
    addTokenProc.running = false
    addTokenProc.running = true
  }
  function revokeSelected() {
    if (!selectedTokenId || tokens.length < 2) return
    revokeProc.pending = selectedTokenId
    revokeProc.running = false
    revokeProc.running = true
  }
  function addCidr() {
    addCidrProc.pending = cidrDraft
    addCidrProc.running = false
    addCidrProc.running = true
  }
  function dropCidr(text) {
    dropCidrProc.pending = text
    dropCidrProc.running = false
    dropCidrProc.running = true
  }

  // A list that shows at most `rows` rows and scrolls the rest inside its own
  // box, so a full token or CIDR list never makes the drawer itself scroll.
  component ScrollList: Item {
    id: scrollList
    property alias model: scrollRows.model
    property alias delegate: scrollRows.delegate
    property real rows: 4.5
    property color barColor: "gray"
    readonly property bool overflowing: scrollBody.implicitHeight > height + 0.5
    implicitHeight: Math.min(scrollBody.implicitHeight, Math.round(rows * (Math.ceil(scrollMetrics.height) + Style.spacing.md) - Style.spacing.md))
    FontMetrics { id: scrollMetrics; font.family: Style.resolvedFontFamily; font.pixelSize: Style.font.caption }
    Flickable {
      id: scrollFlick
      anchors { fill: parent; rightMargin: scrollList.overflowing ? Style.spacing.md : 0 }
      contentWidth: width
      contentHeight: scrollBody.implicitHeight
      clip: true
      interactive: scrollList.overflowing
      boundsBehavior: Flickable.StopAtBounds
      Column { id: scrollBody; width: scrollFlick.width; spacing: Style.spacing.md; Repeater { id: scrollRows } }
    }
    Rectangle {
      visible: scrollList.overflowing
      anchors.right: parent.right
      width: 2
      y: scrollFlick.visibleArea.yPosition * scrollList.height
      height: scrollFlick.visibleArea.heightRatio * scrollList.height
      color: scrollList.barColor
    }
  }

  Text {
    textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
    visible: !!root.settings.settingsError; text: root.settings.settingsError
    color: root.red; font.family: root.mono; font.pixelSize: Style.font.caption
  }


  Component.onCompleted: { refreshMeta(); checkTailscale(); resetManualDraft() }
  onVisibleChanged: if (!visible) hideQr()
  property string tailMessage: "Checking Tailscale…"
  property bool tailReady: false
  property bool tailBusy: false
  function checkTailscale() {
    if (tailProc.running) return
    tailBusy = true
    tailProc.output = ""
    tailProc.running = true
  }
  Process {
    id: tailProc
    property string output: ""
    command: ["bun", Qt.resolvedUrl("web-tailscale.ts").toString().replace(/^file:\/\//, "")]
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        if (tailProc.output.length + chunk.length > 2048) { tailProc.running = false; return }
        tailProc.output += chunk
      }
    }
    onExited: {
      root.tailBusy = false
      try {
        var value = JSON.parse(output)
        root.tailReady = value.ok === true
        root.tailMessage = root.plain(value.message, 400)
      } catch (e) { root.tailReady = false; root.tailMessage = "Could not check Tailscale. Try again." }
      output = ""
    }
  }
  Connections {
    target: root.settings
    function onManualHttpsChanged() { if (!root.manualDirty) root.resetManualDraft() }
    function onWebAccessModeChanged() { root.hideQr() }
    function onWebEnabledChanged() { root.refreshMeta(); root.hideQr() }
  }

  Process {
    id: copyProc
    property string pendingText: ""
    command: ["bun", root.desk ? root.desk.copyTextPath : Qt.resolvedUrl("copy-text.ts").toString().replace(/^file:\/\//, "")]
    stdinEnabled: true
    onStarted: { write(JSON.stringify(pendingText) + "\n"); pendingText = "" }
  }
  Process {
    id: metaProc
    command: ["bun", root.webServerPath, "tokens"]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        var raw = String(line || "")
        if (raw.length > 4096) return
        try {
          var parsed = JSON.parse(raw)
          if (!parsed || parsed.ok !== true) return
          root.tokens = Array.isArray(parsed.tokens) ? parsed.tokens.slice(0, 8) : []
          root.extraCidrs = Array.isArray(parsed.extraCidrs) ? parsed.extraCidrs.slice(0, 8) : []
          root.defaultCidrs = Array.isArray(parsed.defaults) ? parsed.defaults.slice(0, 8) : []
          if (!root.selectedTokenId && root.tokens.length) root.selectedTokenId = root.tokens[0].id
          // Viewer links from a build that offered LAN HTTP were replaced.
          // The notice stays until the first new link is copied or shown.
          if (typeof parsed.notice === "string" && parsed.notice) root.statusText = root.plain(parsed.notice, 200)
        } catch (e) {}
      }
    }
  }
  Process {
    id: urlProc
    property string pendingId: ""
    command: ["bun", root.webServerPath, "copy-url", pendingId]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (line.length > 512) return
        try { var parsed = JSON.parse(line); root.statusText = root.plain(parsed.message || "Listener is not ready. Check WEB status.", 200) }
        catch (e) { root.statusText = "Could not copy the viewer link." }
      }
    }
  }

  Process {
    id: qrProc
    command: ["bun", root.webServerPath, "qr", root.selectedTokenId]
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        var raw = String(line || "")
        if (raw.length > 8192 || !root.qrRevealed || !root.settings.webEnabled) return
        try {
          var parsed = JSON.parse(raw)
          if (!parsed || parsed.ok !== true || !Array.isArray(parsed.rows)) { root.qrRows = []; root.qrSize = 0; root.statusText = "Cannot create QR. Install qrencode and check WEB status."; return }
          root.qrRows = parsed.rows.slice(0, 80)
          root.qrSize = root.qrRows.length
        } catch (e) { root.qrRows = []; root.qrSize = 0 }
      }
    }
  }
  Process {
    id: addTokenProc
    property string pending: ""
    command: ["bun", root.webServerPath, "token-add", pending]
    onExited: { root.tokenLabelDraft = ""; root.refreshMeta() }
  }
  Process {
    id: revokeProc
    property string pending: ""
    command: ["bun", root.webServerPath, "token-revoke", pending]
    onExited: { root.selectedTokenId = ""; root.refreshMeta() }
  }
  Process {
    id: addCidrProc
    property string pending: ""
    command: ["bun", root.webServerPath, "cidr-add", pending]
    onExited: { root.cidrDraft = ""; root.refreshMeta() }
  }
  Process {
    id: dropCidrProc
    property string pending: ""
    command: ["bun", root.webServerPath, "cidr-remove", pending]
    onExited: root.refreshMeta()
  }

  // Three columns so every control is visible at once at 1600x1000 without
  // page scrolling: ACCESS (mode and its setup), VIEWERS (WEB, links, QR,
  // tokens, allow list) and SECTIONS. The token and CIDR lists scroll inside
  // their own bounded boxes, so they never make the drawer scroll.
  readonly property int columnGap: Style.spacing.xl * 2
  function columnWidth(share) { return Math.floor((width - columnGap * 2) * share) }
  RowLayout {
    Layout.fillWidth: true
    spacing: root.columnGap
    ColumnLayout {
      id: accessColumn
      Layout.alignment: Qt.AlignTop
      Layout.fillWidth: true
      Layout.minimumWidth: 0
      Layout.preferredWidth: root.columnWidth(0.37)
      spacing: Style.spacing.md
      Text { textFormat: Text.PlainText; text: "ACCESS"; color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1.4 }
      Text {
        textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
        text: "Desktop privacy " + (root.settings.privacyMode ? "ON" : "OFF") + ". It is off until you turn it on, and connected web viewers receive full values while it is off. With privacy on, recent prompts keep four words and session topics are not sent."
        color: root.settings.privacyMode ? root.yellow : root.red; font.family: root.mono; font.pixelSize: Style.font.caption
      }
      RowLayout {
        Layout.fillWidth: true; spacing: Style.spacing.xl * 2
        Repeater {
          model: [{ id: "tailscale", label: "PRIVATE HTTPS" }, { id: "manual", label: "MANUAL HTTPS" }]
          delegate: Text {
            required property var modelData
            textFormat: Text.PlainText; text: (root.settings.webAccessMode === modelData.id ? "● " : "○ ") + modelData.label
            color: root.settings.webAccessMode === modelData.id ? root.cyan : root.dim
            font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { root.settings.setWebAccessMode(modelData.id); root.hideQr() } }
          }
        }
      }
      Text {
        textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
        text: root.settings.webModeUnset
          ? "Choose an access mode to turn WEB on. Both modes are HTTPS. Switching access mode turns WEB off."
          : root.settings.webAccessMode === "manual" ? "Use an existing certificate. You manage client trust, renewal and DNS when using a hostname. Bind to a private LAN/VPN address or loopback. Public exposure is unsupported. Saving certificate settings turns Manual HTTPS off."
          : "Private HTTPS lets your connected Tailscale devices view the dashboard securely on port 8788. CONFIGURE & ENABLE sets up access, and WEB off closes it. Tailscale and other services keep running."
        color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption
      }
      ColumnLayout {
        visible: root.settings.webAccessMode === "manual"
        Layout.fillWidth: true
        spacing: Style.spacing.sm
        Repeater {
          model: [
            {key:"hostname", label:"HOSTNAME / IPv4", hint:"desk.home.arpa or your private IPv4 address"},
            {key:"bind", label:"BIND IPv4", hint:"127.0.0.1 or private interface address"},
            {key:"port", label:"PORT", hint:"8789"},
            {key:"certPath", label:"CERTIFICATE CHAIN", hint:"/absolute/path/to/server-chain.pem"},
            {key:"keyPath", label:"PRIVATE KEY FILE", hint:"/absolute/path/to/server-key.pem"},
            {key:"fingerprint", label:"SHA-256 FINGERPRINT", hint:"Leaf certificate fingerprint, with or without colons"}
          ]
          delegate: ColumnLayout {
            required property var modelData
            Layout.fillWidth: true
            Text { textFormat: Text.PlainText; text: modelData.label; color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption }
            Rectangle {
              Layout.fillWidth: true
              implicitHeight: Style.font.body + Style.spacing.md * 2
              color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.04)
              border.color: manualInput.activeFocus ? root.cyan : root.faint
              radius: Style.cornerRadius
              TextInput {
                id: manualInput
                anchors.fill: parent; anchors.margins: Style.spacing.sm
                text: String(root.manualDraft[modelData.key] || "")
                color: root.fg; font.family: root.mono; font.pixelSize: Style.font.caption
                maximumLength: modelData.key === "fingerprint" ? 95 : 2048
                clip: true; selectByMouse: true
                onTextEdited: {
                  var next = Object.assign({}, root.manualDraft)
                  next[modelData.key] = text
                  root.manualDraft = next
                  root.manualDirty = true
                }
              }
              Text { anchors.fill: manualInput; textFormat: Text.PlainText; visible: !manualInput.text && !manualInput.activeFocus; text: modelData.hint; color: root.faint; font.family: root.mono; font.pixelSize: Style.font.caption; elide: Text.ElideRight }
            }
          }
        }
        RowLayout {
          spacing: Style.spacing.xl * 2
          Text {
            textFormat: Text.PlainText; text: root.settings.settingsWriting ? "SAVING…" : "SAVE CERTIFICATE SETTINGS"
            color: root.cyan; font.family: root.mono; font.pixelSize: Style.font.caption
            MouseArea { anchors.fill: parent; enabled: !root.settings.settingsWriting; cursorShape: Qt.PointingHandCursor; onClicked: root.saveManual() }
          }
          Text {
            textFormat: Text.PlainText; text: manualCheck.running ? "CHECKING…" : "CHECK CERTIFICATE"
            color: root.cyan; font.family: root.mono; font.pixelSize: Style.font.caption
            MouseArea { anchors.fill: parent; enabled: !root.settings.settingsWriting && !root.manualDirty && !manualCheck.running; cursorShape: Qt.PointingHandCursor; onClicked: root.checkManual() }
          }
        }
        Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; text: root.manualMessage; color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption }
        Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; text: "The fingerprint confirms the certificate loaded here. It does not install trust on a viewing device. A renewed certificate needs an updated fingerprint. Certificate and key files must be regular files without symlinks, and key permissions must be 0600 or 0400."; color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption }
      }
      Text {
        visible: root.settings.webAccessMode === "tailscale" && !root.settings.webReady && !root.settings.webStarting
        textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
        text: root.tailMessage; color: root.tailReady ? root.green : root.yellow
        font.family: root.mono; font.pixelSize: Style.font.caption
      }
      RowLayout {
        visible: root.settings.webAccessMode === "tailscale" && !root.settings.webReady && !root.settings.webStarting; spacing: Style.spacing.xl * 2
        Text {
          textFormat: Text.PlainText; text: root.tailBusy ? "CHECKING…" : "CHECK PREREQUISITES"; color: root.cyan
          font.family: root.mono; font.pixelSize: Style.font.caption
          MouseArea { anchors.fill: parent; enabled: !root.tailBusy; cursorShape: Qt.PointingHandCursor; onClicked: root.checkTailscale() }
        }
        Text {
          textFormat: Text.PlainText; text: "SETUP GUIDE"; color: root.cyan
          font.family: root.mono; font.pixelSize: Style.font.caption
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: Qt.openUrlExternally("https://tailscale.com/docs/features/tailscale-serve") }
        }
      }
      Text {
        visible: root.settings.webAccessMode === "tailscale"
        textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap
        text: "Install and connect Tailscale on the viewing device too. Your tailnet must permit access to this computer on port 8788. Then use Copy URL or Show QR. The dashboard QR opens the page. It does not enroll or authorize a device. Public access is unsupported."
        color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption
      }
    }
    ColumnLayout {
      id: viewersColumn
      Layout.alignment: Qt.AlignTop
      Layout.fillWidth: true
      Layout.minimumWidth: 0
      Layout.preferredWidth: root.columnWidth(0.37)
      spacing: Style.spacing.md
      Text { textFormat: Text.PlainText; text: "VIEWERS"; color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1.4 }
      Text { textFormat: Text.PlainText; visible: !!root.statusText; text: root.statusText; Layout.fillWidth: true; wrapMode: Text.Wrap; color: root.yellow; font.family: root.mono; font.pixelSize: Style.font.caption }
      RowLayout {
        Layout.fillWidth: true
        spacing: Style.spacing.sm
        Rectangle {
          implicitWidth: webToggle.implicitWidth + Style.spacing.md * 2
          implicitHeight: webToggle.implicitHeight + Style.spacing.xs * 2
          radius: Style.cornerRadius
          color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, root.settings.webReady ? 0.16 : 0.06)
          border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, root.settings.webReady ? 0.55 : 0.18)
          border.width: 1
          Text { id: webToggle; anchors.centerIn: parent; textFormat: Text.PlainText; text: root.settings.webEnabled ? (root.settings.webReady ? "WEB ON" : (root.settings.webStarting ? "STARTING…" : "WEB FAILED")) : "CONFIGURE & ENABLE"; color: root.settings.webReady ? root.green : (root.settings.webFailed ? root.yellow : root.faint); font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; enabled: root.settings.webEnabled || (!root.settings.settingsWriting && !root.settings.webModeUnset && (root.settings.webAccessMode === "manual" ? !root.manualDirty : root.tailReady)); onClicked: root.settings.toggleWebEnabled() }
        }
        Rectangle {
          visible: root.settings.webFailed
          implicitWidth: retryLabel.implicitWidth + Style.spacing.md * 2
          implicitHeight: retryLabel.implicitHeight + Style.spacing.xs * 2
          radius: Style.cornerRadius
          color: Qt.rgba(root.cyan.r, root.cyan.g, root.cyan.b, 0.12)
          border.color: root.cyan; border.width: 1
          Text { id: retryLabel; anchors.centerIn: parent; textFormat: Text.PlainText; text: "RETRY SETUP"; color: root.cyan; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.settings.retryWebSetup() }
        }
        Rectangle {
          visible: root.settings.webEnabled && root.settings.webReady
          implicitWidth: copyUrl.implicitWidth + Style.spacing.md * 2
          implicitHeight: copyUrl.implicitHeight + Style.spacing.xs * 2
          radius: Style.cornerRadius
          color: Qt.rgba(root.cyan.r, root.cyan.g, root.cyan.b, 0.12)
          border.color: Qt.rgba(root.cyan.r, root.cyan.g, root.cyan.b, 0.45)
          border.width: 1
          Text { id: copyUrl; anchors.centerIn: parent; textFormat: Text.PlainText; text: "COPY URL"; color: root.cyan; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.copySelectedUrl() }
        }
        Rectangle {
          visible: root.settings.webEnabled && root.settings.webReady
          implicitWidth: showQr.implicitWidth + Style.spacing.md * 2
          implicitHeight: showQr.implicitHeight + Style.spacing.xs * 2
          radius: Style.cornerRadius
          color: Qt.rgba(root.cyan.r, root.cyan.g, root.cyan.b, 0.12)
          border.color: Qt.rgba(root.cyan.r, root.cyan.g, root.cyan.b, 0.45)
          border.width: 1
          Text { id: showQr; anchors.centerIn: parent; textFormat: Text.PlainText; text: root.qrSize ? "HIDE QR" : "SHOW QR"; color: root.cyan; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { if (root.qrSize) root.hideQr(); else root.refreshQr() } }
        }
      }
      Text { textFormat: Text.PlainText; visible: !root.settings.webEnabled; wrapMode: Text.Wrap; Layout.fillWidth: true; text: "Turning Web Mode off stops the listener and keeps tokens. Revoke a token to rotate it."; color: root.faint; font.family: root.mono; font.pixelSize: Style.font.caption }

      Text { textFormat: Text.PlainText; visible: (root.settings.webModeUnset && !!root.settings.webStatusText) || (root.settings.webEnabled && !root.settings.webReady); Layout.fillWidth: true; wrapMode: Text.Wrap; text: root.settings.webStatusText || "Starting listener…"; color: root.yellow; font.family: root.mono; font.pixelSize: Style.font.caption }
      Text { textFormat: Text.PlainText; Layout.fillWidth: true; wrapMode: Text.Wrap; text: "Privacy changes apply on the next successful five-second refresh. Previously received or saved data cannot be retracted."; color: root.faint; font.family: root.mono; font.pixelSize: Style.font.caption }
      Column {
        visible: root.qrSize > 0 && root.settings.webEnabled
        Layout.alignment: Qt.AlignHCenter
        Repeater {
          model: root.qrRows
          delegate: Row {
            id: qrRow
            required property string modelData
            Repeater {
              model: qrRow.modelData.length
              delegate: Rectangle {
                required property int index
                width: 5
                height: 5
                color: qrRow.modelData.charAt(index) === "1" ? "#111" : "#eee"
              }
            }
          }
        }
      }

      Text { textFormat: Text.PlainText; text: "TOKENS" + (tokenList.overflowing ? " · " + root.tokens.length + " · SCROLL" : ""); color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1.4 }
      ScrollList {
        id: tokenList
        Layout.fillWidth: true
        barColor: root.faint
        model: root.tokens
        delegate: RowLayout {
          required property var modelData
          width: parent ? parent.width : 0
          spacing: Style.spacing.sm
          Text {
            textFormat: Text.PlainText
            text: (root.selectedTokenId === modelData.id ? "● " : "○ ") + root.plain(modelData.label, 32) + " · …" + root.plain(modelData.suffix, 4)
            color: root.selectedTokenId === modelData.id ? root.fg : root.dim
            font.family: root.mono
            font.pixelSize: Style.font.caption
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { root.selectedTokenId = modelData.id; root.hideQr() } }
          }
          Item { Layout.fillWidth: true }
          Text { textFormat: Text.PlainText; visible: root.tokens.length > 1; text: "REVOKE"; color: root.red; font.family: root.mono; font.pixelSize: Style.font.caption; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { root.selectedTokenId = modelData.id; root.revokeSelected() } } }
        }
      }
      RowLayout {
        Layout.fillWidth: true
        spacing: Style.spacing.sm
        Rectangle {
          Layout.fillWidth: true
          implicitHeight: 28
          radius: Style.cornerRadius
          color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.06)
          border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.18)
          border.width: 1
          TextInput {
            id: tokenInput
            anchors { fill: parent; leftMargin: 8; rightMargin: 8 }
            text: root.tokenLabelDraft
            color: root.fg
            font.family: root.mono
            font.pixelSize: Style.font.caption
            maximumLength: 32
            clip: true
            onTextChanged: root.tokenLabelDraft = text
            Text { textFormat: Text.PlainText; visible: !parent.text; text: "label"; color: root.faint; font: parent.font; anchors.verticalCenter: parent.verticalCenter }
          }
        }
        Rectangle {
          implicitWidth: addTok.implicitWidth + Style.spacing.md * 2
          implicitHeight: 28
          radius: Style.cornerRadius
          color: Qt.rgba(root.green.r, root.green.g, root.green.b, 0.12)
          border.color: Qt.rgba(root.green.r, root.green.g, root.green.b, 0.45)
          border.width: 1
          Text { id: addTok; anchors.centerIn: parent; textFormat: Text.PlainText; text: "ADD"; color: root.green; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.addToken() }
        }
      }

      ColumnLayout {
        visible: root.settings.webAccessMode === "manual"
        Layout.fillWidth: true
        spacing: Style.spacing.md
      Text { textFormat: Text.PlainText; text: "ALLOW LIST" + (cidrList.overflowing ? " · " + root.extraCidrs.length + " · SCROLL" : ""); color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1.4 }
      Text { textFormat: Text.PlainText; wrapMode: Text.Wrap; Layout.fillWidth: true; text: "Default: " + root.defaultCidrs.join(", "); color: root.faint; font.family: root.mono; font.pixelSize: Style.font.caption }
      ScrollList {
        id: cidrList
        Layout.fillWidth: true
        visible: root.extraCidrs.length > 0
        barColor: root.faint
        model: root.extraCidrs
        delegate: RowLayout {
          required property string modelData
          width: parent ? parent.width : 0
          Text { textFormat: Text.PlainText; text: root.plain(modelData, 20); color: root.fg; font.family: root.mono; font.pixelSize: Style.font.caption }
          Item { Layout.fillWidth: true }
          Text { textFormat: Text.PlainText; text: "REMOVE"; color: root.red; font.family: root.mono; font.pixelSize: Style.font.caption; MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.dropCidr(modelData) } }
        }
      }
      RowLayout {
        Layout.fillWidth: true
        spacing: Style.spacing.sm
        Rectangle {
          Layout.fillWidth: true
          implicitHeight: 28
          radius: Style.cornerRadius
          color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.06)
          border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.18)
          border.width: 1
          TextInput {
            anchors { fill: parent; leftMargin: 8; rightMargin: 8 }
            text: root.cidrDraft
            color: root.fg
            font.family: root.mono
            font.pixelSize: Style.font.caption
            maximumLength: 18
            clip: true
            onTextChanged: root.cidrDraft = text
            Text { textFormat: Text.PlainText; visible: !parent.text; text: "10.0.0.0/24"; color: root.faint; font: parent.font; anchors.verticalCenter: parent.verticalCenter }
          }
        }
        Rectangle {
          implicitWidth: addCidr.implicitWidth + Style.spacing.md * 2
          implicitHeight: 28
          radius: Style.cornerRadius
          color: Qt.rgba(root.green.r, root.green.g, root.green.b, 0.12)
          border.color: Qt.rgba(root.green.r, root.green.g, root.green.b, 0.45)
          border.width: 1
          Text { id: addCidr; anchors.centerIn: parent; textFormat: Text.PlainText; text: "ADD"; color: root.green; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.addCidr() }
        }
      }

      }
    }
    ColumnLayout {
      id: sectionsColumn
      Layout.alignment: Qt.AlignTop
      Layout.fillWidth: true
      Layout.minimumWidth: 0
      Layout.preferredWidth: root.columnWidth(0.26)
      spacing: Style.spacing.md
      Text { textFormat: Text.PlainText; text: "SECTIONS · DESK / WEB"; color: root.dim; font.family: root.mono; font.pixelSize: Style.font.caption; font.bold: true; font.letterSpacing: 1.4 }
      Repeater {
        model: root.settings.definitions
        delegate: RowLayout {
          id: sectionRow
          required property var modelData
          // Only sections the browser page can render get a WEB toggle.
          readonly property bool webable: root.settings.webSectionIds.indexOf(modelData.id) >= 0
          Layout.fillWidth: true
          spacing: Style.spacing.sm
          Text { textFormat: Text.PlainText; text: root.plain(modelData.label, 16); color: root.fg; font.family: root.mono; font.pixelSize: Style.font.caption; Layout.preferredWidth: Math.round(96 * Style.fontScale) }
          Text {
            textFormat: Text.PlainText
            text: root.settings.sectionEnabled(modelData.id) ? "DESK ON" : "DESK OFF"
            color: root.settings.sectionEnabled(modelData.id) ? root.green : root.faint
            Layout.preferredWidth: Math.round(72 * Style.fontScale)
            font.family: root.mono
            font.pixelSize: Style.font.caption
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: root.settings.toggleSection(modelData.id) }
          }
          Text {
            textFormat: Text.PlainText
            text: !sectionRow.webable ? "WEB n/a" : (root.settings.webSectionEnabled(modelData.id) ? "WEB ON" : "WEB OFF")
            color: !sectionRow.webable ? root.faint : (root.settings.webSectionEnabled(modelData.id) ? root.cyan : root.faint)
            font.family: root.mono
            font.pixelSize: Style.font.caption
            MouseArea { anchors.fill: parent; enabled: sectionRow.webable; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: root.settings.toggleWebSection(modelData.id) }
          }
        }
      }
    }
  }
}
