import { z } from "zod";

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LIVE_TRADING_ENABLED: booleanFlag,
});

export type AppConfig = Omit<z.infer<typeof EnvSchema>, "LIVE_TRADING_ENABLED"> & {
  /** Always false in this build: live execution is not implemented. */
  LIVE_TRADING_ENABLED: false;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (parsed.data.LIVE_TRADING_ENABLED) {
    // Fail closed rather than silently ignoring the flag (PRD 11.4, 19).
    throw new Error(
      "LIVE_TRADING_ENABLED=true is not allowed: live execution is not available in this build " +
        "and must be activated through the administrator approval workflow once it exists.",
    );
  }
  return { ...parsed.data, LIVE_TRADING_ENABLED: false };
}
