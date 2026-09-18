import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test.skipIf(!existsSync("/usr/bin/quickshell"))("QML retries an exited setup once and retains WEB off control", async () => {
  const dir = mkdtempSync(join(tmpdir(), "infomarchy-retry-"));
  const service = readFileSync(join(import.meta.dir, "Infomarchy.qml"), "utf8");
  const lifecycle = service.slice(service.indexOf("  readonly property string webServerPath:"), service.indexOf("  function imageUrl("));
  writeFileSync(join(dir, "web-server.ts"), `
    import { existsSync, readFileSync, writeFileSync } from 'fs';
    const path = ${JSON.stringify(join(dir, "attempts"))};
    if (process.argv[2] === 'disable') process.exit(0);
    const attempt = existsSync(path) ? Number(readFileSync(path,'utf8')) + 1 : 1;
    writeFileSync(path, String(attempt));
    if (attempt === 1) { console.log(JSON.stringify({ok:false,message:'Enable HTTPS certificates, then retry.'})); }
    else { console.log(JSON.stringify({ok:true,ready:true})); setInterval(() => {},1000); }
  `);
  writeFileSync(join(dir, "shell.qml"), `
    import QtQuick
    import Quickshell
    import Quickshell.Io
    ShellRoot {
      id: root
      QtObject {
        id: dashboardSettings
        property bool ready: true
        property bool webEnabled: true
        property bool webReady: false
        property bool webStarting: false
        property string webAccessMode: "tailscale"
        property string webStatusText: ""
      }
      ${lifecycle}
      Timer {
        property int stage: 0
        interval: 50; running: true; repeat: true
        onTriggered: {
          if (stage === 0 && !webServer.running && dashboardSettings.webStatusText) {
            if (dashboardSettings.webStarting || dashboardSettings.webReady) { console.log("RETRY_TEST_FAILED"); Qt.quit(); return }
            stage = 1
            root.retryWebSetup()
            root.retryWebSetup()
          } else if (stage === 1 && dashboardSettings.webReady) {
            root.retryWebSetup() // A healthy listener must not be restarted.
            stage = 2
            dashboardSettings.webEnabled = false
          } else if (stage === 2 && !webServer.running && !webDisable.running) {
            console.log("RETRY_TEST_PASSED")
            Qt.quit()
          }
        }
      }
    }
  `);
  const proc = Bun.spawn(["/usr/bin/quickshell", "--no-color", "-p", dir], {
    env: { ...process.env, QT_QPA_PLATFORM: "offscreen" }, stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 8000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    expect((stdout + stderr).includes("RETRY_TEST_PASSED")).toBe(true);
    expect((stdout + stderr).includes("RETRY_TEST_FAILED")).toBe(false);
    expect(readFileSync(join(dir, "attempts"), "utf8")).toBe("2");
  } finally {
    clearTimeout(deadline); proc.kill("SIGKILL"); await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
