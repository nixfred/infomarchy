import { afterAll, expect, test } from "bun:test";
import { X509Certificate } from "crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadManualTls, parseManualHttps } from "./web-manual";
import { handleRequest, parseCidrList } from "./web-server";

const dir = mkdtempSync(join(tmpdir(), "infomarchy-manual-"));
afterAll(() => rmSync(dir, {recursive:true, force:true}));
function openssl(args: string[]) {
  const p = Bun.spawnSync(["/usr/bin/timeout", "10", "/usr/bin/openssl", ...args], {cwd:dir, stdout:"ignore", stderr:"ignore"});
  if (p.exitCode !== 0) throw new Error("Test certificate generation failed");
}
openssl(["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout","ca.key","-out","ca.pem","-days","2","-subj","/CN=Infomarchy synthetic test CA","-addext","basicConstraints=critical,CA:TRUE"]);
openssl(["req","-new","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout","server.key","-out","server.csr","-subj","/CN=infomarchy.localhost"]);
writeFileSync(join(dir,"extensions"),"subjectAltName=DNS:infomarchy.localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n");
openssl(["x509","-req","-in","server.csr","-CA","ca.pem","-CAkey","ca.key","-CAcreateserial","-out","server.pem","-days","1","-extfile","extensions"]);
chmodSync(join(dir,"server.key"),0o600);
const leaf = new X509Certificate(readFileSync(join(dir,"server.pem")));
writeFileSync(join(dir,"chain.pem"),readFileSync(join(dir,"server.pem"),"utf8")+readFileSync(join(dir,"ca.pem"),"utf8"));
const config = {hostname:"infomarchy.localhost",bind:"127.0.0.1",port:8789,certPath:join(dir,"chain.pem"),keyPath:join(dir,"server.key"),fingerprint:leaf.fingerprint256};

writeFileSync(join(dir,"ip-extensions"),"subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n");
openssl(["x509","-req","-in","server.csr","-CA","ca.pem","-CAkey","ca.key","-CAcreateserial","-out","server-ip.pem","-days","1","-extfile","ip-extensions"]);
const ipLeaf = new X509Certificate(readFileSync(join(dir,"server-ip.pem")));
const ipConfig = {...config,hostname:"127.0.0.1",certPath:join(dir,"server-ip.pem"),fingerprint:ipLeaf.fingerprint256};
test("literal private IP addresses require matching IP SANs, never DNS SAN or CN fallback", () => {
  expect(loadManualTls(ipConfig).origin).toBe("https://127.0.0.1:8789");
  expect(() => loadManualTls({...config,hostname:"127.0.0.1"})).toThrow("subject alternative names");
  expect(() => loadManualTls({...ipConfig,hostname:"127.0.0.2"})).toThrow("subject alternative names");
});

test("existing PEM chain matches the exact fingerprint, SAN hostname and private key", () => {
  const loaded = loadManualTls(config);
  expect(loaded.origin).toBe("https://infomarchy.localhost:8789");
  expect(loaded.tls.key.length > 0).toBe(true);
  expect(loaded.expiresAt > Date.now()).toBe(true);
  expect(loadManualTls({...config,fingerprint:leaf.fingerprint256.replace(/:/g,"").toLowerCase()}).config.port).toBe(8789);
});

test("mismatched fingerprint, hostname, key and invalid dates fail before listening", () => {
  expect(() => loadManualTls({...config,fingerprint:"00".repeat(32)})).toThrow("fingerprint mismatch");
  expect(() => loadManualTls({...config,hostname:"other.localhost"})).toThrow("hostname");
  expect(() => loadManualTls({...config,keyPath:join(dir,"ca.key")})).toThrow("private key does not match");
  expect(() => loadManualTls(config,Date.parse(leaf.validTo)+1)).toThrow("expired");
  expect(() => loadManualTls(config,Date.parse(leaf.validFrom)-1)).toThrow("not yet valid");
});

test("public or wildcard binds, malformed names, ports and paths are refused", () => {
  for (const bind of ["0.0.0.0","8.8.8.8","::","127.0.0.999"]) expect(parseManualHttps({...config,bind})).toBeNull();
  for (const hostname of ["https://desk.localhost","desk.localhost/path","user@desk.localhost","*.localhost","999.0.0.1","8.8.8.8","desk.localhost\ninvalid"]) expect(parseManualHttps({...config,hostname})).toBeNull();
  for (const port of [0,443,65536]) expect(parseManualHttps({...config,port})).toBeNull();
  expect(parseManualHttps({...config,keyPath:"relative.key"})).toBeNull();
  expect(parseManualHttps({...config,keyPath:"/tmp/../key"})).toBeNull();
});

