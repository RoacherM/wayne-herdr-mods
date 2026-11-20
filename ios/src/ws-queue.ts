/**
 * FIFO-queued WebSocket adapter over nsh's `websocket` (`WebSocketConnection.write()`).
 *
 * nsh 0.4.0's global `WebSocket.send()` has an 8-message native outbound queue and throws
 * `Error: WebSocket outbound queue is full` on burst sends (e.g. `flushPendingLogs` + `term.open`
 * + `board.get` right after `ready`). Because `shared/e2e.js` advances `sendCounter++` before
 * `ws.send()`, any dropped frame permanently desyncs nonces and triggers Mac `kick=bad-frame`.
 * Awaiting `conn.write()` strictly one frame at a time keeps at most 1 write in flight in Rust.
 */

export interface QueuedConn {
  write(data: string | Uint8Array): Promise<void>;
  read(): Promise<string | Uint8Array | null>;
  close(code?: number | null, reason?: string | null): Promise<void>;
  dispose(): void;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
}

const MAX_QUEUED_FRAMES = 512;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? "");
}

function validCloseCode(code?: number): number {
  if (code === 1000 || (typeof code === "number" && code >= 3000 && code <= 4999)) return code;
  return 1000;
}

function disposeConn(conn: QueuedConn | null) {
  if (!conn) return;
  try { conn.dispose(); } catch { /* already disposed */ }
}

export class QueuedWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | Uint8Array }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private conn: QueuedConn | null = null;
  private out: (string | Uint8Array)[] = [];
  private flushing = false;
  private closed = false;

  constructor(url: string, connectFn: (url: string) => Promise<QueuedConn>) {
    this.dial(url, connectFn);
  }

  private dial(url: string, connectFn: (url: string) => Promise<QueuedConn>) {
    connectFn(url).then(
      (conn) => {
        if (this.closed) {
          conn.close(1000, "").catch(() => {}).finally(() => disposeConn(conn));
          return;
        }
        this.conn = conn;
        this.readyState = 1;
        this.onopen?.();
        if (this.closed) return;
        this.drain();
        this.readLoop(conn);
      },
      (err) => {
        this.onerror?.(err);
        this.finishClose(1006, errMessage(err));
      },
    );
  }

  send(data: string | Uint8Array) {
    if (this.readyState !== 1) return;
    if (this.out.length >= MAX_QUEUED_FRAMES) {
      this.finishClose(1006, "send queue overflow");
      return;
    }
    this.out.push(data);
    this.drain();
  }

  private async drain() {
    if (this.flushing || !this.conn) return;
    this.flushing = true;
    try {
      while (this.out.length && this.readyState === 1 && this.conn) {
        const next = this.out.shift()!;
        await this.conn.write(next);
      }
    } catch (err) {
      this.onerror?.(err);
      this.finishClose(1006, errMessage(err));
    } finally {
      this.flushing = false;
    }
  }

  private async readLoop(conn: QueuedConn) {
    try {
      while (!this.closed) {
        const msg = await conn.read();
        if (msg === null) break;
        this.onmessage?.({ data: msg });
      }
      this.finishClose(conn.closeCode ?? 1000, conn.closeReason ?? "");
    } catch (err) {
      this.finishClose(conn.closeCode ?? 1006, errMessage(err));
    }
  }

  private finishClose(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.closed = true;
    this.readyState = 3;
    this.out.length = 0;
    const c = this.conn;
    this.conn = null;
    disposeConn(c);
    this.onclose?.({ code, reason });
  }

  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2;
    this.out.length = 0;
    const safeCode = validCloseCode(code);
    const safeReason = typeof reason === "string" ? reason.slice(0, 100) : "";
    const c = this.conn;
    if (!c) { this.finishClose(safeCode, safeReason); return; }
    c.close(safeCode, safeReason).catch(() => {}).finally(() => this.finishClose(safeCode, safeReason));
  }
}

export function createQueuedWebSocket(connectFn: (url: string) => Promise<QueuedConn>) {
  return class extends QueuedWebSocket {
    constructor(url: string) {
      super(url, connectFn);
    }
  };
}
