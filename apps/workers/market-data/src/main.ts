import { z } from "zod";
import { loadConfig } from "@atrp/config";
import { createPool, migrate } from "@atrp/database";
import { MarketEventPublisher, Redis } from "@atrp/event-bus";
import { OkxMarketDataAdapter } from "@atrp/exchange-adapters";
import { createLogger } from "@atrp/logging";
import { MarketDataStore } from "@atrp/market-data";
import { TIMEFRAMES, TimeframeSchema } from "@atrp/shared-types";
import { MarketDataCollector } from "./collector.js";

const env = z
  .object({
    MARKET_DATA_TIMEFRAMES: z
      .string()
      .default(TIMEFRAMES.join(","))
      .transform((s) => s.split(",").map((t) => TimeframeSchema.parse(t.trim()))),
    MARKET_DATA_BACKFILL_CANDLES: z.coerce.number().int().min(1).max(10_000).default(500),
    MARKET_DATA_STALE_AFTER_MS: z.coerce.number().int().min(1000).default(15_000),
    MARKET_DATA_ORDERBOOK_SNAPSHOT_MS: z.coerce.number().int().min(100).default(5_000),
    MARKET_DATA_GAP_SWEEP_MS: z.coerce.number().int().min(10_000).default(300_000),
  })
  .parse(process.env);

const config = loadConfig();
const log = createLogger("market-data");
const pool = createPool(config.DATABASE_URL);
await migrate(pool, { log: (m) => log.info(m) });
const redis = new Redis(config.REDIS_URL);
const publisher = new MarketEventPublisher(redis);

let collector: MarketDataCollector | undefined;
const adapter = new OkxMarketDataAdapter({ onStreamEvent: (e) => collector?.handleStreamEvent(e) });
collector = new MarketDataCollector(adapter, new MarketDataStore(pool), log, {
  timeframes: env.MARKET_DATA_TIMEFRAMES,
  backfillCandles: env.MARKET_DATA_BACKFILL_CANDLES,
  staleAfterMs: env.MARKET_DATA_STALE_AFTER_MS,
  orderBookSnapshotMs: env.MARKET_DATA_ORDERBOOK_SNAPSHOT_MS,
  gapSweepMs: env.MARKET_DATA_GAP_SWEEP_MS,
  publish: (event) => publisher.publish(event),
});

await collector.start();
log.info("market data collector running");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    await collector?.stop();
    await pool.end();
    await redis.quit();
    process.exit(0);
  });
}
