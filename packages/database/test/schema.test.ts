import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, recreateDatabase, type Pool } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("database schema", () => {
  let pool: Pool;

  beforeAll(async () => {
    await recreateDatabase(url!);
    pool = createPool(url!);
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await pool.query<T>(sql, params)).rows;

  async function fixture() {
    const [admin] = await q<{ id: string }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
      [`admin-${crypto.randomUUID()}@example.com`],
    );
    const [strategy] = await q<{ id: string }>(
      "INSERT INTO strategies (slug, name, created_by) VALUES ($1, 'Momentum', 'builtin') RETURNING id",
      [`momentum-${crypto.randomUUID().slice(0, 8)}`],
    );
    const [version] = await q<{ id: string }>(
      `INSERT INTO strategy_versions (strategy_id, version, spec, spec_hash, author)
       VALUES ($1, '1.0.0', '{"timeframe":"15m"}', 'hash-1', 'builtin') RETURNING id`,
      [strategy!.id],
    );
    const [agent] = await q<{ id: string }>(
      "INSERT INTO agents (slug, name, strategy_id) VALUES ($1, 'Agent A', $2) RETURNING id",
      [`agent-${crypto.randomUUID().slice(0, 8)}`, strategy!.id],
    );
    const [experiment] = await q<{ id: string }>(
      `INSERT INTO experiments (name, market_universe, starting_capital, simulation_config, risk_config)
       VALUES ('Test', ARRAY['BTC/USDT'], 1000, '{}', '{}') RETURNING id`,
    );
    const [participant] = await q<{ id: string }>(
      "INSERT INTO experiment_agents (experiment_id, agent_id, strategy_version_id) VALUES ($1, $2, $3) RETURNING id",
      [experiment!.id, agent!.id, version!.id],
    );
    const [account] = await q<{ id: string }>(
      "INSERT INTO simulated_accounts (experiment_agent_id, quote_asset, starting_balance) VALUES ($1, 'USDT', 1000) RETURNING id",
      [participant!.id],
    );
    return {
      adminId: admin!.id,
      strategyId: strategy!.id,
      versionId: version!.id,
      agentId: agent!.id,
      experimentId: experiment!.id,
      participantId: participant!.id,
      accountId: account!.id,
    };
  }

  it("is idempotent when migrations run again", async () => {
    const result = await migrate(pool);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses to run a migration that was edited after being applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "migrations-"));
    await writeFile(join(dir, "0001_initial_schema.sql"), "SELECT 1;");
    await expect(migrate(pool, { dir })).rejects.toThrow(/modified after being applied/);
  });

  it("seeds OKX as market data only, with the initial five pairs", async () => {
    const [okx] = await q("SELECT supports_market_data, live_trading_eligible FROM exchanges WHERE id = 'okx'");
    expect(okx).toEqual({ supports_market_data: true, live_trading_eligible: false });
    const pairs = await q<{ symbol: string }>("SELECT symbol FROM instruments ORDER BY symbol");
    expect(pairs.map((p) => p.symbol)).toEqual(["BTC/USDT", "DOGE/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"]);
  });

  it("stores prices as exact decimals", async () => {
    await q(
      `INSERT INTO market_candles (exchange_id, symbol, timeframe, ts, open, high, low, close, volume, is_closed, source)
       VALUES ('okx', 'BTC/USDT', '1m', '2026-10-30T00:00:00Z', '0.1', '0.30000000000000000001', '0.1', '0.2', '12.5', true, 'rest')`,
    );
    const [row] = await q<{ high: string; ts: Date }>(
      "SELECT high, ts FROM market_candles WHERE symbol = 'BTC/USDT' AND timeframe = '1m'",
    );
    expect(row!.high).toBe("0.30000000000000000001");
    expect(row!.ts.toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });

  it("rejects candles with impossible OHLC values and unknown timeframes", async () => {
    await expect(
      q(`INSERT INTO market_candles (exchange_id, symbol, timeframe, ts, open, high, low, close, volume, is_closed, source)
         VALUES ('okx', 'ETH/USDT', '1m', now(), 10, 9, 8, 9, 1, true, 'rest')`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      q(`INSERT INTO market_candles (exchange_id, symbol, timeframe, ts, open, high, low, close, volume, is_closed, source)
         VALUES ('okx', 'ETH/USDT', '2m', now(), 1, 1, 1, 1, 1, true, 'rest')`),
    ).rejects.toThrow(/check constraint/);
  });

  it("keeps strategy versions immutable but lets validation status move", async () => {
    const { versionId } = await fixture();
    await expect(
      q("UPDATE strategy_versions SET parameters = '{\"period\":21}' WHERE id = $1", [versionId]),
    ).rejects.toThrow(/immutable/);
    await expect(q("DELETE FROM strategy_versions WHERE id = $1", [versionId])).rejects.toThrow(/cannot be deleted/);
    await q("UPDATE strategy_versions SET validation_status = 'approved' WHERE id = $1", [versionId]);
  });

  it("fixes a participant's strategy version and blocks joining a frozen experiment", async () => {
    const f = await fixture();
    const [other] = await q<{ id: string }>(
      `INSERT INTO strategy_versions (strategy_id, version, spec, spec_hash, author)
       VALUES ($1, '1.1.0', '{"timeframe":"1h"}', 'hash-2', 'builtin') RETURNING id`,
      [f.strategyId],
    );
    await expect(
      q("UPDATE experiment_agents SET strategy_version_id = $1 WHERE id = $2", [other!.id, f.participantId]),
    ).rejects.toThrow(/cannot change strategy version/);

    await q("UPDATE experiments SET versions_frozen_at = now() WHERE id = $1", [f.experimentId]);
    const [lateAgent] = await q<{ id: string }>(
      "INSERT INTO agents (slug, name, strategy_id) VALUES ($1, 'Late', $2) RETURNING id",
      [`late-${crypto.randomUUID().slice(0, 8)}`, f.strategyId],
    );
    await expect(
      q("INSERT INTO experiment_agents (experiment_id, agent_id, strategy_version_id) VALUES ($1, $2, $3)", [
        f.experimentId,
        lateAgent!.id,
        other!.id,
      ]),
    ).rejects.toThrow(/frozen/);
  });

  it("forbids negative simulated balances (no shorting)", async () => {
    const { accountId } = await fixture();
    await q("INSERT INTO simulated_balances (account_id, asset, free) VALUES ($1, 'USDT', 1000)", [accountId]);
    await expect(
      q("UPDATE simulated_balances SET free = free - 1000.01 WHERE account_id = $1", [accountId]),
    ).rejects.toThrow(/check constraint/);
  });

  it("deduplicates simulated orders by client order id", async () => {
    const { accountId } = await fixture();
    const insert = () =>
      q(
        `INSERT INTO simulated_orders (account_id, client_order_id, symbol, side, type, status, quantity, execution_model_version)
         VALUES ($1, 'sig-123', 'BTC/USDT', 'buy', 'market', 'pending', '0.001', 'v1')`,
        [accountId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it("cannot attach a live order to a simulated account", async () => {
    const { accountId, versionId } = await fixture();
    await expect(
      q(
        `INSERT INTO live_orders (live_account_id, strategy_version_id, client_order_id, symbol, side, type, status, quantity)
         VALUES ($1, $2, 'x', 'BTC/USDT', 'buy', 'market', 'pending', 1)`,
        [accountId, versionId],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("keeps live accounts disabled unless an admin enables them on an eligible exchange", async () => {
    const { adminId } = await fixture();
    const [cred] = await q<{ id: string }>(
      `INSERT INTO exchange_credentials (exchange_id, label, ciphertext, nonce, key_version, permissions)
       VALUES ('okx', 'main', '\\x00', '\\x00', 1, ARRAY['read','trade']) RETURNING id`,
    );
    const [live] = await q<{ id: string; enabled: boolean }>(
      "INSERT INTO live_accounts (exchange_id, credential_id, label, quote_asset, capital_limit) VALUES ('okx', $1, 'live', 'USDT', 50) RETURNING id, enabled",
      [cred!.id],
    );
    expect(live!.enabled).toBe(false);

    await expect(
      q("UPDATE live_accounts SET enabled = true, enabled_by = $2, enabled_at = now() WHERE id = $1", [
        live!.id,
        adminId,
      ]),
    ).rejects.toThrow(/not eligible for live trading/);

    // Even on an eligible exchange, enabling needs a named administrator.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE exchanges SET live_trading_eligible = true WHERE id = 'okx'");
      await expect(client.query("UPDATE live_accounts SET enabled = true WHERE id = $1", [live!.id])).rejects.toThrow(
        /check constraint/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("never stores credentials with withdrawal permission", async () => {
    await expect(
      q(
        `INSERT INTO exchange_credentials (exchange_id, label, ciphertext, nonce, key_version, permissions)
         VALUES ('okx', 'bad', '\\x00', '\\x00', 1, ARRAY['trade','withdraw'])`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("keeps the audit log append-only", async () => {
    const [row] = await q<{ id: string }>(
      "INSERT INTO audit_logs (actor_type, actor_id, action) VALUES ('system', 'test', 'noop') RETURNING id",
    );
    await expect(q("UPDATE audit_logs SET action = 'x' WHERE id = $1", [row!.id])).rejects.toThrow(/append-only/);
    await expect(q("DELETE FROM audit_logs WHERE id = $1", [row!.id])).rejects.toThrow(/append-only/);
  });

  it("requires risk events to name exactly one kind of account", async () => {
    const { accountId } = await fixture();
    await q(
      "INSERT INTO risk_events (account_kind, simulated_account_id, severity, kind) VALUES ('simulated', $1, 'warning', 'exposure')",
      [accountId],
    );
    await expect(
      q("INSERT INTO risk_events (account_kind, simulated_account_id, severity, kind) VALUES ('live', $1, 'warning', 'x')", [
        accountId,
      ]),
    ).rejects.toThrow(/check constraint/);
  });
});
