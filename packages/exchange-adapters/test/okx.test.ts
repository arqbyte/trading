import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { Candle, StreamEvent, Ticker } from "@atrp/shared-types";
import { OkxApiError, OkxMarketDataAdapter, OkxRestClient, RateLimiter } from "../src/index.js";
import * as fx from "./fixtures/okx.js";

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const body = routes[url.pathname];
    if (body === undefined) return new Response("{}", { status: 404 });
    if (typeof body === "function") return (body as () => Response)();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const noSleep = async () => {};

describe("OKX REST normalisation", () => {
  it("normalises instruments with exact precision", async () => {
    const adapter = new OkxMarketDataAdapter({ rest: { fetch: fakeFetch({ "/api/v5/public/instruments": fx.instruments }) } });
    const markets = await adapter.getMarkets();
    expect(markets[0]).toEqual({
      exchange: "okx",
      symbol: "BTC/USDT",
      exchangeSymbol: "BTC-USDT",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      marketType: "spot",
      tickSize: "0.1",
      lotSize: "0.00000001",
      minOrderSize: "0.00001",
      active: true,
    });
    expect(markets[1]!.active).toBe(false);
  });

  it("normalises tickers", async () => {
    const adapter = new OkxMarketDataAdapter({ rest: { fetch: fakeFetch({ "/api/v5/market/ticker": fx.ticker }) } });
    expect(await adapter.getTicker("BTC/USDT")).toEqual({
      exchange: "okx",
      symbol: "BTC/USDT",
      timestamp: 1761825600000,
      last: "67012.3",
      bid: "67012.3",
      bidSize: "0.8",
      ask: "67012.4",
      askSize: "1.25",
      volume24h: "12000.5",
    });
  });

  it("returns candles oldest first and marks the forming candle as open", async () => {
    const calls: string[] = [];
    const adapter = new OkxMarketDataAdapter({ rest: { fetch: fakeFetch({ "/api/v5/market/candles": fx.candles }, calls) } });
    const candles = await adapter.getCandles("BTC/USDT", "1m", 1000);
    expect(candles.map((c) => [c.timestamp, c.isClosed])).toEqual([
      [1761825600000, true],
      [1761825660000, false],
    ]);
    expect(candles[0]).toMatchObject({ open: "67000", high: "67015", low: "66990", close: "67010", volume: "2.25" });
    expect(calls[0]).toContain("limit=300");
    expect(calls[0]).toContain("bar=1m");
  });

  it("uses the history endpoint and UTC bars for backfill", async () => {
    const calls: string[] = [];
    const adapter = new OkxMarketDataAdapter({
      rest: { fetch: fakeFetch({ "/api/v5/market/history-candles": fx.candles }, calls) },
    });
    await adapter.getCandles("ETH/USDT", "1d", 500, 1761825600000);
    expect(calls[0]).toBe("/api/v5/market/history-candles?instId=ETH-USDT&bar=1Dutc&limit=100&after=1761825600000");
  });

  it("normalises order books and trades", async () => {
    const adapter = new OkxMarketDataAdapter({
      rest: { fetch: fakeFetch({ "/api/v5/market/books": fx.books, "/api/v5/market/trades": fx.trades }) },
    });
    const book = await adapter.getOrderBook("BTC/USDT", 5);
    expect(book.asks[0]).toEqual({ price: "67012.4", size: "1.25" });
    expect(book.bids).toHaveLength(1);
    const trades = await adapter.getRecentTrades("BTC/USDT", 2);
    expect(trades.map((t) => t.tradeId)).toEqual(["1", "2"]);
  });

  it("rejects malformed numbers instead of passing them on", async () => {
    const bad = structuredClone(fx.ticker);
    bad.data[0]!.last = "";
    const adapter = new OkxMarketDataAdapter({ rest: { fetch: fakeFetch({ "/api/v5/market/ticker": bad }) } });
    await expect(adapter.getTicker("BTC/USDT")).rejects.toThrow(/Invalid decimal/);
  });
});

