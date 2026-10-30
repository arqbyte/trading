import { RateLimiter } from "../rate-limiter.js";

export const OKX_REST_URL = "https://www.okx.com";

export class OkxApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OkxApiError";
  }
}

type Fetch = typeof fetch;

export interface OkxRestOptions {
  baseUrl?: string;
  fetch?: Fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

// OKX limits are per IP per endpoint over 2 seconds; these stay below them.
const LIMITS: Record<string, [number, number]> = {
  "/api/v5/public/instruments": [10, 2000],
  "/api/v5/market/ticker": [15, 2000],
  "/api/v5/market/candles": [30, 2000],
  "/api/v5/market/history-candles": [15, 2000],
  "/api/v5/market/books": [30, 2000],
  "/api/v5/market/trades": [60, 2000],
};

// OKX error codes that mean "slow down" or "try again".
const RETRYABLE_CODES = new Set(["50011", "50013", "50001", "50004", "50026"]);

/** Thin client for OKX public REST endpoints. No credentials, ever. */
export class OkxRestClient {
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(options: OkxRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? OKX_REST_URL;
    this.fetch = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) query.set(k, String(v));
    const url = `${this.baseUrl}${path}?${query}`;

    for (let attempt = 0; ; attempt++) {
      await this.limiter(path).acquire();
      try {
        return await this.request<T>(url);
      } catch (err) {
        const retryable = !(err instanceof OkxApiError) || err.retryable;
        if (!retryable || attempt >= this.maxRetries) throw err;
        await this.sleep(Math.min(500 * 2 ** attempt, 8000));
      }
    }
  }

  private async request<T>(url: string): Promise<T[]> {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    const body = (await res.json().catch(() => undefined)) as { code?: string; msg?: string; data?: T[] } | undefined;
    if (!res.ok || body?.code !== "0" || !Array.isArray(body.data)) {
      const code = body?.code;
      const retryable = res.status === 429 || res.status >= 500 || (code !== undefined && RETRYABLE_CODES.has(code));
      throw new OkxApiError(`OKX ${res.status} code=${code ?? "?"}: ${body?.msg ?? res.statusText}`, res.status, code, retryable);
    }
    return body.data;
  }

  private limiter(path: string): RateLimiter {
    let limiter = this.limiters.get(path);
    if (!limiter) {
      const [capacity, windowMs] = LIMITS[path] ?? [5, 2000];
      limiter = new RateLimiter(capacity, windowMs);
      this.limiters.set(path, limiter);
    }
    return limiter;
  }
}
