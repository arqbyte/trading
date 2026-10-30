import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Pool } from "@atrp/database";
import { type Candle, type MarketDataAdapter, type Timeframe, toDecimalString } from "@atrp/shared-types";
import { MarketDataStore, backfillCandles } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
const M = 60_000;
const T0 = Date.UTC(2026, 9, 30, 0, 0);

const candle = (ts: number, isClosed = true, close = "100"): Candle => ({
  exchange: "okx",
  symbol: "BTC/USDT",
  timeframe: "1m",
  timestamp: ts,
  open: toDecimalString("100"),
  high: toDecimalString("101"),
  low: toDecimalString("99"),
  close: toDecimalString(close),
  volume: toDecimalString("1"),
  isClosed,
});

/** Serves candles from an in-memory history, paging like OKX's history endpoint. */
function historyAdapter(history: Candle[]): MarketDataAdapter & { calls: number } {
  const adapter = {
    exchange: "okx",
    calls: 0,
    async getCandles(_s: string, _tf: Timeframe, limit: number, before?: number) {
      adapter.calls++;
      return history
        .filter((c) => before === undefined || c.timestamp < before)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
        .reverse();
    },
  };
  return adapter as unknown as MarketDataAdapter & { calls: number };
}

describe.skipIf(!url)("MarketDataStore", () => {
  let pool: Pool;
  let store: MarketDataStore;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    store = new MarketDataStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("never lets a forming candle overwrite a closed one", async () => {
    await store.upsertCandles([candle(T0, false, "100.5")], "websocket");
    await store.upsertCandles([candle(T0, true, "100.7")], "websocket");
    await store.upsertCandles([candle(T0, false, "100.9")], "websocket");
    const { rows } = await pool.query("SELECT close, is_closed FROM market_candles WHERE ts = $1", [new Date(T0)]);
    expect(rows).toEqual([{ close: "100.7", is_closed: true }]);
  });

  it("deduplicates trades", async () => {
    const trade = {
      exchange: "okx",
      symbol: "BTC/USDT",
      tradeId: "42",
      timestamp: T0,
      side: "buy" as const,
      price: toDecimalString("100"),
      size: toDecimalString("0.1"),
    };
    expect(await store.insertTrades([trade])).toBe(1);
    expect(await store.insertTrades([trade])).toBe(0);
  });

  it("syncs instrument precision from exchange metadata", async () => {
    const updated = await store.syncInstruments([
      {
        exchange: "okx",
        symbol: "BTC/USDT",
        exchangeSymbol: "BTC-USDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        marketType: "spot",
        tickSize: toDecimalString("0.1"),
        lotSize: toDecimalString("0.00000001"),
        minOrderSize: toDecimalString("0.00001"),
        active: true,
      },
    ]);
    expect(updated).toBe(1);
    const { rows } = await pool.query("SELECT lot_size FROM instruments WHERE symbol = 'BTC/USDT'");
    expect(rows[0].lot_size).toBe("0.00000001");
  });

  it("backfills missing candles across several pages", async () => {
    const symbolHistory = Array.from({ length: 300 }, (_, i) => candle(T0 + (i + 10) * M));
    // Keep a few, so there is an interior gap and a long leading gap.
    await store.upsertCandles([symbolHistory[0]!, symbolHistory[250]!], "rest");
    const adapter = historyAdapter(symbolHistory);
    const from = T0 + 10 * M;
    const to = T0 + 309 * M;
    const result = await backfillCandles(adapter, store, "BTC/USDT", "1m", from, to);
    expect(result.gapsFound.reduce((n, g) => n + g.missing, 0)).toBe(298);
    expect(result.unfilled).toEqual([]);
    expect(adapter.calls).toBeGreaterThan(2);
    expect(await store.closedCandleTimes("okx", "BTC/USDT", "1m", from, to)).toHaveLength(300);
  });

  it("reports gaps the exchange cannot fill", async () => {
    const from = T0 + 1000 * M;
    const result = await backfillCandles(historyAdapter([]), store, "BTC/USDT", "1m", from, from + 4 * M);
    expect(result.unfilled).toEqual([{ from, to: from + 4 * M, missing: 5 }]);
  });
});
