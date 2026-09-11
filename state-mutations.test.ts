import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { patchDashboard } from "./dashboard-state";

const root = mkdtempSync(join(tmpdir(), "infomarchy-mutations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const envFor = (dir: string) => ({ ...process.env, XDG_STATE_HOME: dir });
const source = (file: string) => JSON.stringify(join(import.meta.dir, file));
async function run(code: string, dir: string) {
  const p = Bun.spawn([process.execPath, "-e", code], { env: envFor(dir), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), 7000);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(0);
    expect(err).toBe("");
    return out.trim();
  } finally { clearTimeout(timer); p.kill("SIGKILL"); await p.exited; }
}
async function heldLock(dir: string, name: string) {
  const ready = join(dir, "held"), release = join(dir, "release");
  const p = Bun.spawn([process.execPath, "-e", `
    import {withStateLock} from ${source("state-lock.ts")};
    import {existsSync,writeFileSync} from 'fs';
    withStateLock(${JSON.stringify(join(dir, "infomarchy"))},${JSON.stringify(name)},()=>{
      writeFileSync(${JSON.stringify(ready)},'ready');
      const end=Date.now()+5000;
      while(!existsSync(${JSON.stringify(release)}) && Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    });
  `], { env: envFor(dir), stdout: "ignore", stderr: "ignore" });
  const until = Date.now() + 3000;
  while (!existsSync(ready) && Date.now() < until) await Bun.sleep(10);
  expect(existsSync(ready)).toBe(true);
  return { p, release: () => writeFileSync(release, "go") };
}

test("desktop and browser field patches wait for the same lock and preserve privacy and distinct map entries", async () => {
  const dir = mkdtempSync(join(root, "dashboard-"));
  const state = join(dir, "infomarchy");
  expect(patchDashboard(state, { privacyMode: true, webEnabled: false, webAccessMode: "tailscale" })).toBe(true);
  const held = await heldLock(dir, "dashboard.lock");
  let completed = 0;
  const workers = Array.from({ length: 6 }, (_, i) => run(i % 2 ? `
    import {patchDashboardPrefs} from ${source("web-server.ts")};
    if(!patchDashboardPrefs({webSections:{${["usage", "recent", "machine"][Math.floor(i / 2)]}:false}})) process.exit(1);
  ` : `
    import {patchDashboard} from ${source("dashboard-state.ts")};
    if(!patchDashboard(${JSON.stringify(state)}, {sections:{card${i}:false}})) process.exit(1);
  `, dir).then(() => { completed++; }));
  try {
    await Bun.sleep(150);
    expect(completed).toBe(0);
    held.release();
    await Promise.all(workers);
    const saved = JSON.parse(readFileSync(join(state, "dashboard.json"), "utf8"));
    expect(saved.privacyMode).toBe(true);
    expect(saved.webEnabled).toBe(false);
    expect(saved.webAccessMode).toBe("tailscale");
    expect(Object.keys(saved.sections).length).toBe(3);
    expect(Object.keys(saved.webSections).length).toBe(3);
  } finally { held.release(); await held.p.exited; await Promise.allSettled(workers); }
});

test("concurrent revocation, token creation, CIDRs and listener writes cannot resurrect a token", async () => {
  const dir = mkdtempSync(join(root, "tokens-"));
  const id = await run(`import {ensureConfig,addWebToken} from ${source("web-server.ts")}; ensureConfig(); console.log(addWebToken('revoke me').id);`, dir);
  const held = await heldLock(dir, "web-config.lock");
  let completed = 0;
  const jobs = [
    `if(!w.revokeWebToken(${JSON.stringify(id)})) process.exit(1);`,
    `if(!w.addWebToken('viewer two')) process.exit(1);`,
    `if(!w.addWebToken('viewer three')) process.exit(1);`,
    `if(!w.addExtraCidr('10.11.0.0/16')) process.exit(1);`,
    `if(!w.addExtraCidr('10.12.0.0/16')) process.exit(1);`,
    `w.ensureConfig([],true);`,
  ].map(code => run(`import * as w from ${source("web-server.ts")}; ${code}`, dir).then(() => { completed++; }));
  try {
    await Bun.sleep(150);
    expect(completed).toBe(0);
    held.release();
    await Promise.all(jobs);
    const report = await run(`import * as w from ${source("web-server.ts")};
      const c=w.loadConfig(); console.log(JSON.stringify({count:c.tokens.length,revoked:!c.tokens.some(t=>t.id===${JSON.stringify(id)}),cidrs:c.extraCidrs.length}));`, dir);
    expect(JSON.parse(report)).toEqual({ count: 3, revoked: true, cidrs: 2 });
  } finally { held.release(); await held.p.exited; await Promise.allSettled(jobs); }
});

test("settings locks fail closed on symlinks and are released on process death", async () => {
  const dir = mkdtempSync(join(root, "locks-")), state = join(dir, "infomarchy");
  mkdirSync(state, {mode: 0o700});
  const victim = join(dir, "victim"); writeFileSync(victim, "unchanged");
  symlinkSync(victim, join(state, "dashboard.lock"));
  expect(patchDashboard(state, {privacyMode: false})).toBe(false);
  expect(readFileSync(victim, "utf8")).toBe("unchanged");
  rmSync(join(state, "dashboard.lock"));
  const held = await heldLock(dir, "dashboard.lock");
  held.p.kill("SIGKILL"); await held.p.exited;
  expect(patchDashboard(state, {privacyMode: true})).toBe(true);
});

test("invalid dashboard state and unknown fields are not overwritten", () => {
  const dir = mkdtempSync(join(root, "invalid-"));
  writeFileSync(join(dir, "dashboard.json"), "broken");
  expect(patchDashboard(dir, { privacyMode: false })).toBe(false);
  expect(readFileSync(join(dir, "dashboard.json"), "utf8")).toBe("broken");
  expect(patchDashboard(dir, { surprise: true })).toBe(false);
});

test("field patches retain other preferences, preserve pin pruning, and keep an explicit unpin deleted", () => {
  const dir = mkdtempSync(join(root, "maps-"));
  const pins = Object.fromEntries(Array.from({length: 200}, (_, i) => ["provider:session:" + (i + 1), true]));
  writeFileSync(join(dir, "dashboard.json"), JSON.stringify({ privacyMode: true, customPreference: "keep", pinnedPrompts: pins }));
  expect(patchDashboard(dir, { pinnedPrompts: { "provider:session:201": true } })).toBe(true);
  expect(patchDashboard(dir, { pinnedPrompts: { "provider:session:100": null } })).toBe(true);
  expect(patchDashboard(dir, { sections: { usage: false } })).toBe(true);
  const saved = JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8"));
  expect(saved.privacyMode).toBe(true);
  expect(saved.customPreference).toBe("keep");
  expect(Object.keys(saved.pinnedPrompts).length).toBe(199);
  expect(saved.pinnedPrompts["provider:session:1"]).toBeUndefined();
  expect(saved.pinnedPrompts["provider:session:100"]).toBeUndefined();
  expect(saved.pinnedPrompts["provider:session:201"]).toBe(true);
});

for (const failWrite of [false, true]) test.skipIf(!existsSync("/usr/bin/quickshell"))(failWrite ? "actual QML reports failed writes and reloads saved settings" : "actual QML stale instances preserve privacy, WEB off and access mode while saving layout", async () => {
  const dir = mkdtempSync(join(root, "qml-")), state = join(dir, "infomarchy");
  expect(patchDashboard(state, { privacyMode: false, webEnabled: true })).toBe(true);
  if (failWrite) { rmSync(join(state, "dashboard.lock")); symlinkSync(join(state, "dashboard.json"), join(state, "dashboard.lock")); }
  writeFileSync(join(dir, "InfoSettings.qml"), readFileSync(join(import.meta.dir, "InfoSettings.qml")));
  symlinkSync(join(import.meta.dir, "dashboard-state.ts"), join(dir, "dashboard-state.ts"));
  // Status polling is irrelevant; the real persistence helper is retained.
  writeFileSync(join(dir, "web-server.ts"), 'console.log(JSON.stringify({ok:true,running:false,ready:false}));');
  writeFileSync(join(dir, "shell.qml"), `
    import QtQuick
    import Quickshell
    ShellRoot {
      InfoSettings { id: a }
      InfoSettings { id: b }
      Timer {
        property int stage: 0
        interval: 50; repeat: true; running: true
        onTriggered: {
          if (stage === 0 && a.ready && b.ready) {
            stage = 1
            a.setPrivacyMode(true)
            a.setWebEnabled(false)
            a.setWebAccessMode("tailscale")
            a.setSection("recent", false)
            b.setSection("usage", false)
            b.setWebSection("machine", false)
            b.setNotificationsEnabled(false)
            b.setOllamaHost("http://127.0.0.1:11435")
          } else if (stage === 1 && !a.settingsWriting && !b.settingsWriting) {
            if (a.settingsError || b.settingsError) {
              if (!${failWrite} || (!a.privacyMode && a.webEnabled && !b.privacyMode && b.webEnabled)) { console.log("MUTATION_FAILED"); Qt.quit() }
              return
            }
            console.log("MUTATION_PASSED"); Qt.quit()
          }
        }
      }
    }
  `);
  const p = Bun.spawn(["/usr/bin/quickshell", "--no-color", "-p", dir], {
    env: {...envFor(dir), QT_QPA_PLATFORM: "offscreen"}, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 8000);
  try {
    const output = (await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])).join("\n");
    expect(await p.exited).toBe(0);
    expect(output).toContain(failWrite ? "MUTATION_FAILED" : "MUTATION_PASSED");
    expect(output).not.toContain(failWrite ? "MUTATION_PASSED" : "MUTATION_FAILED");
    const saved = JSON.parse(readFileSync(join(state, "dashboard.json"), "utf8"));
    if (failWrite) {
      expect(saved.privacyMode).toBe(false);
      expect(saved.webEnabled).toBe(true);
      return;
    }
    expect(saved.privacyMode).toBe(true);
    expect(saved.webEnabled).toBe(false);
    expect(saved.webAccessMode).toBe("tailscale");
    expect(saved.sections).toEqual({ recent: false, usage: false });
    expect(saved.webSections).toEqual({ machine: false });
    expect(saved.notificationsEnabled).toBe(false);
    expect(saved.ollamaHost).toBe("http://127.0.0.1:11435");
  } finally { clearTimeout(timer); p.kill("SIGKILL"); await p.exited; }
}, 12000);
