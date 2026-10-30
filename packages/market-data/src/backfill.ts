import { type Candle, type MarketDataAdapter, TIMEFRAME_MS, type Timeframe } from "@atrp/shared-types";
import { findGaps, type Gap } from "./gaps.js";
import type { MarketDataStore } from "./store.js";

export interface BackfillResult {
  gapsFound: Gap[];
  candlesWritten: number;
  /** The closed candles fetched for the gaps, oldest first. */
  candles: Candle[];
  /** Gaps the exchange could not fill (e.g. no trading, delisted period). */
  unfilled: Gap[];
}

/**
 * Finds missing closed candles in [from, to] and fetches them over REST.
 * Only closed candles are written by backfill.
 */
export async function backfillCandles(
  adapter: MarketDataAdapter,
  store: MarketDataStore,
  symbol: string,
  timeframe: Timeframe,
  from: number,
  to: number,
): Promise<BackfillResult> {
  const step = TIMEFRAME_MS[timeframe];
  const present = await store.closedCandleTimes(adapter.exchange, symbol, timeframe, from, to);
  const gaps = findGaps(present, timeframe, from, to);
  let written = 0;
  const fetched = new Map<number, Candle>();

  for (const gap of gaps) {
    // Page backwards from just after the end of the gap.
    let before = gap.to + step;
    while (before > gap.from) {
      const page = await adapter.getCandles(symbol, timeframe, 100, before);
      const wanted = page.filter((c) => c.isClosed && c.timestamp >= gap.from && c.timestamp <= gap.to);
      written += await store.upsertCandles(wanted, "rest");
      for (const c of wanted) fetched.set(c.timestamp, c);
      const oldest = page[0]?.timestamp;
      if (oldest === undefined || oldest >= before) break; // no more history
      before = oldest;
    }
  }

  const after = gaps.length > 0 ? await store.closedCandleTimes(adapter.exchange, symbol, timeframe, from, to) : present;
  const candles = [...fetched.values()].sort((a, b) => a.timestamp - b.timestamp);
  return { gapsFound: gaps, candlesWritten: written, candles, unfilled: gaps.length > 0 ? findGaps(after, timeframe, from, to) : [] };
}
