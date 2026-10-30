// Payloads shaped after the OKX v5 public API documentation. They are not
// recorded from the live API (this environment cannot reach okx.com).

export const instruments = {
  code: "0",
  msg: "",
  data: [
    { instType: "SPOT", instId: "BTC-USDT", baseCcy: "BTC", quoteCcy: "USDT", tickSz: "0.1", lotSz: "0.00000001", minSz: "0.00001", state: "live" },
    { instType: "SPOT", instId: "DOGE-USDT", baseCcy: "DOGE", quoteCcy: "USDT", tickSz: "0.00001", lotSz: "0.000001", minSz: "10", state: "suspend" },
  ],
};

export const ticker = {
  code: "0",
  msg: "",
  data: [
    {
      instType: "SPOT", instId: "BTC-USDT", last: "67012.3", lastSz: "0.0012",
      askPx: "67012.4", askSz: "1.25", bidPx: "67012.3", bidSz: "0.8",
      open24h: "66000", high24h: "67500", low24h: "65800", volCcy24h: "800000000", vol24h: "12000.5",
      sodUtc0: "66100", sodUtc8: "66200", ts: "1761825600000",
    },
  ],
};

// Newest first, as OKX returns them. The newest is still forming (confirm "0").
export const candles = {
  code: "0",
  msg: "",
  data: [
    ["1761825660000", "67010", "67020", "67000", "67012.3", "1.5", "100512", "100512", "0"],
    ["1761825600000", "67000", "67015", "66990", "67010", "2.25", "150760", "150760", "1"],
  ],
};

export const books = {
  code: "0",
  msg: "",
  data: [
    {
      asks: [["67012.4", "1.25", "0", "3"], ["67012.5", "0.5", "0", "1"]],
      bids: [["67012.3", "0.8", "0", "2"]],
      ts: "1761825600123",
    },
  ],
};

export const trades = {
  code: "0",
  msg: "",
  data: [
    { instId: "BTC-USDT", tradeId: "2", px: "67012.4", sz: "0.01", side: "buy", ts: "1761825600200" },
    { instId: "BTC-USDT", tradeId: "1", px: "67012.3", sz: "0.02", side: "sell", ts: "1761825600100" },
  ],
};
