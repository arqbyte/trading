import * as ind from "@atrp/indicators";
import { type Candle, Decimal, type DecimalString, toDecimalString } from "@atrp/shared-types";
import {
  type IndicatorDef,
  type Operand,
  type PriceSource,
  type QuoteField,
  type Rule,
  type StrategySpec,
  validateStrategy,
} from "@atrp/strategy-dsl";

export interface PositionView {
  /** Base asset held; "0" when flat. */
  quantity: DecimalString;
  averageEntryPrice?: DecimalString;
  /** Highest price since entry, maintained by the portfolio, for trailing stops. */
  highestPriceSinceEntry?: DecimalString;
}

/** Latest top-of-book quote, for strategies that use `quote` operands. */
export interface QuoteView {
  bid: DecimalString;
  bidSize: DecimalString;
  ask: DecimalString;
  askSize: DecimalString;
}

export interface Decision {
  action: "BUY" | "SELL" | "HOLD";
  reasoning: string;
  stopLoss?: DecimalString;
  takeProfit?: DecimalString;
}

type Lines = Record<string, ind.Out>;

/**
 * A validated, compiled strategy. Evaluation is a pure function of the
 * candle history and position, so the same inputs always give the same
 * decision (PRD 7.6).
 */
export class CompiledStrategy {
  readonly warmupBars: number;
  readonly hash: string;

  private constructor(
    readonly spec: StrategySpec,
    warmupBars: number,
    hash: string,
  ) {
    this.warmupBars = warmupBars;
    this.hash = hash;
  }

  static compile(input: unknown): CompiledStrategy {
    const result = validateStrategy(input);
    if (!result.ok) throw new Error(`Invalid strategy: ${result.errors.join("; ")}`);
    return new CompiledStrategy(result.spec, result.warmupBars, result.hash);
  }

  /** Decides on the latest candle in `candles` (oldest first, all closed). */
  evaluate(candles: readonly Candle[], position: PositionView, quote?: QuoteView): Decision {
    assertHistory(candles, this.spec.timeframe);
    if (candles.length < this.warmupBars) {
      return { action: "HOLD", reasoning: `warming up: ${candles.length}/${this.warmupBars} candles` };
    }

    const series = toSeries(candles);
    const lines = computeIndicators(this.spec.indicators, series);
    const last = candles.length - 1;
    const close = new Decimal(candles[last]!.close);
    const ctx: EvalContext = {
      series,
      lines,
      defs: new Map(this.spec.indicators.map((d) => [d.id, d])),
      i: last,
      quote: quote && quoteValues(quote),
    };
    const inPosition = new Decimal(position.quantity).gt(0);

    if (!inPosition) {
      const why: string[] = [];
      if (!evalRule(this.spec.entry, ctx, why)) return { action: "HOLD", reasoning: "entry conditions not met" };
      const { stopLossPercent, takeProfitPercent } = this.spec.risk;
      return {
        action: "BUY",
        reasoning: `entry: ${why.join("; ")}`,
        stopLoss: toDecimalString(close.mul(new Decimal(100).minus(stopLossPercent)).div(100)),
        ...(takeProfitPercent !== undefined && {
          takeProfit: toDecimalString(close.mul(new Decimal(100).plus(takeProfitPercent)).div(100)),
        }),
      };
    }

    const trail = this.spec.risk.trailingStopPercent;
    if (trail !== undefined && position.highestPriceSinceEntry !== undefined) {
      const peak = Decimal.max(position.highestPriceSinceEntry, candles[last]!.high);
      const stop = peak.mul(new Decimal(100).minus(trail)).div(100);
      if (close.lte(stop)) {
        return { action: "SELL", reasoning: `trailing stop: close ${close} <= ${stop} (${trail}% below peak ${peak})` };
      }
    }
    const why: string[] = [];
    if (evalRule(this.spec.exit, ctx, why)) return { action: "SELL", reasoning: `exit: ${why.join("; ")}` };
    return { action: "HOLD", reasoning: "in position; exit conditions not met" };
  }
}

function assertHistory(candles: readonly Candle[], timeframe: string): void {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    // Guards against look-ahead: a forming candle must never reach a strategy.
    if (!c.isClosed) throw new Error(`candle at ${c.timestamp} is not closed`);
    if (c.timeframe !== timeframe) throw new Error(`expected ${timeframe} candles, got ${c.timeframe}`);
    if (i > 0) {
      const prev = candles[i - 1]!;
      if (c.symbol !== prev.symbol) throw new Error("candles from more than one symbol");
      if (c.timestamp <= prev.timestamp) throw new Error("candles are not in ascending time order");
    }
  }
}

type SeriesSet = Record<PriceSource, number[]>;