test("unsafe key permissions and symlinks, including parent symlinks, are refused", () => {
  chmodSync(config.keyPath,0o644);
  try { expect(() => loadManualTls(config)).toThrow("permissions"); } finally { chmodSync(config.keyPath,0o600); }
  symlinkSync(config.keyPath,join(dir,"key-link"));
  symlinkSync(dir,join(dir,"dir-link"));
  expect(() => loadManualTls({...config,keyPath:join(dir,"key-link")})).toThrow("safely read");
  expect(() => loadManualTls({...config,keyPath:join(dir,"dir-link/server.key")})).toThrow("safely read");
});

const token = "a".repeat(48);
const request = {method:"GET",pathname:`/t/${token}/`,host:"infomarchy.localhost:8789",origin:null,sourceIp:"127.0.0.1",contentLength:0,
  tokens:[{id:"aaaaaaaa",token,label:"test",createdAt:1}],port:8789,allowedHosts:[],cidrs:parseCidrList([]),snapshot:{ai:{}},background:null,
  externalOrigin:"https://infomarchy.localhost:8789",manualTls:true};
test("manual HTTPS retains token, source, exact Host/Origin and privacy mutation boundaries", () => {
  expect(handleRequest(request).status).toBe(200);
  expect(handleRequest({...request,sourceIp:"8.8.8.8"}).status).toBe(403);
  expect(handleRequest({...request,host:"127.0.0.1:8789"}).status).toBe(403);
  expect(handleRequest({...request,origin:"http://infomarchy.localhost:8789"}).status).toBe(403);
  expect(handleRequest({...request,pathname:"/t/"+"b".repeat(48)+"/"}).status).toBe(404);
  expect(handleRequest({...request,method:"POST",pathname:request.pathname+"prefs",origin:request.externalOrigin,contentType:"application/json",body:'{"privacyMode":false}'}).status).toBe(400);
  expect(handleRequest({...request,manualTls:false}).status).toBe(403);
});

for (const useIp of [false,true]) test("a real TLS listener serves trusted HTTPS by " + (useIp ? "IP" : "hostname") + ", rejects wrong Host and never falls back to HTTP", async () => {
  const state = mkdtempSync(join(dir,"state-"));
  const probe = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("")});
  const port = probe.port; probe.stop(true);
  const opts = {...(useIp ? ipConfig : config),port};
  const setup = Bun.spawnSync([process.execPath,"-e",`
    import {patchDashboard} from ${JSON.stringify(join(import.meta.dir,"dashboard-state.ts"))};
    import {ensureConfig,publishSnapshot} from ${JSON.stringify(join(import.meta.dir,"web-server.ts"))};
    if(!patchDashboard(${JSON.stringify(join(state,"infomarchy"))},{manualHttps:${JSON.stringify(opts)},webAccessMode:'manual',privacyMode:true})) process.exit(1);
    ensureConfig(); publishSnapshot({user:'PRIVATE_USER',ai:{recent:[{text:'one two three four PRIVATE_PROMPT'}]}});
  `],{env:{...process.env,XDG_STATE_HOME:state},stdout:"ignore",stderr:"ignore"});
  expect(setup.exitCode).toBe(0);
  const p = Bun.spawn([process.execPath,join(import.meta.dir,"web-server.ts"),"serve","manual"],{env:{...process.env,XDG_STATE_HOME:state},stdout:"pipe",stderr:"pipe"});
  const timer = setTimeout(()=>p.kill("SIGKILL"),7000);
  try {
    const reader = p.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain('"ready":true');
    // Private token read is confined to this synthetic fixture and never printed.
    const cfg = JSON.parse(readFileSync(join(state,"infomarchy/web.json"),"utf8"));
    const path = `/t/${cfg.tokens[0].token}/`;
    const get = async (host: string) => {
      const {request} = await import("node:https");
      return await new Promise<{status:number,body:string}>((resolve,reject)=>{
        const req=request({hostname:"127.0.0.1",port,path,servername:useIp ? "" : opts.hostname,checkServerIdentity:(_host,cert)=>require("node:tls").checkServerIdentity(opts.hostname,cert),ca:readFileSync(join(dir,"ca.pem")),headers:{Host:host}},res=>{
          let body="";res.on("data",b=>body+=b);res.on("end",()=>resolve({status:res.statusCode!,body}));
        }); req.on("error",()=>reject(new Error("TLS request failed")));req.end();
      });
    };
    const good=await get(`${opts.hostname}:${port}`);
    expect(good.status).toBe(200);
    expect(good.body.includes("PRIVATE_")).toBe(false);
    expect((await get(`wrong.localhost:${port}`)).status).toBe(403);
    let plaintext=false;
    try { const r=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(1000)}); plaintext=r.status===200; } catch {}
    expect(plaintext).toBe(false);
  } finally {clearTimeout(timer);p.kill("SIGTERM");await p.exited;}
  // Invalid fingerprint must exit without binding the chosen port at all.
  const dash=join(state,"infomarchy/dashboard.json"), saved=JSON.parse(readFileSync(dash,"utf8"));
  saved.manualHttps.fingerprint="00".repeat(32);writeFileSync(dash,JSON.stringify(saved));
  const failed=Bun.spawnSync([process.execPath,join(import.meta.dir,"web-server.ts"),"serve","manual"],{env:{...process.env,XDG_STATE_HOME:state},stdout:"pipe",stderr:"ignore"});
  expect(failed.stdout.toString()).toContain("fingerprint mismatch");
  const free=Bun.serve({hostname:"127.0.0.1",port,fetch:()=>new Response("")});free.stop(true);
},12000);

