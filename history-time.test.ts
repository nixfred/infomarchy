import { describe, expect, test } from "bun:test";
import { localDayIndex, localDayStarts } from "./history-time";

describe("local history days", () => {
  test("keeps local midnights aligned across spring DST", () => {
    process.env.TZ = "America/New_York";
    const days = localDayStarts(new Date("2026-03-10T12:00:00-04:00").getTime(), 4);
    expect(days.map(value => new Date(value).getHours())).toEqual([0, 0, 0, 0]);
    expect(days[2] - days[1]).toBe(23 * 60 * 60 * 1000);
    expect(localDayIndex(new Date("2026-03-08T23:30:00-04:00").getTime(), days)).toBe(1);
  });

  test("keeps local midnights aligned across fall DST", () => {
    process.env.TZ = "America/New_York";
    const days = localDayStarts(new Date("2026-11-03T12:00:00-05:00").getTime(), 4);
    expect(days.map(value => new Date(value).getHours())).toEqual([0, 0, 0, 0]);
    expect(days[2] - days[1]).toBe(25 * 60 * 60 * 1000);
    expect(localDayIndex(new Date("2026-11-01T23:30:00-05:00").getTime(), days)).toBe(1);
  });
});

describe("localDayStarts midnight-DST zones", () => {
  test("every start is a local midnight, even where DST changes at 00:00", () => {
    const run = Bun.spawnSync(["bun", "-e", `import { localDayStarts } from "./history-time";
const s = localDayStarts(new Date(2026, 2, 20, 15).getTime(), 14).slice(2);
console.log(s.every(t => new Date(t).getHours() === 0 && new Date(t).getMinutes() === 0));`], { env: { ...process.env, TZ: "America/Havana" }, cwd: import.meta.dir });
    expect(run.stdout.toString().trim()).toBe("true");
  });
});
