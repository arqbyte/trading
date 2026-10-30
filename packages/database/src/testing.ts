import pg from "pg";

/**
 * Drops and recreates the database named in `url`. Used by tests only.
 *
 * Recreating the database (rather than dropping the public schema) matters
 * with TimescaleDB: dropping the extension and creating it again in the same
 * backend fails, and a fresh database inherits the extension from template1.
 */
export async function recreateDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name) || !/test/i.test(name)) {
    throw new Error(`Refusing to recreate database "${name}": test database names must contain "test"`);
  }
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}
