#!/usr/bin/env bun

const text = String(process.argv[2] || "");
if (!text || text.length > 10000 || /\0/.test(text) || !Bun.which("wl-copy")) process.exit(2);
const proc = Bun.spawn(["wl-copy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
proc.stdin.write(text);
proc.stdin.end();
process.exit(await proc.exited);
