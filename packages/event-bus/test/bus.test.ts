import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CandleClosedEvent,
  type ConsumedEvent,
  MarketEventConsumer,
  MarketEventPublisher,
  Redis,
  getFeedStatus,
  getLatestTicker,
} from "../src/index.js";
import { toDecimalString as d } from "@atrp/shared-types";

const url = process.env.TEST_REDIS_URL;

const candle = (ts: number): CandleClosedEvent => ({
  type: "candle.closed",
  exchange: "okx",
  symbol: "BTC/USDT",
  timeframe: "1m",
  timestamp: ts,
  open: d("100"),
  high: d("101"),
  low: d("99"),
  close: d("100.5"),
  volume: d("2"),
  backfilled: false,
});

describe.skipIf(!url)("market event bus", () => {
  let redis: Redis;
  let publisher: MarketEventPublisher;

  beforeAll(() => {
    redis = new Redis(url!);
    publisher = new MarketEventPublisher(redis);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis?.quit();
  });

  const consumer = (group: string, name = "c1", startFrom: "$" | "0" = "$") =>
    new MarketEventConsumer(redis, { group, consumer: name, types: ["candle.closed"], startFrom, blockMs: 50 });

  it("rejects malformed events before they reach the stream", async () => {
    await expect(publisher.publish({ ...candle(1), close: "1e5" as never } as CandleClosedEvent)).rejects.toThrow();
    await expect(publisher.publish({ ...candle(1), timeframe: "2m" } as unknown as CandleClosedEvent)).rejects.toThrow();
    expect(await redis.exists("md:candles")).toBe(0);
  });

  it("delivers every event to every group, in order", async () => {
    const a = consumer("agent-a");
    const b = consumer("agent-b");
    await a.init();
    await b.init();
    for (const ts of [1, 2, 3]) await publisher.publish(candle(ts));
    const seenA: number[] = [];
    const seenB: number[] = [];
    await a.poll((e) => void seenA.push((e.event as CandleClosedEvent).timestamp));
    await b.poll((e) => void seenB.push((e.event as CandleClosedEvent).timestamp));
    expect(seenA).toEqual([1, 2, 3]);
    expect(seenB).toEqual([1, 2, 3]);
    expect(await a.poll(() => {})).toBe(0);
  });

  it("redelivers events whose handler failed", async () => {
    const c = consumer("agent-c");
    await c.init();
    await publisher.publish(candle(10));
    await expect(
      c.poll(() => {
        throw new Error("agent crashed");
      }),
    ).rejects.toThrow("agent crashed");

    // A restarted consumer with the same name picks up its pending event.
    const restarted = consumer("agent-c");
    const seen: ConsumedEvent[] = [];
    await restarted.poll((e) => void seen.push(e));
    expect(seen.map((e) => (e.event as CandleClosedEvent).timestamp)).toEqual([10]);
    expect(await restarted.poll(() => {})).toBe(0);
  });

  it("can replay history for a new group", async () => {
    await publisher.publish(candle(1));
    const late = consumer("late-joiner", "c1", "0");
    await late.init();
    const seen: number[] = [];
    await late.poll((e) => void seen.push((e.event as CandleClosedEvent).timestamp));
    expect(seen).toEqual([1]);
  });

  it("keeps the latest ticker and feed status per symbol", async () => {
    await publisher.publish({
      type: "ticker",
      exchange: "okx",
      symbol: "ETH/USDT",
      timestamp: 5,
      last: d("2500"),
      bid: d("2499.9"),
      bidSize: d("1"),
      ask: d("2500.1"),
      askSize: d("2"),
    });
    await publisher.publish({ type: "feed.status", exchange: "okx", symbol: "ETH/USDT", timestamp: 6, stale: true });
    expect((await getLatestTicker(redis, "okx", "ETH/USDT"))?.bid).toBe("2499.9");
    expect((await getFeedStatus(redis, "okx", "ETH/USDT"))?.stale).toBe(true);
    expect(await getLatestTicker(redis, "okx", "SOL/USDT")).toBeUndefined();
  });
});
