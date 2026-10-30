import WebSocket from "ws";

export interface ReconnectingSocketOptions {
  url: string;
  /** Called after every (re)connect, e.g. to resubscribe. */
  onOpen: (send: (data: string) => void) => void;
  onMessage: (data: string) => void;
  /** Reported so the collector can record data quality events. */
  onDisconnect?: (info: { code: number; reason: string; attempt: number }) => void;
  pingIntervalMs?: number;
  /** No message (including pong) for this long means the link is dead. */
  idleTimeoutMs?: number;
  maxBackoffMs?: number;
}

/**
 * WebSocket that reconnects with capped exponential backoff and detects
 * silent connections with an application-level "ping" (OKX closes idle
 * connections after 30s and answers the text "ping" with "pong").
 */
export class ReconnectingSocket {
  private ws: WebSocket | undefined;
  private attempt = 0;
  private closed = false;
  private pingTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private lastMessageAt = 0;

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  send(data: string): void {
    if (this.isOpen) this.ws!.send(data);
  }

  async stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close();
      });
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.startHeartbeat(ws);
      this.opts.onOpen((data) => ws.send(data));
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      const text = raw.toString();
      if (text === "pong") return;
      this.opts.onMessage(text);
    });

    ws.on("error", () => {
      // "close" always follows "error"; reconnection is handled there.
    });

    ws.on("close", (code, reason) => {
      clearInterval(this.pingTimer);
      if (this.closed) return;
      this.attempt += 1;
      this.opts.onDisconnect?.({ code, reason: reason.toString(), attempt: this.attempt });
      const base = Math.min(500 * 2 ** (this.attempt - 1), this.opts.maxBackoffMs ?? 30_000);
      const delay = base / 2 + Math.random() * (base / 2);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    const interval = this.opts.pingIntervalMs ?? 20_000;
    const idle = this.opts.idleTimeoutMs ?? 30_000;
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > idle) {
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, interval);
  }
}
