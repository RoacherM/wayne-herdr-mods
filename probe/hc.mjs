// Minimal herdr-core client in framed mode, over `hc connect` (stdin/stdout).
// Wire format (herdr-core schema/README.md): [channel u32 LE][kind u8][len u32 LE][payload].
// Channel 0 carries JSON-RPC; attach and event streams get their own channels.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA = 0, CREDIT = 1, CLOSE = 2, RESIZE = 3, FOCUS = 4, FACTS = 5;
export const HC = process.env.HC_BIN ?? join(homedir(), '.local', 'bin', 'hc');

export function encode(channel, kind, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = Buffer.alloc(9 + body.length);
  out.writeUInt32LE(channel, 0);
  out[4] = kind;
  out.writeUInt32LE(body.length, 5);
  body.copy(out, 9);
  return out;
}

export class Core {
  /** session: undefined = the user's default core; a name = an isolated scratch core. */
  static async open(session) {
    const core = new Core(session);
    await core.ready;
    return core;
  }

  constructor(session) {
    const args = ['connect', ...(session ? ['--session', session] : [])];
    this.proc = spawn(HC, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = Buffer.alloc(0);
    this.framed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.channels = new Map(); // channel -> { onData, onClose, onResize }
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    this.ready = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.proc.on('error', reject);
      this.proc.on('exit', (code) => reject(new Error(`hc connect exited ${code}: ${this.stderr.trim()}`)));
    });
    this.proc.stdout.on('data', (d) => this.receive(d));
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { framed: true, generation: 1 } }) + '\n');
  }

  receive(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.framed) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      this.hello = JSON.parse(this.buf.subarray(0, nl).toString()).result;
      this.buf = this.buf.subarray(nl + 1);
      this.framed = true;
      this.helloResolve(this.hello);
    }
    while (this.buf.length >= 9) {
      const channel = this.buf.readUInt32LE(0);
      const kind = this.buf[4];
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < 9 + len) break;
      const payload = this.buf.subarray(9, 9 + len);
      this.buf = this.buf.subarray(9 + len);
      this.frame(channel, kind, Buffer.from(payload));
    }
  }

  frame(channel, kind, payload) {
    if (channel === 0 && kind === DATA) {
      const msg = JSON.parse(payload.toString());
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(Object.assign(new Error(msg.error.message), { data: msg.error.data })) : p.resolve(msg.result);
      return;
    }
    const ch = this.channels.get(channel);
    // The attach reply and the first paint can arrive in one chunk: the caller registers its
    // handlers only after the reply's promise settles, so hold early frames until it does.
    if (!ch) { (this.early ??= new Map()).set(channel, [...(this.early.get(channel) ?? []), [kind, payload]]); return; }
    if (kind === DATA) {
      ch.onData?.(payload);
      this.send(channel, CREDIT, u32(payload.length)); // a well-behaved viewer returns credit
    } else if (kind === RESIZE) {
      ch.onResize?.(payload.readUInt16LE(0), payload.readUInt16LE(2));
    } else if (kind === CLOSE) {
      this.channels.delete(channel);
      ch.onClose?.(payload.length ? JSON.parse(payload.toString()) : null);
    }
  }

  send(channel, kind, payload) { this.proc.stdin.write(encode(channel, kind, payload)); }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(0, DATA, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Register handlers for a stream channel returned by attach / events.subscribe. */
  on(channel, handlers) {
    this.channels.set(channel, handlers);
    const held = this.early?.get(channel) ?? [];
    this.early?.delete(channel);
    for (const [kind, payload] of held) this.frame(channel, kind, payload);
  }

  close() { try { this.proc.stdin.end(); } catch {} this.proc.kill(); }
}

export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const size = (cols, rows) => { const b = Buffer.alloc(4); b.writeUInt16LE(cols, 0); b.writeUInt16LE(rows, 2); return b; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const strip = (s) => s.replace(/\x1b\[[0-9;?!>=]*[ -/]*[@-~]/g, '').replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b./g, '');
