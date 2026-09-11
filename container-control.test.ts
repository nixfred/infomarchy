import { describe, expect, test } from "bun:test";
import {
  containerListArgv,
  containerMutateArgv,
  controlContainer,
  parseContainerList,
  parseContainerRecord,
  parseControlRequest,
  readBoundedInput,
  validContainerName,
} from "./container-control";

const dockerLine = JSON.stringify({
  ID: "a49221833480",
  Names: "lab-search-1",
  Image: "ghcr.io/example/searxng:2026.8.29-d226b78bc",
  State: "running",
  Status: "Up 18 minutes (healthy)",
  HealthStatus: "healthy",
  Command: "evil $(curl)",
  Mounts: "/home/someone/secret",
  Ports: "0.0.0.0:8787->80/tcp",
  Labels: "com.docker.compose.project=lab,com.docker.compose.service=search,com.docker.compose.project.working_dir=/home/someone/Projects/lab,com.docker.compose.project.environment_file=/home/someone/Projects/lab/.env",
});

describe("container inventory parsing", () => {
  test("accepts docker newline JSON and drops host paths, commands, ports, and raw labels", () => {
    const items = parseContainerList(dockerLine + "\n" + JSON.stringify({
      ID: "deadbeef0123",
      Names: "lab-worker-1",
      Image: "lab-worker",
      State: "exited",
      Status: "Exited (0) 4 minutes ago",
      Labels: "com.docker.compose.project=lab,com.docker.compose.service=worker",
    }));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "a49221833480",
      name: "lab-search-1",
      label: "search",
      service: "search",
      project: "lab",
      image: "searxng:2026.8.29-d226b78bc",
      state: "running",
      running: true,
      health: "healthy",
    });
    expect(items[1]).toMatchObject({ name: "lab-worker-1", label: "worker", running: false, state: "exited" });
    const blob = JSON.stringify(items);
    expect(blob).not.toContain("/home/");
    expect(blob).not.toContain(".env");
    expect(blob).not.toContain("$(curl)");
    expect(blob).not.toContain("8787");
    expect(blob).not.toContain("working_dir");
  });

  test("prefixes the compose service when more than one project is present", () => {
    const items = parseContainerList([
      JSON.stringify({ ID: "aaaaaaaaaaaa", Names: "one-web-1", Image: "nginx", State: "running", Labels: "com.docker.compose.project=one,com.docker.compose.service=web" }),
      JSON.stringify({ ID: "bbbbbbbbbbbb", Names: "two-web-1", Image: "nginx", State: "exited", Labels: "com.docker.compose.project=two,com.docker.compose.service=web" }),
    ].join("\n"));
    expect(items.map(item => item.label).sort()).toEqual(["one/web", "two/web"]);
  });

  test("parses podman JSON arrays and object State", () => {
    const items = parseContainerList(JSON.stringify([{
      Id: "0123456789abcdef0123456789abcdef",
      Names: ["web"],
      Image: "docker.io/library/nginx:latest",
      State: { Status: "running" },
      Status: "Up 2 hours",
      Labels: { "com.docker.compose.project": "demo", "com.docker.compose.service": "web" },
    }]));
    expect(items).toEqual([expect.objectContaining({
      id: "0123456789ab",
      name: "web",
      label: "web",
      image: "nginx:latest",
      running: true,
    })]);
  });

  test("rejects option-shaped names, empty records, and over-budget lists", () => {
    expect(validContainerName("-evil")).toBe("");
    expect(validContainerName("../x")).toBe("");
    expect(validContainerName("ok_name.1")).toBe("ok_name.1");
    expect(parseContainerRecord({ Names: "-flag", State: "running" })).toBeNull();
    expect(parseContainerRecord({ Names: "", State: "running" })).toBeNull();
    const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({
      ID: i.toString(16).padStart(12, "0"),
      Names: "c" + i,
      Image: "x",
      State: "exited",
    }));
    expect(parseContainerList(lines.join("\n"))).toHaveLength(32);
  });
});

describe("container start/stop", () => {
  test("accepts only start/stop of a sane name", () => {
    expect(parseControlRequest({ action: "start", name: "lab-search-1" })).toEqual({ action: "start", name: "lab-search-1" });
    expect(parseControlRequest({ action: "kill", name: "lab-search-1" })).toBeNull();
    expect(parseControlRequest({ action: "stop", name: "-n" })).toBeNull();
    expect(parseControlRequest({ action: "stop", name: "a/b" })).toBeNull();
    expect(containerListArgv("docker")[0]).toBe("/usr/bin/docker");
    expect(containerMutateArgv("docker", "stop", "lab-search-1")).toEqual(["/usr/bin/docker", "stop", "--", "lab-search-1"]);
  });

  test("refuses names outside the live inventory and never mutates them", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      return { code: 0, stdout: dockerLine };
    };
    const result = await controlContainer({ action: "stop", name: "not-listed" }, "docker", run);
    expect(result).toMatchObject({ ok: false, message: "Container is not in the live inventory" });
    expect(calls).toEqual([["/usr/bin/docker", "ps", "-a", "--format", "{{json .}}"]]);
  });

  test("starts and stops through argv after an inventory match", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => {
      calls.push(argv);
      if (argv.includes("ps")) return { code: 0, stdout: dockerLine };
      return { code: 0, stdout: "lab-search-1\n" };
    };
    expect(await controlContainer({ action: "stop", name: "lab-search-1" }, "docker", run)).toMatchObject({ ok: true, action: "stop" });
    expect(await controlContainer({ action: "start", name: "lab-search-1" }, "docker", run)).toMatchObject({ ok: true, message: "Already running" });
    expect(calls).toEqual([
      ["/usr/bin/docker", "ps", "-a", "--format", "{{json .}}"],
      ["/usr/bin/docker", "stop", "--", "lab-search-1"],
      ["/usr/bin/docker", "ps", "-a", "--format", "{{json .}}"],
    ]);
  });

  test("bounds stdin frames and stops at the first newline", async () => {
    async function* chunks() { yield new TextEncoder().encode("1234"); yield new TextEncoder().encode("5"); }
    expect(await readBoundedInput(chunks(), 4)).toBeNull();
    let pulled = 0;
    async function* endless() {
      yield new TextEncoder().encode('{"action":"stop",');
      yield new TextEncoder().encode('"name":"lab-search-1"}\ntrailing');
      while (true) { pulled++; yield new TextEncoder().encode("x"); }
    }
    expect(await readBoundedInput(endless())).toBe('{"action":"stop","name":"lab-search-1"}');
    expect(pulled).toBe(0);
  });

  test("the helper process exits promptly while stdin is still open", async () => {
    const proc = Bun.spawn(["bun", new URL("./container-control.ts", import.meta.url).pathname], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    proc.stdin.write('{"action":"stop","name":"definitely-missing"}\n');
    await proc.stdin.flush();
    const started = performance.now();
    const exit = await Promise.race([proc.exited, Bun.sleep(8000).then(() => "timeout" as const)]);
    proc.kill();
    expect(exit).not.toBe("timeout");
    expect(performance.now() - started).toBeLessThan(7000);
    const out = JSON.parse(await new Response(proc.stdout).text());
    expect(out.ok).toBe(false);
  });
});
