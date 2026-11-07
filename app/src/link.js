/**
 * Phone ↔ Mac link (copied from dsh-pair): relay WebSocket + E2E handshake + encrypted RPC, with reconnects.
 * Emits: 'status' (connecting|offline|ready|error), 'confirm' {sas}, 'ready' {…}, 'ev' {ev, …}, 'fatal' {code, message}
 *
 * The relay answers "ping" itself, so a fresh pong only proves the relay is there, not the desktop.
 * Every step that waits on the desktop or the network has its own deadline, and a socket that
 * misses one is dropped at once: iOS may never fire onclose for a socket that died while the app
 * was suspended, so nothing waits for it.
 *
 * `socket` (optional) gives a ready-made connection instead of the relay WebSocket: a direct
 * WebRTC data channel (direct.js). Then there are no relay frames, the handshake starts at once,
 * and a dropped connection is not retried here: direct.js decides.
 */
import { phoneHandshake, unb64 } from '../../shared/e2e.js';

export const TIMEOUTS = {
  connect: 10_000, // socket open
  handshake: 12_000, // desktop online → ready (or the pairing confirmation)
  ping: 20_000,
  silent: 50_000, // no frame at all, not even the relay's pong
  asleep: 30_000, // back in the foreground after this long without a frame: reconnect
  wakePong: 4_000, // back in the foreground: no frame (not even the relay's pong) this long after the ping → reconnect
};

