/**
 * Phone ↔ Mac, direct when it can be. The relay connection (link.js) comes up first; through it
 * the phone sends a WebRTC offer to the Mac (`rtc.offer`), and the data channel that opens is a
 * second Link with its own handshake and auth. While the direct one is ready, everything goes
 * over it; the relay connection stays up as the spare. When the direct one drops, the relay one
 * takes over at once and the direct one is tried again later.
 *
 *   Duo            looks like a Link to main.js: status, rpc, notify, events, close, wake
 *   'ready' again  each time the connection in use changes: main.js opens its terminal again
 *                  there; the one left behind is told to close its streams (`link.idle`)
 */
import { Link } from './link.js';
import { joiner, pieces } from '../../shared/pieces.js';

const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const GATHER_MS = 2_500;   // our addresses: answer with what we have by then
const OPEN_MS = 10_000;    // the channel must open by then
const READY_MS = 10_000;   // and the handshake be done by then
const RETRY_MS = [3_000, 15_000, 60_000, 300_000];
const STEADY_MS = 60_000;  // ready this long: the next failure starts the retries over
// Pings are cheap on a direct link: notice a dead one in seconds, not in a minute.
const DIRECT_TIMEOUTS = { ping: 5_000, silent: 15_000, handshake: READY_MS };

const supported = () => typeof RTCPeerConnection === 'function';

/** A data channel dressed as the WebSocket link.js expects (readyState as a number, framing). */
function socketOf(pc, dc) {
  const join = joiner();
  const s = {
    onopen: null, onmessage: null, onclose: null,
    get readyState() { return { connecting: 0, open: 1, closing: 2, closed: 3 }[dc.readyState] ?? 3; },
    send(text) { for (const p of pieces(text)) dc.send(p); },
    close() { try { dc.close(); } catch {} try { pc.close(); } catch {} },
  };
  dc.onmessage = (m) => {
    let whole;
    try { whole = join(String(m.data)); } catch { s.close(); s.onclose?.(); return; }
    if (whole !== null) s.onmessage?.({ data: whole });
  };
  dc.onclose = () => s.onclose?.();
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') s.onclose?.(); };
  setTimeout(() => s.onopen?.(), 0); // the channel is open already; link.js sets onopen after this
  return s;
}

const within = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}超时`)), ms));

/** Open a direct Link through `relay` (a ready Link). Resolves when it is ready; throws if not. */
export async function openDirect(relay) {
  const pc = new RTCPeerConnection({ iceServers: STUN });
  try {
    const dc = pc.createDataChannel('herdr', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, GATHER_MS);
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
      });
    }
    const { sdp } = await relay.rpc('rtc.offer', { sdp: pc.localDescription.sdp }, 15_000);
    await pc.setRemoteDescription({ type: 'answer', sdp });
    if (dc.readyState !== 'open') {
      await Promise.race([new Promise((resolve, reject) => { dc.onopen = resolve; dc.onclose = () => reject(new Error('直连关闭')); }), within(OPEN_MS, '直连')]);
    }
    const link = new Link({ desktopKey: relay.desktopKey, deviceKeys: relay.deviceKeys, timeouts: DIRECT_TIMEOUTS, socket: () => socketOf(pc, dc) });
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          link.addEventListener('ready', resolve, { once: true });
          link.addEventListener('status', () => { if (link.status === 'offline' || link.status === 'error') reject(new Error('直连握手失败')); });
        }),
        within(READY_MS, '直连握手'),
      ]);
    } catch (error) { link.close(); throw error; }
    link.pc = pc;
    return link;
  } catch (error) {
    try { pc.close(); } catch {}
    throw error;
  }
}

export class Duo extends EventTarget {
  /** @param {Link} relay  the relay Link; `direct: false` keeps everything on it */
  constructor(relay, { direct = supported() } = {}) {
    super();
    this.relay = relay;
    this.direct = null;     // the direct Link while it is ready
    this.active = relay;    // where calls go
    this.useDirect = direct;
    this.tries = 0;
    this.closed = false;
    relay.addEventListener('status', () => this.emit('status', {}));
    relay.addEventListener('ready', (e) => {
      this.info = e.detail;
      if (this.active === relay) this.emit('ready', e.detail);
      this.later(500);
    });
    relay.addEventListener('ev', (e) => { if (this.active === relay) this.emit('ev', e.detail); });
    relay.addEventListener('fatal', (e) => this.emit('fatal', e.detail));
    relay.addEventListener('confirm', (e) => this.emit('confirm', e.detail));
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get status() { return this.active === this.direct && this.direct?.status === 'ready' ? 'ready' : this.relay.status; }
  /** 'direct' or 'relay': which one carries the calls now. */
  get via() { return this.active === this.direct ? 'direct' : 'relay'; }

  rpc(m, p, timeoutMs) { return this.active.rpc(m, p, timeoutMs); }
  notify(m, p) { this.active.notify(m, p); }

  wake() { this.relay.wake(); this.direct?.wake(); }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.direct?.close();
    this.relay.close();
  }

  // ---- inside

  later(ms) {
    clearTimeout(this.timer);
    if (!this.useDirect || this.closed || this.direct) return;
    this.timer = setTimeout(() => this.attempt(), ms);
  }

  async attempt() {
    if (this.closed || this.direct || this.trying || this.relay.status !== 'ready') return;
    this.trying = true;
    let link;
    try { link = await openDirect(this.relay); } catch { link = null; }
    this.trying = false;
    if (!link) { this.later(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]); return; }
    if (this.closed) { link.close(); return; }
    this.direct = link;
    this.since = Date.now();
    link.addEventListener('ev', (e) => { if (this.active === link) this.emit('ev', e.detail); });
    link.addEventListener('status', () => { if (link.status !== 'ready') this.lost(link); });
    this.use(link);
  }

  /** The direct one dropped: back to the relay, and try again later. */
  lost(link) {
    if (this.direct !== link) return;
    this.direct = null;
    link.close();
    if (Date.now() - this.since > STEADY_MS) this.tries = 0;
    if (this.active === link) this.use(this.relay);
    this.later(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
  }

  use(link) {
    const from = this.active;
    this.active = link;
    if (from === link) return;
    if (from.status === 'ready') from.rpc('link.idle').catch(() => {});
    this.emit('status', {});
    if (link.status === 'ready') this.emit('ready', { ...this.info, paired: false });
  }
}
