# AI Trading Research Platform

Self-hosted research and paper-trading platform for cryptocurrency spot strategies. OKX is the first market data source. See [docs/roadmap.md](docs/roadmap.md) for build progress against the PRD.

**Live trading is disabled.** The live execution service does not exist in this build, the API refuses to start with `LIVE_TRADING_ENABLED=true`, and the database will not enable a live account without an administrator and an exchange explicitly marked eligible.

## Layout

```text
apps/
  api/              Fastify REST API (/api/v1)
  workers/
    market-data/    OKX collector: instrument sync, backfill, streams, gap repair, staleness
packages/
  shared-types/     Normalised market data, signal contract, exchange adapter interfaces, Decimal helpers
  config/           Environment parsing (fails closed on unsafe settings)
  logging/          pino logger with secret redaction
  database/         SQL migrations, migration runner, connection pool
  exchange-adapters/ OKX public REST + WebSocket adapter (market data only), rate limiter
  market-data/      Candle/trade/order book storage, gap detection, backfill, staleness monitor
```

Further workers and packages from PRD section 13.2 are added stage by stage.

## Local development

Requirements: Node 22, pnpm 10, Docker.

```bash
cp .env.example .env
docker compose up -d          # TimescaleDB (PostgreSQL 16) + Redis
pnpm install
pnpm db:migrate               # needs DATABASE_URL in the environment
pnpm dev:api                  # http://localhost:4000/api/v1/health
pnpm --filter @atrp/worker-market-data dev   # start collecting OKX data
```

## Tests

```bash
pnpm typecheck
TEST_DATABASE_URL=postgres://trading:trading@localhost:5432/trading_test pnpm test
```

Database tests drop and recreate the `public` schema of `TEST_DATABASE_URL`, so point it at a throwaway database. Without it they are skipped. CI runs them against TimescaleDB.

## Engineering rules

- Money is never a JavaScript `number`: prices, sizes and balances are `NUMERIC` in PostgreSQL and `Decimal` / decimal strings in TypeScript.
- All timestamps are UTC (`timestamptz`, sessions pinned to UTC).
- Simulated and live funds live in separate tables with no foreign key path between them.
- Strategy versions are immutable once written; changing parameters means a new version.
- Migrations are append-only: an edited, already-applied migration stops the migrator.
