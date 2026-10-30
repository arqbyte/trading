import type { Candle, Market, MarketTrade, OrderBook, Ticker, Timeframe } from "./market.js";

/** Unsubscribes a stream. */
export type Unsubscribe = () => Promise<void>;

/**
 * Public market data only. Implementing this does not make a provider
 * eligible for live trading (PRD 3.3); that is a separate interface and a
 * separate, administrator-controlled flag in the database.
 */
export interface MarketDataAdapter {
  readonly exchange: string;
  getMarkets(): Promise<Market[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getCandles(symbol: string, timeframe: Timeframe, limit: number, before?: number): Promise<Candle[]>;
  getOrderBook(symbol: string, depth: number): Promise<OrderBook>;
  getRecentTrades(symbol: string, limit: number): Promise<MarketTrade[]>;
  subscribeTicker(symbol: string, onTicker: (ticker: Ticker) => void): Promise<Unsubscribe>;
  subscribeCandles(symbol: string, timeframe: Timeframe, onCandle: (candle: Candle) => void): Promise<Unsubscribe>;
  subscribeOrderBook(symbol: string, onBook: (book: OrderBook) => void): Promise<Unsubscribe>;
  subscribeTrades(symbol: string, onTrade: (trade: MarketTrade) => void): Promise<Unsubscribe>;
  /** Stops every stream. */
  close(): Promise<void>;
}

/** Connection lifecycle events, recorded as data quality events. */
export type StreamEvent =
  | { type: "disconnected"; stream: string; code: number; reason: string; attempt: number }
  | { type: "invalid_payload"; stream: string; error: string; payload: string }
  | { type: "subscription_error"; stream: string; error: string };

/** Read-only view of a real exchange account. Not implemented in the MVP. */
export interface AccountInfoAdapter {
  readonly exchange: string;
  getBalances(): Promise<Array<{ asset: string; free: string; locked: string }>>;
}

/**
 * Real-money order placement. Deliberately has no withdraw method. Not
 * implemented in the MVP and must stay disabled until explicitly approved.
 */
export interface LiveExecutionAdapter {
  readonly exchange: string;
  readonly kind: "live";
  placeOrder(order: LiveOrderRequest): Promise<{ exchangeOrderId: string }>;
  cancelOrder(symbol: string, exchangeOrderId: string): Promise<void>;
}

export interface LiveOrderRequest {
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  quantity: string;
  limitPrice?: string;
}
