import { describe, expect, it } from "vitest";
import { StalenessMonitor, candleOpenTime, findGaps } from "../src/index.js";

const M = 60_000;

describe("findGaps", () => {
  it("finds nothing when every candle is present", () => {
    expect(findGaps([0, M, 2 * M], "1m", 0, 2 * M)).toEqual([]);
  });

  it("finds interior and trailing gaps", () => {
    expect(findGaps([0, 3 * M, 4 * M], "1m", 0, 6 * M)).toEqual([
      { from: M, to: 2 * M, missing: 2 },
      { from: 5 * M, to: 6 * M, missing: 2 },
    ]);
  });

  it("aligns to UTC candle boundaries", () => {
    const t = Date.UTC(2026, 9, 30, 13, 47, 12);
    expect(candleOpenTime(t, "1h")).toBe(Date.UTC(2026, 9, 30, 13));
    expect(candleOpenTime(t, "4h")).toBe(Date.UTC(2026, 9, 30, 12));
    expect(candleOpenTime(t, "1d")).toBe(Date.UTC(2026, 9, 30));
  });
});

describe("StalenessMonitor", () => {
  it("flags silent feeds and clears them when data resumes", () => {
    let now = 0;
    const changes: Array<[string, boolean]> = [];
    const monitor = new StalenessMonitor(5000, (k, stale) => changes.push([k, stale]), () => now);
    monitor.watch("BTC/USDT");
    expect(monitor.isStale("BTC/USDT")).toBe(false);
    now = 6000;
    monitor.check();
    monitor.check();
    expect(monitor.isStale("BTC/USDT")).toBe(true);
    monitor.touch("BTC/USDT");
    expect(monitor.isStale("BTC/USDT")).toBe(false);
    expect(changes).toEqual([
      ["BTC/USDT", true],
      ["BTC/USDT", false],
    ]);
  });

  it("treats an unknown feed as stale", () => {
    expect(new StalenessMonitor(1000, () => {}).isStale("never-seen")).toBe(true);
  });
});
