import { createHash } from "node:crypto";
import { INDICATOR_FIELDS, type IndicatorDef, type Operand, type Rule, StrategySpec } from "./schema.js";

export const MAX_WARMUP_BARS = 1000;
const MAX_RULE_DEPTH = 6;
const MAX_CONDITIONS = 50;

export type ValidationResult =
  | { ok: true; spec: StrategySpec; warmupBars: number; hash: string }
  | { ok: false; errors: string[] };

/** Bars of history an indicator needs before it produces values. */
export function indicatorLookback(def: IndicatorDef): number {
  switch (def.type) {
    case "MACD":
      return def.slow + def.signal;
    case "RSI":
    case "ATR":
    case "ROC":
      return def.period + 1;
    case "ADX":
      return def.period * 2 + 1;
    default:
      return def.period;
  }
}

/**
 * Validates a strategy specification: schema, then semantics (indicator
 * references, fields, rule size, warm-up length). Nothing in a spec is ever
 * executed, so this is the complete static check (PRD 6.4 steps 1-4).
 */
export function validateStrategy(input: unknown): ValidationResult {
  const parsed = StrategySpec.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const spec = parsed.data;
  const errors: string[] = [];
  const byId = new Map<string, IndicatorDef>();
  for (const def of spec.indicators) {
    if (byId.has(def.id)) errors.push(`indicators: duplicate id "${def.id}"`);
    byId.set(def.id, def);
    if (def.type === "MACD" && def.fast >= def.slow) errors.push(`indicators.${def.id}: fast must be shorter than slow`);
  }

  let conditions = 0;
  let maxOffset = 0;
  const used = new Set<string>();

  const checkOperand = (o: Operand, path: string) => {
    if ("indicator" in o) {
      const def = byId.get(o.indicator);
      if (!def) return errors.push(`${path}: unknown indicator "${o.indicator}"`);
      used.add(o.indicator);
      const fields = INDICATOR_FIELDS[def.type];
      const field = o.field ?? (fields.length === 1 ? "value" : undefined);
      if (!field) errors.push(`${path}: ${def.type} needs a field (${fields.join(", ")})`);
      else if (!fields.includes(field)) errors.push(`${path}: ${def.type} has no field "${field}" (${fields.join(", ")})`);
      maxOffset = Math.max(maxOffset, o.offset);
    } else if ("price" in o) {
      maxOffset = Math.max(maxOffset, o.offset);
    }
  };

  const walk = (rule: Rule, path: string, depth: number) => {
    if (depth > MAX_RULE_DEPTH) return errors.push(`${path}: rules nest deeper than ${MAX_RULE_DEPTH}`);
    if ("all" in rule) return rule.all.forEach((r, i) => walk(r, `${path}.all[${i}]`, depth + 1));
    if ("any" in rule) return rule.any.forEach((r, i) => walk(r, `${path}.any[${i}]`, depth + 1));
    if ("not" in rule) return walk(rule.not, `${path}.not`, depth + 1);
    conditions++;
    checkOperand(rule.left, `${path}.left`);
    checkOperand(rule.right, `${path}.right`);
    if ("value" in rule.left && "value" in rule.right) errors.push(`${path}: compares two constants`);
    if ((rule.op === "crossesAbove" || rule.op === "crossesBelow") && "value" in rule.left) {
      errors.push(`${path}: the left side of a cross must change over time`);
    }
  };

  walk(spec.entry, "entry", 0);
  walk(spec.exit, "exit", 0);
  if (conditions > MAX_CONDITIONS) errors.push(`rules: ${conditions} conditions exceed the limit of ${MAX_CONDITIONS}`);
  for (const def of spec.indicators) {
    if (!used.has(def.id)) errors.push(`indicators.${def.id}: defined but never used`);
  }

  // +1 so crosses can always look at the previous bar.
  const lookback = Math.max(1, ...spec.indicators.map(indicatorLookback));
  const warmupBars = lookback + maxOffset + 1;
  if (warmupBars > MAX_WARMUP_BARS) errors.push(`needs ${warmupBars} bars of history; the limit is ${MAX_WARMUP_BARS}`);

  const { takeProfitPercent: tp, stopLossPercent: sl } = spec.risk;
  if (tp !== undefined && tp <= sl * 0.5) errors.push("risk: take-profit is less than half the stop-loss distance");

  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec, warmupBars, hash: specHash(spec) };
}

/** JSON with sorted keys, so equal specs always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash of the trading logic. Name, version and description do not count. */
export function specHash(spec: StrategySpec): string {
  const { name: _n, version: _v, description: _d, ...logic } = spec;
  return createHash("sha256").update(canonicalJson(logic)).digest("hex");
}
