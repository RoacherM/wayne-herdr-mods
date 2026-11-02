/**
 * Phones connected through the relay: E2E handshake → auth (resume a paired device, or pair with a
 * one-time token + confirmation on the Mac) → encrypted RPC and terminal streams.
 *
 * Phone → host, after the handshake:
 *   {id, m, p}   a call, answered by {id, ok, r | e}
 *   {m, p}       a notification, no answer (term.input, term.ack: these are hot paths)
 * Host → phone:
 *   {ev, ...}    terminals (list changed), out (terminal bytes), closed (stream over), size,
 *                conv (a conversation's new items, or a fresh page after `reset`)
 *
 * Only the methods below reach herdr-core. Nothing here forwards a raw RPC: herdr-core's socket
 * has no password, so `machine.exec`, `file.*`, `terminal.run`, `server.*` stay unreachable.
 */
import { homedir, userInfo } from 'node:os';
import { desktopAccept } from '../shared/e2e.js';
import { CREDIT, DATA, RESIZE, size, u32 } from './hc.js';
import { programOf } from './terminals.js';
import { createConversations } from './transcripts.js';
import { createUploads } from './uploads.js';
import { MAX_BYTES as MAX_VOICE_BYTES } from './voice.js';

const MAX_STREAMS = 4; // per phone
const HISTORY_LINES = 400; // scrollback sent with the first paint
const KEY_RE = /^(?:(?:ctrl|alt|shift|cmd|super|meta)\+)*(?:[a-z0-9]|enter|esc|escape|tab|backspace|space|delete|del|insert|home|end|pageup|pgup|pagedown|pgdn|up|down|left|right|f(?:[1-9]|1[0-2])|[-=[\]\\;',./`])$/i;

export function createPhones({ state, pairing, push, terminals, voice, link: getLink, log = () => {}, onChange = () => {}, home }) {
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
    peer.convs = createConversations({ home, find: findAgent, emit: (c, payload) => event(peer, 'conv', { c, ...payload }) });
    peers.set(cid, peer);
  }

  function close(cid) {
    const peer = peers.get(cid);
    if (!peer) return;
    peers.delete(cid);
    for (const stream of peer.streams.values()) stream.stop();
    peer.convs.closeAll();
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
      if (verdict === 'invalid') return kick(peer, 'expired', '配对二维码已失效，请在电脑上重新运行 herdr-relay pair');
      if (verdict === 'busy') return kick(peer, 'busy', '电脑正在确认另一台设备，请稍后再试');
      if (verdict !== 'allowed') return kick(peer, 'denied', '电脑上拒绝了这次配对');
      const device = await state.addDevice({ name: message.name, pub: peer.pub });
      return ready(peer, device, true);
    }
    return kick(peer, 'bad-auth', 'unknown auth mode');
  }

  async function ready(peer, device, paired = false) {
    peer.device = device;
    peer.stage = 'ready';
    await state.updateDevice(device.id, { lastSeen: Date.now() });
    if (!peers.has(peer.cid)) return;
    send(peer, {
      type: 'ready', paired, deviceId: device.id, deviceName: device.name, desktopName: state.desktopName,
      vapidPublicKey: push.publicKey, hasPush: Boolean(device.push),
      voice: Boolean(await voice?.available()),
    });
    onChange();
  }

  // ------------------------------------------------------------------ streams ----
  /**
   * One phone viewer of one terminal. It attaches as a non-observe viewer with `resumed: true`
   * at the terminal's current size: herdr-core then never lets it lead the size until it types.
   * Before each burst of input it re-states the terminal's *current* size, so typing on the phone
   * never shrinks the Mac windows (DESIGN.md「多个窗口怎么同步」). `fit` opts into the phone's size:
   * the program lays itself out for the phone; the Mac windows show that size until someone types
   * there (herdr-core: the last active viewer sets the size). `before` is the size to give back.
   */
  async function openStream(peer, address, { fit } = {}) {
    if (peer.streams.size >= MAX_STREAMS) {
      const oldest = peer.streams.values().next().value;
      oldest.stop('replaced');
    }
    const core = terminals.core();
    if (!core) throw new Error('herdr-core 未运行');
    const t = terminals.get(address);
    if (!t || t.state !== 'live') throw new Error(`没有正在运行的终端 ${address}`);
    const id = nextStream++;
    const stream = { id, address, core, channel: null, fit: null, stopped: false };
    stream.stop = (reason = 'closed') => {
      if (stream.stopped) return;
      stream.stopped = true;
      peer.streams.delete(id);
      if (stream.channel !== null) core.release(stream.channel);
      event(peer, 'closed', { s: id, reason });
    };
    peer.streams.set(id, stream);
    const cols = fit?.cols ?? t.cols;
    const rows = fit?.rows ?? t.rows;
    const before = { cols: t.cols, rows: t.rows }; // now: `t` follows the core's size events
    let reply;
    try {
      reply = await core.call('terminal.attach', { terminal: address, cols, rows, history: HISTORY_LINES, resumed: !fit });
    } catch (error) {
      peer.streams.delete(id);
      throw error;
    }
    if (stream.stopped) { core.release(reply.channel); return { s: id }; }
    stream.channel = reply.channel;
    if (fit) { stream.fit = { cols, rows }; stream.before = before; }
    core.on(reply.channel, {
      onData: (bytes) => event(peer, 'out', { s: id, d: bytes.toString('base64') }),
      onClose: (reason) => {
        if (stream.stopped) return;
        stream.stopped = true;
        peer.streams.delete(id);
        event(peer, 'closed', { s: id, reason: reason?.reason ?? 'closed', exitCode: reason?.exit_code ?? null });
      },
    });
    const now = reply.terminal ?? t;
    return { s: id, cols: now.cols, rows: now.rows };
  }

  function streamOf(peer, s) {
    const stream = peer.streams.get(Number(s));
    if (!stream || stream.stopped) throw new Error('终端已关闭，请重新打开');
    return stream;
  }

  function input(stream, text) {
    if (typeof text !== 'string' || !text || text.length > 64 * 1024) return;
    const t = terminals.get(stream.address);
    // Follow the size the Mac windows set, unless this phone asked to fit the terminal to itself.
    const want = stream.fit ?? (t ? { cols: t.cols, rows: t.rows } : null);
    if (want) stream.core.send(stream.channel, RESIZE, size(want.cols, want.rows));
    stream.core.send(stream.channel, DATA, Buffer.from(text, 'utf8'));
  }

  function notify(peer, { m, p = {} }) {
    try {
      if (m === 'term.input') input(streamOf(peer, p.s), p.d);
      else if (m === 'term.ack') {
        const stream = streamOf(peer, p.s);
        stream.core.send(stream.channel, CREDIT, u32(Math.max(0, Math.min(Number(p.n) || 0, 16 << 20))));
      }
    } catch {}
  }

  /** A terminal's foreground program, for its transcript (transcripts.js); argv stays on the Mac. */
  function findAgent(address) {
    const t = terminals.get(address);
    const fg = t?.foreground;
    const program = programOf(fg);
    if (!program) return null;
    const others = terminals.raw()
      .filter((o) => o.address !== address && o.foreground?.cwd === fg.cwd && programOf(o.foreground) === program)
      .map((o) => o.foreground);
    return { fg, program, others };
  }

  // ------------------------------------------------------------------ RPC --------
  const call = async (method, params) => {
    const core = terminals.core();
    if (!core) throw new Error('herdr-core 未运行');
    return core.call(method, params);
  };
  const addressOf = (p) => {
    const address = String(p.address ?? '');
    if (!/^[A-Za-z0-9_./-]{1,80}$/.test(address)) throw new Error('无效的终端地址');
    return address;
  };

  const methods = {
    'terminals.list': () => ({ core: terminals.state(), terminals: terminals.list(), layout: terminals.layout() }),
    'term.open': (peer, p) => openStream(peer, addressOf(p), { fit: p.fit && validSize(p.fit) }),
    'term.close': (peer, p) => { peer.streams.get(Number(p.s))?.stop(); return {}; },
    // A coding agent's conversation from its transcript (transcripts.js): the phone names the terminal only.
    'conv.open': (peer, p) => peer.convs.open(addressOf(p)),
    'conv.older': (peer, p) => peer.convs.older(p.c, p.before),
    'conv.close': (peer, p) => { peer.convs.close(p.c); return {}; },
    // The phone's size (fit), or back to the size from before the phone took it (fit: null).
    'term.fit': (peer, p) => {
      const stream = streamOf(peer, p.s);
      const fit = p.fit ? validSize(p.fit) : null;
      const t = terminals.get(stream.address);
      if (fit && !stream.fit && t) stream.before = { cols: t.cols, rows: t.rows };
      // Give the size back only while the phone still leads it (the Mac may have taken it since).
      const leads = stream.fit && t && t.cols === stream.fit.cols && t.rows === stream.fit.rows;
      const want = fit ?? (leads ? stream.before : null);
      if (!fit) stream.before = null;
      stream.fit = fit;
      if (want) stream.core.send(stream.channel, RESIZE, size(want.cols, want.rows));
      return { fit: Boolean(fit) };
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

function validSize(fit) {
  const cols = Math.round(Number(fit.cols));
  const rows = Math.round(Number(fit.rows));
  if (!(cols >= 20 && cols <= 500 && rows >= 5 && rows <= 300)) throw new Error('无效的终端尺寸');
  return { cols, rows };
}

