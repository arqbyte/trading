import type {
  Candle,
  Market,
  MarketDataAdapter,
  MarketTrade,
  OrderBook,
  StreamEvent,
  Ticker,
  Timeframe,
  Unsubscribe,
} from "@atrp/shared-types";
import { ReconnectingSocket } from "../reconnecting-socket.js";
import {
  OKX,
  type OkxBook,
  type OkxCandleRow,
  type OkxInstrument,
  type OkxTicker,
  type OkxTrade,
  fromOkxSymbol,
  normaliseCandle,
  normaliseInstrument,
  normaliseOrderBook,
  normaliseTicker,
  normaliseTrade,
  toOkxSymbol,
} from "./normalise.js";
import { OkxRestClient, type OkxRestOptions } from "./rest.js";
import { OKX_BAR, OKX_CANDLE_CHANNEL } from "./timeframes.js";

export const OKX_WS_PUBLIC = "wss://ws.okx.com:8443/ws/v5/public";
export const OKX_WS_BUSINESS = "wss://ws.okx.com:8443/ws/v5/business";

export interface OkxAdapterOptions {
  rest?: OkxRestOptions;
  publicWsUrl?: string;
  businessWsUrl?: string;
  onStreamEvent?: (event: StreamEvent) => void;
  socket?: { pingIntervalMs?: number; idleTimeoutMs?: number; maxBackoffMs?: number };
}

interface Arg {
  channel: string;
  instId: string;
}

type Handler = (data: unknown[], arg: Arg) => void;

/**
 * One OKX WebSocket endpoint with its subscriptions. Subscriptions are
 * replayed on every reconnect so callers never resubscribe themselves.
 */
class OkxStream {
  private readonly handlers = new Map<string, Handler>();
  private readonly socket: ReconnectingSocket;
  private started = false;

  constructor(
    readonly name: string,
    url: string,
    private readonly onEvent: (e: StreamEvent) => void,
    socketOpts: OkxAdapterOptions["socket"] = {},
  ) {
    this.socket = new ReconnectingSocket({
      url,
      ...socketOpts,
      onOpen: (send) => {
        const args = [...this.handlers.keys()].map((k) => JSON.parse(k) as Arg);
        if (args.length > 0) send(JSON.stringify({ op: "subscribe", args }));
      },
      onMessage: (text) => this.dispatch(text),
      onDisconnect: ({ code, reason, attempt }) =>
        this.onEvent({ type: "disconnected", stream: name, code, reason, attempt }),
    });
  }

  subscribe(arg: Arg, handler: Handler): Unsubscribe {
    const key = JSON.stringify({ channel: arg.channel, instId: arg.instId });
    if (this.handlers.has(key)) throw new Error(`Already subscribed to ${key}`);
    this.handlers.set(key, handler);
    if (!this.started) {
      this.started = true;
      this.socket.start();
    } else {
      this.socket.send(JSON.stringify({ op: "subscribe", args: [arg] }));
    }
    return async () => {
      this.handlers.delete(key);
      this.socket.send(JSON.stringify({ op: "unsubscribe", args: [arg] }));
    };
  }

  stop(): Promise<void> {
    return this.socket.stop();
  }

  private dispatch(text: string): void {
    let msg: { event?: string; msg?: string; arg?: Arg; data?: unknown[] };
    try {
      msg = JSON.parse(text);
    } catch {
      this.onEvent({ type: "invalid_payload", stream: this.name, error: "not JSON", payload: text.slice(0, 500) });
      return;
    }
    if (msg.event === "error") {
      this.onEvent({ type: "subscription_error", stream: this.name, error: msg.msg ?? text });
      return;
    }
    if (msg.event || !msg.arg || !Array.isArray(msg.data)) return;
    const handler = this.handlers.get(JSON.stringify({ channel: msg.arg.channel, instId: msg.arg.instId }));
    if (!handler) return;
    try {
      handler(msg.data, msg.arg);
    } catch (err) {
      this.onEvent({
        type: "invalid_payload",
        stream: this.name,
        error: (err as Error).message,
        payload: text.slice(0, 500),
      });
    }
  }
}

