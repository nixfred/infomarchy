import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPreviewTarget, validWindowAddress, reapPreviewDirectories, expiredPreviewDirectories, looksLikeOurPreviewDirectory, ownedPreviewDirectory, removePreviewArtifact, terminate, PREVIEW_PREFIX } from "./window-preview";

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
  test("only expired directories with an exact mkdtemp-shaped name are selected", () => {
    const ages = { [PREVIEW_PREFIX + "Ab3xYz"]: 10 * 60_000, [PREVIEW_PREFIX + "Qw9rTu"]: 1_000, [PREVIEW_PREFIX + "not-created-by-this-plugin"]: 10 * 60_000, "unrelated-old": 10 * 60_000 };
    expect(expiredPreviewDirectories(Object.keys(ages), ages, 5 * 60_000)).toEqual([PREVIEW_PREFIX + "Ab3xYz"]);
  });

  test("a same-prefix directory holding other files is never deleted", () => {
    expect(looksLikeOurPreviewDirectory([])).toBe(true);
    expect(looksLikeOurPreviewDirectory(["preview.png"])).toBe(true);
    expect(looksLikeOurPreviewDirectory(["preview.png", "notes.txt"])).toBe(false);
    expect(looksLikeOurPreviewDirectory(["important.db"])).toBe(false);
    const base = mkdtempSync(join(tmpdir(), "infomarchy-reap-test-"));
    try {
      const foreign = join(base, PREVIEW_PREFIX + "Zz9Yy8");
      mkdirSync(foreign); writeFileSync(join(foreign, "keep-me"), "user data");
      expect(reapPreviewDirectories(base, 0, Date.now() + 1000)).toBe(0);
      expect(lstatSync(join(foreign, "keep-me")).isFile()).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
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

describe("explicit artifact removal and firm deadlines", () => {
  test("removes exactly one owned preview directory, by png path or directory", () => {
    const base = mkdtempSync(join(tmpdir(), "infomarchy-remove-test-"));
    try {
      const a = createPreviewTarget(base); closeSync(a.fd);
      const b = createPreviewTarget(base); closeSync(b.fd);
      expect(ownedPreviewDirectory(a.directory, base)).toBe(true);
      expect(removePreviewArtifact(a.path, base)).toBe(true);
      expect(() => lstatSync(a.directory)).toThrow();
      expect(lstatSync(b.directory).isDirectory()).toBe(true);
      expect(removePreviewArtifact(b.directory, base)).toBe(true);
      // Never anything else: wrong parent, wrong shape, foreign contents.
      const foreign = join(base, PREVIEW_PREFIX + "Ab12Cd"); mkdirSync(foreign); writeFileSync(join(foreign, "user.txt"), "x");
      expect(removePreviewArtifact(foreign, base)).toBe(false);
      expect(removePreviewArtifact(join(base, "not-ours"), base)).toBe(false);
      expect(removePreviewArtifact(a.directory, "/elsewhere")).toBe(false);
      expect(lstatSync(join(foreign, "user.txt")).isFile()).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test("the stale sweep is capped per run", () => {
    const base = mkdtempSync(join(tmpdir(), "infomarchy-sweep-test-"));
    try {
      for (let i = 0; i < 5; i++) { const t = createPreviewTarget(base); closeSync(t.fd); }
      expect(reapPreviewDirectories(base, 0, Date.now() + 1000, 2)).toBe(2);
      expect(reapPreviewDirectories(base, 0, Date.now() + 1000, 10)).toBe(3);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test("terminate escalates from TERM to KILL and reaps a child that ignores TERM", async () => {
    const proc = Bun.spawn(["bun", "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300); // let the child install its handler, as a real long-running tool has
    const started = performance.now();
    await terminate(proc, 200);
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    expect(proc.signalCode).toBe("SIGKILL");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
