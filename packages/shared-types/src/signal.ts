import { z } from "zod";
import { TimeframeSchema } from "./market.js";
import { isDecimalString } from "./decimal.js";

const decimal = z.string().refine(isDecimalString, "must be a decimal string");
const positiveDecimal = decimal.refine((v) => !v.startsWith("-") && /[1-9]/.test(v), "must be positive");

/**
 * The only thing a strategy agent can produce (PRD 5.2). Agents never place
 * orders; the execution engine sizes orders independently, and `confidence`
 * is informational only.
 */
export const TradingSignalSchema = z
  .object({
    agentId: z.string().min(1),
    strategyVersion: z.string().min(1),
    symbol: z.string().regex(/^[A-Z0-9]+\/[A-Z0-9]+$/, "symbol must be BASE/QUOTE"),
    action: z.enum(["BUY", "SELL", "HOLD"]),
    confidence: z.number().min(0).max(1),
    suggestedPrice: positiveDecimal.optional(),
    suggestedSize: positiveDecimal.optional(),
    stopLoss: positiveDecimal.optional(),
    takeProfit: positiveDecimal.optional(),
    timeframe: TimeframeSchema,
    reasoning: z.string().max(4000),
    timestamp: z.number().int().positive(),
  })
  .strict();

export type TradingSignal = z.infer<typeof TradingSignalSchema>;
