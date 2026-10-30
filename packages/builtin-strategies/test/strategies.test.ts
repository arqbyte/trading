import { describe, expect, it } from "vitest";
import { toDecimalString as d } from "@atrp/shared-types";
import { validateStrategy } from "@atrp/strategy-dsl";
import { BUILTIN_AGENTS, breakout, meanReversion, momentum, scalping, trendFollowing } from "../src/index.js";
import { type Bar, sideways, simulate, toCandles, walk } from "./scenarios.js";

const tightQuote = { bid: d("100"), ask: d("100.01"), bidSize: d("5"), askSize: d("2") };

describe("built-in strategies", () => {
  it("are six valid, distinct strategies covering the PRD agents", () => {
    expect(BUILTIN_AGENTS.map((a) => a.slug)).toEqual([
      "momentum",
      "mean-reversion",
      "breakout",
      "scalping",
      "trend-following",
      "experimental",
    ]);
    const hashes = new Set<string>();
    for (const { slug, spec } of BUILTIN_AGENTS) {
      const r = validateStrategy(spec);
      if (!r.ok) throw new Error(`${slug}: ${r.errors.join("; ")}`);
      hashes.add(r.hash);
    }
    expect(hashes.size).toBe(6);
  });

  it("all trade on a long random walk without errors", () => {
    for (const { slug, spec } of BUILTIN_AGENTS) {
      const tf = validateStrategy(spec).ok ? (spec.timeframe as Parameters<typeof toCandles>[1]) : "1m";
      const bars = walk(3000, { seed: 7, vol: 0.006 }).map((b, i) => ({
        ...b,
        // Occasional volume bursts so volume filters can pass.
        volume: i % 37 < 3 ? 400 : b.volume,
      }));
      const r = simulate(spec, toCandles(bars, tf), tightQuote);
      expect(r.buys.length, `${slug} buys`).toBeGreaterThan(0);
      expect(r.sells.length, `${slug} sells`).toBeGreaterThan(0);
    }
  });
});

describe("agent briefs", () => {
  it("trend following trades sustained uptrends and sits out sideways markets", () => {
    let trendBuys = 0;
    let sidewaysBuys = 0;
    for (const seed of [3, 4, 5, 6, 7]) {
      trendBuys += simulate(trendFollowing, toCandles(walk(600, { seed, drift: 0.002, vol: 0.004 }), "1h")).buys.length;
      sidewaysBuys += simulate(trendFollowing, toCandles(sideways(600, seed), "1h")).buys.length;
    }
    expect(trendBuys).toBeGreaterThan(0);
    expect(sidewaysBuys).toBe(0);
  });

  it("mean reversion buys a sharp dip in a range, and not in a strong downtrend", () => {
    const range = sideways(200, 5, 100, 0.6);
    const dip: Bar[] = [...range, { close: 98.6 }, { close: 97.4 }, { close: 96.5 }, ...sideways(40, 6, 97, 0.4)];
    const r = simulate(meanReversion, toCandles(dip, "15m"));
    expect(r.buys.some((i) => i >= 200 && i <= 205)).toBe(true);

    const crash = simulate(meanReversion, toCandles(walk(400, { seed: 9, drift: -0.004, vol: 0.002 }), "15m"));
    expect(crash.buys).toEqual([]);
  });

  it("breakout needs consolidation and a volume surge", () => {
    const base = sideways(120, 11, 100, 0.4);
    const surge: Bar[] = [...base, { close: 102.5, volume: 600 }, { close: 103 }, { close: 103.4 }];
    const quiet: Bar[] = [...base, { close: 102.5, volume: 100 }, { close: 103 }, { close: 103.4 }];
    expect(simulate(breakout, toCandles(surge, "1h")).buys).toContain(120);
    expect(simulate(breakout, toCandles(quiet, "1h")).buys).not.toContain(120);
  });

  it("momentum requires above-average volume", () => {
    const bars = walk(1500, { seed: 21, drift: 0.0005, vol: 0.006 });
    const lowVolume = bars.map((b) => ({ ...b, volume: 100 }));
    expect(simulate(momentum, toCandles(lowVolume, "15m")).buys).toEqual([]);
  });

  it("scalping never trades without a tight, bid-heavy quote", () => {
    const candles = toCandles(
      walk(2000, { seed: 4, vol: 0.002 }).map((b, i) => ({ ...b, volume: i % 5 === 0 ? 300 : 80 })),
      "1m",
    );
    expect(simulate(scalping, candles).buys).toEqual([]);
    expect(simulate(scalping, candles, { ...tightQuote, ask: d("100.05") }).buys).toEqual([]);
    expect(simulate(scalping, candles, { ...tightQuote, askSize: d("5") }).buys).toEqual([]);
    expect(simulate(scalping, candles, tightQuote).buys.length).toBeGreaterThan(0);
  });

  it("scalping's target clears a round trip of base-tier taker fees", () => {
    const takerFeePercent = 0.1;
    expect(scalping.risk.takeProfitPercent!).toBeGreaterThan(2 * takerFeePercent + 0.03);
  });
});
