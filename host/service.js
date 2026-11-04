/**
 * The background host: one outbound WebSocket to the relay, one connection to herdr-core, and a
 * local control socket for the `wayne-herdr-mods` commands (pair, devices, status, ctl).
 *
 *   phones ──relay──▶ relay-link ─▶ phones.js ─▶ terminals.js ─▶ herdr-core
 *                                        ▲
 *   wayne-herdr-mods pair / devices / ctl ──control.sock (0600, JSON lines)
 */
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { basename, join } from 'node:path';
import { desktopIdFor } from '../shared/e2e.js';
import { createNotifier } from './notify.js';
import { createPairing } from './pairing.js';
import { createMetricsStore } from './metrics.js';
import { createPhones } from './phones.js';
import { createPush } from './push.js';
import { createRelayLink } from './relay-link.js';
import { createRtcLink } from './rtc-link.js';
import { createState } from './state.js';
import { createTerminals } from './terminals.js';
import { readKey, recognize, toWav } from './voice.js';

export const DEFAULT_RELAY = 'https://herdr-relay.sir-housir.workers.dev';

export async function startService({ relayUrl = process.env.WAYNE_HERDR_MODS_URL ?? DEFAULT_RELAY, dataDir, coreOptions = {}, log = console.error, notifyAfterSeconds = 20 } = {}) {
  const state = await createState(dataDir ? { dir: dataDir } : {});
  const desktopId = await desktopIdFor(state.signKeys.publicKey);

  const watchers = new Set(); // control connections waiting for a change
  const changed = () => { for (const fn of watchers) fn(); };

  let link;
  let phones;
  const pairing = createPairing({ relayUrl, desktopId, boxKeys: state.boxKeys, desktopName: () => state.desktopName, onChange: changed });
  const push = createPush({ state, log, isOnline: (id) => phones?.online(id) ?? false });
  const notifier = createNotifier({
    minRunMs: notifyAfterSeconds * 1000,
    // Push even to phones that look connected: iOS suspends a backgrounded PWA without closing its
    // socket. The service worker drops the notification when the app is on screen.
    notify: (payload) => push.notify(payload, { includeOnline: true }).catch((error) => log(`wayne-herdr-mods: 推送失败：${error.message}`)),
  });
  const terminals = createTerminals({
    coreOptions, log,
    onChange: () => phones?.broadcast('terminals', {}),
    onStatus: (change) => notifier.onStatus(change),
    onCore: () => { phones?.coreChanged(); changed(); },
  });
  const voice = createVoice({ dir: state.dir, log });
  const metrics = createMetricsStore({ dir: state.dir });
  // Two kinds of connection carry phones: through the relay, and direct (WebRTC, `rtc:<n>`).
  const via = (cid) => (String(cid).startsWith('rtc:') ? rtc : link);
  const links = { send: (cid, data) => via(cid).send(cid, data), close: (cid, reason) => via(cid).close(cid, reason) };
  const rtc = createRtcLink({
    log,
    onOpen: (cid) => phones.open(cid),
    onData: (cid, data) => { phones.data(cid, data).catch((error) => log(`wayne-herdr-mods: ${error.stack ?? error.message}`)); },
    onClose: (cid) => phones.close(cid),
  });
  phones = createPhones({ state, pairing, push, terminals, voice, metrics, link: () => links, rtc, log, onChange: changed });
  link = createRelayLink({
    relayUrl, desktopId, signKeys: state.signKeys, log,
    onOpen: (cid) => phones.open(cid),
    onData: (cid, data) => { phones.data(cid, data).catch((error) => log(`wayne-herdr-mods: ${error.stack ?? error.message}`)); },
    onClose: (cid) => phones.close(cid),
    onStatus: () => changed(),
  });

  const view = () => ({
    desktopName: state.desktopName,
    desktopId,
    relayUrl,
    relay: link.status(),
    direct: rtc.count(),
    core: terminals.state(),
    terminals: terminals.list().length,
    pairing: pairing.view(),
    devices: state.devices().map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, push: Boolean(d.push), online: phones.online(d.id) })),
    connected: phones.connected(),
  });

  const control = {
    status: () => view(),
    'pair.start': () => { pairing.start(); return view(); },
    'pair.cancel': () => { pairing.cancel(); return view(); },
    'pair.decide': ({ allow }) => ({ decided: pairing.decide(Boolean(allow)) }),
    'devices.remove': async ({ id }) => {
      const device = state.devices().find((d) => d.id === id || d.id.startsWith(String(id)));
      if (!device) throw new Error(`没有设备 ${id}`);
      phones.revoke(device.id);
      await state.removeDevice(device.id);
      changed();
      return view();
    },
    /** Long-poll: answers when anything changes (or after `ms`). */
    watch: ({ ms = 25_000 }) => new Promise((resolve) => {
      const done = () => { watchers.delete(done); clearTimeout(timer); resolve(view()); };
      const timer = setTimeout(done, Math.min(Number(ms) || 25_000, 60_000));
      watchers.add(done);
    }),
  };

  const sockPath = controlSocketPath(state.dir);
  await mkdir(state.dir, { recursive: true, mode: 0o700 });
  await rm(sockPath, { force: true });
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        Promise.resolve()
          .then(() => { const fn = control[req.m]; if (!fn) throw new Error(`unknown ${req.m}`); return fn(req.p ?? {}); })
          .then((r) => conn.write(JSON.stringify({ id: req.id, ok: true, r }) + '\n'), (error) => conn.write(JSON.stringify({ id: req.id, ok: false, e: error.message }) + '\n'))
          .catch(() => {});
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sockPath, resolve); });
  await chmod(sockPath, 0o600);

  // Waking from sleep: the relay socket and herdr-core may both need a fresh dial.
  let lastTick = Date.now();
  const wakeTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 30_000) { link.kick(); terminals.kick(); }
    lastTick = now;
  }, 5_000);
  wakeTimer.unref?.();

  return {
    desktopId, state, terminals, phones, pairing, view,
    async stop() {
      clearInterval(wakeTimer);
      link.dispose();
      rtc.dispose();
      terminals.dispose();
      server.close();
      await rm(sockPath, { force: true });
    },
  };
}

