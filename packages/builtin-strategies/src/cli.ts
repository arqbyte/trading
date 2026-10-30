import { createPool, migrate } from "@atrp/database";
import { createLogger } from "@atrp/logging";
import { seedBuiltinAgents } from "./seed.js";

const log = createLogger("seed");
const url = process.env.DATABASE_URL;
if (!url) {
  log.fatal("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  await migrate(pool);
  const results = await seedBuiltinAgents(pool);
  for (const r of results) log.info({ slug: r.slug, created: r.created, versionId: r.versionId }, "built-in agent");
} catch (err) {
  log.fatal({ err }, "seeding failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
