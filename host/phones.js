/**
 * Phones connected through the relay: E2E handshake → auth (resume a paired device, or pair with a
 * one-time token + confirmation on the Mac) → encrypted RPC and terminal streams.
 *
 * Phone → host, after the handshake:
 *   {id, m, p}   a call, answered by {id, ok, r | e}
 *   {m, p}       a notification, no answer (term.input, term.ack: these are hot paths; term.coast:
 *                the coast after a flick, see shared/coast.js)
 * Host → phone:
 *   {ev, ...}    terminals (list changed), out (terminal bytes), closed (stream over), size (the
 *                terminal's new grid, in order with out: the repaint at that size follows)
 *
 * Only the methods below reach herdr-core. Nothing here forwards a raw RPC: herdr-core's socket
 * has no password, so `machine.exec`, `file.*`, `terminal.run`, `server.*` stay unreachable.
 */
import { homedir, userInfo } from 'node:os';
import { coastSteps } from '../shared/coast.js';
import { desktopAccept } from '../shared/e2e.js';
import { CREDIT, DATA, RESIZE, size, u32 } from './hc.js';
import { wheelSteps } from '../shared/wheel.js';
import { scrollWatch } from './scroll-watch.js';
import { createUploads } from './uploads.js';
import { MAX_BYTES as MAX_VOICE_BYTES } from './voice.js';

