import { describe, expect, it } from "vitest";
import { sma } from "@atrp/indicators";
import { type Candle, toDecimalString as d } from "@atrp/shared-types";
import type { StrategySpecInput } from "@atrp/strategy-dsl";
import { CandleHistory, CompiledStrategy, DslStrategyAgent, checkSignal } from "../src/index.js";

const M = 60_000;
const T0 = Date.UTC(2026, 9, 30);

function candles(closes: number[], opts: { spread?: number; symbol?: string } = {}): Candle[] {
  const spread = opts.spread ?? 0.5;
  return closes.map((c, i) => ({
    exchange: "okx",
    symbol: opts.symbol ?? "BTC/USDT",
    timeframe: "1m",
    timestamp: T0 + i * M,
    open: d(String(i === 0 ? c : closes[i - 1]!)),
    high: d(String(Math.max(c, i === 0 ? c : closes[i - 1]!) + spread)),
    low: d(String(Math.min(c, i === 0 ? c : closes[i - 1]!) - spread)),
    close: d(String(c)),
    volume: d("10"),
    isClosed: true,
  }));
}

const crossSpec: StrategySpecInput = {
  schemaVersion: 1,
  name: "SMA cross",
  version: "1.0.0",
  market: "spot",
  timeframe: "1m",
  indicators: [
    { id: "fast", type: "SMA", period: 2 },
    { id: "slow", type: "SMA", period: 4 },
  ],
  entry: { op: "crossesAbove", left: { indicator: "fast" }, right: { indicator: "slow" } },
  exit: { op: "crossesBelow", left: { indicator: "fast" }, right: { indicator: "slow" } },
  risk: { stopLossPercent: 2, takeProfitPercent: 4 },
};

const flat = { quantity: d("0") };
const held = { quantity: d("0.01"), averageEntryPrice: d("100") };

describe("CompiledStrategy", () => {
  const strategy = CompiledStrategy.compile(crossSpec);
  const closes = [100, 99, 98, 97, 96, 97, 99, 101, 103, 102, 100, 98, 96, 95, 97, 100];

  it("holds while warming up", () => {
    expect(strategy.evaluate(candles(closes.slice(0, 3)), flat)).toMatchObject({ action: "HOLD" });
  });

  it("buys exactly where the fast average crosses above the slow one", () => {
    const fast = sma(closes, 2);
    const slow = sma(closes, 4);
    const expectedBuys = closes
      .map((_, i) => i)
      .filter((i) => i >= 1 && slow[i - 1] !== undefined && fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!);
    const buys = closes
      .map((_, i) => i)
      .filter((i) => strategy.evaluate(candles(closes.slice(0, i + 1)), flat).action === "BUY");
    expect(buys).toEqual(expectedBuys);
    expect(buys.length).toBeGreaterThan(0);
  });

  it("sells on the exit cross only when holding", () => {
    const sells = closes
      .map((_, i) => i)
      .filter((i) => strategy.evaluate(candles(closes.slice(0, i + 1)), held).action === "SELL");
    expect(sells.length).toBeGreaterThan(0);
    for (const i of sells) expect(strategy.evaluate(candles(closes.slice(0, i + 1)), flat).action).not.toBe("SELL");
  });

  it("sets exact decimal stop-loss and take-profit from the close", () => {
    const fast = sma(closes, 2);
    const slow = sma(closes, 4);
    const i = closes.findIndex((_, k) => k >= 4 && fast[k - 1]! <= slow[k - 1]! && fast[k]! > slow[k]!);
    const decision = strategy.evaluate(candles(closes.slice(0, i + 1)), flat);
    expect(decision.action).toBe("BUY");
    expect(decision.stopLoss).toBe(d(String((closes[i]! * 98) / 100)));
    expect(decision.takeProfit).toBe(d(String((closes[i]! * 104) / 100)));
    expect(decision.reasoning).toContain("crossesAbove");
  });

  it("is deterministic", () => {
    const history = candles(closes);
    expect(strategy.evaluate(history, held)).toEqual(strategy.evaluate(history, held));
  });

  it("refuses forming, mixed or unordered candles", () => {
    const history = candles(closes);
    expect(() => strategy.evaluate([...history.slice(0, -1), { ...history.at(-1)!, isClosed: false }], flat)).toThrow(
      /not closed/,
    );
    expect(() => strategy.evaluate([history[1]!, history[0]!], flat)).toThrow(/ascending/);
    expect(() => strategy.evaluate([history[0]!, { ...history[1]!, symbol: "ETH/USDT" }], flat)).toThrow(/more than one/);
    expect(() => strategy.evaluate([{ ...history[0]!, timeframe: "5m" }], flat)).toThrow(/expected 1m/);
  });

  it("exits on a trailing stop", () => {
    const trailing = CompiledStrategy.compile({ ...crossSpec, risk: { stopLossPercent: 2, trailingStopPercent: 3 } });
    const history = candles([100, 101, 102, 103, 104, 105, 101]);
    const decision = trailing.evaluate(history, { ...held, highestPriceSinceEntry: d("105.5") });
    expect(decision.action).toBe("SELL");
    expect(decision.reasoning).toContain("trailing stop");
  });

  it("supports any/not, offsets and multi-line indicators", () => {
    const s = CompiledStrategy.compile({
      ...crossSpec,
      indicators: [{ id: "bb", type: "BBANDS", period: 5, stdDev: 1 }],
      entry: {
        all: [
          { op: "lt", left: { price: "close" }, right: { indicator: "bb", field: "lower" } },
          { not: { op: "lt", left: { price: "close" }, right: { price: "close", offset: 1 } } },
        ],
      },
      exit: { any: [{ op: "gt", left: { price: "close" }, right: { indicator: "bb", field: "middle" } }] },
    });
    // Falls hard, then ticks up while still below the lower band.
    const decision = s.evaluate(candles([100, 100, 100, 100, 90, 80, 81]), flat);
    expect(decision.action).toBe("BUY");
  });

  it("uses live quote values and scaled operands", () => {
    const s = CompiledStrategy.compile({
      ...crossSpec,
      indicators: [{ id: "vol", type: "SMA", period: 3, source: "volume" }],
      entry: {
        all: [
          { op: "lt", left: { quote: "spreadPercent" }, right: { value: 0.05 } },
          { op: "gt", left: { quote: "imbalance" }, right: { value: 0.2 } },
          { op: "gte", left: { price: "volume" }, right: { indicator: "vol", scale: 1 } },
        ],
      },
      exit: { op: "lt", left: { price: "volume" }, right: { indicator: "vol", scale: 0.5 } },
    });
    const history = candles([100, 100, 100, 100, 100]);
    const tight = { bid: d("100"), ask: d("100.01"), bidSize: d("3"), askSize: d("1") };
    expect(s.evaluate(history, flat, tight).action).toBe("BUY");
    expect(s.evaluate(history, flat, { ...tight, ask: d("100.2") }).action).toBe("HOLD"); // spread 0.2%
    expect(s.evaluate(history, flat, { ...tight, askSize: d("3") }).action).toBe("HOLD"); // balanced book
    expect(s.evaluate(history, flat).action).toBe("HOLD"); // no quote, no trade
    expect(s.evaluate(history, flat, { ...tight, ask: d("99") }).action).toBe("HOLD"); // crossed book
  });

  it("will not compile an invalid spec", () => {
    expect(() => CompiledStrategy.compile({ ...crossSpec, risk: {} })).toThrow(/Invalid strategy/);
  });
});