/** OKX public market data. Implements no trading or account methods. */
export class OkxMarketDataAdapter implements MarketDataAdapter {
  readonly exchange = OKX;
  private readonly rest: OkxRestClient;
  private readonly publicStream: OkxStream;
  private readonly businessStream: OkxStream;

  constructor(options: OkxAdapterOptions = {}) {
    const onEvent = options.onStreamEvent ?? (() => {});
    this.rest = new OkxRestClient(options.rest);
    this.publicStream = new OkxStream("okx-public", options.publicWsUrl ?? OKX_WS_PUBLIC, onEvent, options.socket);
    this.businessStream = new OkxStream("okx-business", options.businessWsUrl ?? OKX_WS_BUSINESS, onEvent, options.socket);
  }

  async getMarkets(): Promise<Market[]> {
    const rows = await this.rest.get<OkxInstrument>("/api/v5/public/instruments", { instType: "SPOT" });
    return rows.map(normaliseInstrument);
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const [row] = await this.rest.get<OkxTicker>("/api/v5/market/ticker", { instId: toOkxSymbol(symbol) });
    if (!row) throw new Error(`No ticker for ${symbol}`);
    return normaliseTicker(row);
  }

  /**
   * Returns candles in ascending time order. With `before`, returns candles
   * that opened strictly before that time (used for backfill); this goes to
   * the history endpoint, which pages 100 at a time.
   */
  async getCandles(symbol: string, timeframe: Timeframe, limit: number, before?: number): Promise<Candle[]> {
    const path = before === undefined ? "/api/v5/market/candles" : "/api/v5/market/history-candles";
    const max = before === undefined ? 300 : 100;
    const rows = await this.rest.get<OkxCandleRow>(path, {
      instId: toOkxSymbol(symbol),
      bar: OKX_BAR[timeframe],
      limit: Math.min(limit, max),
      after: before,
    });
    return rows.map((r) => normaliseCandle(symbol, timeframe, r)).sort((a, b) => a.timestamp - b.timestamp);
  }

  async getOrderBook(symbol: string, depth: number): Promise<OrderBook> {
    const [row] = await this.rest.get<OkxBook>("/api/v5/market/books", { instId: toOkxSymbol(symbol), sz: depth });
    if (!row) throw new Error(`No order book for ${symbol}`);
    return normaliseOrderBook(symbol, row);
  }

  async getRecentTrades(symbol: string, limit: number): Promise<MarketTrade[]> {
    const rows = await this.rest.get<OkxTrade>("/api/v5/market/trades", { instId: toOkxSymbol(symbol), limit });
    return rows.map(normaliseTrade).sort((a, b) => a.timestamp - b.timestamp);
  }

  async subscribeTicker(symbol: string, onTicker: (t: Ticker) => void): Promise<Unsubscribe> {
    return this.publicStream.subscribe({ channel: "tickers", instId: toOkxSymbol(symbol) }, (data) => {
      for (const row of data) onTicker(normaliseTicker(row as OkxTicker));
    });
  }

  async subscribeCandles(symbol: string, timeframe: Timeframe, onCandle: (c: Candle) => void): Promise<Unsubscribe> {
    return this.businessStream.subscribe(
      { channel: OKX_CANDLE_CHANNEL(timeframe), instId: toOkxSymbol(symbol) },
      (data) => {
        for (const row of data) onCandle(normaliseCandle(symbol, timeframe, row as OkxCandleRow));
      },
    );
  }

  /** Top five levels, pushed as full snapshots (OKX "books5"). */
  async subscribeOrderBook(symbol: string, onBook: (b: OrderBook) => void): Promise<Unsubscribe> {
    return this.publicStream.subscribe({ channel: "books5", instId: toOkxSymbol(symbol) }, (data, arg) => {
      for (const row of data) onBook(normaliseOrderBook(fromOkxSymbol(arg.instId), row as OkxBook));
    });
  }

  async subscribeTrades(symbol: string, onTrade: (t: MarketTrade) => void): Promise<Unsubscribe> {
    return this.publicStream.subscribe({ channel: "trades", instId: toOkxSymbol(symbol) }, (data) => {
      for (const row of data) onTrade(normaliseTrade(row as OkxTrade));
    });
  }

  async close(): Promise<void> {
    await Promise.all([this.publicStream.stop(), this.businessStream.stop()]);
  }
}
