# Roadmap

Tracks the PRD section 19 build order.

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Project foundation and database | Done |
| 2 | OKX market data collector | Done |
| 3 | Normalised market data infrastructure (Redis distribution to agents) | Done |
| 4 | Strategy engine, strategy DSL and agent SDK | In review |
| 5 | Initial strategy agents (momentum, mean reversion, breakout, scalping, trend, experimental) | In review |
| 6 | Paper trading engine (plus the agent runner that feeds it) | Next |
| 7 | Risk management | |
| 8 | Performance evaluation | |
| 9 | Dashboard and leaderboard | |
| 10 | AI research laboratory | |
| 11 | Historical backtesting | |
| 12–13 | 30-day competition, strategy selection | |
| 14–15 | Live execution adapter and live validation | Blocked until explicit administrator approval |

## Decisions so far

- **Decimal strings instead of `number` in shared types.** The PRD's example interfaces use `number` for prices; the PRD also forbids float arithmetic for money (14.2). Shared types carry prices and sizes as decimal strings so nothing is lost between exchange, database and engine.
- **Plain SQL migrations with a small runner** rather than an ORM, so constraints and triggers (immutability, isolation, append-only logs) are explicit and reviewable.
- **TimescaleDB is optional at migration time.** Hypertables are created when the extension exists (Docker, CI) and skipped otherwise, so the schema also runs on plain PostgreSQL.
- **OKX bars use the UTC variants** (`4Hutc`, `1Dutc`); OKX's default 4H/1D candles are aligned to Hong Kong time.
- **Order books are stored as throttled top-5 snapshots** (OKX `books5`, default every 5s) rather than full incremental depth. Enough for spread and imbalance; full depth with checksums can be added if scalping needs it.
- **Staleness is measured from ticker arrival time.** A symbol with no ticker for 15s (configurable) is recorded as stale; later stages must refuse to trade it.
- **The OKX adapter has not yet been run against the live API**: the build environment's network policy blocks okx.com. Parsing is tested against payloads shaped from the OKX v5 docs.
- **Redis Streams with consumer groups** for distribution. Each consumer group (e.g. one per agent) receives every event once, in order; events are acknowledged only after the handler succeeds, so a crashed agent resumes from where it stopped. The latest ticker and feed status per symbol are also kept in plain keys for quick freshness checks.
- **Only closed candles go on the bus**, and only those that close after the collector starts. When a gap is found, the recovered candles are published (flagged `backfilled`) before the candle that revealed the gap, so consumers always see candles in order. Agents warm up from the database.
- **A JSON rule-tree DSL instead of the PRD example's free-text conditions** (`"EMA20 crosses above EMA50"`). Free text needs a parser and is ambiguous; structured operands can be validated completely and can't express code. See docs/strategy-dsl.md.
- **Indicators use JavaScript numbers; money uses Decimal.** Indicators only feed decisions, are deterministic for the same inputs, and would be very slow in 40-digit decimals. Stop/take-profit prices, sizes, balances, fees and P&L stay in Decimal.
- **Every strategy must set a stop-loss**, and strategies are long-only spot. The engine produces signals only; sizing and stop enforcement belong to the risk and paper execution engines (Stages 6–7).
- **Two DSL additions for the agents:** `scale` on operands (for example, volume above 1.5 × its average) and live `quote` operands (`spreadPercent`, `imbalance`) for scalping. Quote values have no history, so crosses on them are rejected.
- **The agent runner moves to Stage 6.** Running agents needs their positions, which come from the paper engine, so both are built together.
