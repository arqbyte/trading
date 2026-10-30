import { type Candle, TIMEFRAME_MS, type Timeframe, toDecimalString } from "@atrp/shared-types";
import { CompiledStrategy, type QuoteView } from "@atrp/strategy-engine";

/** Small deterministic PRNG so scenarios are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export interface Bar {
  close: number;
  volume?: number;
  range?: number;
}

export function toCandles(bars: Bar[], timeframe: Timeframe, symbol = "BTC/USDT"): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const fmt = (n: number) => toDecimalString(n.toFixed(8));
  return bars.map((b, i) => {
    const open = i === 0 ? b.close : bars[i - 1]!.close;
    const range = b.range ?? Math.abs(b.close - open) * 0.5 + b.close * 0.001;
    return {
      exchange: "okx",
      symbol,
      timeframe,
      timestamp: Date.UTC(2026, 0, 1) + i * step,
      open: fmt(open),
      high: fmt(Math.max(open, b.close) + range),
      low: fmt(Math.min(open, b.close) - range),
      close: fmt(b.close),
      volume: fmt(b.volume ?? 100),
      isClosed: true,
    };
  });
}

/** Random walk with drift (per bar, as a fraction) and noise. */
export function walk(n: number, opts: { seed: number; drift?: number; vol?: number; start?: number }): Bar[] {
  const r = rng(opts.seed);
  let p = opts.start ?? 100;
  return Array.from({ length: n }, () => {
    p *= 1 + (opts.drift ?? 0) + (r() - 0.5) * 2 * (opts.vol ?? 0.005);
    return { close: p, volume: 60 + r() * 80 };
  });
}

/** Choppy mean-reverting noise around a level: a sideways market. */
export function sideways(n: number, seed: number, level = 100, amplitude = 1.5): Bar[] {
  const r = rng(seed);
  let x = level;
  return Array.from({ length: n }, () => {
    x += -0.4 * (x - level) + (r() - 0.5) * amplitude;
    return { close: x, volume: 80 + r() * 40 };
  });
}

export interface SimResult {
  buys: number[];
  sells: number[];
}

/**
 * Runs a strategy bar by bar with a one-unit long-only position, the way the
 * agent runner will: decide on each closed candle with the history so far.
 */
export function simulate(spec: unknown, candles: Candle[], quote?: QuoteView): SimResult {
  const s = CompiledStrategy.compile(spec);
  const buys: number[] = [];
  const sells: number[] = [];
  let held = false;
  let peak = 0;
  for (let i = 0; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i + 1 - s.warmupBars * 2), i + 1);
    const high = Number(candles[i]!.high);
    if (held) peak = Math.max(peak, high);
    const d = s.evaluate(
      window,
      held
        ? { quantity: toDecimalString("1"), highestPriceSinceEntry: toDecimalString(peak.toFixed(8)) }
        : { quantity: toDecimalString("0") },
      quote,
    );
    if (d.action === "BUY") {
      buys.push(i);
      held = true;
      peak = high;
    } else if (d.action === "SELL") {
      sells.push(i);
      held = false;
    }
  }
  return { buys, sells };
}