function toSeries(candles: readonly Candle[]): SeriesSet {
  return {
    open: candles.map((c) => Number(c.open)),
    high: candles.map((c) => Number(c.high)),
    low: candles.map((c) => Number(c.low)),
    close: candles.map((c) => Number(c.close)),
    volume: candles.map((c) => Number(c.volume)),
  };
}

function computeIndicators(defs: readonly IndicatorDef[], s: SeriesSet): Map<string, Lines> {
  const out = new Map<string, Lines>();
  for (const d of defs) {
    switch (d.type) {
      case "SMA":
        out.set(d.id, { value: ind.sma(s[d.source], d.period) });
        break;
      case "EMA":
        out.set(d.id, { value: ind.ema(s[d.source], d.period) });
        break;
      case "RSI":
        out.set(d.id, { value: ind.rsi(s.close, d.period) });
        break;
      case "MACD":
        out.set(d.id, ind.macd(s.close, d.fast, d.slow, d.signal));
        break;
      case "BBANDS":
        out.set(d.id, ind.bollinger(s.close, d.period, d.stdDev));
        break;
      case "ATR":
        out.set(d.id, { value: ind.atr(s.high, s.low, s.close, d.period) });
        break;
      case "ADX":
        out.set(d.id, ind.adx(s.high, s.low, s.close, d.period));
        break;
      case "ROC":
        out.set(d.id, { value: ind.roc(s[d.source], d.period) });
        break;
      case "STDEV":
        out.set(d.id, { value: ind.stdev(s[d.source], d.period) });
        break;
      case "HIGHEST":
        out.set(d.id, { value: ind.highest(s[d.source], d.period) });
        break;
      case "LOWEST":
        out.set(d.id, { value: ind.lowest(s[d.source], d.period) });
        break;
    }
  }
  return out;
}

interface EvalContext {
  series: SeriesSet;
  lines: Map<string, Lines>;
  defs: Map<string, IndicatorDef>;
  i: number;
  quote: Record<QuoteField, number | undefined> | undefined;
}

function quoteValues(q: QuoteView): Record<QuoteField, number | undefined> {
  const bid = new Decimal(q.bid);
  const ask = new Decimal(q.ask);
  const mid = bid.plus(ask).div(2);
  const sizes = new Decimal(q.bidSize).plus(q.askSize);
  return {
    // A crossed or empty book is unusable, so the condition reads as false.
    spreadPercent: ask.lt(bid) || mid.lte(0) ? undefined : ask.minus(bid).div(mid).mul(100).toNumber(),
    imbalance: sizes.lte(0) ? undefined : new Decimal(q.bidSize).minus(q.askSize).div(sizes).toNumber(),
  };
}

function operandAt(o: Operand, ctx: EvalContext, back: number): number | undefined {
  if ("value" in o) return o.value;
  if ("quote" in o) return back === 0 ? ctx.quote?.[o.quote] : undefined;
  const idx = ctx.i - o.offset - back;
  if (idx < 0) return undefined;
  const raw = "price" in o ? ctx.series[o.price][idx] : ctx.lines.get(o.indicator)![o.field ?? "value"]?.[idx];
  return raw === undefined ? undefined : raw * (o.scale ?? 1);
}

function describe(o: Operand): string {
  if ("value" in o) return String(o.value);
  if ("quote" in o) return `quote.${o.quote}`;
  const base = "price" in o ? o.price : o.field ? `${o.indicator}.${o.field}` : o.indicator;
  const shifted = o.offset ? `${base}[-${o.offset}]` : base;
  return o.scale !== undefined && o.scale !== 1 ? `${o.scale}x ${shifted}` : shifted;
}

const fmt = (n: number) => (Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(6));

/** Missing data (warm-up) makes a condition false, never true. */
function evalRule(rule: Rule, ctx: EvalContext, why: string[]): boolean {
  if ("all" in rule) return rule.all.every((r) => evalRule(r, ctx, why));
  if ("any" in rule) return rule.any.some((r) => evalRule(r, ctx, why));
  if ("not" in rule) return !evalRule(rule.not, ctx, []);

  const l = operandAt(rule.left, ctx, 0);
  const r = operandAt(rule.right, ctx, 0);
  if (l === undefined || r === undefined) return false;
  let ok: boolean;
  switch (rule.op) {
    case "gt":
      ok = l > r;
      break;
    case "gte":
      ok = l >= r;
      break;
    case "lt":
      ok = l < r;
      break;
    case "lte":
      ok = l <= r;
      break;
    case "crossesAbove":
    case "crossesBelow": {
      const pl = operandAt(rule.left, ctx, 1);
      const pr = operandAt(rule.right, ctx, 1);
      if (pl === undefined || pr === undefined) return false;
      ok = rule.op === "crossesAbove" ? pl <= pr && l > r : pl >= pr && l < r;
      break;
    }
  }
  if (ok) why.push(`${describe(rule.left)} (${fmt(l)}) ${rule.op} ${describe(rule.right)} (${fmt(r)})`);
  return ok;
}
