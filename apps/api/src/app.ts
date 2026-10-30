import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "@atrp/database";

export interface AppDeps {
  pool: Pool;
}

export function buildApp({ pool }: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/api/v1/health", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "degraded", database: "unreachable" });
    }
  });

  // Live execution is not part of the MVP. This endpoint exists so the
  // dashboard can show the state explicitly rather than infer it.
  app.get("/api/v1/live/status", async () => ({
    enabled: false,
    available: false,
    reason: "Live execution is not implemented in this build and is disabled by default.",
  }));

  return app;
}
