import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    const config = loadConfig(base);
    expect(config.LIVE_TRADING_ENABLED).toBe(false);
    expect(config.API_PORT).toBe(4000);
  });

  it("refuses to start with live trading enabled", () => {
    expect(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: "true" })).toThrow(/not allowed/);
  });

  it("requires a database URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
