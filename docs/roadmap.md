# Roadmap

Tracks the PRD section 19 build order.

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Project foundation and database | In review |
| 2 | OKX market data collector | Next |
| 3 | Normalised market data infrastructure (Redis distribution, gap recovery, staleness) | |
| 4 | Strategy engine, strategy DSL and agent SDK | |
| 5 | Initial strategy agents (momentum, mean reversion, breakout, scalping, trend, experimental) | |
| 6 | Paper trading engine | |
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
