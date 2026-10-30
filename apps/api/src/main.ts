import { loadConfig } from "@atrp/config";
import { createPool, migrate } from "@atrp/database";
import { createLogger } from "@atrp/logging";
import { buildApp } from "./app.js";

const config = loadConfig();
const log = createLogger("api");
const pool = createPool(config.DATABASE_URL);

await migrate(pool, { log: (m) => log.info(m) });

const app = buildApp({ pool });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
log.info({ port: config.API_PORT }, "api listening");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
