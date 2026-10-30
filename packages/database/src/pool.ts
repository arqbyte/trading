import pg from "pg";

/**
 * Creates a connection pool whose sessions always run in UTC. NUMERIC values
 * come back as strings (pg's default), which callers parse with Decimal.
 */
export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, options: "-c timezone=UTC" });
  return pool;
}

export type { Pool, PoolClient } from "pg";
