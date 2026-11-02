/**
 * herdr-core client in framed mode (herdr-core schema/README.md, protocol generation 1).
 *
 *   frame = [channel u32 LE][kind u8][len u32 LE][payload]
 *   channel 0: JSON-RPC both ways; attach and event streams get channels of their own.
 *
 * `openCore({ socket })` dials the Unix socket directly and never starts a core: if herdr-core is
 * not running, the connection fails and the caller retries later. `openCore({ session })` goes
 * through `hc connect --session`, which starts a scratch core when needed (probes and tests only).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA = 0, CREDIT = 1, CLOSE = 2, RESIZE = 3, FOCUS = 4, FACTS = 5;
export const HC_BIN = process.env.HC_BIN ?? join(homedir(), '.local', 'bin', 'hc');

/**
 * Where herdr-core listens, by the same rules as its paths.rs: HC_SOCKET, else `socket` in
 * ~/.config/herdr-core/config.toml, else <runtime dir or state dir>/<session>.sock.
 */
export function coreSocketPath(session = process.env.HC_SESSION || 'default', env = process.env) {
  if (env.HC_SOCKET) return env.HC_SOCKET;
  const configHome = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  try {
    const toml = readFileSync(join(configHome, 'herdr-core', 'config.toml'), 'utf8');
    const m = /^\s*socket\s*=\s*"([^"]+)"/m.exec(toml);
    if (m) return m[1];
  } catch {}
  const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  const state = join(stateHome, 'herdr-core', session);
  const run = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'herdr-core') : state;
  return join(run, `${session}.sock`);
}

export function encode(channel, kind, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.alloc(9 + body.length);
  out.writeUInt32LE(channel, 0);
  out[4] = kind;
  out.writeUInt32LE(body.length, 5);
  body.copy(out, 9);
  return out;
}

export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
export const size = (cols, rows) => { const b = Buffer.alloc(4); b.writeUInt16LE(cols, 0); b.writeUInt16LE(rows, 2); return b; };

export class CoreError extends Error {
  constructor(message, data) { super(message); this.kind = data?.kind; this.hint = data?.hint; this.data = data; }
}

/** One framed connection to herdr-core. */
export class Core {
  constructor({ readable, writable, kill = () => {} }) {
    this.readable = readable;
    this.writable = writable;
    this.kill = kill;
    this.buf = Buffer.alloc(0);
    this.framed = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.channels = new Map(); // channel → { onData, onResize, onClose }
    this.early = new Map(); // frames for a channel whose handlers are not registered yet
    this.closeHandlers = new Set();
    this.ready = new Promise((resolve, reject) => { this.helloResolve = resolve; this.helloReject = reject; });
    readable.on('data', (d) => { try { this.receive(d); } catch (error) { this.end(error); } });
    readable.on('end', () => this.end(new Error('herdr-core closed the connection')));
    readable.on('error', (error) => this.end(error));
    writable.on?.('error', (error) => this.end(error));
    writable.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed: true, generation: 1 } }) + '\n');
  }

  receive(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.framed) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      const reply = JSON.parse(this.buf.subarray(0, nl).toString());
      this.buf = this.buf.subarray(nl + 1);
      if (reply.error) { this.helloReject(new CoreError(reply.error.message, reply.error.data)); this.end(); return; }
      this.hello = reply.result;
      this.framed = true;
      this.helloResolve(this.hello);
    }
    while (this.buf.length >= 9) {
      const channel = this.buf.readUInt32LE(0);
      const kind = this.buf[4];
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < 9 + len) break;
      const payload = Buffer.from(this.buf.subarray(9, 9 + len));
      this.buf = this.buf.subarray(9 + len);
      this.frame(channel, kind, payload);
    }
  }

  frame(channel, kind, payload) {
    if (channel === 0) {
      if (kind !== DATA) return;
      const msg = JSON.parse(payload.toString());
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CoreError(msg.error.message, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    const ch = this.channels.get(channel);
    // The reply that names a channel and the channel's first frames can arrive in one chunk;
    // the caller registers handlers only once the reply's promise settles, so hold them.
    if (!ch) {
      const held = this.early.get(channel) ?? [];
      held.push([kind, payload]);
      this.early.set(channel, held);
      return;
    }
    if (kind === DATA) ch.onData?.(payload);
    else if (kind === RESIZE && payload.length >= 4) ch.onResize?.(payload.readUInt16LE(0), payload.readUInt16LE(2));
    else if (kind === CLOSE) {
      this.channels.delete(channel);
      let reason = null;
      try { reason = payload.length ? JSON.parse(payload.toString()) : null; } catch {}
      ch.onClose?.(reason);
    }
  }

  send(channel, kind, payload) {
    if (this.closed) return false;
    try { this.writable.write(encode(channel, kind, payload)); return true; } catch { return false; }
  }

  call(method, params = {}) {
    if (this.closed) return Promise.reject(new CoreError('herdr-core is not connected', { kind: 'offline' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(0, DATA, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Handlers for a stream channel named by attach / events.subscribe. */
  on(channel, handlers) {
    this.channels.set(channel, handlers);
    const held = this.early.get(channel) ?? [];
    this.early.delete(channel);
    for (const [kind, payload] of held) this.frame(channel, kind, payload);
  }

  /** Stop listening to a channel and tell the core (a viewer detaching). */
  release(channel) {
    if (!this.channels.delete(channel)) return;
    this.send(channel, CLOSE);
  }

  credit(channel, n) { if (n > 0) this.send(channel, CREDIT, u32(n)); }

  onEnd(fn) { this.closeHandlers.add(fn); return () => this.closeHandlers.delete(fn); }

  end(error) {
    if (this.closed) return;
    this.closed = true;
    this.helloReject?.(error ?? new Error('closed'));
    for (const p of this.pending.values()) p.reject(new CoreError(error?.message ?? 'herdr-core connection closed', { kind: 'offline' }));
    this.pending.clear();
    const channels = [...this.channels.values()];
    this.channels.clear();
    for (const ch of channels) ch.onClose?.({ reason: 'core_lost' });
    try { this.writable.end?.(); } catch {}
    try { this.kill(); } catch {}
    for (const fn of this.closeHandlers) { try { fn(error); } catch {} }
  }

  close() { this.end(); }
}

/** Dial herdr-core. Resolves once `hello` succeeded; rejects when it is not running. */
export async function openCore({ socket, session } = {}) {
  let core;
  if (session) {
    const proc = spawn(HC_BIN, ['connect', '--session', session], { stdio: ['pipe', 'pipe', 'ignore'] });
    core = new Core({ readable: proc.stdout, writable: proc.stdin, kill: () => proc.kill() });
    proc.on('error', (error) => core.end(error));
  } else {
    const path = socket ?? coreSocketPath();
    const conn = net.connect(path);
    await new Promise((resolve, reject) => {
      conn.once('connect', resolve);
      conn.once('error', (error) => reject(Object.assign(new Error(`herdr-core is not running (${path}): ${error.code ?? error.message}`), { code: error.code })));
    });
    core = new Core({ readable: conn, writable: conn, kill: () => conn.destroy() });
  }
  await core.ready;
  return core;
}
