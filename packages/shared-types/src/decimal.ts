import { Decimal as DecimalJs } from "decimal.js";

/**
 * All financial arithmetic goes through this Decimal clone, never through
 * JavaScript numbers (PRD 14.2). Precision is far above anything an exchange
 * reports so intermediate results never lose digits; rounding to instrument
 * precision is an explicit, separate step.
 */
export const Decimal = DecimalJs.clone({
  precision: 40,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;

/** A base-10 number serialised as a string, e.g. "0.00012345". */
export type DecimalString = string & { readonly __decimal: unique symbol };

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

/** Parses exchange text (or a Decimal) into a canonical DecimalString. */
export function toDecimalString(value: string | Decimal): DecimalString {
  const d = typeof value === "string" ? parseDecimal(value) : value;
  if (!d.isFinite()) throw new Error(`Non-finite decimal: ${d.toString()}`);
  return d.toFixed() as DecimalString;
}

export function parseDecimal(value: string): Decimal {
  const trimmed = value.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal: ${JSON.stringify(value)}`);
  }
  return new Decimal(trimmed);
}

/** Rounds down to a step size such as an instrument's lot or tick size. */
export function floorToStep(value: Decimal, step: Decimal): Decimal {
  if (step.lte(0)) throw new Error("Step must be positive");
  return value.div(step).floor().mul(step);
}