describe("DslStrategyAgent and checkSignal", () => {
  const agent = new DslStrategyAgent("momentum", crossSpec);
  const history = candles([100, 99, 98, 97, 96, 97, 99, 101]);
  const now = T0 + 8 * M;
  const expected = { agentId: "momentum", strategyVersion: "1.0.0", symbol: "BTC/USDT", timeframe: "1m" as const, now };

  it("produces signals that pass validation", () => {
    const signal = agent.onCandle({ symbol: "BTC/USDT", candles: history, position: flat, now });
    expect(agent.warmupBars).toBe(5);
    expect(checkSignal(signal, expected)).toMatchObject({ ok: true });
  });

  it("rejects signals about another agent, symbol, time or with extra fields", () => {
    const signal = agent.onCandle({ symbol: "BTC/USDT", candles: history, position: flat, now });
    expect(checkSignal({ ...signal, agentId: "other" }, expected).ok).toBe(false);
    expect(checkSignal({ ...signal, symbol: "ETH/USDT" }, expected).ok).toBe(false);
    expect(checkSignal({ ...signal, timestamp: now + 1 }, expected).ok).toBe(false);
    expect(checkSignal({ ...signal, leverage: 3 }, expected).ok).toBe(false);
    expect(checkSignal(null, expected).ok).toBe(false);
  });
});

describe("CandleHistory", () => {
  it("keeps a bounded, ordered window of closed candles", () => {
    const h = new CandleHistory("BTC/USDT", "1m", 3);
    const cs = candles([1, 2, 3, 4, 5]);
    expect(h.push(cs[0]!)).toBe("appended");
    expect(h.push(cs[0]!)).toBe("duplicate");
    expect(h.push(cs[2]!)).toBe("gap");
    h.push(cs[3]!);
    h.push(cs[4]!);
    expect(h.snapshot().map((c) => c.close)).toEqual(["3", "4", "5"]);
    expect(() => h.push({ ...cs[4]!, timestamp: cs[4]!.timestamp + M, isClosed: false })).toThrow(/closed/);
  });

  it("hands out snapshots agents cannot mutate", () => {
    const h = new CandleHistory("BTC/USDT", "1m", 10);
    h.push(candles([1])[0]!);
    const snap = h.snapshot() as Candle[];
    expect(() => snap.push(snap[0]!)).toThrow();
    expect(() => ((snap[0] as { close: string }).close = "999")).toThrow();
  });
});
