# Strategy DSL

Strategies are JSON documents validated by `@atrp/strategy-dsl` and interpreted by `@atrp/strategy-engine`. They contain no code, expressions or function references, so a strategy written by a research agent can't execute anything (PRD 6.4). It can only be interpreted.

## Shape

```json
{
  "schemaVersion": 1,
  "name": "EMA Momentum Breakout",
  "version": "1.0.0",
  "market": "spot",
  "timeframe": "15m",
  "indicators": [
    { "id": "ema20", "type": "EMA", "period": 20 },
    { "id": "ema50", "type": "EMA", "period": 50 },
    { "id": "rsi14", "type": "RSI", "period": 14 }
  ],
  "entry": {
    "all": [
      { "op": "crossesAbove", "left": { "indicator": "ema20" }, "right": { "indicator": "ema50" } },
      { "op": "gt", "left": { "indicator": "rsi14" }, "right": { "value": 50 } }
    ]
  },
  "exit": { "op": "crossesBelow", "left": { "indicator": "ema20" }, "right": { "indicator": "ema50" } },
  "risk": { "stopLossPercent": 1.5, "takeProfitPercent": 3 }
}
```

This is the PRD 6.3 example. Like the PRD, it is illustrative and not a validated trading recommendation.

## Indicators

| Type | Parameters (defaults) | Fields |
|---|---|---|
| `SMA`, `EMA` | `period`, `source` (close) | `value` |
| `RSI` | `period` (14) | `value` |
| `MACD` | `fast` (12), `slow` (26), `signal` (9) | `macd`, `signal`, `histogram` |
| `BBANDS` | `period` (20), `stdDev` (2) | `middle`, `upper`, `lower`, `width` (relative) |
| `ATR` | `period` (14) | `value` |
| `ADX` | `period` (14) | `adx`, `plusDI`, `minusDI` |
| `ROC` | `period`, `source` (close) | `value` (percent) |
| `STDEV` | `period`, `source` (close) | `value` |
| `HIGHEST` | `period`, `source` (high) | `value` |
| `LOWEST` | `period`, `source` (low) | `value` |

`source` is one of `open`, `high`, `low`, `close`, `volume`. Periods are 1–500. At most 20 indicators.

## Rules

A rule is a comparison or a group:

- `{ "op": "gt" | "gte" | "lt" | "lte" | "crossesAbove" | "crossesBelow", "left": operand, "right": operand }`
- `{ "all": [rule, ...] }`, `{ "any": [rule, ...] }`, `{ "not": rule }` (nesting depth 6, 50 comparisons max)

An operand is one of:

- `{ "indicator": "id", "field": "upper", "offset": 0, "scale": 1.5 }`. `field` is required only for multi-line indicators. `offset` is bars ago, 0–50. `scale` multiplies the value (for example, volume above 1.5 × its average).
- `{ "price": "close", "offset": 1, "scale": 1 }`
- `{ "quote": "spreadPercent" | "imbalance" }`. These are live top-of-book values at decision time: spread as a percent of mid, and (bidSize − askSize) / (bidSize + askSize). They have no history, so they can't be used in crosses. Missing or crossed quotes make the condition false.
- `{ "value": 50 }`

A cross compares the latest bar with the bar before it. If an indicator is still warming up, the condition is false. It is never true.

## Semantics

- The engine only accepts **closed** candles of the strategy's timeframe, oldest first, for a single symbol. Anything else throws, so look-ahead can't happen by accident.
- Spot, long-only. When flat, `entry` true → `BUY`. When holding, `exit` true or the trailing stop hit → `SELL`. Otherwise `HOLD`.
- `risk.stopLossPercent` is required. `BUY` signals carry `stopLoss` / `takeProfit` prices calculated exactly in Decimal from the close. Order sizing and enforcing those levels are the risk and execution engines' job.
- Indicators are calculated with JavaScript numbers. They only feed decisions, while every money calculation (balances, fees, P&L, stop prices) uses Decimal.

## Validation

`validateStrategy(spec)` runs the schema, checks references and fields, flags unused indicators, impossible MACD periods, rules comparing two constants and oversized rules, and works out the warm-up length (1000 bars max). It also returns a SHA-256 hash of the trading logic. The hash ignores name, version and description, so the registry refuses a "new version" that changes nothing.
