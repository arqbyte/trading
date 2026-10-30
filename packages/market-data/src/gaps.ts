import { TIMEFRAME_MS, type Timeframe } from "@atrp/shared-types";

export interface Gap {
  /** First missing candle open time (inclusive). */
  from: number;
  /** Last missing candle open time (inclusive). */
  to: number;
  missing: number;
}

/** Floors a timestamp to the open time of its candle (UTC-aligned). */
export function candleOpenTime(timestamp: number, timeframe: Timeframe): number {
  const step = TIMEFRAME_MS[timeframe];
  return Math.floor(timestamp / step) * step;
}

/**
 * Finds runs of missing candle open times between `from` and `to`
 * (inclusive) given the open times that are present.
 */
export function findGaps(present: Iterable<number>, timeframe: Timeframe, from: number, to: number): Gap[] {
  const step = TIMEFRAME_MS[timeframe];
  const have = new Set(present);
  const gaps: Gap[] = [];
  let start: number | undefined;
  const first = candleOpenTime(from, timeframe);
  for (let t = first; t <= to; t += step) {
    if (!have.has(t)) {
      start ??= t;
    } else if (start !== undefined) {
      gaps.push({ from: start, to: t - step, missing: (t - start) / step });
      start = undefined;
    }
  }
  if (start !== undefined) {
    const last = candleOpenTime(to, timeframe);
    gaps.push({ from: start, to: last, missing: (last - start) / step + 1 });
  }
  return gaps;
}
