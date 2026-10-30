import { describe, expect, it } from "vitest";
import { adx, atr, bollinger, ema, highest, lowest, macd, roc, rsi, sma, stdev } from "../src/index.js";

const ramp = (n: number, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + i * step);
const flat = (n: number, v = 50) => new Array<number>(n).fill(v);

describe("moving averages", () => {
  it("computes SMA with a warm-up period", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it("seeds EMA with the SMA and then smooths", () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2)).toEqual([undefined, undefined]);
    expect(out[2]).toBe(2);
    expect(out[3]).toBeCloseTo(3); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4);
  });

  it("is constant on a constant series", () => {
    expect(ema(flat(30), 10).at(-1)).toBe(50);
  });
});

describe("oscillators", () => {
  it("RSI is 100 on a rising series and 0 on a falling one", () => {
    expect(rsi(ramp(30), 14).at(-1)).toBe(100);
    expect(rsi(ramp(30, 100, -1), 14).at(-1)).toBe(0);
    expect(rsi(flat(30), 14).at(-1)).toBe(50);
    expect(rsi(ramp(30), 14).findIndex((v) => v !== undefined)).toBe(14);
  });

  it("MACD is positive in an uptrend", () => {
    const { macd: line, signal, histogram } = macd(ramp(60).map((v, i) => v + i * i * 0.01));
    expect(line.at(-1)!).toBeGreaterThan(0);
    expect(signal.at(-1)).toBeDefined();
    expect(histogram.at(-1)!).toBeGreaterThan(0);
    expect(line.findIndex((v) => v !== undefined)).toBe(25);
    expect(signal.findIndex((v) => v !== undefined)).toBe(33);
  });

  it("ROC is the percentage change", () => {
    expect(roc([100, 110, 121], 1)).toEqual([undefined, 10, 10]);
  });
});

describe("volatility and trend", () => {
  it("Bollinger bands collapse on a constant series", () => {
    const b = bollinger(flat(25), 20, 2);
    expect(b.upper.at(-1)).toBe(50);
    expect(b.lower.at(-1)).toBe(50);
    expect(b.width.at(-1)).toBe(0);
  });

  it("population standard deviation", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8).at(-1)).toBe(2);
  });

  it("ATR equals the constant bar range", () => {
    const n = 30;
    const close = flat(n, 100);
    expect(atr(close.map((c) => c + 1), close.map((c) => c - 1), close, 14).at(-1)).toBeCloseTo(2);
  });

  it("ADX is high in a steady trend with +DI above -DI", () => {
    const close = ramp(80);
    const r = adx(close.map((c) => c + 0.5), close.map((c) => c - 0.5), close, 14);
    expect(r.adx.at(-1)!).toBeGreaterThan(50);
    expect(r.plusDI.at(-1)!).toBeGreaterThan(r.minusDI.at(-1)!);
  });

  it("highest and lowest over a window", () => {
    expect(highest([1, 3, 2, 5, 4], 3)).toEqual([undefined, undefined, 3, 5, 5]);
    expect(lowest([1, 3, 2, 5, 4], 3)).toEqual([undefined, undefined, 1, 2, 2]);
  });
});

describe("no look-ahead", () => {
  it("values up to i do not change when later data is appended", () => {
    const base = ramp(50).map((v, i) => v + Math.sin(i) * 3);
    const extended = [...base, 1000, 0, 500];
    for (const f of [(s: number[]) => ema(s, 10), (s: number[]) => rsi(s, 14), (s: number[]) => bollinger(s).upper]) {
      expect(f(extended).slice(0, base.length)).toEqual(f(base));
    }
  });
});
