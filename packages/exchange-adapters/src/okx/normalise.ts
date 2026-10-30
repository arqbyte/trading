import { type Candle, type Market, type MarketTrade, type OrderBook, type Ticker, type Timeframe, toDecimalString } from "@atrp/shared-types";

export const OKX = "okx";

export const toOkxSymbol = (symbol: string) => symbol.replace("/", "-");
export const fromOkxSymbol = (instId: string) => instId.replace("-", "/");

const ts = (value: string): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid OKX timestamp: ${value}`);
  return n;
};

export interface OkxInstrument {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  state: string;
}

export function normaliseInstrument(raw: OkxInstrument): Market {
  return {
    exchange: OKX,
    symbol: fromOkxSymbol(raw.instId),
    exchangeSymbol: raw.instId,
    baseAsset: raw.baseCcy,
    quoteAsset: raw.quoteCcy,
    marketType: "spot",
    tickSize: toDecimalString(raw.tickSz),
    lotSize: toDecimalString(raw.lotSz),
    minOrderSize: toDecimalString(raw.minSz),
    active: raw.state === "live",
  };
}

export interface OkxTicker {
  instId: string;
  last: string;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  vol24h: string;
  ts: string;
}

export function normaliseTicker(raw: OkxTicker): Ticker {
  return {
    exchange: OKX,
    symbol: fromOkxSymbol(raw.instId),
    timestamp: ts(raw.ts),
    last: toDecimalString(raw.last),
    bid: toDecimalString(raw.bidPx),
    bidSize: toDecimalString(raw.bidSz),
    ask: toDecimalString(raw.askPx),
    askSize: toDecimalString(raw.askSz),
    volume24h: toDecimalString(raw.vol24h),
  };
}

/** OKX candle row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]. */
export type OkxCandleRow = string[];

export function normaliseCandle(symbol: string, timeframe: Timeframe, row: OkxCandleRow): Candle {
  const [t, o, h, l, c, vol, , , confirm] = row;
  if (t === undefined || o === undefined || h === undefined || l === undefined || c === undefined || vol === undefined) {
    throw new Error(`Malformed OKX candle: ${JSON.stringify(row)}`);
  }
  return {
    exchange: OKX,
    symbol,
    timeframe,
    timestamp: ts(t),
    open: toDecimalString(o),
    high: toDecimalString(h),
    low: toDecimalString(l),
    close: toDecimalString(c),
    // `vol` is in base currency for spot instruments.
    volume: toDecimalString(vol),
    // Only "1" means the candle is final; anything else is treated as open.
    isClosed: confirm === "1",
  };
}

export interface OkxBook {
  asks: string[][];
  bids: string[][];
  ts: string;
}

export function normaliseOrderBook(symbol: string, raw: OkxBook): OrderBook {
  const level = ([price, size]: string[]) => {
    if (price === undefined || size === undefined) throw new Error("Malformed OKX book level");
    return { price: toDecimalString(price), size: toDecimalString(size) };
  };
  return { exchange: OKX, symbol, timestamp: ts(raw.ts), bids: raw.bids.map(level), asks: raw.asks.map(level) };
}

export interface OkxTrade {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: string;
  ts: string;
}

export function normaliseTrade(raw: OkxTrade): MarketTrade {
  if (raw.side !== "buy" && raw.side !== "sell") throw new Error(`Unknown trade side: ${raw.side}`);
  return {
    exchange: OKX,
    symbol: fromOkxSymbol(raw.instId),
    tradeId: raw.tradeId,
    timestamp: ts(raw.ts),
    side: raw.side,
    price: toDecimalString(raw.px),
    size: toDecimalString(raw.sz),
  };
}