export const controlSocketPath = (dir) => join(dir, 'control.sock');

// Hotwords for mixed Chinese/English dev speech. All of them go to the recognizer as hints; only
// SPELL (and your own words) are also forced back to this exact spelling afterwards, so ordinary
// words like "Node" or "push" keep whatever case the sentence gave them.
const HINTS = ['commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'diff', 'deploy', 'bug', 'Node', 'Rust', 'Python', 'Worker', 'Cloudflare'];
const SPELL = ['npm', 'pnpm', 'npx', 'git', 'test', 'README', 'JSON', 'API', 'PR', 'pull request', 'JavaScript', 'TypeScript', 'Claude', 'Claude Code', 'Codex', 'herdr', 'wrangler'];

/** { hints, spell } for one recognition: built-ins, ~/.config/wayne-herdr-mods/voice-words.txt, the terminal's folder. */
export async function voiceWords(dir, cwd) {
  const own = [];
  try { for (const w of (await readFile(join(dir, 'voice-words.txt'), 'utf8')).split(/\r?\n/)) if (w.trim() && !w.trim().startsWith('#')) own.push(w.trim()); } catch {}
  if (cwd) own.push(basename(cwd));
  const spell = [...new Set([...SPELL, ...own])];
  return { hints: [...new Set([...spell, ...HINTS])], spell };
}

/** The Mac side of voice input: key from the keychain, hotwords from voiceWords(). */
function createVoice({ dir, log }) {
  return {
    available: async () => Boolean(await readKey()),
    async transcribe(bytes, { terminal } = {}) {
      const key = await readKey();
      const wav = await toWav(bytes);
      const { hints, spell } = await voiceWords(dir, terminal?.foreground?.cwd ?? terminal?.cwd);
      try {
        const r = await recognize(wav, { key, words: hints, spell });
        log(`wayne-herdr-mods: 语音识别 ${(wav.length / 32000).toFixed(1)} 秒音频，用时 ${r.ms} ms`);
        return { text: r.text, ms: r.ms };
      } catch (error) {
        log(`wayne-herdr-mods: 语音识别失败：${error.message}${error.logid ? ` logid=${error.logid}` : ''}`);
        throw error;
      }
    },
  };
}

/** One request to a running service's control socket. */
export function controlCall(dir, m, p = {}, { timeoutMs = 65_000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(controlSocketPath(dir));
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('wayne-herdr-mods 后台服务没有响应')); }, timeoutMs);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify({ id: 1, m, p }) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      conn.end();
      const res = JSON.parse(buf.slice(0, nl));
      res.ok ? resolve(res.r) : reject(new Error(res.e));
    });
    conn.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? Object.assign(new Error('wayne-herdr-mods 后台服务没有运行。先在仓库里运行 node dist/wayne-herdr-mods.mjs install（或前台运行 wayne-herdr-mods serve）。'), { code: 'NOT_RUNNING' })
        : error);
    });
  });
}
