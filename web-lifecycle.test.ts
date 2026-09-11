import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { localPrivateIPv4 } from "./web-server";
import { mappingReady } from "./web-tailscale";

const root = mkdtempSync(join(tmpdir(), "infomarchy-lifecycle-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("only an owned foreground HTTPS mapping qualifies; Funnel and background do not", () => {
  const origin = "https://desk.example.ts.net:8788";
  const mapping = { TCP: { "8788": { HTTPS: true } }, Web: { "desk.example.ts.net:8788": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } };
  expect(mappingReady(mapping, origin, 8787)).toBe(false);
  expect(mappingReady({ Foreground: { ours: mapping } }, origin, 8787)).toBe(true);
  expect(mappingReady({ Foreground: { ours: mapping } }, origin, 9999)).toBe(false);
  expect(mappingReady({ Foreground: { ours: mapping }, AllowFunnel: { "desk.example.ts.net:8788": true } }, origin, 8787)).toBe(false);
});

test("private listener binds loopback, stops its child, and can enable again", async () => {
  // Mock only the external Tailscale service. Exercise the real listener, auth,
  // status, shutdown and Linux parent-death guard in isolated processes/state.
  const childCode = `import runpy,sys,time; runpy.run_path(${JSON.stringify(join(import.meta.dir, "web-child.py"))})['arm_parent_death'](int(sys.argv[1])); print('armed',flush=True); time.sleep(120)`;
  const fixture = join(root, "listener.ts");
  writeFileSync(fixture, `
    import { serve } from ${JSON.stringify(join(import.meta.dir, "web-server.ts"))};
    import { writeFileSync } from 'fs';
    let child;
    await serve('tailscale', {
      inspectTailscale: async () => ({ ok: true, state: 'ready', message: '', origin: 'https://desk.example.ts.net:8788' }),
      startServe: () => {
        child = Bun.spawn(['/usr/bin/python3', '-I', '-S', '-c', ${JSON.stringify(childCode)}, String(process.pid)], {stdout:'pipe',stderr:'ignore'});
        writeFileSync(${JSON.stringify(join(root, "child-pid"))}, String(child.pid));
        return child;
      },
      serveMappingReady: async () => { await child.stdout.getReader().read(); return true; },
    });
  `);
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const proc = Bun.spawn([process.execPath, fixture], {
      env: { HOME: root, XDG_STATE_HOME: root, INFOMARCHY_WEB_PORT: "0", PATH: "/usr/bin:/bin" },
      stdout: "pipe", stderr: "ignore",
    });
    try {
      const first = await proc.stdout.getReader().read();
      const status = JSON.parse(new TextDecoder().decode(first.value));
      expect(status.ready).toBe(true);
      const config = JSON.parse(readFileSync(join(root, "infomarchy/web.json"), "utf8"));
      writeFileSync(join(root, "infomarchy/web-snapshot.json"), JSON.stringify({ ai: {} }));
      const path = `/t/${config.tokens[0].token}/`;
      const url = `http://127.0.0.1:${status.port}${path}`;
      const allowed = await fetch(url, { headers: { Host: "desk.example.ts.net:8788" } });
      expect(allowed.status).toBe(200);
      expect((await fetch(url)).status).toBe(403);
      expect((await fetch(url, { headers: { "X-Forwarded-Host": "desk.example.ts.net:8788", "X-Forwarded-Proto": "https", "Tailscale-User-Login": "admin@example.com" } })).status).toBe(403);
      for (const ip of localPrivateIPv4().slice(0, 1)) {
        let reached = false;
        try { await fetch(`http://${ip}:${status.port}${path}`, { signal: AbortSignal.timeout(500) }); reached = true; } catch {}
        expect(reached).toBe(false);
      }
      const childPid = Number(readFileSync(join(root, "child-pid"), "utf8"));
      proc.kill(signal);
      await proc.exited;
      let stopped = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const stat = readFileSync(`/proc/${childPid}/stat`, "utf8");
          stopped = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
        } catch { stopped = true; }
        if (stopped) break;
        await Bun.sleep(25);
      }
      expect(stopped).toBe(true);
      let connected = false;
      try { await fetch(url, { signal: AbortSignal.timeout(500) }); connected = true; } catch {}
      expect(connected).toBe(false);
    } finally { proc.kill("SIGKILL"); await proc.exited; }
  }
});

test("missing prerequisites and failed Serve setup exit without a LAN fallback", async () => {
  for (const ready of [false, true]) {
    const fixture = join(root, `failed-${ready}.ts`);
    writeFileSync(fixture, `
      import { serve } from ${JSON.stringify(join(import.meta.dir, "web-server.ts"))};
      await serve('tailscale', {
        inspectTailscale: async () => ({ok:${ready},state:'missing',message:'Install Tailscale first.',origin:'https://desk.example.ts.net:8788'}),
        startServe: () => Bun.spawn(['/usr/bin/false'], {stdout:'ignore',stderr:'ignore'}),
        serveMappingReady: async () => false,
      });
    `);
    const proc = Bun.spawn([process.execPath, fixture], {
      env: { HOME: root, XDG_STATE_HOME: root, INFOMARCHY_WEB_PORT: "0", PATH: "/usr/bin:/bin" },
      stdout: "pipe", stderr: "ignore",
    });
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 3000);
    try {
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const result = JSON.parse(output);
      expect(result.ok).toBe(false);
      expect(result.url).toBeUndefined();
      const status = JSON.parse(readFileSync(join(root, "infomarchy/web-status.json"), "utf8"));
      expect(status.ready).toBe(false);
      expect(status.mode).toBe("tailscale");
      expect(status.origin).toBe("");
    } finally { clearTimeout(deadline); proc.kill("SIGKILL"); await proc.exited; }
  }
});
