/**
 * Token bucket that delays callers instead of failing them, so the collector
 * stays inside exchange rate limits (PRD 4.4). One bucket per endpoint group.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Resolves once a request may be sent. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take());
    this.queue = next.catch(() => {});
    return next;
  }

  private async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const msPerToken = this.windowMs / this.capacity;
      await this.sleep(Math.ceil(msPerToken * (1 - this.tokens)));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs);
    this.lastRefill = now;
  }
}
