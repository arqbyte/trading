import { pino, type Logger, type LoggerOptions } from "pino";

/**
 * Keys that must never reach logs (PRD 11.3). Matched at the top level and one
 * level down, which covers request headers and config objects.
 */
const SECRET_KEYS = [
  "apiKey",
  "api_key",
  "secret",
  "secretKey",
  "passphrase",
  "password",
  "authorization",
  "cookie",
  "ciphertext",
  "DATABASE_URL",
];

export const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`]);

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    ...options,
  });
}

export type { Logger };