const MAX_STREAMS = 4; // per phone
const HISTORY_LINES = 400; // scrollback sent with the first paint
const OUT_MERGE_MS = 4; // terminal output merged this long into one message
// Wheel steps wait while more than this is on its way to the phone (sent, not yet drawn there), then
// go to the program together: one redraw for many steps, so redraws never queue up on a slow
// network (DESIGN.md「滑动延迟」).
const WHEEL_BEHIND = 12 * 1024;
const WHEEL_HELD_MAX = 4096; // characters of held steps (about 400): beyond, the oldest go
const WHEEL_ANSWER_MS = 100; // a step the program has not answered yet holds the next ones this long at most
// One wheel step, as xterm reports it to a program: SGR, or the old X10 form.
const WHEEL_RE = /^(?:\x1b\[<6[45];\d{1,4};\d{1,4}M|\x1b\[M[`a][\x20-\xff]{2})$/;
const KEY_RE = /^(?:(?:ctrl|alt|shift|cmd|super|meta)\+)*(?:[a-z0-9]|enter|esc|escape|tab|backspace|space|delete|del|insert|home|end|pageup|pgup|pagedown|pgdn|up|down|left|right|f(?:[1-9]|1[0-2])|[-=[\]\\;',./`])$/i;

export function createPhones({ state, pairing, push, terminals, voice, metrics, link: getLink, rtc, log = () => {}, onChange = () => {} }) {
  const peers = new Map(); // cid → peer
  let nextStream = 1;

  const online = (deviceId) => [...peers.values()].some((peer) => peer.device?.id === deviceId && peer.stage === 'ready');

  // ------------------------------------------------------------------ transport --
  const sendRaw = (peer, text) => getLink()?.send(peer.cid, text);
  const send = (peer, value) => { if (peer.cipher) sendRaw(peer, peer.cipher.seal(value)); };
  const event = (peer, ev, payload) => { if (peer.stage === 'ready') send(peer, { ev, ...payload }); };
  const broadcast = (ev, payload) => { for (const peer of peers.values()) event(peer, ev, payload); };

  function open(cid) {
    const peer = { cid, stage: 'hello', cipher: null, device: null, streams: new Map(), uploads: createUploads(), recognizing: false };
    peers.set(cid, peer);
  }

  function close(cid) {
    const peer = peers.get(cid);
    if (!peer) return;
    peers.delete(cid);
    for (const stream of [...peer.streams.values()]) stream.stop('dropped');
    pairing.dropped(cid);
    if (peer.device) onChange();
  }

  function kick(peer, code, message) {
    if (peer.cipher) send(peer, { type: 'error', code, message });
    else sendRaw(peer, JSON.stringify({ type: 'error', code, error: message }));
    setTimeout(() => getLink()?.close(peer.cid, code), 50);
  }

  async function data(cid, text) {
    const peer = peers.get(cid);
    if (!peer) return;
    if (peer.stage === 'hello') {
      try {
        const accepted = desktopAccept(state.boxKeys, text);
        Object.assign(peer, { cipher: accepted.cipher, sas: accepted.sas, pub: accepted.phonePublicKey, stage: 'auth' });
        sendRaw(peer, accepted.welcome);
        // A paired phone: its `ready` goes with the welcome, one round trip earlier (DESIGN.md
        // 「体验记录」). Safe: sealed with a key only the holder of the phone's secret can derive.
        // The phone still sends `auth` next, and only that proves it: until then it is not online
        // and nothing it sends is served (a replayed hello gets a `ready` nobody can read).
        const known = state.deviceByKey(peer.pub);
        if (known) { peer.early = known; await sendReady(peer, known); }
      } catch (error) {
        kick(peer, 'bad-hello', error.message);
      }
      return;
    }
    let message;
    try { message = peer.cipher.open(text); } catch { kick(peer, 'bad-frame', 'decryption failed'); return; }
    if (peer.stage === 'auth') return auth(peer, message);
    if (peer.stage !== 'ready' || !message) return;
    if (message.id === undefined) return notify(peer, message);
    return rpc(peer, message);
  }

  async function auth(peer, message) {
    if (message?.type !== 'auth') return kick(peer, 'bad-auth', 'expected auth');
    // `ready` already sent with the welcome: this is the proof. (Pairing a phone that is paired
    // already is the same: it is let in as itself.)
    if (peer.early && (message.mode === 'resume' || message.mode === 'pair')) return ready(peer, peer.early, false, false);
    if (message.mode === 'resume') {
      const device = state.deviceByKey(peer.pub);
      if (!device) return kick(peer, 'unknown-device', '这台设备已被移除或尚未配对，请重新扫码配对');
      return ready(peer, device);
    }
    if (message.mode === 'pair') {
      peer.stage = 'pairing';
      send(peer, { type: 'confirm', sas: peer.sas, desktopName: state.desktopName });
      const verdict = await pairing.ask({ cid: peer.cid, token: message.token, name: message.name, sas: peer.sas, pub: peer.pub });
      if (!peers.has(peer.cid)) return;
      if (verdict === 'invalid') return kick(peer, 'expired', '配对二维码已失效，请在 Mac 的 Herdr.app 里点手机图标，重新配对');
      if (verdict === 'busy') return kick(peer, 'busy', '电脑正在确认另一台设备，请稍后再试');
      if (verdict !== 'allowed') return kick(peer, 'denied', '电脑上拒绝了这次配对');
      const device = await state.addDevice({ name: message.name, pub: peer.pub });
      return ready(peer, device, true);
    }
    return kick(peer, 'bad-auth', 'unknown auth mode');
  }

  async function ready(peer, device, paired = false, tell = true) {
    peer.device = device;
    peer.stage = 'ready';
    await state.updateDevice(device.id, { lastSeen: Date.now() });
    if (!peers.has(peer.cid)) return;
    if (tell) await sendReady(peer, device, paired);
    onChange();
  }

  async function sendReady(peer, device, paired = false) {
    const voiceOn = Boolean(await voice?.available());
    if (!peers.has(peer.cid)) return;
    send(peer, {
      type: 'ready', paired, deviceId: device.id, deviceName: device.name, desktopName: state.desktopName,
      vapidPublicKey: push.publicKey, hasPush: Boolean(device.push), voice: voiceOn,
    });
  }

  // ------------------------------------------------------------------ streams ----
  /**
   * One phone viewer of one terminal, made of two herdr-core viewers:
   *  - the view: `observe` with `resize_notifications`. What the phone shows. herdr-core sends RESIZE
   *    on this channel before the repaint at the new size, so the phone changes its grid in step
   *    with the bytes (forwarded as `size`). It never sets the size.
   *  - the typer: a typing viewer. Its own bytes are dropped (credited at once). Two ways:
   *    - with `fit` (the phone's own grid; DESIGN.md「手机布局」): attached at once at that size, not
   *      resumed, so it leads: the program redraws for the phone. Each burst re-states the size, so
   *      the device used last leads (typing on the Mac takes the Mac's size back; herdr-core
   *      viewers.rs `touch`). `term.fit` with no size (the phone left the page or locked) detaches
   *      it, and the Mac windows lead again at once.
   *    - without (an older phone page): opened at the first input with `resumed: true` at the size
   *      the view last saw, so herdr-core never lets it lead; each burst re-states that size, and
   *      typing on the phone never changes the Mac windows.
   * Output is merged for OUT_MERGE_MS: a repaint comes in 16 KB frames, and reaches the phone whole.
   */
  async function openStream(peer, address, fit = null, lead = true) {
    if (peer.streams.size >= MAX_STREAMS) {
      const oldest = peer.streams.values().next().value;
      oldest.stop('replaced');
    }
    const core = terminals.core();
    if (!core) throw new Error('herdr-core 未运行');
    const t = terminals.get(address);
    if (!t || t.state !== 'live') throw new Error(`没有正在运行的终端 ${address}`);
    const id = nextStream++;
    const stream = { id, address, core, device: peer.device?.id, channel: null, typer: null, fit, sized: false, cols: t.cols, rows: t.rows, out: [], outW: null, outTimer: null, stopped: false };
    // Scrolling, as the Mac sees it (scroll-watch.js), to the same records as the phone's.
    const via = String(peer.cid).startsWith('rtc:') ? 'direct' : 'relay';
    stream.watch = scrollWatch({ record: (e) => metrics?.put(peer.device, { ctx: { src: 'mac' }, events: [{ t: Date.now(), via, ...e }] }).catch(() => {}) });
    stream.flush = () => {
      clearTimeout(stream.outTimer);
      stream.outTimer = null;
      if (!stream.out.length || stream.stopped) { stream.out = []; return; }
      const bytes = stream.out.length === 1 ? stream.out[0] : Buffer.concat(stream.out);
      stream.out = [];
      // w: the phone's wheel steps the program had when these bytes began (the phone's lag, DESIGN.md「滑动延迟」).
      event(peer, 'out', { s: id, d: bytes.toString('base64'), w: stream.outW });
      stream.outW = null;
      stream.watch.sent(bytes.length);
    };
    stream.stop = (reason = 'closed') => {
      if (stream.stopped) return;
      stream.stopped = true;
      stopCoast(stream);
      stream.watch.stop();
      clearTimeout(stream.outTimer);
      peer.streams.delete(id);
      if (stream.channel !== null) core.release(stream.channel);
      dropTyper(stream, reason === 'moved' || reason === 'dropped');
      event(peer, 'closed', { s: id, reason });
    };
    // The same terminal opened again on this connection (the page reopened it): the new stream
    // replaces the old, and takes over its typer (no second resize).
    const same = [...peer.streams.values()].filter((x) => x.address === address);
    for (const old of same) old.stop('moved');
    await Promise.all(same.map((old) => old.parking));
    peer.streams.set(id, stream);
    // With `fit`, the typer leads before the view attaches: the first paint is at the phone's size.
    // `lead: false` (opened again after a reconnect, while a Mac window led): at the first input.
    if (fit && lead) await typer(stream);
    let reply;
    try {
      reply = await core.call('terminal.attach', { terminal: address, cols: t.cols, rows: t.rows, history: HISTORY_LINES, observe: true, resize_notifications: true });
    } catch (error) {
      stream.stopped = true;
      peer.streams.delete(id);
      dropTyper(stream, false);
      throw error;
    }
    if (stream.stopped) { core.release(reply.channel); return { s: id }; }
    stream.channel = reply.channel;
    stream.sized = reply.resize_notifications === true;
    core.on(reply.channel, {
      onData: (bytes) => {
        stream.watch.output(bytes.length);
        stream.outW ??= stream.watch.w;
        stream.out.push(bytes);
        stream.outTimer ??= setTimeout(stream.flush, OUT_MERGE_MS);
      },
      onResize: (cols, rows) => {
        stream.flush(); // the bytes before it were drawn for the old size
        stream.cols = cols;
        stream.rows = rows;
        event(peer, 'size', { s: id, cols, rows });
      },
      onClose: (reason) => {
        if (stream.stopped) return;
        stream.flush();
        stream.stopped = true;
        stream.watch.stop();
        clearTimeout(stream.outTimer);
        peer.streams.delete(id);
        dropTyper(stream, false);
        event(peer, 'closed', { s: id, reason: reason?.reason ?? 'closed', exitCode: reason?.exit_code ?? null });
      },
    });
    const now = reply.terminal ?? t;
    if (!stream.sized) { stream.cols = now.cols; stream.rows = now.rows; }
    if (fit && !stream.sized) refit(stream, null, true); // an older core cannot tell the view its size in step
    return { s: id, cols: now.cols, rows: now.rows, sized: stream.sized };
  }

  function streamOf(peer, s) {
    const stream = peer.streams.get(Number(s));
    if (!stream || stream.stopped) throw new Error('终端已关闭，请重新打开');
    return stream;
  }

  /** The terminal's size now: what the view's RESIZE said (in step with its bytes), else the events'. */
  function sizeOf(stream) {
    if (stream.sized) return [stream.cols, stream.rows];
    const t = terminals.get(stream.address);
    return t ? [t.cols, t.rows] : [stream.cols, stream.rows];
  }

  /**
   * A phone's typer outlives its stream for a moment when the connection moved (relay ↔ direct) or
   * dropped: the stream opened again on the new connection takes it over. Released at once, the Mac
   * windows would lead until the new one attached, and the program would redraw twice (flicker).
   */
  const PARK_MS = 4000;
  const parked = new Map(); // `${device}|${address}` → { channel, core, timer }
  function dropTyper(stream, keep) {
    const pending = stream.typer;
    stream.typer = null;
    stream.parking = pending?.then((ch) => {
      if (ch === null) return;
      const key = `${stream.device}|${stream.address}`;
      if (!keep || !stream.fit || !stream.device || parked.has(key)) { stream.core.release(ch); return; }
      parked.set(key, { channel: ch, core: stream.core, timer: setTimeout(() => { parked.delete(key); stream.core.release(ch); }, PARK_MS) });
    });
  }
  function unpark(stream) {
    const key = `${stream.device}|${stream.address}`, p = parked.get(key);
    if (!p) return null;
    parked.delete(key);
    clearTimeout(p.timer);
    if (p.core !== stream.core) { p.core.release(p.channel); return null; }
    return p.channel;
  }
  /** Handlers of a typer channel: its own output is not wanted (credited at once). */
  function ownTyper(stream, channel) {
    stream.core.on(channel, {
      onData: (bytes) => stream.core.send(channel, CREDIT, u32(bytes.length)),
      onClose: () => { if (!stream.stopped && stream.typer) stream.typer = null; },
    });
  }

  /** The size the typer states: the phone's own, or the one the Mac windows set. */
  const typerSize = (stream) => stream.fit ?? sizeOf(stream);

  /** The typing viewer's channel, attached when first needed; null if it could not be. */
  function typer(stream) {
    if (!stream.typer) {
      const [cols, rows] = typerSize(stream);
      const kept = stream.fit ? unpark(stream) : null;
      if (kept !== null) {
        ownTyper(stream, kept);
        stream.core.send(kept, RESIZE, size(cols, rows)); // leads again (the phone may have turned)
        stream.typer = Promise.resolve(kept);
        return stream.typer;
      }
      stream.typer = stream.core.call('terminal.attach', { terminal: stream.address, cols, rows, history: 0, resumed: !stream.fit }).then((r) => {
        if (stream.stopped) { stream.core.release(r.channel); return null; }
        ownTyper(stream, r.channel);
        return r.channel;
      }, () => { stream.typer = null; return null; });
    }
    return stream.typer;
  }

  function input(stream, text, coasting = false) {
    if (typeof text !== 'string' || !text || text.length > 64 * 1024) return;
    const steps = wheelSteps(text);
    const phone = coasting ? 0 : steps, coast = coasting ? steps : 0;
    if (steps && (stream.held || !wheelMay(stream))) {
      // Held, never dropped: the phone counts its own steps (`w`), so the count stays whole even
      // when the oldest characters must go.
      const h = stream.held ??= { text: '', phone: 0, coast: 0 };
      h.text += text; h.phone += phone; h.coast += coast;
      if (h.text.length > WHEEL_HELD_MAX) h.text = h.text.slice(h.text.length - WHEEL_HELD_MAX).replace(/^[^\x1b]*/, '');
      retry(stream);
      return;
    }
    if (stream.held) release(stream); // anything else goes after the steps before it
    write(stream, text, phone, coast);
  }
  /** May a wheel step go to the program now: little on its way to the phone, and the last step answered. */
  const wheelMay = (stream) => stream.watch.behind() <= WHEEL_BEHIND && stream.watch.waiting() > WHEEL_ANSWER_MS;
  function retry(stream) {
    stream.heldTimer ??= setTimeout(() => {
      stream.heldTimer = null;
      if (!stream.held || stream.stopped) return;
      if (wheelMay(stream)) release(stream); else retry(stream);
    }, 15);
  }
  /** The held wheel steps, to the program at once. */
  function release(stream) {
    const h = stream.held;
    stream.held = null;
    clearTimeout(stream.heldTimer); stream.heldTimer = null;
    if (h?.text) write(stream, h.text, h.phone, h.coast);
  }
  function write(stream, text, phone = 0, coast = 0) {
    const bytes = Buffer.from(text, 'utf8');
    // In order, also while the typer is still attaching.
    stream.inputs = (stream.inputs ?? Promise.resolve()).then(async () => {
      const channel = await typer(stream);
      if (channel === null || stream.stopped) return;
      const [cols, rows] = typerSize(stream); // the device used last leads
      stream.core.send(channel, RESIZE, size(cols, rows));
      stream.core.send(channel, DATA, bytes);
      stream.watch.steps(phone, false);
      stream.watch.steps(coast, true);
    });
  }

  /**
   * The coast after a flick, sent from here so the steps reach the program evenly. `d` is one wheel
   * step; `v` the finger's speed (px/ms) and `cell` a row's height on the phone; `stop` ends it.
   * Anything typed (or a new drag) ends it too.
   */
  function coast(stream, { d, v, cell, stop }) {
    stopCoast(stream);
    if (stop || typeof d !== 'string' || !WHEEL_RE.test(d)) return;
    const times = coastSteps(Math.min(20, Number(v) || 0), Math.max(4, Math.min(100, Number(cell) || 0)));
    const t0 = performance.now();
    let i = 0;
    const tick = () => {
      stream.coast = null;
      if (stream.stopped) return;
      const now = performance.now() - t0;
      let n = 0;
      while (i < times.length && times[i] <= now) { i++; n++; }
      if (n) input(stream, d.repeat(n), true);
      if (i < times.length) stream.coast = setTimeout(tick, Math.max(1, times[i] - (performance.now() - t0)));
    };
    if (times.length) stream.coast = setTimeout(tick, Math.max(1, times[0]));
  }
  function stopCoast(stream) {
    clearTimeout(stream.coast); stream.coast = null;
    if (stream.held && !stream.held.phone) stream.held = null; // a stopped coast's held steps are void too
  }

  /**
   * The phone's grid changed (it turned), or the phone left (`fit` null: back, locked, in the
   * background). In order with the input, so a burst never goes out at a stale size.
   */
  function refit(stream, fit, force = false) {
    if (!stream.sized && !force) return;
    const next = fitOf(fit);
    stream.inputs = (stream.inputs ?? Promise.resolve()).then(async () => {
      if (stream.stopped) return;
      stream.fit = next;
      if (!next) {
        const ch = stream.typer && await stream.typer;
        stream.typer = null;
        if (ch !== null && ch !== undefined) stream.core.release(ch); // the Mac windows lead again
        return;
      }
      const had = stream.typer;
      const channel = await typer(stream);
      if (had && channel !== null && !stream.stopped) stream.core.send(channel, RESIZE, size(...next));
    });
  }

  function notify(peer, { m, p = {} }) {
    try {
      if (m === 'term.input') { const stream = streamOf(peer, p.s); stopCoast(stream); input(stream, p.d); }
      else if (m === 'term.coast') coast(streamOf(peer, p.s), p);
      else if (m === 'term.fit') refit(streamOf(peer, p.s), p.fit);
      else if (m === 'term.ack') {
        const stream = streamOf(peer, p.s);
        const n = Math.max(0, Math.min(Number(p.n) || 0, 16 << 20));
        stream.watch.acked(n);
        stream.core.send(stream.channel, CREDIT, u32(n));
        if (stream.held && wheelMay(stream)) release(stream);
      }
    } catch {}
  }

  // ------------------------------------------------------------------ RPC --------
  const call = async (method, params) => {
    const core = terminals.core();
    if (!core) throw new Error('herdr-core 未运行');
    return core.call(method, params);
  };
  /** The phone's grid, [cols, rows], or null. */
  const fitOf = (f) => {
    const cols = Math.trunc(Number(f?.cols)), rows = Math.trunc(Number(f?.rows));
    return cols >= 20 && cols <= 500 && rows >= 5 && rows <= 300 ? [cols, rows] : null;
  };
  const addressOf = (p) => {
    const address = String(p.address ?? '');
    if (!/^[A-Za-z0-9_./-]{1,80}$/.test(address)) throw new Error('无效的终端地址');
    return address;
  };

  const methods = {
    'terminals.list': () => ({ core: terminals.state(), terminals: terminals.list(), layout: terminals.layout() }),
    'term.open': (peer, p) => openStream(peer, addressOf(p), fitOf(p.fit), p.lead !== false),
    'term.close': (peer, p) => { peer.streams.get(Number(p.s))?.stop(); return {}; },
    // Direct link (rtc-link.js): the phone's WebRTC offer → our answer. The channel then gets its
    // own handshake and auth like any connection; this only introduces the two sides.
    'rtc.offer': (peer, p) => { if (!rtc) throw new Error('不支持直连'); return rtc.answer(p.sdp); },
    // The phone moved to its other connection: this one stays as the spare, with nothing open.
    'link.idle': (peer) => {
      for (const stream of [...peer.streams.values()]) stream.stop('moved');
      return {};
    },
    'term.send': async (peer, p) => {
      const text = String(p.text ?? '').trim();
      if (!text) throw new Error('消息不能为空');
      if (text.length > 32 * 1024) throw new Error('消息太长');
      try {
        return await call('terminal.send', { terminal: addressOf(p), text, force: Boolean(p.force) });
      } catch (error) {
        if (error.kind === 'blocked') throw new Error('程序正在等你确认（blocked）。先用快捷键回答。');
        throw error;
      }
    },
    'term.keys': (peer, p) => {
      const keys = Array.isArray(p.keys) ? p.keys.map(String) : [];
      if (!keys.length || keys.length > 32 || !keys.every((k) => KEY_RE.test(k))) throw new Error('无效的按键');
      return call('terminal.keys', { terminal: addressOf(p), keys });
    },
    'term.interrupt': (peer, p) => call('terminal.interrupt', { terminal: addressOf(p), timeout: 5 }),
    'term.read': async (peer, p) => {
      const r = await call('terminal.read', { terminal: addressOf(p), lines: Math.min(Number(p.lines) || 0, 2000) });
      return { text: r.text, complete: r.complete };
    },
    // A new tab, as on the Mac: a login shell in a space's current folder. herdr-core starts it with
    // the herdr.space label and Herdr.app adopts it as a new tab without moving the Mac's focus
    // (probe/create.mjs). The phone never picks the program.
    'term.new': async (peer, p) => {
      const space = terminals.layout().find((s) => s.id === String(p.space ?? ''));
      if (!space) throw new Error('没有这个工作区');
      const first = space.tabs.flatMap((t) => t.terminals).map((a) => terminals.get(a)).find(Boolean);
      const cwd = first?.foreground?.cwd ?? first?.cwd ?? space.folder ?? homedir();
      const shell = userInfo().shell || process.env.SHELL || '/bin/zsh';
      const r = await call('terminal.run', {
        argv: [shell, '-l'], cwd, keep: true, no_parent: true,
        labels: { 'herdr.space': space.id },
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'ghostty' },
      });
      // The phone opens it next: wait until the event stream has it, so term.open finds it.
      for (let i = 0; i < 40 && !terminals.get(r.address); i++) await new Promise((res) => setTimeout(res, 50));
      return { address: r.address };
    },
    // Voice: chunks in, then one recognition on the Mac. The text goes back to the phone's message
    // box; nothing is typed into the terminal until the user presses send.
    'upload.put': (peer, p) => peer.uploads.put(p),
    'upload.drop': (peer, p) => { peer.uploads.drop(p.id); return {}; },
    'voice.done': async (peer, p) => {
      if (!voice) throw new Error('这台 Mac 没开语音识别');
      if (peer.recognizing) throw new Error('上一段还在识别，请稍等');
      const upload = peer.uploads.take(p.id);
      if (upload.total > MAX_VOICE_BYTES) throw new Error('录音太长');
      peer.recognizing = true;
      try {
        const t = p.address ? terminals.get(String(p.address)) : null;
        return await voice.transcribe(upload.bytes, { terminal: t });
      } finally { peer.recognizing = false; }
    },
    // Images: herdr-core's terminal.put drops the file in a folder beside the terminal and returns
    // its path. The phone pastes the path into the program's line (term.input), as a paste of its
    // own: Claude Code / Codex then show [Image #N].
    'image.put': async (peer, p) => {
      const upload = peer.uploads.take(p.id);
      if (!/^image\//.test(upload.mime)) throw new Error('只能发图片');
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' }[upload.mime] ?? 'jpg';
      const stem = String(p.name ?? '').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
      const r = await call('terminal.put', { terminal: addressOf(p), name: `${stem}.${ext}`, data: upload.bytes.toString('base64') });
      return { path: r.path, bytes: r.bytes };
    },
    'push.subscribe': async (peer, p) => {
      const sub = p.subscription;
      if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('无效的推送订阅');
      await state.updateDevice(peer.device.id, { push: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } });
      onChange();
      return { ok: true };
    },
    'push.unsubscribe': async (peer) => { await state.updateDevice(peer.device.id, { push: null }); onChange(); return { ok: true }; },
    'push.test': (peer) => push.sendTo(state.deviceById(peer.device.id), { title: 'herdr 推送测试', body: `来自「${state.desktopName}」的测试通知`, tag: 'test' }),
    // The phone's experience records (metrics.js): times and kinds only.
    'metrics.put': (peer, p) => { if (!metrics) throw new Error('不记录'); return metrics.put(peer.device, p); },
    'device.forget': async (peer) => { await state.removeDevice(peer.device.id); setTimeout(() => getLink()?.close(peer.cid, 'forgotten'), 50); onChange(); return { ok: true }; },
  };

  async function rpc(peer, { id, m, p }) {
    const fn = methods[m];
    if (!fn) return send(peer, { id, ok: false, e: `未知方法 ${m}` });
    try {
      const r = await fn(peer, p ?? {});
      send(peer, { id, ok: true, r: r ?? {} });
    } catch (error) {
      send(peer, { id, ok: false, e: error?.message ?? String(error), k: error?.kind });
    }
  }

  /** herdr-core went away or came back: every stream on the old connection is over. */
  function coreChanged() {
    for (const peer of peers.values()) {
      for (const stream of [...peer.streams.values()]) if (stream.core !== terminals.core()) stream.stop('core_lost');
    }
    broadcast('terminals', {});
  }

  /** A device was removed on the Mac: drop its live connections. */
  function revoke(deviceId) {
    for (const peer of peers.values()) {
      if (peer.device?.id === deviceId) kick(peer, 'revoked', '这台设备已在电脑上移除');
    }
  }

  return {
    open, close, data, broadcast, online, coreChanged, revoke,
    connected: () => [...peers.values()].filter((peer) => peer.stage === 'ready').map((peer) => ({ deviceId: peer.device.id, streams: [...peer.streams.values()].map((s) => s.address) })),
  };
}


