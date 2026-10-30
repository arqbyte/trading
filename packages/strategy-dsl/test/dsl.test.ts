import { describe, expect, it } from "vitest";
import { type StrategySpecInput, canonicalJson, validateStrategy } from "../src/index.js";

/** The PRD 6.3 example, written in the DSL. */
export const emaMomentumBreakout: StrategySpecInput = {
  schemaVersion: 1,
  name: "EMA Momentum Breakout",
  version: "1.0.0",
  market: "spot",
  timeframe: "15m",
  indicators: [
    { id: "ema20", type: "EMA", period: 20 },
    { id: "ema50", type: "EMA", period: 50 },
    { id: "rsi14", type: "RSI", period: 14 },
  ],
  entry: {
    all: [
      { op: "crossesAbove", left: { indicator: "ema20" }, right: { indicator: "ema50" } },
      { op: "gt", left: { indicator: "rsi14" }, right: { value: 50 } },
    ],
  },
  exit: { op: "crossesBelow", left: { indicator: "ema20" }, right: { indicator: "ema50" } },
  risk: { stopLossPercent: 1.5, takeProfitPercent: 3 },
};

const withChanges = (patch: Record<string, unknown>) => ({ ...emaMomentumBreakout, ...patch });

describe("validateStrategy", () => {
  it("accepts the PRD example and computes its warm-up", () => {
    const result = validateStrategy(emaMomentumBreakout);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warmupBars).toBe(51);
      expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("rejects anything that looks like code", () => {
    const result = validateStrategy(
      withChanges({ entry: { op: "gt", left: { expression: "process.exit()" }, right: { value: 1 } } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown fields, leverage and non-spot markets", () => {
    expect(validateStrategy(withChanges({ leverage: 5 })).ok).toBe(false);
    expect(validateStrategy(withChanges({ market: "futures" })).ok).toBe(false);
  });

  it("requires a stop-loss", () => {
    const result = validateStrategy(withChanges({ risk: { takeProfitPercent: 3 } }));
    expect(result.ok).toBe(false);
  });

  it("reports unknown indicators, bad fields and unused indicators", () => {
    const result = validateStrategy(
      withChanges({
        indicators: [
          { id: "bb", type: "BBANDS" },
          { id: "unused", type: "SMA", period: 5 },
        ],
        entry: { op: "lt", left: { price: "close" }, right: { indicator: "bb", field: "bottom" } },
        exit: { op: "gt", left: { price: "close" }, right: { indicator: "missing" } },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('no field "bottom"'),
          expect.stringContaining('unknown indicator "missing"'),
          expect.stringContaining("unused: defined but never used"),
        ]),
      );
    }
  });

  it("requires a field on multi-line indicators", () => {
    const result = validateStrategy(
      withChanges({
        indicators: [{ id: "m", type: "MACD" }],
        entry: { op: "crossesAbove", left: { indicator: "m" }, right: { value: 0 } },
        exit: { op: "lt", left: { indicator: "m", field: "histogram" }, right: { value: 0 } },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("needs a field");
  });

  it("rejects excessive warm-up and invalid MACD periods", () => {
    const longEma = validateStrategy(
      withChanges({
        indicators: [{ id: "e", type: "EMA", period: 500 }],
        entry: { op: "gt", left: { price: "close" }, right: { indicator: "e", offset: 50 } },
        exit: { op: "lt", left: { price: "close" }, right: { indicator: "e" } },
      }),
    );
    expect(longEma.ok).toBe(true);

    const tooLong = validateStrategy(
      withChanges({
        indicators: [{ id: "a", type: "ADX", period: 500 }],
        entry: { op: "gt", left: { indicator: "a", field: "adx" }, right: { value: 25 } },
        exit: { op: "lt", left: { indicator: "a", field: "adx" }, right: { value: 20 } },
      }),
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.errors.join()).toContain("bars of history");

    const macd = validateStrategy(
      withChanges({
        indicators: [{ id: "m", type: "MACD", fast: 30, slow: 10 }],
        entry: { op: "gt", left: { indicator: "m", field: "macd" }, right: { value: 0 } },
        exit: { op: "lt", left: { indicator: "m", field: "macd" }, right: { value: 0 } },
      }),
    );
    expect(macd.ok).toBe(false);
  });

  it("does not allow crosses on live quote values", () => {
    const result = validateStrategy(
      withChanges({
        indicators: [{ id: "ema20", type: "EMA", period: 20 }],
        entry: { op: "crossesAbove", left: { quote: "imbalance" }, right: { value: 0 } },
        exit: { op: "lt", left: { price: "close" }, right: { indicator: "ema20" } },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.stringContaining("cannot be used in a cross")]);
  });

  it("hashes logic, not labels", () => {
    const a = validateStrategy(emaMomentumBreakout);
    const b = validateStrategy(withChanges({ name: "Renamed", version: "9.9.9", description: "x" }));
    const c = validateStrategy(withChanges({ risk: { stopLossPercent: 2, takeProfitPercent: 3 } }));
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
    expect(a.ok && c.ok && a.hash !== c.hash).toBe(true);
  });

  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });
});
