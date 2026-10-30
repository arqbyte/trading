import type { StrategySpecInput } from "@atrp/strategy-dsl";

/**
 * The six initial competition strategies (PRD 5.3). They are starting points
 * for the experiment, written to follow each agent's brief, and are not
 * validated trading recommendations. Parameters are deliberately ordinary;
 * improving them is the research lab's job, through new versions.
 */

/** Agent A: strong directional moves confirmed by volume. */
export const momentum: StrategySpecInput = {
  schemaVersion: 1,
  name: "Momentum",
  version: "1.0.0",
  description:
    "Enters when MACD momentum turns positive with RSI in a strong-but-not-exhausted zone, price above its 50 EMA and above-average volume. Exits when momentum fades.",
  market: "spot",
  timeframe: "15m",
  indicators: [
    { id: "macd", type: "MACD", fast: 12, slow: 26, signal: 9 },
    { id: "rsi", type: "RSI", period: 14 },
    { id: "ema50", type: "EMA", period: 50 },
    { id: "vol_avg", type: "SMA", period: 20, source: "volume" },
  ],
  entry: {
    all: [
      { op: "crossesAbove", left: { indicator: "macd", field: "histogram" }, right: { value: 0 } },
      { op: "gt", left: { indicator: "rsi" }, right: { value: 55 } },
      { op: "lt", left: { indicator: "rsi" }, right: { value: 75 } },
      { op: "gt", left: { price: "close" }, right: { indicator: "ema50" } },
      // Insufficient volume means no trade.
      { op: "gt", left: { price: "volume" }, right: { indicator: "vol_avg", scale: 1.2 } },
    ],
  },
  exit: {
    any: [
      { op: "crossesBelow", left: { indicator: "macd", field: "histogram" }, right: { value: 0 } },
      { op: "lt", left: { indicator: "rsi" }, right: { value: 45 } },
    ],
  },
  risk: { stopLossPercent: 2, takeProfitPercent: 4 },
};

/** Agent B: buys statistically stretched dips in non-trending markets. */
export const meanReversion: StrategySpecInput = {
  schemaVersion: 1,
  name: "Mean Reversion",
  version: "1.0.0",
  description:
    "Buys closes below the lower Bollinger Band with oversold RSI, but only when ADX says the market is not trending strongly. Exits at the mean, or if a trend develops.",
  market: "spot",
  timeframe: "15m",
  indicators: [
    { id: "bb", type: "BBANDS", period: 20, stdDev: 2 },
    { id: "rsi", type: "RSI", period: 14 },
    { id: "adx", type: "ADX", period: 14 },
  ],
  entry: {
    all: [
      { op: "lt", left: { price: "close" }, right: { indicator: "bb", field: "lower" } },
      { op: "lt", left: { indicator: "rsi" }, right: { value: 30 } },
      // Avoid strong directional conditions.
      { op: "lt", left: { indicator: "adx", field: "adx" }, right: { value: 25 } },
    ],
  },
  exit: {
    any: [
      { op: "gte", left: { price: "close" }, right: { indicator: "bb", field: "middle" } },
      { op: "gt", left: { indicator: "adx", field: "adx" }, right: { value: 35 } },
    ],
  },
  risk: { stopLossPercent: 2.5, takeProfitPercent: 3 },
};

/** Agent C: confirmed breakouts out of consolidation. */
export const breakout: StrategySpecInput = {
  schemaVersion: 1,
  name: "Breakout",
  version: "1.0.0",
  description:
    "Waits for a tight range (narrow Bollinger width), then buys a close above the prior 20-bar high on 1.5x average volume. Exits if price falls back below the prior 10-bar low or the 20 EMA.",
  market: "spot",
  timeframe: "1h",
  indicators: [
    { id: "range_high", type: "HIGHEST", period: 20, source: "high" },
    { id: "range_low", type: "LOWEST", period: 10, source: "low" },
    { id: "bb", type: "BBANDS", period: 20, stdDev: 2 },
    { id: "vol_avg", type: "SMA", period: 20, source: "volume" },
    { id: "ema20", type: "EMA", period: 20 },
  ],
  entry: {
    all: [
      // Prior bar's 20-bar high, so the breakout bar itself is not included.
      { op: "gt", left: { price: "close" }, right: { indicator: "range_high", offset: 1 } },
      { op: "lt", left: { indicator: "bb", field: "width", offset: 1 }, right: { value: 0.06 } },
      { op: "gt", left: { price: "volume" }, right: { indicator: "vol_avg", scale: 1.5 } },
    ],
  },
  exit: {
    any: [
      { op: "lt", left: { price: "close" }, right: { indicator: "range_low", offset: 1 } },
      { op: "crossesBelow", left: { price: "close" }, right: { indicator: "ema20" } },
    ],
  },
  risk: { stopLossPercent: 3, takeProfitPercent: 6, trailingStopPercent: 4 },
};

/**
 * Agent D: small short-term moves. Needs a tight spread and bid-side book
 * pressure. The 0.6% target is set to clear a round trip of taker fees
 * (2 x 0.1% on OKX spot at the base tier) plus spread with room to spare.
 */
