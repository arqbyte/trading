import { describe, expect, it } from "vitest";
import { Decimal, TradingSignalSchema, floorToStep, parseDecimal, toDecimalString } from "../src/index.js";

describe("decimal helpers", () => {
  it("avoids floating point error", () => {
    expect(new Decimal("0.1").plus("0.2").toFixed()).toBe("0.3");
  });

  it("normalises exchange strings", () => {
    expect(toDecimalString("1e-8")).toBe("0.00000001");
    expect(toDecimalString(" 42.50 ")).toBe("42.5");
  });

  it("rejects junk", () => {
    expect(() => parseDecimal("NaN")).toThrow();
    expect(() => parseDecimal("1,000")).toThrow();
  });

  it("floors to lot size", () => {
    expect(floorToStep(new Decimal("0.123456"), new Decimal("0.0001")).toFixed()).toBe("0.1234");
  });
});

describe("TradingSignalSchema", () => {
  const valid = {
    agentId: "momentum",
    strategyVersion: "1.0.0",
    symbol: "BTC/USDT",
    action: "BUY",
    confidence: 0.7,
    stopLoss: "61000.5",
    timeframe: "15m",
    reasoning: "EMA20 crossed above EMA50",
    timestamp: 1_761_800_000_000,
  };

  it("accepts a valid signal", () => {
    expect(TradingSignalSchema.parse(valid).symbol).toBe("BTC/USDT");
  });

  it("rejects unknown fields so agents cannot smuggle extra instructions", () => {
    expect(() => TradingSignalSchema.parse({ ...valid, leverage: 10 })).toThrow();
  });

  it("rejects out-of-range confidence, bad timeframes and float prices", () => {
    expect(() => TradingSignalSchema.parse({ ...valid, confidence: 1.5 })).toThrow();
    expect(() => TradingSignalSchema.parse({ ...valid, timeframe: "2m" })).toThrow();
    expect(() => TradingSignalSchema.parse({ ...valid, stopLoss: 61000.5 })).toThrow();
    expect(() => TradingSignalSchema.parse({ ...valid, stopLoss: "-1" })).toThrow();
  });
});