test.skipIf(!existsSync("/usr/bin/quickshell"))("Manual HTTPS settings form saves, checks its certificate and switches back to Tailscale with WEB off", async () => {
  const harness = mkdtempSync(join(dir,"qml-"));
  const fs = await import("fs");
  fs.mkdirSync(join(harness,"Commons"));
  writeFileSync(join(harness,"Commons/qmldir"),"module qs.Commons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\n");
  writeFileSync(join(harness,"Commons/Style.qml"),'pragma Singleton\nimport QtQuick\nQtObject { property var spacing: ({xs:4,sm:6,md:10,lg:14}); property var font: ({caption:11,body:13,bodySmall:12,subtitle:14,family:"monospace"}); property string resolvedFontFamily:"monospace"; property int cornerRadius:4 }');
  writeFileSync(join(harness,"Commons/Color.qml"),'pragma Singleton\nimport QtQuick\nQtObject { property color foreground:"#dddddd"; property color accent:"#88bbff"; property color urgent:"#ff6666" }');
  for(const name of ["SettingsBody.qml","InfoSettings.qml"]) writeFileSync(join(harness,name),readFileSync(join(import.meta.dir,name)));
  for(const name of ["dashboard-state.ts","web-manual.ts"]) symlinkSync(join(import.meta.dir,name),join(harness,name));
  writeFileSync(join(harness,"web-server.ts"),'console.log(JSON.stringify({ok:false}));');
  writeFileSync(join(harness,"web-tailscale.ts"),'console.log(JSON.stringify({ok:false,message:"not checked in this harness"}));');
  writeFileSync(join(harness,"shell.qml"),`
    import QtQuick
    import Quickshell
    ShellRoot {
      InfoSettings { id: settings }
      Window {
        visible:true; width:540; height:900; color:"#202020"
        Flickable { anchors.fill:parent; contentHeight:body.implicitHeight; clip:true
          SettingsBody { id:body; width:520; settings:settings }
        }
      }
      Timer {
        property int stage:0
        interval:50;running:true;repeat:true
        onTriggered: {
          if(stage===0 && settings.ready) {
            stage=1; settings.setWebAccessMode("manual"); body.manualDraft=${JSON.stringify(config)}; body.saveManual()
          } else if(stage===1 && !settings.settingsWriting) {
            if(settings.settingsError) { console.log("FORM_FAILED"); Qt.quit(); return }
            stage=2; body.checkManual()
          } else if(stage===2 && body.manualMessage.indexOf("fingerprint match")>=0) {
            stage=3; settings.setWebAccessMode("tailscale")
          } else if(stage===3 && !settings.settingsWriting) {console.log("FORM_PASSED");Qt.quit()}
        }
      }
    }
  `);
  const p=Bun.spawn(["/usr/bin/quickshell","--no-color","-p",harness],{env:{...process.env,XDG_STATE_HOME:harness,QT_QPA_PLATFORM:"offscreen"},stdout:"pipe",stderr:"pipe"});
  const deadline=setTimeout(()=>p.kill("SIGKILL"),8000);
  try {
    const output=(await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()])).join("\n");
    expect(await p.exited).toBe(0);
    expect(output).toContain("FORM_PASSED");
    expect(output).not.toMatch(/ReferenceError|TypeError|Binding loop|Unable to assign/);
    const saved=JSON.parse(readFileSync(join(harness,"infomarchy/dashboard.json"),"utf8"));
    expect(saved.webAccessMode).toBe("tailscale");expect(saved.webEnabled).toBe(false);
    expect(saved.manualHttps.hostname).toBe(config.hostname);
  } finally {clearTimeout(deadline);p.kill("SIGKILL");await p.exited;}
},12000);
