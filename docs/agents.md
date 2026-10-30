# Initial strategy agents

The six competition agents from PRD 5.3, defined as DSL specs in `packages/builtin-strategies/src/specs.ts`. `pnpm db:seed` registers them as immutable `1.0.0` versions and creates the agents in the **paused** state. They are starting points for the experiment, not validated trading recommendations. Improving them is the research lab's job, through new versions.

| Agent | Timeframe | Entry (all of) | Exit (any of) | Stop / target |
|---|---|---|---|---|
| A Momentum | 15m | MACD histogram crosses above 0; 55 < RSI14 < 75; close > EMA50; volume > 1.2 × 20-bar average | histogram crosses below 0; RSI < 45 | 2% / 4% |
| B Mean Reversion | 15m | close < lower Bollinger (20, 2σ); RSI14 < 30; ADX14 < 25 | close ≥ middle band; ADX > 35 | 2.5% / 3% |
| C Breakout | 1h | close > prior 20-bar high; prior Bollinger width < 6%; volume > 1.5 × average | close < prior 10-bar low; close crosses below EMA20 | 3% / 6%, 4% trailing |
| D Scalping | 1m | spread < 0.03%; book imbalance > 0.2; EMA9 > EMA21; close crosses above EMA9; RSI7 < 70; volume > 30-bar average | close < EMA21; RSI7 > 80 | 0.4% / 0.6% |
| E Trend Following | 1h | EMA20 > EMA50; EMA50 ≥ 1.01 × EMA200; ADX > 25; +DI > −DI; close > EMA20 | EMA20 crosses below EMA50 | 4% stop, 6% trailing |
| F Experimental | 15m | RSI crosses above 30; close < middle band; MACD histogram rising | RSI > 65; high ≥ upper band | 2% / 3.5% |

## Notes

- **Scalping costs.** The 0.6% target clears a round trip of OKX base-tier taker fees (2 × 0.1%) plus the maximum allowed spread. That's only a sanity bound. The paper engine (Stage 6) models fees, spread and slippage for real, and the risk engine (Stage 7) will reject entries whose expected edge doesn't cover estimated costs (PRD 5.3 D).
- **Experimental slot.** Agent F starts with a combined baseline. Research-agent candidates that pass validation and backtesting are trialled here as new versions (PRD 5.3 F, 6.2).
- **Behaviour tests** (`packages/builtin-strategies/test`) run each agent bar by bar over seeded synthetic markets. They check the agents follow their briefs: trend following stays out of sideways noise, mean reversion buys a dip in a range but not a steady decline, breakout needs a volume surge, momentum needs volume, and scalping never trades without a tight, bid-heavy quote. These tests check behaviour only and say nothing about profitability.
