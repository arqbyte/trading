import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, recreateDatabase, type Pool } from "@atrp/database";
import { seedBuiltinAgents } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("seedBuiltinAgents", () => {
  let pool: Pool;

  beforeAll(async () => {
    await recreateDatabase(url!);
    pool = createPool(url!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates six paused agents with immutable strategy versions, idempotently", async () => {
    const first = await seedBuiltinAgents(pool);
    expect(first).toHaveLength(6);
    expect(first.every((r) => r.created)).toBe(true);

    const second = await seedBuiltinAgents(pool);
    expect(second.some((r) => r.created)).toBe(false);
    expect(second.map((r) => r.versionId)).toEqual(first.map((r) => r.versionId));

    const { rows } = await pool.query("SELECT status, count(*)::int AS n FROM agents GROUP BY status");
    expect(rows).toEqual([{ status: "paused", n: 6 }]);
    const versions = await pool.query("SELECT count(*)::int AS n FROM strategy_versions WHERE author = 'builtin'");
    expect(versions.rows[0].n).toBe(6);
  });
});
