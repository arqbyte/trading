/**
 * Tracks when each feed last produced data. A feed is stale once it has been
 * silent for longer than its threshold; consumers must stop trading on a
 * stale symbol rather than use outdated prices (PRD 4.4).
 */
export class StalenessMonitor {
  private readonly lastSeen = new Map<string, number>();
  private readonly stale = new Set<string>();

  constructor(
    private readonly thresholdMs: number,
    private readonly onChange: (key: string, stale: boolean, silentForMs: number) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts tracking a feed as of now, so a feed that never speaks goes stale. */
  watch(key: string): void {
    if (!this.lastSeen.has(key)) this.lastSeen.set(key, this.now());
  }

  touch(key: string, at: number = this.now()): void {
    this.lastSeen.set(key, at);
    if (this.stale.delete(key)) this.onChange(key, false, 0);
  }

  isStale(key: string): boolean {
    return this.stale.has(key) || !this.lastSeen.has(key);
  }

  /** Call periodically. */
  check(): void {
    const now = this.now();
    for (const [key, at] of this.lastSeen) {
      const silent = now - at;
      if (silent > this.thresholdMs && !this.stale.has(key)) {
        this.stale.add(key);
        this.onChange(key, true, silent);
      }
    }
  }
}
