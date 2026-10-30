import { createLogger } from "@atrp/logging";
import { migrate } from "./migrate.js";
import { createPool } from "./pool.js";

const log = createLogger("migrate");
const url = process.env.DATABASE_URL;
if (!url) {
  log.fatal("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const { applied, skipped } = await migrate(pool, { log: (m) => log.info(m) });
  log.info({ applied, alreadyApplied: skipped.length }, "migrations complete");
} catch (err) {
  log.fatal({ err }, "migration failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
