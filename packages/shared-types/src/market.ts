import { z } from "zod";
import type { DecimalString } from "./decimal.js";

export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const TimeframeSchema = z.enum(TIMEFRAMES);

const MINUTE = 60_000;
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "4h": 240 * MINUTE,
  "1d": 1440 * MINUTE,
};

/** Internal symbols use BASE/QUOTE, e.g. "BTC/USDT". */
export type Symbol = string;

export interface Market {
  exchange: string;
  symbol: Symbol;
  /** The exchange's own identifier, e.g. "BTC-USDT" on OKX. */
  exchangeSymbol: string;
  baseAsset: string;
  quoteAsset: string;
  marketType: "spot";
  tickSize: DecimalString;
  lotSize: DecimalString;
  minOrderSize: DecimalString;
  active: boolean;
}

export interface Ticker {
  exchange: string;
  symbol: Symbol;
  /** UTC epoch milliseconds from the exchange. */
  timestamp: number;
  last: DecimalString;
  bid: DecimalString;
  bidSize: DecimalString;
  ask: DecimalString;
  askSize: DecimalString;
  volume24h: DecimalString;
}

/**
 * Normalised OHLCV candle (PRD 4.3). `timestamp` is the UTC open time.
 * Strategies must only act on candles with `isClosed: true`.
 */
export interface Candle {
  exchange: string;
  symbol: Symbol;
  timeframe: Timeframe;
  timestamp: number;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  volume: DecimalString;
  isClosed: boolean;
}

export interface OrderBookLevel {
  price: DecimalString;
  size: DecimalString;
}

export interface OrderBook {
  exchange: string;
  symbol: Symbol;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface MarketTrade {
  exchange: string;
  symbol: Symbol;
  tradeId: string;
  timestamp: number;
  side: "buy" | "sell";
  price: DecimalString;
  size: DecimalString;
}
