import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPreviewTarget, validWindowAddress, reapPreviewDirectories, expiredPreviewDirectories, PREVIEW_PREFIX } from "./window-preview";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("blurred window previews", () => {
  test("accepts only exact Hyprland hexadecimal addresses", () => {
    expect(validWindowAddress("0xAbC123")).toBe("0xabc123");
    expect(validWindowAddress("title:anything")).toBeNull();
    expect(validWindowAddress("0x123; grim /tmp/leak")).toBeNull();
    expect(validWindowAddress("")).toBeNull();
  });

  test("creates an exclusive no-follow file in a random private directory", () => {
    const base = join(tmpdir(), `infomarchy-preview-test-${crypto.randomUUID()}`);
    mkdirSync(base, { mode: 0o700 });
    cleanup.push(base);
    const target = createPreviewTarget(base);
    try {
      expect(target.directory.startsWith(join(base, "infomarchy-preview-"))).toBe(true);
      expect(lstatSync(target.directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(target.path).isSymbolicLink()).toBe(false);
      expect(lstatSync(target.path).mode & 0o777).toBe(0o600);
      expect(() => openSync(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)).toThrow();
    } finally {
      closeSync(target.fd);
    }
  });

  test("never uses the legacy predictable screenshot paths", () => {
    const source = readFileSync(import.meta.dir + "/window-preview.ts", "utf8");
    expect(source).not.toContain("/tmp/infomarchy-preview-${process.pid}.png");
    expect(source).not.toContain("address.slice(2)}.png");
    expect(source).toContain('["grim", "-g", geometry, "-"]');
    expect(source).toContain('"png:-"');
  });

  test("an attacker-created legacy symlink remains untouched", () => {
    const base = join(tmpdir(), `infomarchy-preview-test-${crypto.randomUUID()}`);
    mkdirSync(base, { mode: 0o700 });
    cleanup.push(base);
    const victim = join(base, "victim");
    const legacy = join(base, `infomarchy-preview-${process.pid}.png`);
    writeFileSync(victim, "unchanged", { mode: 0o600 });
    symlinkSync(victim, legacy);
    const target = createPreviewTarget(base);
    try {
      writeFileSync(target.fd, "preview");
    } finally {
      closeSync(target.fd);
    }
    expect(readFileSync(victim, "utf8")).toBe("unchanged");
  });

  test("streams the capture pipeline and returns only a securely created result", async () => {
    const base = mkdtempSync(join(tmpdir(), "infomarchy-preview-e2e-"));
    cleanup.push(base);
    const fakeBin = join(base, "bin");
    mkdirSync(fakeBin, { mode: 0o700 });
    const install = (name: string, body: string) => {
      const path = join(fakeBin, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      chmodSync(path, 0o700);
    };
    install("hyprctl", "printf '%s' '[{\"address\":\"0xabc\",\"at\":[0,0],\"size\":[100,80]}]'");
    install("grim", "printf '%s\\n' \"$@\" > \"$INFOMARCHY_GRIM_ARGS\"; printf '%s' 'raw-preview-bytes'");
    install("magick", "printf '%s\\n' \"$@\" > \"$INFOMARCHY_MAGICK_ARGS\"; cat");
    const grimArgs = join(base, "grim-args");
    const magickArgs = join(base, "magick-args");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "window-preview.ts"), "0xabc"], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        TMPDIR: base,
        INFOMARCHY_GRIM_ARGS: grimArgs,
        INFOMARCHY_MAGICK_ARGS: magickArgs,
      },
    });
    const output = (await new Response(proc.stdout).text()).trim();
    expect(await proc.exited).toBe(0);
    expect(output.startsWith(join(base, "infomarchy-preview-"))).toBe(true);
    expect(readFileSync(output, "utf8")).toBe("raw-preview-bytes");
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(grimArgs, "utf8").trim().endsWith("-")).toBe(true);
    const magickInvocation = readFileSync(magickArgs, "utf8");
    expect(magickInvocation).toContain("png:-");
    expect(magickInvocation).not.toContain(base + "/");
  });
});

describe("preview temp dirs are reaped", () => {
  test("only expired, prefixed directories are selected", () => {
    const ages = { [PREVIEW_PREFIX + "old"]: 10 * 60_000, [PREVIEW_PREFIX + "new"]: 1_000, "unrelated-old": 10 * 60_000 };
    expect(expiredPreviewDirectories(Object.keys(ages), ages, 5 * 60_000)).toEqual([PREVIEW_PREFIX + "old"]);
  });

  test("a successful capture's directory does not leak forever", () => {
    const base = mkdtempSync(join(tmpdir(), "infomarchy-reap-test-"));
    try {
      const target = createPreviewTarget(base);
      closeSync(target.fd);
      const bystander = join(base, "someone-elses-dir");
      mkdirSync(bystander);
      // Fresh captures survive — the shell may still be loading the PNG.
      expect(reapPreviewDirectories(base, 5 * 60_000)).toBe(0);
      expect(lstatSync(target.directory).isDirectory()).toBe(true);
      // Stale ones are removed; anything not ours is left untouched.
      expect(reapPreviewDirectories(base, 0, Date.now() + 1000)).toBe(1);
      expect(() => lstatSync(target.directory)).toThrow();
      expect(lstatSync(bystander).isDirectory()).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