export const scalping: StrategySpecInput = {
  schemaVersion: 1,
  name: "Scalping",
  version: "1.0.0",
  description:
    "On 1-minute candles, buys short-term upward momentum (EMA9 above EMA21) when the spread is tight and the book leans to the bid. Quick exits.",
  market: "spot",
  timeframe: "1m",
  indicators: [
    { id: "ema9", type: "EMA", period: 9 },
    { id: "ema21", type: "EMA", period: 21 },
    { id: "rsi", type: "RSI", period: 7 },
    { id: "vol_avg", type: "SMA", period: 30, source: "volume" },
  ],
  entry: {
    all: [
      { op: "lt", left: { quote: "spreadPercent" }, right: { value: 0.03 } },
      { op: "gt", left: { quote: "imbalance" }, right: { value: 0.2 } },
      { op: "gt", left: { indicator: "ema9" }, right: { indicator: "ema21" } },
      { op: "crossesAbove", left: { price: "close" }, right: { indicator: "ema9" } },
      { op: "lt", left: { indicator: "rsi" }, right: { value: 70 } },
      { op: "gt", left: { price: "volume" }, right: { indicator: "vol_avg" } },
    ],
  },
  exit: {
    any: [
      { op: "lt", left: { price: "close" }, right: { indicator: "ema21" } },
      { op: "gt", left: { indicator: "rsi" }, right: { value: 80 } },
    ],
  },
  risk: { stopLossPercent: 0.4, takeProfitPercent: 0.6 },
};

/** Agent E: sustained trends, with a trailing stop. */
export const trendFollowing: StrategySpecInput = {
  schemaVersion: 1,
  name: "Trend Following",
  version: "1.0.0",
  description:
    "Enters when EMA20 > EMA50 and EMA50 is at least 1% above EMA200, ADX shows a real trend and +DI leads -DI, on a close back above EMA20. Exits on EMA20 crossing below EMA50 or a 6% trailing stop. Stays out of sideways markets.",
  market: "spot",
  timeframe: "1h",
  indicators: [
    { id: "ema20", type: "EMA", period: 20 },
    { id: "ema50", type: "EMA", period: 50 },
    { id: "ema200", type: "EMA", period: 200 },
    { id: "adx", type: "ADX", period: 14 },
  ],
  entry: {
    all: [
      { op: "gt", left: { indicator: "ema20" }, right: { indicator: "ema50" } },
      // Established trend: EMA50 at least 1% above EMA200, not just touching it.
      { op: "gt", left: { indicator: "ema50" }, right: { indicator: "ema200", scale: 1.01 } },
      { op: "gt", left: { indicator: "adx", field: "adx" }, right: { value: 25 } },
      { op: "gt", left: { indicator: "adx", field: "plusDI" }, right: { indicator: "adx", field: "minusDI" } },
      { op: "gt", left: { price: "close" }, right: { indicator: "ema20" } },
    ],
  },
  exit: { op: "crossesBelow", left: { indicator: "ema20" }, right: { indicator: "ema50" } },
  risk: { stopLossPercent: 4, trailingStopPercent: 6 },
};

/**
 * Agent F: the experimental slot. It starts with a combined signal and is
 * where validated research-agent candidates are trialled (PRD 5.3 F).
 */
export const experimental: StrategySpecInput = {
  schemaVersion: 1,
  name: "Experimental",
  version: "1.0.0",
  description:
    "Baseline for the experimental slot: buys an RSI recovery from oversold below the Bollinger mid-band while MACD histogram is rising. Exits on RSI strength or a tag of the upper band.",
  market: "spot",
  timeframe: "15m",
  indicators: [
    { id: "rsi", type: "RSI", period: 14 },
    { id: "bb", type: "BBANDS", period: 20, stdDev: 2 },
    { id: "macd", type: "MACD", fast: 12, slow: 26, signal: 9 },
  ],
  entry: {
    all: [
      { op: "crossesAbove", left: { indicator: "rsi" }, right: { value: 30 } },
      { op: "lt", left: { price: "close" }, right: { indicator: "bb", field: "middle" } },
      {
        op: "gt",
        left: { indicator: "macd", field: "histogram" },
        right: { indicator: "macd", field: "histogram", offset: 1 },
      },
    ],
  },
  exit: {
    any: [
      { op: "gt", left: { indicator: "rsi" }, right: { value: 65 } },
      { op: "gte", left: { price: "high" }, right: { indicator: "bb", field: "upper" } },
    ],
  },
  risk: { stopLossPercent: 2, takeProfitPercent: 3.5 },
};

export interface BuiltinAgent {
  slug: string;
  agentName: string;
  spec: StrategySpecInput;
}

export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [
  { slug: "momentum", agentName: "Agent A: Momentum", spec: momentum },
  { slug: "mean-reversion", agentName: "Agent B: Mean Reversion", spec: meanReversion },
  { slug: "breakout", agentName: "Agent C: Breakout", spec: breakout },
  { slug: "scalping", agentName: "Agent D: Scalping", spec: scalping },
  { slug: "trend-following", agentName: "Agent E: Trend Following", spec: trendFollowing },
  { slug: "experimental", agentName: "Agent F: Experimental", spec: experimental },
];
