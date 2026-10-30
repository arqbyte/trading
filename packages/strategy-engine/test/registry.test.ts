import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, recreateDatabase, type Pool } from "@atrp/database";
import type { StrategySpecInput } from "@atrp/strategy-dsl";
import { StrategyRegistry, StrategyValidationError } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;

const spec: StrategySpecInput = {
  schemaVersion: 1,
  name: "RSI dip",
  version: "1.0.0",
  market: "spot",
  timeframe: "15m",
  indicators: [{ id: "rsi", type: "RSI" }],
  entry: { op: "lt", left: { indicator: "rsi" }, right: { value: 30 } },
  exit: { op: "gt", left: { indicator: "rsi" }, right: { value: 55 } },
  risk: { stopLossPercent: 2 },
};

describe.skipIf(!url)("StrategyRegistry", () => {
  let pool: Pool;
  let registry: StrategyRegistry;

  beforeAll(async () => {
    await recreateDatabase(url!);
    pool = createPool(url!);
    await migrate(pool);
    registry = new StrategyRegistry(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("stores validated, immutable versions", async () => {
    const strategyId = await registry.createStrategy({ slug: "rsi-dip", name: "RSI dip", createdBy: "builtin" });
    const v1 = await registry.registerVersion(strategyId, spec, "builtin");
    expect(v1).toMatchObject({ version: "1.0.0", validationStatus: "valid" });
    expect(v1.spec.indicators[0]).toEqual({ id: "rsi", type: "RSI", period: 14 });

    // Same logic under a new version number is refused.
    await expect(registry.registerVersion(strategyId, { ...spec, version: "1.0.1" }, "builtin")).rejects.toThrow(
      /identical to existing version 1.0.0/,
    );

    const v2 = await registry.registerVersion(
      strategyId,
      { ...spec, version: "1.1.0", entry: { op: "lt", left: { indicator: "rsi" }, right: { value: 25 } } },
      "researcher:strategy_optimiser",
    );
    expect((await registry.listVersions(strategyId)).map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
    expect((await registry.getVersion(v2.id))?.author).toBe("researcher:strategy_optimiser");

    await expect(
      pool.query("UPDATE strategy_versions SET spec = '{}' WHERE id = $1", [v1.id]),
    ).rejects.toThrow(/immutable/);
  });

  it("refuses invalid specs with readable errors", async () => {
    const strategyId = await registry.createStrategy({ slug: "broken", name: "Broken", createdBy: "builtin" });
    const err = await registry.registerVersion(strategyId, { ...spec, risk: {} }, "x").catch((e) => e);
    expect(err).toBeInstanceOf(StrategyValidationError);
    expect((err as StrategyValidationError).errors.join()).toContain("stopLossPercent");
  });
});