describe("OKX REST errors", () => {
  it("retries rate-limit responses then succeeds", async () => {
    let n = 0;
    const client = new OkxRestClient({
      sleep: noSleep,
      fetch: fakeFetch({
        "/api/v5/market/ticker": () =>
          ++n < 3
            ? new Response(JSON.stringify({ code: "50011", msg: "Too Many Requests", data: [] }), { status: 429 })
            : new Response(JSON.stringify(fx.ticker), { status: 200 }),
      }),
    });
    const rows = await client.get("/api/v5/market/ticker", { instId: "BTC-USDT" });
    expect(rows).toHaveLength(1);
    expect(n).toBe(3);
  });

  it("does not retry client errors", async () => {
    let n = 0;
    const client = new OkxRestClient({
      sleep: noSleep,
      fetch: fakeFetch({
        "/api/v5/market/ticker": () => {
          n++;
          return new Response(JSON.stringify({ code: "51001", msg: "Instrument ID does not exist", data: [] }), {
            status: 200,
          });
        },
      }),
    });
    await expect(client.get("/api/v5/market/ticker", { instId: "NOPE-USDT" })).rejects.toBeInstanceOf(OkxApiError);
    expect(n).toBe(1);
  });
});

describe("RateLimiter", () => {
  it("delays requests beyond capacity", async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new RateLimiter(2, 1000, () => now, async (ms) => {
      slept.push(ms);
      now += ms;
    });
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(slept).toEqual([500]);
  });
});

describe("OKX WebSocket streams", () => {
  let server: WebSocketServer | undefined;
  let adapter: OkxMarketDataAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  async function startServer() {
    server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const subscriptions: unknown[] = [];
    const clients: WebSocket[] = [];
    server.on("connection", (ws) => {
      clients.push(ws);
      ws.on("message", (raw) => {
        const text = raw.toString();
        if (text === "ping") return ws.send("pong");
        const msg = JSON.parse(text);
        if (msg.op === "subscribe") {
          subscriptions.push(...msg.args);
          for (const arg of msg.args) ws.send(JSON.stringify({ event: "subscribe", arg }));
        }
      });
    });
    return { url, subscriptions, clients };
  }

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("delivers normalised candles and tickers", async () => {
    const { url, clients } = await startServer();
    adapter = new OkxMarketDataAdapter({ publicWsUrl: url, businessWsUrl: url });
    const candles: Candle[] = [];
    const tickers: Ticker[] = [];
    await adapter.subscribeCandles("BTC/USDT", "1m", (c) => candles.push(c));
    await adapter.subscribeTicker("BTC/USDT", (t) => tickers.push(t));
    await until(() => clients.length === 2);
    for (const ws of clients) {
      ws.send(JSON.stringify({ arg: { channel: "candle1m", instId: "BTC-USDT" }, data: [fx.candles.data[1]] }));
      ws.send(JSON.stringify({ arg: { channel: "tickers", instId: "BTC-USDT" }, data: fx.ticker.data }));
    }
    await until(() => candles.length === 1 && tickers.length === 1);
    expect(candles[0]).toMatchObject({ symbol: "BTC/USDT", timeframe: "1m", isClosed: true, close: "67010" });
    expect(tickers[0]!.bid).toBe("67012.3");
  });

  it("reconnects, reports the disconnect and resubscribes", async () => {
    const { url, subscriptions, clients } = await startServer();
    const events: StreamEvent[] = [];
    adapter = new OkxMarketDataAdapter({
      publicWsUrl: url,
      businessWsUrl: url,
      onStreamEvent: (e) => events.push(e),
      socket: { maxBackoffMs: 50 },
    });
    await adapter.subscribeTicker("ETH/USDT", () => {});
    await until(() => subscriptions.length === 1);
    clients[0]!.terminate();
    await until(() => subscriptions.length === 2);
    expect(subscriptions[1]).toEqual({ channel: "tickers", instId: "ETH-USDT" });
    expect(events.some((e) => e.type === "disconnected")).toBe(true);
  });

  it("reports malformed payloads without crashing the stream", async () => {
    const { url, clients } = await startServer();
    const events: StreamEvent[] = [];
    adapter = new OkxMarketDataAdapter({ publicWsUrl: url, businessWsUrl: url, onStreamEvent: (e) => events.push(e) });
    await adapter.subscribeTicker("BTC/USDT", () => {});
    await until(() => clients.length === 1);
    clients[0]!.send(JSON.stringify({ arg: { channel: "tickers", instId: "BTC-USDT" }, data: [{ instId: "BTC-USDT", last: "x" }] }));
    await until(() => events.length > 0);
    expect(events[0]!.type).toBe("invalid_payload");
  });
});
