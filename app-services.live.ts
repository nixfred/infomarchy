#!/usr/bin/env bun
/** Explicit smoke test. Owns only a random fixture app; never touches existing registrations. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { paths, SCRIPT, MARKER, run } from "./app-services";

if (!process.argv.includes("--run")) {
  console.log("Run explicitly with --run to exercise a temporary systemd user service.");
} else {
  const root = mkdtempSync(join(tmpdir(), "infomarchy-live-"));
  const appFolder = join(root, "app with % spaces $"), registry = join(root, "apps.json");
  mkdirSync(appFolder); writeFileSync(registry, "[]");
  const env = { ...process.env, INFOMARCHY_APPS_REGISTRY: registry, XDG_STATE_HOME: join(root, "state % $") };
  const id = "smoke-" + crypto.randomUUID().slice(0, 8), unit = `infomarchy-app-${id}.service`;
  const unitFile = join(paths(env).units, unit);
  assert(!existsSync(unitFile));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port!; await probe.stop(true);
  const serverFile = join(appFolder, "serve.ts");
  writeFileSync(serverFile, 'const server = Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch(){console.log("GET / HTTP/1.1 200");return new Response("fixture")}}); console.log("ready",server.port);');
  async function cli(args: string[], expected = true): Promise<any> {
    const child = Bun.spawn([process.execPath, SCRIPT, ...args, "--json"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const result = JSON.parse(stdout); assert.equal(code === 0 && result.ok, expected, stderr || stdout); return result;
  }
  let foreign: ReturnType<typeof Bun.serve> | undefined;
  try {
    await cli(["register", "--registration", JSON.stringify({ id, name: "Temporary app", path: appFolder, port, command: [process.execPath, serverFile] })]);
    assert.equal((await cli(["status", id])).services[0].state, "stopped");
    run(["systemd-analyze", "--user", "verify", unitFile]);
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => cli(["ensure", id])));
    const started = concurrent[0].status; assert(started.ready); assert(concurrent.every(r => r.status.pid === started.pid));
    assert.equal(started.autostart, false);
    const restarted = (await cli(["restart", id])).status; assert(restarted.ready && restarted.pid !== started.pid);
    const beforeLog = (await cli(["logs", id])).log; assert(beforeLog.includes("GET / HTTP/1.1 200"));
    await cli(["stop", id]);
    foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("foreign fixture") });
    const conflict = await cli(["ensure", id], false); assert(conflict.error.includes("occupied"));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "foreign fixture");
    await foreign.stop(true); foreign = undefined;
    const active = (await cli(["ensure", id])).status;
    process.kill(active.pid, "SIGKILL"); // only this freshly-created fixture unit's main process
    let recovered: any; const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await Bun.sleep(500); recovered = (await cli(["status", id])).services[0];
      if (recovered.ready && recovered.pid !== active.pid) break;
    }
    assert(recovered.ready && recovered.pid !== active.pid, "systemd did not recover the fixture");
    assert((await cli(["logs", id])).log.includes(beforeLog));
    console.log(JSON.stringify({ ok: true, checks: ["register stays stopped", "four concurrent ensures reuse one PID", "restart", "HTTP request logs retained", "foreign listener preserved", "automatic crash recovery", "paths with spaces/percent/dollar", "stop and cleanup"], fixture: id }));
  } finally {
    await foreign?.stop(true);
    if (existsSync(unitFile)) {
      assert(readFileSync(unitFile, "utf8").startsWith(MARKER));
      run(["systemctl", "--user", "stop", unit], { timeout: 30000, check: false });
      unlinkSync(unitFile); run(["systemctl", "--user", "daemon-reload"]); run(["systemctl", "--user", "reset-failed", unit], { check: false });
    }
    rmSync(root, { recursive: true, force: true });
  }
}
