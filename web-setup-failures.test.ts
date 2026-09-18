import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {rankLanAddresses, qrMatrixForUrl, copyWebLink} from './web-server';

test('LAN advertisement follows default route metric and excludes isolated bridges', () => {
  const ip = (address:string) => [{address, family:'IPv4', internal:false}] as any;
  const nets = {'br-test':ip('172.20.0.1'),docker0:ip('10.88.0.1'),wlo1:ip('172.21.1.50'),eth0:ip('192.168.1.50')};
  const routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask\nwlo1 00000000 010115AC 0003 0 0 50 00000000\neth0 00000000 0101A8C0 0003 0 0 100 00000000';
  expect(rankLanAddresses(nets,routes)).toEqual(['172.21.1.50','192.168.1.50']);
  expect(rankLanAddresses({docker0:nets.docker0},'')).toEqual([]);
  expect(rankLanAddresses({wlo1:nets.wlo1},'malformed')).toEqual(['172.21.1.50']);
});

for (const scenario of ['unknown','legacy','launch-failure']) test.skipIf(!existsSync('/usr/bin/quickshell'))('actual QML setup recovery: '+scenario, async () => {
  const dir=mkdtempSync(join(tmpdir(),'infomarchy-setup-'));
  mkdirSync(join(dir,'infomarchy'));
  writeFileSync(join(dir,'infomarchy/dashboard.json'),JSON.stringify({privacyMode:false,webEnabled:true,...(scenario==='legacy'?{}:{webAccessMode:scenario==='unknown'?'typo':'manual'})}));
  let qml=readFileSync(join(import.meta.dir,'InfoSettings.qml'),'utf8');
  qml=qml.replace('  id: root','  id: root\n  property string reviewWriter: "/nonexistent/infomarchy-test-bun"');
  if(scenario==='launch-failure') qml=qml.replace('command: ["/usr/bin/bun", Qt.resolvedUrl("dashboard-state.ts")','command: [root.reviewWriter, Qt.resolvedUrl("dashboard-state.ts")');
  writeFileSync(join(dir,'InfoSettings.qml'),qml);
  symlinkSync(join(import.meta.dir,'dashboard-state.ts'),join(dir,'dashboard-state.ts'));
  writeFileSync(join(dir,'web-server.ts'),'console.log(JSON.stringify({ok:true,running:false,ready:false}));');
  const action = scenario==='launch-failure' ? `
    if(stage===0 && s.ready) {stage=1;s.setPrivacyMode(true)}
    else if(stage===1 && !s.settingsWriting && s.settingsError && !s.privacyMode) {stage=2;s.reviewWriter="/usr/bin/bun";s.setPrivacyMode(true)}
    else if(stage===2 && !s.settingsWriting && !s.settingsError && s.privacyMode) {console.log("RECOVERY_OK");Qt.quit()}
  ` : scenario==='unknown' ? `
    if(stage===0 && s.ready) {
      if(!s.webModeInvalid || s.webEnabled || s.webAccessMode!=="") {console.log("FAILED");Qt.quit();return}
      s.setWebEnabled(true); if(s.webEnabled) {console.log("FAILED");Qt.quit();return}
      stage=1;s.setWebAccessMode("tailscale")
    } else if(stage===1 && !s.settingsWriting && !s.webModeInvalid && !s.webEnabled && s.webAccessMode==="tailscale") {console.log("RECOVERY_OK");Qt.quit()}
  ` : 'if(s.ready){console.log(s.webAccessMode==="lan" && s.webEnabled && !s.webModeInvalid ? "RECOVERY_OK" : "FAILED");Qt.quit()}';
  writeFileSync(join(dir,'shell.qml'),`import QtQuick\nimport Quickshell\nShellRoot { InfoSettings {id:s} Timer {property int stage:0;interval:50;running:true;repeat:true;onTriggered:{${action}}} }`);
  const p=Bun.spawn(['/usr/bin/quickshell','--no-color','-p',dir],{env:{...process.env,XDG_STATE_HOME:dir,QT_QPA_PLATFORM:'offscreen'},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>p.kill('SIGKILL'),7000);
  try {
    const output=(await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()])).join('\n');
    expect(await p.exited).toBe(0);expect(output).toContain('RECOVERY_OK');
    expect(output).not.toMatch(/ReferenceError|TypeError|Cannot assign to non-existent/);
    if(scenario==='launch-failure') expect(JSON.parse(readFileSync(join(dir,'infomarchy/dashboard.json'),'utf8')).privacyMode).toBe(true);
  } finally {clearTimeout(timer);p.kill('SIGKILL');await p.exited;rmSync(dir,{recursive:true,force:true});}
},10000);

test('missing QR and clipboard tools fail without exposing a viewer credential', async () => {
  const synthetic = 'https://example.invalid:8789/t/' + 'a'.repeat(48) + '/';
  expect(await qrMatrixForUrl(synthetic, '/nonexistent/qrencode')).toEqual([]);
  expect(await copyWebLink(synthetic, '/nonexistent/wl-copy')).toBe(false);
});
