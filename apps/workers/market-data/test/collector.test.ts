import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, type Pool } from "@atrp/database";
import { createLogger } from "@atrp/logging";
import { MarketDataStore } from "@atrp/market-data";
import {
  type Candle,
  type Market,
  type MarketDataAdapter,
  type Ticker,
  type Timeframe,
  toDecimalString,
} from "@atrp/shared-types";
import { MarketDataCollector } from "../src/collector.js";

const url = process.env.TEST_DATABASE_URL;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 30);

const d = toDecimalString;
const candle = (ts: number, isClosed = true): Candle => ({
  exchange: "okx",
  symbol: "BTC/USDT",
  timeframe: "1m",
  timestamp: ts,
  open: d("100"),
  high: d("101"),
  low: d("99"),
  close: d("100"),
  volume: d("1"),
  isClosed,
});

/** In-memory stand-in for the exchange: a fixed candle history plus push hooks. */
function fakeAdapter(history: Candle[]) {
  const candleHandlers: Array<(c: Candle) => void> = [];
  const tickerHandlers: Array<(t: Ticker) => void> = [];
  const adapter: MarketDataAdapter = {
    exchange: "okx",
    async getMarkets(): Promise<Market[]> {
      return [
        {
          exchange: "okx",
          symbol: "BTC/USDT",
          exchangeSymbol: "BTC-USDT",
          baseAsset: "BTC",
          quoteAsset: "USDT",
          marketType: "spot",
          tickSize: d("0.1"),
          lotSize: d("0.00000001"),
          minOrderSize: d("0.00001"),
          active: true,
        },
      ];
    },
    async getCandles(_s: string, _tf: Timeframe, limit: number, before?: number) {
      return history
        .filter((c) => before === undefined || c.timestamp < before)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit)
        .reverse();
    },
    async subscribeCandles(symbol, _tf, cb) {
      if (symbol === "BTC/USDT") candleHandlers.push(cb);
      return async () => {};
    },
    async subscribeTicker(symbol, cb) {
      if (symbol === "BTC/USDT") tickerHandlers.push(cb);
      return async () => {};
    },
    async subscribeTrades() {
      return async () => {};
    },
    async subscribeOrderBook() {
      return async () => {};
    },
    async getTicker() {
      throw new Error("unused");
    },
    async getOrderBook() {
      throw new Error("unused");
    },
    async getRecentTrades() {
      return [];
    },
    async close() {},
  };
  return { adapter, candleHandlers, tickerHandlers };
}

describe.skipIf(!url)("MarketDataCollector", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(url!);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    // Only BTC/USDT, to keep the fake small.
    await pool.query("UPDATE instruments SET enabled = (symbol = 'BTC/USDT')");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("backfills on start, repairs stream gaps and records staleness", async () => {
    const lastClosed = Date.UTC(2026, 9, 30, 11, 59);
    const history = Array.from({ length: 60 }, (_, i) => candle(lastClosed - (59 - i) * M));
    const { adapter, candleHandlers } = fakeAdapter(history);
    let now = NOW;
    const collector = new MarketDataCollector(adapter, new MarketDataStore(pool), createLogger("test", { level: "silent" }), {
      timeframes: ["1m"],
      backfillCandles: 30,
      staleAfterMs: 5000,
      orderBookSnapshotMs: 1000,
      gapSweepMs: 3_600_000,
      now: () => now,
    });
    await collector.start();

    const count = async () =>
      Number((await pool.query("SELECT count(*) FROM market_candles WHERE symbol = 'BTC/USDT' AND is_closed")).rows[0].count);
    expect(await count()).toBe(30);
    const [btc] = (await pool.query("SELECT tick_size FROM instruments WHERE symbol = 'BTC/USDT'")).rows;
    expect(btc.tick_size).toBe("0.1");

    // Stream delivers 11:59 then jumps to 12:05; 12:00-12:04 exist on the exchange.
    for (let i = 1; i <= 6; i++) history.push(candle(lastClosed + i * M));
    candleHandlers[0]!(candle(lastClosed));
    candleHandlers[0]!(candle(lastClosed + 6 * M));
    await new Promise((r) => setTimeout(r, 300));
    expect(await count()).toBe(36);
    const gaps = await pool.query("SELECT details FROM data_quality_events WHERE kind = 'gap'");
    expect(gaps.rows.at(-1).details.written).toBe(5);

    // No ticker within the threshold: the symbol goes stale and it is recorded.
    now += 6000;
    collector.staleness.check();
    await new Promise((r) => setTimeout(r, 100));
    expect(collector.staleness.isStale("BTC/USDT")).toBe(true);
    const stale = await pool.query("SELECT symbol FROM data_quality_events WHERE kind = 'stale' AND resolved_at IS NULL");
    expect(stale.rows).toEqual([{ symbol: "BTC/USDT" }]);

    await collector.stop();
  });
});