export class Link extends EventTarget {
  constructor({ relay, desktopId, desktopKey, deviceKeys, pair, timeouts, socket }) {
    super();
    this.t = { ...TIMEOUTS, ...timeouts };
    this.socket = socket;
    this.url = relay ? `${relay.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/client/${desktopId}` : null;
    this.desktopKey = typeof desktopKey === 'string' ? unb64(desktopKey) : desktopKey;
    this.deviceKeys = deviceKeys;
    this.pair = pair; // { token, name } while pairing
    this.status = 'connecting';
    this.pending = new Map();
    this.nextId = 1;
    this.attempt = 0;
    this.frames = 0; // every frame heard, the relay's pong too: wake() compares counts, not clock times
    this.closed = false;
    // Browser only (the native app calls wake() from its own app-state events).
    this.onVisible = () => { if (globalThis.document?.visibilityState !== 'hidden') this.wake(); };
    globalThis.document?.addEventListener('visibilitychange', this.onVisible);
    globalThis.window?.addEventListener('online', this.onVisible);
    this.connect();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setStatus(status, detail) { this.status = status; this.emit('status', { status, ...detail }); }

  connect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');
    const ws = this.socket ? this.socket() : new WebSocket(this.url);
    this.ws = ws;
    this.cipher = null;
    this.hs = null;
    this.lastHeard = Date.now();
    this.stepTimer(this.t.connect, ws);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      clearTimeout(this.deadline); // the relay's online/offline frame follows at once
      clearInterval(this.pingTimer);
      this.lastHeard = Date.now();
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastHeard > this.t.silent) { this.drop(ws); return; }
        try { ws.send('ping'); } catch {}
      }, this.t.ping);
      if (this.socket) this.hello(ws); // straight to the desktop: no relay to say it is online
    };
    ws.onmessage = (m) => this.receive(ws, m.data);
    ws.onclose = () => this.drop(ws);
  }

  /** Arm the deadline for the step in progress; a socket that misses it is dropped. */
  stepTimer(ms, ws) {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.drop(ws), ms);
  }

  /** Forget this socket now (without waiting for onclose, which may never come) and retry. */
  drop(ws, { now = false } = {}) {
    if (!ws || this.ws !== ws) return;
    this.ws = null;
    clearTimeout(this.deadline);
    clearTimeout(this.wakeTimer);
    clearInterval(this.pingTimer);
    try { ws.close(); } catch {}
    this.cipher = null;
    this.hs = null;
    this.failAll('连接已断开');
    if (this.closed) return;
    if (this.socket) { this.close(); this.setStatus('offline', { reason: 'network' }); return; } // one use only
    if (this.status !== 'error') this.setStatus('offline', { reason: 'network' });
    clearTimeout(this.retryTimer);
    if (now) { this.attempt = 0; this.connect(); return; }
    const delay = Math.min(15_000, 700 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 5);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Back in the foreground or back online. */
  wake() {
    if (this.closed) return;
    const ws = this.ws;
    if (!ws) { this.attempt = 0; this.connect(); return; }
    // Suspended for a while: the socket is likely dead even if it says open. A step still in
    // progress has its own deadline, which fires as soon as timers run again.
    if (Date.now() - this.lastHeard > this.t.asleep || ws.readyState > 1) { this.drop(ws, { now: true }); return; }
    if (ws.readyState !== 1) return; // still connecting: its connect deadline covers it
    // Said OPEN, but iOS may have killed it silently during suspension: the relay answers the ping
    // at once, so no frame within `wakePong` means the socket is dead.
    const heard = this.frames;
    try { ws.send('ping'); } catch {}
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      if (this.ws === ws && this.frames === heard) this.drop(ws, { now: true });
    }, this.t.wakePong);
  }

  receive(ws, data) {
    if (ws !== this.ws) return;
    this.lastHeard = Date.now();
    this.frames++;
    if (data === 'pong') return;
    if (data[0] === '\u0000') {
      const state = data.slice(1);
      if (state === 'online') this.hello(ws);
      else if (state === 'offline') {
        clearTimeout(this.deadline); // nothing to wait for until the relay says online
        this.cipher = null;
        this.failAll('电脑离线');
        this.setStatus('offline', { reason: 'desktop' });
      }
      return;
    }
    this.fromDesktop = (this.fromDesktop ?? 0) + 1;
    if (!this.cipher) {
      if (!this.hs) return;
      try {
        const { cipher, sas } = this.hs.finish(data);
        this.cipher = cipher;
        this.sas = sas;
        this.hs = null;
        this.send(this.pair ? { type: 'auth', mode: 'pair', token: this.pair.token, name: this.pair.name } : { type: 'auth', mode: 'resume' });
      } catch (error) {
        let parsed; try { parsed = JSON.parse(data); } catch {}
        this.fatal(parsed?.code ?? 'handshake', parsed?.error ?? error.message);
      }
      return;
    }
    let msg;
    try { msg = this.cipher.open(data); } catch { this.drop(ws); return; }
    if (msg.type === 'confirm') { clearTimeout(this.deadline); this.emit('confirm', msg); return; } // a human decides now
    if (msg.type === 'ready') {
      clearTimeout(this.deadline);
      this.pair = null;
      this.attempt = 0;
      this.info = msg;
      this.setStatus('ready');
      this.emit('ready', msg);
      return;
    }
    if (msg.type === 'error') { this.fatal(msg.code, msg.message); return; }
    if (msg.ev) { this.emit('ev', msg); return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.r) : p.reject(Object.assign(new Error(msg.e), { kind: msg.k }));
    }
  }

  /** (Re)start the handshake: the desktop may have restarted and lost our session. */
  hello(ws) {
    this.failAll('电脑已重新连接');
    this.cipher = null;
    this.hs = phoneHandshake(this.deviceKeys, this.desktopKey);
    ws.send(this.hs.hello);
    this.stepTimer(this.t.handshake, ws);
    this.setStatus('connecting');
  }

  fatal(code, message) {
    clearTimeout(this.deadline);
    if (code === 'bad-frame' && this.ws) {
      this.drop(this.ws, { now: true });
      return;
    }
    const permanent = ['unknown-device', 'denied', 'expired', 'revoked', 'busy', 'bad-hello'].includes(code);
    this.setStatus('error', { code, message });
    this.emit('fatal', { code, message });
    if (permanent) this.close();
  }

  send(value) { if (this.cipher && this.ws?.readyState === 1) this.ws.send(this.cipher.seal(value)); }

  /** Fire-and-forget (terminal input, credit): no reply, dropped while not ready. */
  notify(m, p = {}) { if (this.status === 'ready') this.send({ m, p }); }

  rpc(m, p = {}, timeoutMs = 30_000) {
    if (this.status !== 'ready') return Promise.reject(new Error(this.status === 'offline' ? '电脑离线' : '尚未连接'));
    const id = this.nextId++;
    const heard = this.fromDesktop ?? 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('请求超时'));
        // Not a single frame from the desktop since: the path is dead though the relay still pongs.
        if (this.status === 'ready' && (this.fromDesktop ?? 0) === heard) this.drop(this.ws);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, m, p });
    });
  }

  failAll(reason) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); this.pending.delete(id); }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.deadline);
    clearTimeout(this.wakeTimer);
    clearInterval(this.pingTimer);
    globalThis.document?.removeEventListener('visibilitychange', this.onVisible);
    globalThis.window?.removeEventListener('online', this.onVisible);
    this.failAll('已断开');
    try { this.ws?.close(); } catch {}
  }
}
