import { describe, expect, it } from "vitest";
import type { Pool } from "@atrp/database";
import { buildApp } from "../src/app.js";

const fakePool = (ok: boolean) =>
  ({ query: async () => (ok ? { rows: [] } : Promise.reject(new Error("down"))) }) as unknown as Pool;

describe("api", () => {
  it("reports healthy when the database answers", async () => {
    const res = await buildApp({ pool: fakePool(true) }).inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("reports degraded when the database is down", async () => {
    const res = await buildApp({ pool: fakePool(false) }).inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(503);
  });

  it("reports live trading as disabled", async () => {
    const res = await buildApp({ pool: fakePool(true) }).inject({ method: "GET", url: "/api/v1/live/status" });
    expect(res.json()).toMatchObject({ enabled: false, available: false });
  });
});
