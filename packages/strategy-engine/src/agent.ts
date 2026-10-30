import { type Candle, TIMEFRAME_MS, type Timeframe, type TradingSignal, TradingSignalSchema } from "@atrp/shared-types";
import { CompiledStrategy, type PositionView, type QuoteView } from "./evaluate.js";

/**
 * Everything an agent sees when a candle closes (PRD 5.1). It is read-only
 * and holds only this agent's own position; agents never see other agents'
 * portfolios and never place orders.
 */
export interface AgentContext {
  readonly symbol: string;
  readonly candles: readonly Candle[];
  readonly position: Readonly<PositionView>;
  /** Latest top-of-book quote, when the feed is fresh. */
  readonly quote?: Readonly<QuoteView>;
  /** UTC epoch ms at which the decision is made. */
  readonly now: number;
}

/** The contract every strategy agent implements (PRD 5.2). */
export interface StrategyAgent {
  readonly agentId: string;
  readonly strategyVersion: string;
  readonly timeframe: Timeframe;
  /** Closed candles needed before the agent can decide. */
  readonly warmupBars: number;
  /** Symbols the agent trades; undefined means the whole experiment universe. */
  readonly symbols?: readonly string[];
  onCandle(ctx: AgentContext): TradingSignal;
}

/** Runs a DSL strategy as an agent. */
export class DslStrategyAgent implements StrategyAgent {
  readonly strategyVersion: string;
  readonly timeframe: Timeframe;
  readonly warmupBars: number;
  readonly symbols?: readonly string[];
  private readonly strategy: CompiledStrategy;

  constructor(
    readonly agentId: string,
    spec: unknown,
  ) {
    this.strategy = CompiledStrategy.compile(spec);
    this.strategyVersion = this.strategy.spec.version;
    this.timeframe = this.strategy.spec.timeframe;
    this.warmupBars = this.strategy.warmupBars;
    if (this.strategy.spec.symbols) this.symbols = this.strategy.spec.symbols;
  }

  onCandle(ctx: AgentContext): TradingSignal {
    const d = this.strategy.evaluate(ctx.candles, ctx.position, ctx.quote);
    return {
      agentId: this.agentId,
      strategyVersion: this.strategyVersion,
      symbol: ctx.symbol,
      action: d.action,
      // Rule-based strategies have no graded confidence; it is informational only.
      confidence: d.action === "HOLD" ? 0 : 1,
      ...(d.stopLoss !== undefined && { stopLoss: d.stopLoss }),
      ...(d.takeProfit !== undefined && { takeProfit: d.takeProfit }),
      timeframe: this.timeframe,
      reasoning: d.reasoning,
      timestamp: ctx.now,
    };
  }
}

export type SignalCheck = { ok: true; signal: TradingSignal } | { ok: false; reason: string };

/**
 * Validates whatever an agent returned before anything else looks at it
 * (PRD 8.2 step 1). Agents are untrusted: the signal must parse, and must
 * be about the agent, version, symbol and moment it was asked about.
 */
export function checkSignal(
  raw: unknown,
  expected: { agentId: string; strategyVersion: string; symbol: string; timeframe: Timeframe; now: number },
): SignalCheck {
  const parsed = TradingSignalSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `invalid signal: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  const s = parsed.data;
  if (s.agentId !== expected.agentId) return { ok: false, reason: `signal claims agent ${s.agentId}` };
  if (s.strategyVersion !== expected.strategyVersion) return { ok: false, reason: `signal claims version ${s.strategyVersion}` };
  if (s.symbol !== expected.symbol) return { ok: false, reason: `signal is for ${s.symbol}, asked about ${expected.symbol}` };
  if (s.timeframe !== expected.timeframe) return { ok: false, reason: `signal timeframe ${s.timeframe} != ${expected.timeframe}` };
  if (s.timestamp !== expected.now) return { ok: false, reason: "signal timestamp does not match the decision time" };
  return { ok: true, signal: s };
}

/**
 * Rolling window of closed candles for one symbol and timeframe. Rejects
 * forming candles, duplicates and anything out of order, and reports gaps
 * so the caller can reload from the database.
 */
export class CandleHistory {
  private readonly candles: Candle[] = [];

  constructor(
    readonly symbol: string,
    readonly timeframe: Timeframe,
    private readonly maxLength: number,
  ) {}

  get length(): number {
    return this.candles.length;
  }

  /** Read-only snapshot, safe to hand to an agent. */
  snapshot(): readonly Candle[] {
    return Object.freeze(this.candles.map((c) => Object.freeze({ ...c })));
  }

  /** Returns "gap" when the candle does not directly follow the last one. */
  push(c: Candle): "appended" | "duplicate" | "gap" {
    if (!c.isClosed) throw new Error("only closed candles can enter history");
    if (c.symbol !== this.symbol || c.timeframe !== this.timeframe) throw new Error("candle for a different series");
    const last = this.candles.at(-1);
    if (last && c.timestamp <= last.timestamp) return "duplicate";
    const gap = last !== undefined && c.timestamp - last.timestamp !== TIMEFRAME_MS[this.timeframe];
    this.candles.push(c);
    if (this.candles.length > this.maxLength) this.candles.splice(0, this.candles.length - this.maxLength);
    return gap ? "gap" : "appended";
  }

  /** Replaces the window, e.g. after loading history from the database. */
  reset(candles: readonly Candle[]): void {
    this.candles.length = 0;
    for (const c of candles) this.push(c);
  }
}
