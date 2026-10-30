/**
 * Technical indicators over plain number series.
 *
 * Indicators feed signal decisions only; they never touch balances, fees or
 * P&L, which use Decimal arithmetic. Every function is pure and returns a
 * series aligned with its input, with `undefined` during the warm-up period,
 * so the value at index i only depends on inputs 0..i (no look-ahead).
 */

export type Series = ReadonlyArray<number>;
export type Out = Array<number | undefined>;

function assertPeriod(n: number): void {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid period: ${n}`);
}

export function sma(values: Series, n: number): Out {
  assertPeriod(n);
  const out: Out = new Array(values.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values. */
export function ema(values: Series, n: number): Out {
  assertPeriod(n);
  const out: Out = new Array(values.length).fill(undefined);
  const k = 2 / (n + 1);
  let prev: number | undefined;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) continue;
    if (prev === undefined) {
      let sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += values[j]!;
      prev = sum / n;
    } else {
      prev = values[i]! * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/** EMA over a series that itself has a warm-up period. */
function emaOfPartial(values: Out, n: number): Out {
  const start = values.findIndex((v) => v !== undefined);
  const out: Out = new Array(values.length).fill(undefined);
  if (start < 0) return out;
  const tail = ema(values.slice(start) as number[], n);
  tail.forEach((v, i) => (out[start + i] = v));
  return out;
}

/** Population standard deviation over a rolling window. */
export function stdev(values: Series, n: number): Out {
  assertPeriod(n);
  const means = sma(values, n);
  return means.map((mean, i) => {
    if (mean === undefined) return undefined;
    let acc = 0;
    for (let j = i - n + 1; j <= i; j++) acc += (values[j]! - mean) ** 2;
    return Math.sqrt(acc / n);
  });
}

/** Wilder's RSI. */
export function rsi(close: Series, n = 14): Out {
  assertPeriod(n);
  const out: Out = new Array(close.length).fill(undefined);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < close.length; i++) {
    const change = close[i]! - close[i - 1]!;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i < n) continue;
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
    }
    out[i] = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function macd(close: Series, fast = 12, slow = 26, signal = 9): { macd: Out; signal: Out; histogram: Out } {
  if (fast >= slow) throw new Error("MACD fast period must be shorter than slow period");
  const f = ema(close, fast);
  const s = ema(close, slow);
  const line: Out = close.map((_, i) => (f[i] !== undefined && s[i] !== undefined ? f[i]! - s[i]! : undefined));
  const sig = emaOfPartial(line, signal);
  const hist: Out = line.map((v, i) => (v !== undefined && sig[i] !== undefined ? v - sig[i]! : undefined));
  return { macd: line, signal: sig, histogram: hist };
}

export function bollinger(close: Series, n = 20, k = 2): { middle: Out; upper: Out; lower: Out; width: Out } {
  const middle = sma(close, n);
  const sd = stdev(close, n);
  const upper = middle.map((m, i) => (m === undefined ? undefined : m + k * sd[i]!));
  const lower = middle.map((m, i) => (m === undefined ? undefined : m - k * sd[i]!));
  // Relative band width, comparable across price levels.
  const width = middle.map((m, i) => (m === undefined || m === 0 ? undefined : (upper[i]! - lower[i]!) / m));
  return { middle, upper, lower, width };
}

function trueRange(high: Series, low: Series, close: Series): number[] {
  return high.map((h, i) =>
    i === 0 ? h - low[0]! : Math.max(h - low[i]!, Math.abs(h - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!)),
  );
}

/** Wilder smoothing seeded with the simple average of the first n values. */
function wilder(values: Series, n: number, startAt = 0): Out {
  const out: Out = new Array(values.length).fill(undefined);
  let prev: number | undefined;
  for (let i = startAt + n - 1; i < values.length; i++) {
    if (prev === undefined) {
      let sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += values[j]!;
      prev = sum / n;
    } else {
      prev = (prev * (n - 1) + values[i]!) / n;
    }
    out[i] = prev;
  }
  return out;
}

/** Wilder's Average True Range. */
export function atr(high: Series, low: Series, close: Series, n = 14): Out {
  assertPeriod(n);
  return wilder(trueRange(high, low, close), n, 1);
}

/** Wilder's ADX with the +DI / -DI lines. */
export function adx(high: Series, low: Series, close: Series, n = 14): { adx: Out; plusDI: Out; minusDI: Out } {
  assertPeriod(n);
  const len = high.length;
  const plusDM = new Array<number>(len).fill(0);
  const minusDM = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    const up = high[i]! - high[i - 1]!;
    const down = low[i - 1]! - low[i]!;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(high, low, close), n, 1);
  const pdm = wilder(plusDM, n, 1);
  const mdm = wilder(minusDM, n, 1);
  const plusDI: Out = tr.map((t, i) => (t === undefined || t === 0 ? undefined : (100 * pdm[i]!) / t));
  const minusDI: Out = tr.map((t, i) => (t === undefined || t === 0 ? undefined : (100 * mdm[i]!) / t));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p === undefined || m === undefined) return undefined;
    return p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
  });
  const start = dx.findIndex((v) => v !== undefined);
  const adxOut: Out = new Array(len).fill(undefined);
  if (start >= 0) {
    const smoothed = wilder(dx.slice(start) as number[], n);
    smoothed.forEach((v, i) => (adxOut[start + i] = v));
  }
  return { adx: adxOut, plusDI, minusDI };
}

/** Rate of change in percent over n bars. */
export function roc(values: Series, n: number): Out {
  assertPeriod(n);
  return values.map((v, i) => (i < n || values[i - n] === 0 ? undefined : ((v - values[i - n]!) / values[i - n]!) * 100));
}

/** Highest value over the n bars ending at i (inclusive). */
export function highest(values: Series, n: number): Out {
  assertPeriod(n);
  return values.map((_, i) => (i < n - 1 ? undefined : Math.max(...values.slice(i - n + 1, i + 1))));
}

/** Lowest value over the n bars ending at i (inclusive). */
export function lowest(values: Series, n: number): Out {
  assertPeriod(n);
  return values.map((_, i) => (i < n - 1 ? undefined : Math.min(...values.slice(i - n + 1, i + 1))));
}
