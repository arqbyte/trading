import type { Pool } from "@atrp/database";
import type { Candle, Market, MarketTrade, OrderBook, Timeframe } from "@atrp/shared-types";

export type DataQualityKind =
  | "gap"
  | "stale"
  | "duplicate"
  | "reconnect"
  | "rate_limit"
  | "checksum_mismatch"
  | "invalid_payload";

const iso = (ms: number) => new Date(ms).toISOString();

/** Persistence for normalised market data. All writes are idempotent. */
export class MarketDataStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Inserts or updates candles. A closed candle is final: it is never
   * overwritten by a later open (forming) version of the same candle.
   */
  async upsertCandles(candles: Candle[], source: "rest" | "websocket"): Promise<number> {
    if (candles.length === 0) return 0;
    const values: unknown[] = [];
    const rows = candles.map((c, i) => {
      values.push(c.exchange, c.symbol, c.timeframe, iso(c.timestamp), c.open, c.high, c.low, c.close, c.volume, c.isClosed, source);
      const o = i * 11;
      return `(${Array.from({ length: 11 }, (_, k) => `$${o + k + 1}`).join(", ")})`;
    });
    const res = await this.pool.query(
      `INSERT INTO market_candles (exchange_id, symbol, timeframe, ts, open, high, low, close, volume, is_closed, source)
       VALUES ${rows.join(", ")}
       ON CONFLICT (exchange_id, symbol, timeframe, ts) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
         volume = EXCLUDED.volume, is_closed = EXCLUDED.is_closed, source = EXCLUDED.source,
         received_at = now()
       WHERE NOT market_candles.is_closed`,
      values,
    );
    return res.rowCount ?? 0;
  }

  /** Open times of closed candles in [from, to]. */
  async closedCandleTimes(exchange: string, symbol: string, timeframe: Timeframe, from: number, to: number): Promise<number[]> {
    const { rows } = await this.pool.query<{ ts: Date }>(
      `SELECT ts FROM market_candles
       WHERE exchange_id = $1 AND symbol = $2 AND timeframe = $3 AND ts BETWEEN $4 AND $5 AND is_closed
       ORDER BY ts`,
      [exchange, symbol, timeframe, iso(from), iso(to)],
    );
    return rows.map((r) => r.ts.getTime());
  }

  async insertTrades(trades: MarketTrade[]): Promise<number> {
    if (trades.length === 0) return 0;
    const values: unknown[] = [];
    const rows = trades.map((t, i) => {
      values.push(t.exchange, t.symbol, t.tradeId, iso(t.timestamp), t.side, t.price, t.size);
      const o = i * 7;
      return `(${Array.from({ length: 7 }, (_, k) => `$${o + k + 1}`).join(", ")})`;
    });
    const res = await this.pool.query(
      `INSERT INTO market_trades (exchange_id, symbol, trade_id, ts, side, price, size)
       VALUES ${rows.join(", ")} ON CONFLICT DO NOTHING`,
      values,
    );
    return res.rowCount ?? 0;
  }

  async insertOrderBook(book: OrderBook): Promise<void> {
    const levels = (side: OrderBook["bids"]) => JSON.stringify(side.map((l) => [l.price, l.size]));
    await this.pool.query(
      `INSERT INTO orderbook_snapshots (exchange_id, symbol, ts, bids, asks)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [book.exchange, book.symbol, iso(book.timestamp), levels(book.bids), levels(book.asks)],
    );
  }

  /** Copies exchange precision metadata onto the instruments we track. */
  async syncInstruments(markets: Market[]): Promise<number> {
    let updated = 0;
    for (const m of markets) {
      const res = await this.pool.query(
        `UPDATE instruments
         SET tick_size = $3, lot_size = $4, min_order_size = $5, metadata_synced_at = now()
         WHERE exchange_id = $1 AND exchange_symbol = $2`,
        [m.exchange, m.exchangeSymbol, m.tickSize, m.lotSize, m.minOrderSize],
      );
      updated += res.rowCount ?? 0;
    }
    return updated;
  }

  async enabledInstruments(exchange: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ symbol: string }>(
      "SELECT symbol FROM instruments WHERE exchange_id = $1 AND enabled ORDER BY symbol",
      [exchange],
    );
    return rows.map((r) => r.symbol);
  }

  async recordQualityEvent(e: {
    exchange: string;
    kind: DataQualityKind;
    symbol?: string;
    timeframe?: Timeframe;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO data_quality_events (exchange_id, symbol, timeframe, kind, details) VALUES ($1, $2, $3, $4, $5)`,
      [e.exchange, e.symbol ?? null, e.timeframe ?? null, e.kind, JSON.stringify(e.details ?? {})],
    );
  }

  async resolveQualityEvents(exchange: string, kind: DataQualityKind, symbol: string): Promise<void> {
    await this.pool.query(
      `UPDATE data_quality_events SET resolved_at = now()
       WHERE exchange_id = $1 AND kind = $2 AND symbol = $3 AND resolved_at IS NULL`,
      [exchange, kind, symbol],
    );
  }
}
