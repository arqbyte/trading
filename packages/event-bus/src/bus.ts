import { Redis } from "ioredis";
import { FeedStatusEvent, MarketEvent, STREAMS, TickerEvent, eventKey } from "./events.js";

export interface MarketEventBusOptions {
  /** Approximate cap per stream; old entries are trimmed. */
  maxLen?: number;
}

const MAX_LEN: Record<MarketEvent["type"], number> = {
  "candle.closed": 100_000,
  ticker: 50_000,
  orderbook: 20_000,
  "feed.status": 10_000,
};

const latestKey = (kind: "ticker" | "status", exchange: string, symbol: string) => `md:latest:${kind}:${exchange}:${symbol}`;

/**
 * Publishes market events to Redis Streams and keeps the latest ticker and
 * feed status per symbol in plain keys, so services can check freshness
 * without reading the stream.
 */
export class MarketEventPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly opts: MarketEventBusOptions = {},
  ) {}

  async publish(event: MarketEvent): Promise<string> {
    const parsed = MarketEvent.parse(event);
    const stream = STREAMS[parsed.type];
    const maxLen = this.opts.maxLen ?? MAX_LEN[parsed.type];
    const payload = JSON.stringify(parsed);
    const multi = this.redis.multi();
    multi.xadd(stream, "MAXLEN", "~", maxLen, "*", "key", eventKey(parsed), "event", payload);
    if (parsed.type === "ticker") multi.set(latestKey("ticker", parsed.exchange, parsed.symbol), payload);
    if (parsed.type === "feed.status") multi.set(latestKey("status", parsed.exchange, parsed.symbol), payload);
    const results = await multi.exec();
    const [err, id] = results?.[0] ?? [new Error("no result"), null];
    if (err) throw err;
    return id as string;
  }
}

export interface ConsumedEvent {
  id: string;
  stream: string;
  event: MarketEvent;
}

export interface ConsumerOptions {
  group: string;
  consumer: string;
  types: MarketEvent["type"][];
  /** Where a new group starts: "$" (only new events) or "0" (full history). */
  startFrom?: "$" | "0";
  blockMs?: number;
  count?: number;
}

/**
 * Reads market events through a Redis consumer group. Each group gets every
 * event once; events are acknowledged only after the handler succeeds, so a
 * crashed consumer picks its pending events up again on restart.
 */
export class MarketEventConsumer {
  private running = false;
  private readonly streams: string[];

  constructor(
    private readonly redis: Redis,
    private readonly opts: ConsumerOptions,
    private readonly onInvalid: (raw: string, error: unknown) => void = () => {},
  ) {
    this.streams = opts.types.map((t) => STREAMS[t]);
  }

  async init(): Promise<void> {
    for (const stream of this.streams) {
      try {
        await this.redis.xgroup("CREATE", stream, this.opts.group, this.opts.startFrom ?? "$", "MKSTREAM");
      } catch (err) {
        if (!String(err).includes("BUSYGROUP")) throw err;
      }
    }
  }

  /**
   * Reads one batch: first anything delivered to this consumer but never
   * acknowledged, then new events. Returns how many events were handled.
   */
  async poll(handler: (e: ConsumedEvent) => Promise<void> | void): Promise<number> {
    let handled = await this.read("0", handler, 0);
    if (handled === 0) handled = await this.read(">", handler, this.opts.blockMs ?? 1000);
    return handled;
  }

  async run(handler: (e: ConsumedEvent) => Promise<void> | void): Promise<void> {
    this.running = true;
    while (this.running) await this.poll(handler);
  }

  stop(): void {
    this.running = false;
  }

  private async read(from: "0" | ">", handler: (e: ConsumedEvent) => Promise<void> | void, blockMs: number): Promise<number> {
    const args: (string | number)[] = ["GROUP", this.opts.group, this.opts.consumer, "COUNT", this.opts.count ?? 100];
    if (from === ">" && blockMs > 0) args.push("BLOCK", blockMs);
    args.push("STREAMS", ...this.streams, ...this.streams.map(() => from));
    const res = (await (this.redis as unknown as { xreadgroup: (...a: (string | number)[]) => Promise<unknown> }).xreadgroup(
      ...args,
    )) as Array<[string, Array<[string, string[]]>]> | null;
    if (!res) return 0;

    let handled = 0;
    for (const [stream, entries] of res) {
      for (const [id, fields] of entries) {
        // Pending reads return deleted (trimmed) entries with null fields.
        const raw = fields ? fields[fields.indexOf("event") + 1] : undefined;
        let event: MarketEvent | undefined;
        if (raw !== undefined) {
          try {
            event = MarketEvent.parse(JSON.parse(raw));
          } catch (err) {
            this.onInvalid(raw, err);
          }
        }
        if (event) {
          await handler({ id, stream, event });
          handled++;
        }
        await this.redis.xack(stream, this.opts.group, id);
      }
    }
    return handled;
  }
}

export async function getLatestTicker(redis: Redis, exchange: string, symbol: string): Promise<TickerEvent | undefined> {
  const raw = await redis.get(latestKey("ticker", exchange, symbol));
  return raw ? TickerEvent.parse(JSON.parse(raw)) : undefined;
}

export async function getFeedStatus(redis: Redis, exchange: string, symbol: string): Promise<FeedStatusEvent | undefined> {
  const raw = await redis.get(latestKey("status", exchange, symbol));
  return raw ? FeedStatusEvent.parse(JSON.parse(raw)) : undefined;
}

export { Redis };
