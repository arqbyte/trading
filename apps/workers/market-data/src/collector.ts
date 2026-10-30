import type { Logger } from "@atrp/logging";
import { MarketDataStore, StalenessMonitor, backfillCandles, candleOpenTime } from "@atrp/market-data";
import {
  type Candle,
  type MarketDataAdapter,
  type MarketTrade,
  type StreamEvent,
  TIMEFRAME_MS,
  type Timeframe,
  type Unsubscribe,
} from "@atrp/shared-types";

export interface CollectorOptions {
  timeframes: Timeframe[];
  /** How many closed candles per timeframe to keep backfilled on startup. */
  backfillCandles: number;
  staleAfterMs: number;
  orderBookSnapshotMs: number;
  gapSweepMs: number;
  now?: () => number;
}

/**
 * Collects OKX market data into the database: syncs instrument metadata,
 * backfills recent history, streams candles, tickers, trades and order
 * books, repairs gaps over REST and records data quality issues.
 */
export class MarketDataCollector {
  private readonly unsubscribes: Unsubscribe[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly lastClosed = new Map<string, number>();
  private readonly repairs = new Map<string, Promise<void>>();
  private readonly lastBookAt = new Map<string, number>();
  private tradeBuffer: MarketTrade[] = [];
  readonly staleness: StalenessMonitor;
  private readonly now: () => number;
  private symbols: string[] = [];

  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly store: MarketDataStore,
    private readonly log: Logger,
    private readonly opts: CollectorOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.staleness = new StalenessMonitor(
      opts.staleAfterMs,
      (key, stale, silentForMs) => void this.onStalenessChange(key, stale, silentForMs),
      this.now,
    );
  }

  /** Called by the adapter for connection-level problems. */
  handleStreamEvent(event: StreamEvent): void {
    const kind = event.type === "disconnected" ? "reconnect" : "invalid_payload";
    this.log.warn({ event }, "stream event");
    void this.store
      .recordQualityEvent({ exchange: this.adapter.exchange, kind, details: { ...event } })
      .catch((err) => this.log.error({ err }, "failed to record data quality event"));
  }

  async start(): Promise<void> {
    const markets = await this.adapter.getMarkets();
    const synced = await this.store.syncInstruments(markets);
    this.symbols = await this.store.enabledInstruments(this.adapter.exchange);
    this.log.info({ synced, symbols: this.symbols }, "instrument metadata synced");

    // Subscribe first so nothing is missed while history loads; the gap
    // check on each closed candle covers any overlap.
    for (const symbol of this.symbols) {
      this.staleness.watch(symbol);
      this.unsubscribes.push(
        await this.adapter.subscribeTicker(symbol, () => this.staleness.touch(symbol)),
        await this.adapter.subscribeTrades(symbol, (t) => this.tradeBuffer.push(t)),
        await this.adapter.subscribeOrderBook(symbol, (b) => this.onOrderBook(b)),
      );
      for (const tf of this.opts.timeframes) {
        this.unsubscribes.push(await this.adapter.subscribeCandles(symbol, tf, (c) => this.onCandle(c)));
      }
    }

    await this.sweepGaps();

    this.timers.push(
      setInterval(() => this.staleness.check(), Math.max(1000, this.opts.staleAfterMs / 3)),
      setInterval(() => void this.flushTrades(), 1000),
      setInterval(() => void this.sweepGaps(), this.opts.gapSweepMs),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await Promise.allSettled(this.unsubscribes.map((u) => u()));
    await this.adapter.close();
    await Promise.allSettled(this.repairs.values());
    await this.flushTrades();
  }

  /** Backfills every symbol/timeframe up to the last closed candle. */
  async sweepGaps(): Promise<void> {
    for (const symbol of this.symbols) {
      for (const tf of this.opts.timeframes) {
        const step = TIMEFRAME_MS[tf];
        const lastClosedOpen = candleOpenTime(this.now(), tf) - step;
        await this.repair(symbol, tf, lastClosedOpen - (this.opts.backfillCandles - 1) * step, lastClosedOpen);
      }
    }
  }

  private onCandle(candle: Candle): void {
    void this.store.upsertCandles([candle], "websocket").catch((err) => this.log.error({ err }, "candle write failed"));
    if (!candle.isClosed) return;
    const key = `${candle.symbol}|${candle.timeframe}`;
    const previous = this.lastClosed.get(key);
    this.lastClosed.set(key, Math.max(previous ?? 0, candle.timestamp));
    const step = TIMEFRAME_MS[candle.timeframe];
    if (previous !== undefined && candle.timestamp - previous > step) {
      void this.repair(candle.symbol, candle.timeframe, previous + step, candle.timestamp - step);
    }
  }

  /** Runs one backfill at a time per symbol/timeframe. */
  private repair(symbol: string, tf: Timeframe, from: number, to: number): Promise<void> {
    const key = `${symbol}|${tf}`;
    const prior = this.repairs.get(key) ?? Promise.resolve();
    const next = prior.then(async () => {
      try {
        const result = await backfillCandles(this.adapter, this.store, symbol, tf, from, to);
        if (result.gapsFound.length === 0) return;
        this.log.info({ symbol, tf, gaps: result.gapsFound.length, written: result.candlesWritten }, "gaps repaired");
        await this.store.recordQualityEvent({
          exchange: this.adapter.exchange,
          kind: "gap",
          symbol,
          timeframe: tf,
          details: { gaps: result.gapsFound, unfilled: result.unfilled, written: result.candlesWritten },
        });
      } catch (err) {
        this.log.error({ err, symbol, tf }, "backfill failed");
      }
    });
    this.repairs.set(key, next);
    return next;
  }

  private onOrderBook(book: Parameters<MarketDataStore["insertOrderBook"]>[0]): void {
    const last = this.lastBookAt.get(book.symbol) ?? 0;
    if (book.timestamp - last < this.opts.orderBookSnapshotMs) return;
    this.lastBookAt.set(book.symbol, book.timestamp);
    void this.store.insertOrderBook(book).catch((err) => this.log.error({ err }, "order book write failed"));
  }

  private async flushTrades(): Promise<void> {
    if (this.tradeBuffer.length === 0) return;
    const batch = this.tradeBuffer;
    this.tradeBuffer = [];
    try {
      await this.store.insertTrades(batch);
    } catch (err) {
      this.log.error({ err, count: batch.length }, "trade write failed");
    }
  }

  private async onStalenessChange(symbol: string, stale: boolean, silentForMs: number): Promise<void> {
    try {
      if (stale) {
        this.log.warn({ symbol, silentForMs }, "market data stale");
        await this.store.recordQualityEvent({ exchange: this.adapter.exchange, kind: "stale", symbol, details: { silentForMs } });
      } else {
        this.log.info({ symbol }, "market data fresh again");
        await this.store.resolveQualityEvents(this.adapter.exchange, "stale", symbol);
      }
    } catch (err) {
      this.log.error({ err }, "failed to record staleness");
    }
  }
}
