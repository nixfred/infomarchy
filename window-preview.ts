#!/usr/bin/env bun
import { rmSync } from "fs";

export function validWindowAddress(value: unknown): string | null {
  const address = String(value || "").toLowerCase();
  return /^0x[0-9a-f]+$/.test(address) ? address : null;
}

if (import.meta.main) {
  const address = validWindowAddress(process.argv[2]);
  if (!address || !Bun.which("grim") || !Bun.which("magick")) process.exit(2);
  const clientsProc = Bun.spawn(["hyprctl", "clients", "-j"], { stdout: "pipe", stderr: "ignore" });
  const clients = JSON.parse(await new Response(clientsProc.stdout).text());
  const client = clients.find((item: any) => String(item.address || "").toLowerCase() === address);
  const at = client?.at, size = client?.size;
  if (!Array.isArray(at) || !Array.isArray(size) || size[0] < 20 || size[1] < 20) process.exit(3);
  const raw = `/tmp/infomarchy-preview-${process.pid}.png`;
  const safe = `/tmp/infomarchy-preview-${process.getuid?.() ?? 0}-${address.slice(2)}.png`;
  try {
    const geometry = `${at[0]},${at[1]} ${size[0]}x${size[1]}`;
    if (await Bun.spawn(["grim", "-g", geometry, raw], { stdout: "ignore", stderr: "ignore" }).exited !== 0) process.exit(4);
    if (await Bun.spawn(["magick", raw, "-resize", "160x90!", "-blur", "0x10", "-scale", "320x180!", safe], { stdout: "ignore", stderr: "ignore" }).exited !== 0) process.exit(5);
    console.log(safe);
  } finally {
    rmSync(raw, { force: true });
  }
}
