import { z } from "zod";
import { TimeframeSchema, isDecimalString } from "@atrp/shared-types";

const decimal = z.string().refine(isDecimalString, "must be a decimal string");
const symbol = z.string().regex(/^[A-Z0-9]+\/[A-Z0-9]+$/);

/**
 * Market data events distributed to agents and services. Only closed candles
 * are published, so no consumer can act on a candle that is still forming
 * (PRD 4.3).
 */
export const CandleClosedEvent = z.object({
  type: z.literal("candle.closed"),
  exchange: z.string(),
  symbol,
  timeframe: TimeframeSchema,
  timestamp: z.number().int(),
  open: decimal,
  high: decimal,
  low: decimal,
  close: decimal,
  volume: decimal,
  /** True when the candle was recovered over REST after a gap. */
  backfilled: z.boolean(),
});

export const TickerEvent = z.object({
  type: z.literal("ticker"),
  exchange: z.string(),
  symbol,
  timestamp: z.number().int(),
  last: decimal,
  bid: decimal,
  bidSize: decimal,
  ask: decimal,
  askSize: decimal,
});

export const OrderBookEvent = z.object({
  type: z.literal("orderbook"),
  exchange: z.string(),
  symbol,
  timestamp: z.number().int(),
  bids: z.array(z.tuple([decimal, decimal])),
  asks: z.array(z.tuple([decimal, decimal])),
});

/** Published whenever a symbol's feed goes stale or recovers. */
export const FeedStatusEvent = z.object({
  type: z.literal("feed.status"),
  exchange: z.string(),
  symbol,
  timestamp: z.number().int(),
  stale: z.boolean(),
});

export const MarketEvent = z.discriminatedUnion("type", [CandleClosedEvent, TickerEvent, OrderBookEvent, FeedStatusEvent]);
export type MarketEvent = z.infer<typeof MarketEvent>;
export type CandleClosedEvent = z.infer<typeof CandleClosedEvent>;
export type TickerEvent = z.infer<typeof TickerEvent>;
export type OrderBookEvent = z.infer<typeof OrderBookEvent>;
export type FeedStatusEvent = z.infer<typeof FeedStatusEvent>;

/** Redis stream holding each event type. */
export const STREAMS = {
  "candle.closed": "md:candles",
  ticker: "md:tickers",
  orderbook: "md:orderbooks",
  "feed.status": "md:status",
} as const satisfies Record<MarketEvent["type"], string>;

/** Deterministic id so consumers can drop redeliveries and duplicates. */
export function eventKey(e: MarketEvent): string {
  switch (e.type) {
    case "candle.closed":
      return `${e.exchange}|${e.symbol}|${e.timeframe}|${e.timestamp}`;
    default:
      return `${e.exchange}|${e.symbol}|${e.timestamp}`;
  }
}
