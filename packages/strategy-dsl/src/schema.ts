import { z } from "zod";
import { TimeframeSchema } from "@atrp/shared-types";

/**
 * The strategy DSL (PRD 6.3, 6.4). A strategy is pure data: a list of
 * indicators and rule trees over them. There is no code, expression string
 * or function reference anywhere, so a strategy written by a research agent
 * cannot execute anything; it can only be interpreted by the engine.
 */

export const PriceSource = z.enum(["open", "high", "low", "close", "volume"]);
export type PriceSource = z.infer<typeof PriceSource>;

const id = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "ids are lowercase, start with a letter, max 32 chars");
const period = z.number().int().min(1).max(500);

export const IndicatorDef = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("SMA"), period, source: PriceSource.default("close") }).strict(),
  z.object({ id, type: z.literal("EMA"), period, source: PriceSource.default("close") }).strict(),
  z.object({ id, type: z.literal("RSI"), period: period.default(14) }).strict(),
  z
    .object({
      id,
      type: z.literal("MACD"),
      fast: period.default(12),
      slow: period.default(26),
      signal: period.default(9),
    })
    .strict(),
  z
    .object({ id, type: z.literal("BBANDS"), period: period.default(20), stdDev: z.number().min(0.1).max(5).default(2) })
    .strict(),
  z.object({ id, type: z.literal("ATR"), period: period.default(14) }).strict(),
  z.object({ id, type: z.literal("ADX"), period: period.default(14) }).strict(),
  z.object({ id, type: z.literal("ROC"), period, source: PriceSource.default("close") }).strict(),
  z.object({ id, type: z.literal("STDEV"), period, source: PriceSource.default("close") }).strict(),
  z.object({ id, type: z.literal("HIGHEST"), period, source: PriceSource.default("high") }).strict(),
  z.object({ id, type: z.literal("LOWEST"), period, source: PriceSource.default("low") }).strict(),
]);
export type IndicatorDef = z.infer<typeof IndicatorDef>;
export type IndicatorType = IndicatorDef["type"];

/** Output fields of multi-line indicators. Single-line indicators have "value". */
export const INDICATOR_FIELDS: Record<IndicatorType, readonly string[]> = {
  SMA: ["value"],
  EMA: ["value"],
  RSI: ["value"],
  MACD: ["macd", "signal", "histogram"],
  BBANDS: ["middle", "upper", "lower", "width"],
  ATR: ["value"],
  ADX: ["adx", "plusDI", "minusDI"],
  ROC: ["value"],
  STDEV: ["value"],
  HIGHEST: ["value"],
  LOWEST: ["value"],
};

/** Bars ago: 0 is the latest closed candle, 1 the one before, and so on. */
const offset = z.number().int().min(0).max(50).default(0);

/** Multiplies the operand, e.g. `volume > 1.5 x average volume`. */
const scale = z.number().positive().max(1000).optional();

/**
 * Live quote values at decision time (latest ticker, not candle history), so
 * they have no offset. Missing quote data makes the condition false.
 * - spreadPercent: (ask - bid) / mid * 100
 * - imbalance: (bidSize - askSize) / (bidSize + askSize), from -1 to 1
 */
export const QuoteField = z.enum(["spreadPercent", "imbalance"]);
export type QuoteField = z.infer<typeof QuoteField>;

export const Operand = z.union([
  z.object({ indicator: id, field: z.string().optional(), offset, scale }).strict(),
  z.object({ price: PriceSource, offset, scale }).strict(),
  z.object({ quote: QuoteField }).strict(),
  z.object({ value: z.number().finite() }).strict(),
]);
export type Operand = z.infer<typeof Operand>;

export const Comparison = z
  .object({ op: z.enum(["gt", "gte", "lt", "lte", "crossesAbove", "crossesBelow"]), left: Operand, right: Operand })
  .strict();
export type Comparison = z.infer<typeof Comparison>;

export type Rule = Comparison | { all: Rule[] } | { any: Rule[] } | { not: Rule };
export const Rule: z.ZodType<Rule> = z.lazy(() =>
  z.union([
    Comparison,
    z.object({ all: z.array(Rule).min(1).max(20) }).strict(),
    z.object({ any: z.array(Rule).min(1).max(20) }).strict(),
    z.object({ not: Rule }).strict(),
  ]),
);

export const RiskSpec = z
  .object({
    /** Required: every strategy must define a stop-loss (PRD 8.2 step 8). */
    stopLossPercent: z.number().min(0.1).max(50),
    takeProfitPercent: z.number().min(0.1).max(500).optional(),
    trailingStopPercent: z.number().min(0.1).max(50).optional(),
  })
  .strict();

export const StrategySpec = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(100),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver x.y.z"),
    description: z.string().max(2000).default(""),
    market: z.literal("spot"),
    timeframe: TimeframeSchema,
    /** Restricts the strategy to these symbols; omitted means the experiment universe. */
    symbols: z.array(z.string().regex(/^[A-Z0-9]+\/[A-Z0-9]+$/)).min(1).max(50).optional(),
    indicators: z.array(IndicatorDef).max(20),
    entry: Rule,
    exit: Rule,
    risk: RiskSpec,
  })
  .strict();

export type StrategySpec = z.infer<typeof StrategySpec>;
export type StrategySpecInput = z.input<typeof StrategySpec>;
