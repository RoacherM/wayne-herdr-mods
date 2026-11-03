/**
 * herdr phone app (PWA). Screens: welcome/pairing → home (terminals grouped like Herdr.app) →
 * terminal (xterm.js + key bar + message box).
 *
 * All Mac traffic goes through Link (E2E encrypted). The terminal is the Mac's: the same columns
 * and rows, at a font the phone can read; the phone shows part of it and pans across the rest. The
 * phone never changes its size. See DESIGN.md「多个窗口怎么同步」.
 */
import { Terminal } from '@xterm/xterm';
import { b64, boxKeysFromSecret, decodePairLink, newBoxKeys, unb64 } from '../../shared/e2e.js';
import { Link } from './link.js';
import { Duo } from './direct.js';
import { scanQr } from './scan.js';
import { touchScroll } from './touch-scroll.js';
import { coastSteps } from '../../shared/coast.js';
import { ConversationView } from './conversation.js';
import { LiveLine, pasteText } from './live-line.js';
import { MAX_MS, shrinkImage, startRecording, transcribe, upload, voiceSupported } from './voice.js';

// ------------------------------------------------------------------ utilities --
const $ = (sel, root = document) => root.querySelector(sel);
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const vibrate = (ms = 10) => { try { navigator.vibrate?.(ms); } catch {} };
const base = (p) => (p ? p.replace(/\/+$/, '').split('/').pop() || p : '');
function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}
const ICONS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
};
const icon = (name) => { const s = h('span', { class: 'ico' }); s.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`; return s; };

// ------------------------------------------------------------------ storage ----
// The device keypair lives in localStorage on this origin (the relay we paired with, which also
// serves this script). The pairing link and the E2E handshake protect the channel itself.
const STORE_KEY = 'herdr-relay';
const DIRECT = 'herdr-relay.direct'; // 'off': relay only (for comparing)
const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {}; } catch { return {}; } };
const save = (value) => localStorage.setItem(STORE_KEY, JSON.stringify(value));
function deviceKeys() {
  const store = load();
  if (!store.deviceSecret) { store.deviceSecret = b64(newBoxKeys().secretKey); save(store); }
  return boxKeysFromSecret(unb64(store.deviceSecret));
}
const currentDesktop = () => load().desktop ?? null;
function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android 手机';
  return '浏览器';
}

// ------------------------------------------------------------------ app state --
const app = {
  link: null,
  info: null,
  list: { core: 'connecting', terminals: [], layout: [] },
  view: { name: 'home' },
  term: null, // the open terminal page, see openTerm()
};
const root = () => $('#app');

function connect(desktop, pair) {
  app.link?.close();
  // Through the relay first; then direct (WebRTC) when the network lets it (direct.js).
  const relay = new Link({ relay: desktop.relay, desktopId: desktop.id, desktopKey: desktop.k, deviceKeys: deviceKeys(), pair });
  const link = new Duo(relay, localStorage.getItem(DIRECT) === 'off' ? { direct: false } : {});
  app.link = link;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) globalThis.__herdrLink = link; // tests (dev/rtc-smoke.mjs)
  link.addEventListener('status', () => { renderStatus(); if (link.status !== 'ready') app.term?.lost(); });
  link.addEventListener('ready', async (e) => {
    app.info = e.detail;
    if (e.detail.paired) {
      const store = load();
      store.desktop = { ...desktop, name: e.detail.desktopName, deviceId: e.detail.deviceId, pairedAt: Date.now() };
      save(store);
      toast('配对成功', 'ok');
      vibrate(30);
      app.view = { name: 'home' };
    }
    await refreshList();
    if (app.view.name === 'term') app.term?.reopen();
    else render();
    maybeResubscribePush();
  });
  link.addEventListener('ev', (e) => onEvent(e.detail));
  link.addEventListener('fatal', (e) => onFatal(e.detail));
  link.addEventListener('confirm', (e) => { app.view = { ...app.view, name: 'pairing', sas: e.detail.sas, desktopName: e.detail.desktopName }; render(); });
  return link;
}

function onFatal({ code, message }) {
  if (code === 'unknown-device' || code === 'revoked') {
    const store = load(); delete store.desktop; save(store);
    app.term?.dispose();
    app.view = { name: 'welcome', error: message };
  } else if (app.view.name === 'pairing') {
    app.view = { name: 'welcome', error: message };
  } else {
    toast(message, 'err');
    return;
  }
  render();
}

let listTimer;
function onEvent(msg) {
  if (msg.ev === 'terminals') {
    clearTimeout(listTimer);
    listTimer = setTimeout(refreshList, 150);
  } else if (msg.ev === 'out' || msg.ev === 'closed') {
    app.term?.onEvent(msg);
  } else if (msg.ev === 'conv') {
    app.term?.onConv?.(msg);
  }
}

async function refreshList() {
  if (app.link?.status !== 'ready') return;
  try {
    app.list = await app.link.rpc('terminals.list');
    if (app.view.name === 'home') renderHomeList();
    app.term?.onList();
  } catch (e) { if (app.view.name === 'home') toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ render -----
function render() {
  const el = root();
  const desktop = currentDesktop();
  if (app.view.name !== 'term') { app.term?.dispose(); app.term = null; }
  if (app.view.name === 'pairing') return fill(el, renderPairing());
  if (!desktop || app.view.name === 'welcome') return fill(el, renderWelcome());
  if (app.view.name === 'settings') return fill(el, renderSettings());
  if (app.view.name === 'term') return; // owned by the terminal page
  return fill(el, renderHome());
}

function statusLine() {
  const s = app.link?.status ?? 'offline';
  const core = app.list?.core;
  const [cls, text] = s === 'ready'
    ? (core === 'online' ? ['ok', app.link.via === 'direct' ? '已直连' : '已连接'] : ['err', 'herdr 未运行'])
    : s === 'connecting' ? ['busy', '连接中…'] : s === 'error' ? ['err', '连接出错'] : ['', '电脑离线'];
  return h('span', { class: 'status', id: 'status' }, h('span', { class: `dot ${cls}` }), text);
}
function renderStatus() {
  const el = $('#status');
  if (el) el.replaceWith(statusLine());
  const banner = $('#offline');
  if (banner) banner.hidden = app.link?.status !== 'offline';
}

// ---- welcome / pairing
function renderWelcome() {
  const hash = location.hash.includes('p=') ? location.hash : null;
  const wrap = h('main', { class: 'screen welcome' },
    h('div', { class: 'hero' },
      h('div', { class: 'logo' }, '>_'),
      h('h1', {}, 'herdr 远程'),
      h('p', {}, '在手机上看和操作 Mac 上 Herdr 的终端与 agent。内容端到端加密，中继只转发密文。')),
    app.view.error ? h('div', { class: 'note err' }, app.view.error) : null,
  );
  if (hash) {
    wrap.append(h('div', { class: 'card' },
      h('b', {}, '准备配对'),
      !standalone() && isIOS() ? h('p', { class: 'muted' }, '提示：想收通知，先点 Safari 的「分享 → 添加到主屏幕」，从主屏幕打开后再扫一次码。') : null,
      h('label', { class: 'field' }, h('span', {}, '这台设备的名字'), h('input', { id: 'devname', value: defaultDeviceName(), maxlength: 40 })),
      h('button', { class: 'btn primary block', onClick: () => startPairing(hash, $('#devname').value) }, '开始配对')));
  } else {
    wrap.append(
      h('div', { class: 'card steps' }, h('ol', {},
        h('li', {}, '在 Mac 的终端里运行 herdr-relay pair。'),
        h('li', {}, isIOS() && !standalone() ? '想收通知：先点 Safari 的「分享 → 添加到主屏幕」，之后从主屏幕打开。' : '点下面的按钮扫描 Mac 上的二维码。'),
        h('li', {}, '在 Mac 上核对 6 位数字，输入 y 确认。'))),
      h('button', { class: 'btn primary block', onClick: scanAndPair }, icon('scan'), '扫描二维码'),
      h('details', { class: 'paste' }, h('summary', {}, '或粘贴配对链接'),
        h('textarea', { id: 'pastelink', rows: 3, placeholder: 'https://…/#p=…' }),
        h('button', { class: 'btn block', onClick: () => startPairing($('#pastelink').value, defaultDeviceName()) }, '使用链接配对')));
  }
  return wrap;
}

async function scanAndPair() {
  try { const text = await scanQr(); if (text) startPairing(text, defaultDeviceName()); } catch (e) { toast(e.message, 'err'); }
}

function startPairing(linkText, name) {
  let offer;
  try { offer = decodePairLink(linkText.trim()); } catch { toast('不是有效的配对链接', 'err'); return; }
  if (offer.e && Date.now() > offer.e) { app.view = { name: 'welcome', error: '二维码已过期，请在 Mac 上重新运行 herdr-relay pair' }; render(); return; }
  history.replaceState(null, '', location.pathname);
  const desktop = { id: offer.i, relay: offer.r, k: offer.k, name: offer.n };
  app.view = { name: 'pairing', desktopName: offer.n };
  render();
  connect(desktop, { token: offer.t, name: name || defaultDeviceName() });
}

function renderPairing() {
  const { sas, desktopName } = app.view;
  return h('main', { class: 'screen welcome' },
    h('div', { class: 'hero' }, h('div', { class: 'logo' }, '>_'), h('h1', {}, sas ? '在 Mac 上确认' : '正在连接…'),
      h('p', {}, sas ? `核对「${desktopName ?? 'Mac'}」终端里显示的数字和下面一致，然后在 Mac 上输入 y。` : `正在连接「${desktopName ?? 'Mac'}」`)),
    sas ? h('div', { class: 'sas' }, `${sas.slice(0, 3)} ${sas.slice(3)}`) : h('div', { class: 'spinner' }),
    h('button', { class: 'btn block ghost', onClick: () => { app.link?.close(); app.view = { name: 'welcome' }; render(); } }, '取消'));
}

// ---- home: terminals grouped by Herdr.app space → tab
const STATE_TEXT = { blocked: '等你处理', working: '工作中', done: '完成', idle: '空闲', error: '出错' };
const KIND_TEXT = { permission: '等你确认', question: '在问你', auth: '要登录' };

function renderHome() {
  const desktop = currentDesktop();
  queueMicrotask(renderHomeList);
  return h('main', { class: 'screen home' },
    h('header', { class: 'bar' },
      h('div', { class: 'bar-title' }, h('b', {}, desktop?.name ?? 'Mac'), statusLine()),
      h('button', { class: 'icon-btn', 'aria-label': '设置', onClick: () => { app.view = { name: 'settings' }; render(); } }, icon('gear'))),
    h('div', { class: 'banner', id: 'offline', hidden: app.link?.status !== 'offline' }, 'Mac 离线或 herdr-relay 没在运行。恢复后会自动重连。'),
    h('div', { id: 'needs' }),
    h('div', { id: 'groups', class: 'groups' }));
}

function termRow(t) {
  const st = t.state;
  const label = st === 'blocked' ? (KIND_TEXT[t.kind] ?? STATE_TEXT.blocked) : STATE_TEXT[st];
  const what = t.app || t.program || 'shell';
  return h('button', { class: `trow ${st ?? ''}`, onClick: () => openTerm(t.address) },
    h('span', { class: `dot ${st === 'working' ? 'busy' : st === 'blocked' || st === 'error' ? 'err' : st === 'done' ? 'ok' : ''}` }),
    h('span', { class: 'trow-main' },
      h('b', {}, what, h('span', { class: 'addr' }, t.address)),
      h('span', {}, [t.msg && st !== 'idle' ? t.msg : null, base(t.cwd)].filter(Boolean).join(' · '))),
    label ? h('span', { class: `tag ${st}` }, label) : null);
}

// A space's name as the Mac shows it. Herdr.app names a space after where its terminals are now
// (the `where` label it writes on each one: "herdr-relay / 1"), not the folder it was made in.
function spaceName(space, byAddr) {
  if (space.name) return space.name;
  const tabs = space.tabs.map((tab) => tab.terminals.map((a) => byAddr.get(a)?.where).find(Boolean));
  const where = tabs.find(Boolean);
  return where?.replace(/ \/ \d+$/, '') || base(space.folder) || '工作区';
}

function renderHomeList() {
  const groups = $('#groups');
  const needs = $('#needs');
  if (!groups) return;
  renderStatus();
  const { terminals = [], layout = [], core } = app.list ?? {};
  if (app.link?.status === 'ready' && core !== 'online') {
    fill(groups, h('div', { class: 'note' }, 'Mac 在线，但 Herdr 没有运行（herdr-core 不在）。打开 Herdr.app 后这里会自动出现终端。'));
    fill(needs);
    return;
  }
  const byAddr = new Map(terminals.map((t) => [t.address, t]));
  const waiting = terminals.filter((t) => t.state === 'blocked' || t.state === 'error');
  fill(needs, waiting.length ? h('section', { class: 'group needs' }, h('h2', {}, `需要你（${waiting.length}）`), h('div', { class: 'list' }, waiting.map(termRow))) : null);
  const placed = new Set();
  const sections = [];
  for (const space of layout) {
    const rows = [];
    for (const tab of space.tabs) {
      const ts = tab.terminals.map((a) => byAddr.get(a)).filter(Boolean);
      if (!ts.length) continue;
      ts.forEach((t) => placed.add(t.address));
      if (space.tabs.length > 1) rows.push(h('div', { class: 'tab-label' }, tab.name || `标签 ${space.tabs.indexOf(tab) + 1}`));
      rows.push(...ts.map(termRow));
    }
    if (rows.length || space.id) sections.push(h('section', { class: 'group' },
      h('div', { class: 'group-head' },
        h('h2', {}, spaceName(space, byAddr)),
        h('button', { class: 'group-add', 'aria-label': '新建终端', onClick: (e) => newTab(space, e.currentTarget) }, icon('plus'))),
      rows.length ? h('div', { class: 'list' }, rows) : null));
  }
  const loose = terminals.filter((t) => !placed.has(t.address));
  if (loose.length) sections.push(h('section', { class: 'group' }, h('h2', {}, '其他终端'), h('div', { class: 'list' }, loose.map(termRow))));
  fill(groups, sections.length ? sections : h('div', { class: 'note' }, app.link?.status === 'ready' ? '没有正在运行的终端。' : '连接中…'));
}

/** A new shell tab in this space, then straight into it. */
async function newTab(space, btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  vibrate(8);
  try {
    const { address } = await app.link.rpc('term.new', { space: space.id }, 15_000);
    await refreshList();
    openTerm(address);
  } catch (e) {
    toast(e.message, 'err');
  } finally { btn.disabled = false; }
}

// ---- settings
function renderSettings() {
  const desktop = currentDesktop();
  const pushOn = Boolean(app.info?.hasPush) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  return h('main', { class: 'screen' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': '返回', onClick: () => { app.view = { name: 'home' }; render(); } }, icon('back')),
      h('div', { class: 'bar-title' }, h('b', {}, '设置'))),
    h('div', { class: 'card' },
      h('p', {}, h('b', {}, desktop?.name ?? 'Mac')),
      h('p', { class: 'muted small' }, `这台设备：${app.info?.deviceName ?? '—'}`),
      h('p', { class: 'muted small' }, `中继：${desktop?.relay ?? '—'}`)),
    h('div', { class: 'card' },
      h('b', {}, '通知'),
      h('p', { class: 'muted small' }, 'agent 等你确认、出错、完成长任务或退出时推送。iPhone 需要先「添加到主屏幕」并从主屏幕打开。'),
      'PushManager' in window
        ? h('div', { class: 'row' },
          h('button', { class: 'btn primary', onClick: enablePush }, pushOn ? '重新订阅' : '开启通知'),
          pushOn ? h('button', { class: 'btn', onClick: () => app.link.rpc('push.test').then(() => toast('已发送'), (e) => toast(e.message, 'err')) }, '发一条测试') : null)
        : h('p', { class: 'note' }, isIOS() ? '在 Safari 里不能收通知。点「分享 → 添加到主屏幕」，从主屏幕打开后再来这里。' : '这个浏览器不支持推送。')),
    h('button', { class: 'btn danger block', onClick: forget }, '取消配对'));
}

// ------------------------------------------------------------------ terminal ---
/*
 * One input box: the program's own line (live-line.js). The phone keyboard types straight into
 * Claude Code / Codex / the shell. The terminal keeps the Mac's size and layout (the Mac windows
 * never change); the phone shows its left part and pans sideways to the rest.
 *
 *   ┌ header ───────────────────────┐
 *   │ terminal, as on the Mac  ⇢    │  tap → keyboard; sideways: pan; up/down: history
 *   │          ( status bubble )    │  only when there is something to say
 *   ├ Esc Tab ^C ↑ ↓ ← → ⏎ 1 2 3 … ┤
 *   │  ＋  │   按住 说话   │  ⌨     │
 *   └───────────────────────────────┘
 */
const KEYBAR = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['^C', '\x03'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['⏎', '\r'],
  ['1', '1'], ['2', '2'], ['3', '3'], ['y', 'y'], ['n', 'n'], ['⇧Tab', '\x1b[Z'], ['^D', '\x04'],
];
// A font the phone can read; the Mac's columns are wider than the phone, and the phone pans.
const TERM_FONT = 12; // px
// Agents whose transcript the Mac can read (host/transcripts.js): they open in the conversation
// view (scrolled on the phone) unless the person chose the terminal.
const CONV_PROGRAMS = new Set(['claude', 'codex', 'epi', 'pi']);
const hasConv = (t) => CONV_PROGRAMS.has(t?.program);
const MODE = 'herdr-relay.mode';
const MOUSE_REPORT = /^(\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/; // SGR, or the default encoding
const ANSWERS = new Set(['Esc', '⏎', '1', '2', '3', 'y', 'n']); // blue while the program asks
// Hardware keys that go to the program as keys, not into the line.
const HW_KEYS = { Escape: '\x1b', Tab: '\t', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D' };
const TERM_THEME = { background: '#0b0b0c', foreground: '#e6e6e1', cursor: '#e6e6e1', selectionBackground: '#3a3a36' };
const IMAGE_GAP_MS = 400; // Claude Code / Codex read the file before the next paste lands
const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);

function openTerm(address) {
  app.term?.dispose();
  app.view = { name: 'term', address };
  const t0 = app.list.terminals.find((t) => t.address === address);
  const page = { address, s: null, closed: false, cols: t0?.cols ?? 80, rows: t0?.rows ?? 24, unacked: 0, opening: false, early: [] };
  app.term = page;
  const status = { notice: '', uploading: '', composing: '', voice: null }; // what the bubble may say

  const title = h('b', {}, t0?.app || t0?.program || address);
  const sub = h('span', { class: 'status' }, t0?.where ?? address);
  const host = h('div', { class: 'xterm-host' });
  const viewport = h('div', { class: 'term-viewport', hidden: true }, host); // the Mac's grid; pans sideways
  const bubble = h('div', { class: 'term-bubble', hidden: true });
  // An agent's view scrolled up (by a pull past the top): back to the latest, as its own ↓ would.
  const latestBtn = h('button', { class: 'term-latest', hidden: true, 'aria-label': '回到最新', onClick: () => { toLatest(); xterm.scrollToBottom(); } }, icon('down'));
  // The keyboard: an invisible textarea that holds the burst (what was typed since the last commit).
  const keys = h('textarea', { class: 'term-keys', rows: 1, enterkeyhint: 'send', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': '输入到终端' });
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const voiceOk = Boolean(app.info?.voice) && voiceSupported();
  const pickBtn = h('button', { class: 'round', 'aria-label': '插入图片', onClick: () => pick() }, icon('plus'));
  const talkBtn = h('button', { class: `talk ${voiceOk ? '' : 'off'}`, 'aria-label': '按住说话' }, '按住 说话');
  const kbdBtn = h('button', { class: 'round', 'aria-label': '键盘', onClick: () => { const f = convMode ? convInput : keys; if (document.activeElement === f) f.blur(); else f.focus(); } }, icon('kbd'));
  // The conversation (from the transcript, scrolled on the phone) or the terminal itself. Without a
  // conversation it still takes the space, so the title stays in the middle.
  const modeBtn = h('button', { class: `icon-btn mode-btn${hasConv(t0) ? '' : ' none'}`, onClick: () => { if (hasConv(current())) setMode(!convMode); } });
  const convEl = h('div', { class: 'conv', hidden: true });
  const convInput = h('textarea', { class: 'conv-input', rows: 1, enterkeyhint: 'send', placeholder: '发消息给 agent', 'aria-label': '发消息给 agent' });
  const convSend = h('button', { class: 'round conv-send', 'aria-label': '发送', onClick: () => sendConv() }, icon('send'));
  const convBox = h('div', { class: 'conv-box', hidden: true }, convInput, convSend);
  const keyBtns = KEYBAR.map(([label, seq]) => h('button', { class: 'key', 'data-label': label, onClick: () => key(seq) }, label));

  const screen = h('main', { class: 'screen term' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': '返回', onClick: () => { app.view = { name: 'home' }; render(); } }, icon('back')),
      h('div', { class: 'bar-title' }, title, sub),
      modeBtn),
    h('div', { class: 'term-stage' }, viewport, convEl, bubble, latestBtn),
    h('footer', { class: 'term-foot' },
      h('div', { class: 'keybar' }, keyBtns),
      convBox,
      h('div', { class: 'term-actions' }, pickBtn, talkBtn, kbdBtn, keys, picker)));
  fill(root(), screen);
  // Buttons must not take the focus: the keyboard stays up while you press Esc or ⏎.
  for (const b of [pickBtn, kbdBtn, latestBtn, convSend, ...keyBtns]) b.addEventListener('pointerdown', (e) => e.preventDefault());

  // ---- the terminal
  const xterm = new Terminal({
    cols: page.cols, rows: page.rows, scrollback: 3000, fontSize: TERM_FONT, lineHeight: 1.0,
    fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace', theme: TERM_THEME, cursorBlink: false, macOptionIsMeta: true,
  });
  xterm.open(host);
  if (globalThis.__herdrLink) globalThis.__herdrTerm = xterm; // tests on this machine only (see connect())
  // Up and down: the history, or (full-screen programs) the wheel to the program. Sideways: the
  // browser pans (touch-action: pan-x). A coding agent's history reads best in the conversation view.
  const stopTouch = touchScroll(viewport, xterm, {
    onTap: () => keys.focus(),
    remoteCoast: (v, cell) => remoteCoast(v, cell),
  });
  viewport.addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse' && !xterm.hasSelection()) keys.focus(); });
  const current = () => app.list.terminals.find((x) => x.address === address);
  const showMode = () => {
    convEl.hidden = !convMode;
    convBox.hidden = !convMode;
    const m = convMode ? 'term' : 'chat';
    if (modeBtn.dataset.to !== m) { modeBtn.dataset.to = m; modeBtn.setAttribute('aria-label', convMode ? '看终端' : '看对话'); fill(modeBtn, icon(m)); }
    if (convMode) { viewport.hidden = true; latestBtn.hidden = true; return; }
    latestBtn.hidden = back === 0;
    viewport.hidden = false;
    layout();
  };
  // ---- the conversation view (conversation.js): the agent's transcript, read on the Mac.
  let convMode = hasConv(t0) && localStorage.getItem(MODE) !== 'term';
  let conv = null;
  async function startConv() {
    if (conv) return;
    conv = new ConversationView({ el: convEl, rpc: (m, p) => app.link.rpc(m, p), address, keys: key });
    conv.state(current());
    try { await conv.open(); } catch (e) {
      conv.close(); conv = null;
      if (convMode && !page.closed) { toast(`没有对话记录，显示终端（${e.message}）`); setMode(false, false); }
    }
  }
  /** Conversation or terminal. */
  function setMode(on, remember = true) {
    convMode = on;
    if (remember) localStorage.setItem(MODE, on ? 'conv' : 'term');
    if (on) {
      if (document.activeElement === keys) keys.blur();
      startConv();
    } else if (document.activeElement === convInput) convInput.blur();
    showMode();
  }
  function sizeConvInput() { convInput.style.height = ''; convInput.style.height = `${Math.min(120, convInput.scrollHeight)}px`; }
  async function sendConv() {
    const text = convInput.value.trim();
    if (!text) return;
    convSend.disabled = true;
    try {
      await app.link.rpc('term.send', { address, text });
      convInput.value = '';
      sizeConvInput();
      vibrate();
      conv?.sent(text);
    } catch (e) { toast(e.message, 'err'); } finally { convSend.disabled = false; }
  }
  convInput.addEventListener('input', sizeConvInput);
  convInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendConv(); }
  });
  convInput.addEventListener('focus', () => kbdBtn.classList.add('on'));
  convInput.addEventListener('blur', () => kbdBtn.classList.remove('on'));
  xterm.buffer.onBufferChange(() => { if (xterm.buffer.active.type !== 'alternate') setBack(0); showMode(); });
  // An agent's full screen has no history of its own here: a drag scrolls the agent's own view, as
  // the Mac's wheel would (touch-scroll.js). The agent's view is the Mac's too: how far up we scrolled it is kept (`back`, in wheel steps),
  // and any input first takes it back to the latest, so what you send and its answer are in view.
  let back = 0;
  const wheelReport = (up) => {
    const b = up ? 64 : 65;
    const sgr = String(xterm._core?.coreMouseService?.activeEncoding ?? '').startsWith('SGR');
    return sgr ? `\x1b[<${b};2;2M` : `\x1b[M${String.fromCharCode(32 + b, 34, 34)}`;
  };
  function wheel(up) {
    if (!page.s || xterm.modes.mouseTrackingMode === 'none') return false;
    out(wheelReport(up), 0, false);
    setBack(Math.max(0, back + (up ? 1 : -1)));
    return true;
  }
  /**
   * A flick's coast, run by the Mac (host/phones.js): it sends the program one wheel step per row of
   * travel, a frame apart. Sent from here, the steps would arrive in clumps (a proxy on the phone
   * batches them). v: px/ms, positive = older; 0 stops it.
   */
  function remoteCoast(v, cell) {
    if (!page.s || xterm.modes.mouseTrackingMode === 'none' || app.link?.status !== 'ready') return false;
    if (!v) { app.link.notify('term.coast', { s: page.s, stop: true }); return true; }
    const up = v > 0;
    app.link.notify('term.coast', { s: page.s, d: wheelReport(up), v: Math.abs(v), cell });
    const n = coastSteps(v, cell).length;
    setBack(Math.max(0, back + (up ? n : -n)));
    return true;
  }
  function setBack(n) { back = n; latestBtn.hidden = back === 0 || convMode; }
  /** Scroll the agent's own view back down to the latest (a few steps more: extra ones do nothing). */
  function toLatest(now = false) {
    stopTouch(); // a coast still sending wheel steps would take it away from the latest again
    if (!back) return;
    const d = wheelReport(false).repeat(back + 2);
    setBack(0);
    if (!page.s || xterm.modes.mouseTrackingMode === 'none') return;
    if (now) app.link.notify('term.input', { s: page.s, d }); else out(d, 0, false);
  }
  // Nothing else on this page pans: with the keyboard up, iOS would slide the whole page.
  screen.addEventListener('touchmove', (e) => { if (!e.target.closest('.keybar, .term-viewport, .conv, .conv-input')) e.preventDefault(); }, { passive: false });
  // No typing into xterm itself: the textarea below is the only way in.
  xterm.textarea?.setAttribute('inputmode', 'none');
  xterm.textarea?.setAttribute('readonly', '');
  // xterm focuses it on every mousedown, also the one a browser makes up after a tap: that would
  // take the focus from the keyboard field (or, after a tap that only stopped a scroll, bring the
  // keyboard up). It never takes the focus.
  if (xterm.textarea) xterm.textarea.focus = () => {};
  // What xterm itself sends: only mouse reports (the wheel, for full-screen programs). Keys come from
  // the phone's own field. Never focus reports: a blur of xterm's hidden input sent ESC [ O, which
  // a program that does not read it shows as "^[[O" in its input line; focus is Herdr's to report.
  xterm.onData((d) => {
    if (!page.s || !MOUSE_REPORT.test(d)) return;
    app.link.notify('term.input', { s: page.s, d });
    // A drag on xterm itself scrolled the program's view: count it, for ↓ and for typing after it.
    const ups = (d.match(/\x1b\[<64;|\x1b\[M`/g) ?? []).length, downs = (d.match(/\x1b\[<65;|\x1b\[Ma/g) ?? []).length;
    if (ups || downs) setBack(Math.max(0, back + ups - downs));
  });

  function write(b64data) {
    const bytes = unb64(b64data);
    xterm.write(bytes, () => {
      if (atCursor && !placing) { placing = true; requestAnimationFrame(() => { placing = false; layout(); }); }
      // Credit only what xterm has actually drawn: a slow phone slows the stream down.
      page.unacked += bytes.length;
      if (page.unacked >= 32 * 1024) { app.link.notify('term.ack', { s: page.s, n: page.unacked }); page.unacked = 0; }
    });
    clearTimeout(page.ackTimer);
    page.ackTimer = setTimeout(() => { if (page.unacked && page.s) { app.link.notify('term.ack', { s: page.s, n: page.unacked }); page.unacked = 0; } }, 100);
  }

  // ---- size: the Mac's columns and rows. Where the phone looks: while you type, at the cursor (the
  // keyboard takes half the screen); after you drag, where you dragged to.
  const cellNow = () => xterm._core?._renderService?.dimensions?.css?.cell;
  let atCursor = true, placing = false;
  viewport.addEventListener('touchmove', () => { atCursor = false; }, { passive: true });
  keys.addEventListener('focus', () => { atCursor = true; requestAnimationFrame(layout); });
  function layout() {
    if (viewport.hidden || !atCursor) return;
    const cell = cellNow();
    if (!cell?.width) return;
    const b = xterm.buffer.active;
    const x = b.cursorX * cell.width, y = (b.cursorY + 1) * cell.height;
    const w = viewport.clientWidth, hgt = viewport.clientHeight;
    if (x < viewport.scrollLeft || x > viewport.scrollLeft + w - 2 * cell.width) viewport.scrollLeft = Math.max(0, x - w / 3);
    if (y > viewport.scrollTop + hgt) viewport.scrollTop = y - hgt + cell.height / 2;
    else if (y - cell.height < viewport.scrollTop) viewport.scrollTop = Math.max(0, y - cell.height * 2);
  }
  function resizeTo(cols, rows) {
    if (cols === page.cols && rows === page.rows) return;
    page.cols = cols; page.rows = rows;
    xterm.resize(cols, rows);
    layout();
  }

  // ---- the stream
  async function open() {
    if (page.opening || page.closed || app.link?.status !== 'ready') return;
    page.opening = true;
    page.early = [];
    try {
      const r = await app.link.rpc('term.open', { address });
      if (page.closed) { app.link.rpc('term.close', { s: r.s }).catch(() => {}); return; }
      page.s = r.s;
      xterm.reset();
      resizeTo(r.cols, r.rows);
      setStatus('notice', '');
      for (const msg of page.early.splice(0)) onEvent(msg);
    } catch (e) {
      setStatus('notice', `打不开：${e.message}`);
    } finally { page.opening = false; }
  }

  function onList() {
    const t = app.list.terminals.find((x) => x.address === address);
    if (!t) { setStatus('notice', '这个终端已经结束。'); return; }
    title.textContent = t.app || t.program || address;
    sub.textContent = [t.where, t.state === 'blocked' ? (KIND_TEXT[t.kind] ?? '等你处理') : STATE_TEXT[t.state]].filter(Boolean).join(' · ');
    resizeTo(t.cols, t.rows); // follow the size the Mac windows set
    showMode();
    const blocked = t.state === 'blocked';
    conv?.state(t);
    keyBtns.forEach((b) => b.classList.toggle('answer', blocked && ANSWERS.has(b.dataset.label)));
    // While the program asks, typing waits: a letter could answer its question.
    line.hold(blocked);
    sync();
  }

  function onEvent(msg) {
    // The first paint can arrive before term.open's reply: hold it until we know our stream id.
    if (page.s === null && page.opening) { page.early.push(msg); return; }
    if (msg.s !== page.s) return;
    if (msg.ev === 'out') write(msg.d);
    else if (msg.ev === 'closed') {
      page.s = null;
      if (msg.reason === 'replaced' || page.closed) return;
      setStatus('notice', msg.reason === 'exited' ? `程序已退出${msg.exitCode !== null && msg.exitCode !== undefined ? `（${msg.exitCode}）` : ''}` : '连接断开，正在重连…');
      if (msg.reason !== 'exited') setTimeout(open, 800);
    }
  }

  // ---- typing: everything goes out in order; an image path waits for the program to read the file.
  let chain = Promise.resolve();
  function out(d, after = 0, follow = true) {
    if (follow) toLatest();
    chain = chain.then(async () => {
      if (page.s) {
        app.link.notify('term.input', { s: page.s, d });
        if (follow) { xterm.scrollToBottom(); atCursor = true; layout(); }
      }
      if (after) await new Promise((r) => setTimeout(r, after));
    });
  }
  const line = new LiveLine((d) => out(d));
  /** The textarea shows the burst; the bubble says what the line cannot. */
  function sync() {
    if (keys.value !== line.value) keys.value = line.value;
    const blocked = line.held;
    const say = status.voice ? status.voice
      : status.uploading ? { text: `上传图片 ${status.uploading}…` }
      : status.composing ? { text: status.composing }
      : line.pending ? { text: `等你回答后输入：${line.pending}`, kind: 'warn' }
      : blocked ? { text: '终端在问你：用蓝色键回答', kind: 'warn' }
      : status.notice ? { text: status.notice, kind: 'warn' }
      : null;
    bubble.hidden = !say;
    if (!say) return;
    bubble.className = `term-bubble ${say.kind ?? ''}`;
    fill(bubble, say.level !== undefined ? h('span', { class: 'voice-level', style: `transform:scaleX(${0.08 + say.level * 0.92})` }) : null, h('span', {}, say.text));
  }
  function setStatus(k, v) { status[k] = v; sync(); }

  keys.addEventListener('compositionstart', () => { line.compose(true); });
  keys.addEventListener('compositionupdate', (e) => setStatus('composing', e.data ?? ''));
  keys.addEventListener('compositionend', () => { status.composing = ''; line.compose(false); line.set(keys.value); sync(); });
  keys.addEventListener('input', (e) => { if (e.isComposing) { line.value = keys.value; return; } line.set(keys.value); sync(); });
  keys.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === 'Backspace' && !keys.value) { e.preventDefault(); line.backspace(); return; }
    const seq = HW_KEYS[e.key] ?? (e.ctrlKey && !e.metaKey && /^[a-z]$/i.test(e.key) ? String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64) : null);
    if (seq) { e.preventDefault(); key(seq); }
  });
  keys.addEventListener('focus', () => kbdBtn.classList.add('on'));
  keys.addEventListener('blur', () => kbdBtn.classList.remove('on'));

  /** A key: the program owns what went in (Tab may complete it), then the key. */
  function key(seq) {
    vibrate(6);
    line.commit(); sync();
    out(seq);
  }
  function submit() {
    if (!line.submit()) { toast('先回答终端里的问题（1 / 2 / 3、⏎ 或 Esc），刚打的字随后会进去'); return; }
    vibrate();
    sync();
  }
  function insert(text) {
    if (convMode) {
      convInput.value += (convInput.value && !/\s$/.test(convInput.value) ? ' ' : '') + text;
      sizeConvInput();
      return;
    }
    const sep = line.value && !/\s$/.test(line.value) ? ' ' : '';
    line.set(line.value + sep + text);
    sync();
  }

  // ---- images go into the program's line as their own pastes: Claude Code / Codex show [Image #N].
  function pick() {
    if (line.held) { toast('先回答终端里的问题，再插图片'); return; }
    picker.click();
  }
  picker.addEventListener('change', async () => {
    const files = [...picker.files].slice(0, 6);
    picker.value = '';
    try {
      for (const [i, file] of files.entries()) {
        setStatus('uploading', `${i + 1}/${files.length}`);
        const blob = await shrinkImage(file);
        const id = await upload(app.link, blob);
        const { path } = await app.link.rpc('image.put', { id, address, name: file.name || 'image' }, 30_000);
        line.commit(); sync();
        out(pasteText(quotePath(path)), IMAGE_GAP_MS);
        out(' ');
      }
    } catch (e) { toast(`图片没发出去：${e.message}`, 'err'); } finally { setStatus('uploading', ''); }
  });

  // ---- hold to talk: speak, release → the words go into the program's line (Enter still yours).
  // The microphone takes a moment to start (the first time, iOS asks for permission meanwhile): a
  // finger lifted before that is a release too, else a tap would record until the time limit.
  {
    let rec = null, startY = 0, cancelled = false, raf = 0, limit = 0, held = false;
    const show = (text, kind = 'rec') => { status.voice = text ? { text, kind, level: rec ? rec.level() : undefined } : null; sync(); };
    const meter = () => {
      if (!rec) return;
      const left = Math.ceil((MAX_MS - (Date.now() - rec.started)) / 1000);
      show(cancelled ? '松开 取消' : left <= 10 ? `还剩 ${left} 秒 · 松开 输入` : '松开 输入 · 上滑 取消', cancelled ? 'rec cancel' : 'rec');
      raf = requestAnimationFrame(meter);
    };
    const begin = async (e) => {
      e.preventDefault();
      if (!voiceOk) { toast(app.info?.voice ? '这个浏览器不能录音' : '这台 Mac 没开语音识别：在 Mac 上运行 herdr-relay voice 设置'); return; }
      if (rec || held || talkBtn.disabled) return;
      held = true;
      startY = e.clientY;
      cancelled = false;
      talkBtn.setPointerCapture?.(e.pointerId);
      let r;
      try { r = await startRecording(); } catch (error) {
        held = false;
        toast(error.name === 'NotAllowedError' ? '没有麦克风权限：在 设置 → Safari → 麦克风 里允许' : `录音失败：${error.message}`, 'err');
        return;
      }
      if (!held) { r.cancel(); toast('按住说话，松开输入'); return; } // let go before it started
      rec = r;
      vibrate(15);
      talkBtn.classList.add('on');
      talkBtn.textContent = '松开 输入';
      meter();
      limit = setTimeout(() => finish(), MAX_MS);
    };
    const move = (e) => {
      if (!rec) return;
      const away = startY - e.clientY > 60;
      if (away !== cancelled) { cancelled = away; vibrate(5); }
    };
    const finish = async () => {
      held = false;
      if (!rec) return;
      const r = rec;
      rec = null;
      clearTimeout(limit);
      cancelAnimationFrame(raf);
      talkBtn.classList.remove('on');
      talkBtn.textContent = '按住 说话';
      if (cancelled || Date.now() - r.started < 400) { r.cancel(); show(null); if (!cancelled) toast('按住说话，松开输入'); return; }
      const blob = await r.stop();
      talkBtn.disabled = true;
      show('识别中…', 'busy');
      try {
        const { text } = await transcribe(app.link, blob, { address });
        if (text) { insert(text); vibrate(10); } else toast('没听清，请再说一次');
      } catch (error) {
        toast(error.message, 'err');
      } finally { talkBtn.disabled = false; show(null); }
    };
    talkBtn.addEventListener('pointerdown', begin);
    talkBtn.addEventListener('pointermove', move);
    talkBtn.addEventListener('pointerup', finish);
    talkBtn.addEventListener('pointercancel', () => { cancelled = true; finish(); });
    // iOS can lose the button's pointerup (the microphone starting mid-press): a finger lifted
    // anywhere is a release too, else it records on until the time limit.
    const lifted = (e) => { if ((held || rec) && !(e.touches?.length)) finish(); };
    window.addEventListener('touchend', lifted, true);
    window.addEventListener('pointerup', lifted, true);
    page.stopTalk = () => { window.removeEventListener('touchend', lifted, true); window.removeEventListener('pointerup', lifted, true); if (rec) { cancelled = true; finish(); } };
    talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- with the keyboard up, the page follows the visible viewport: on iOS the keyboard covers the
  // page instead of resizing it. Otherwise CSS holds it (inset 0): the toolbars of iOS browsers
  // grow and shrink as you touch the page, and following them made the layout jump.
  // "Keyboard up" needs our field focused: iOS does not always report the last viewport change
  // when the keyboard goes away, and a stale height left the page at half the screen. On blur the
  // page goes back to full height at once, and is checked again while the keyboard slides away.
  const vv = window.visualViewport;
  let checks = [];
  const followViewport = () => {
    if (!vv) return;
    const keyboard = (document.activeElement === keys || document.activeElement === convInput) && window.innerHeight - vv.height > 120;
    screen.style.height = keyboard ? `${vv.height}px` : '';
    screen.style.transform = keyboard && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    if (!keyboard && (window.scrollX || window.scrollY)) window.scrollTo(0, 0); // iOS scrolled the page for the field
  };
  const recheck = () => {
    followViewport();
    checks.forEach(clearTimeout);
    checks = [100, 300, 600, 1000].map((ms) => setTimeout(followViewport, ms));
  };
  vv?.addEventListener('resize', followViewport);
  vv?.addEventListener('scroll', followViewport);
  window.addEventListener('resize', recheck);
  window.addEventListener('orientationchange', recheck);
  for (const f of [keys, convInput]) { f.addEventListener('focus', recheck); f.addEventListener('blur', recheck); }
  followViewport();
  const ro = new ResizeObserver(() => layout());
  ro.observe(viewport);
  requestAnimationFrame(layout);

  Object.assign(page, {
    onEvent, onList,
    onConv(msg) { conv?.onEvent(msg); },
    reopen() {
      page.s = null; open();
      // A new connection: the Mac forgot the old conversation; open it again.
      if (conv) { conv.close(); conv = null; if (convMode) startConv(); }
    },
    lost() { if (page.s) { page.s = null; setStatus('notice', '连接断开，正在重连…'); } },
    dispose() {
      toLatest(true); // leave the Mac's view at the latest too, before the stream closes
      page.closed = true;
      ro.disconnect();
      vv?.removeEventListener('resize', followViewport);
      vv?.removeEventListener('scroll', followViewport);
      window.removeEventListener('resize', recheck);
      window.removeEventListener('orientationchange', recheck);
      checks.forEach(clearTimeout);
      screen.style.height = screen.style.transform = '';
      stopTouch();
      conv?.close();
      page.stopTalk?.();
      clearTimeout(page.ackTimer);
      if (page.s && app.link?.status === 'ready') app.link.rpc('term.close', { s: page.s }).catch(() => {});
      xterm.dispose();
    },
  });
  onList();
  open();
  if (convMode) startConv();
}

// ------------------------------------------------------------------ push -------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const raw = atob((base64String + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('没有获得通知权限（可在系统设置里打开）', 'err'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = app.info?.vapidPublicKey;
    if (sub && key && sub.options?.applicationServerKey) {
      const current = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (current !== key) { await sub.unsubscribe(); sub = null; }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
    await app.link.rpc('push.subscribe', { subscription: sub.toJSON() });
    app.info = { ...app.info, hasPush: true };
    const store = load(); store.push = true; save(store);
    toast('通知已开启', 'ok');
    if (app.view.name === 'settings') render();
  } catch (e) { toast(`开启失败：${e.message}`, 'err'); }
}

async function maybeResubscribePush() {
  if (!load().push || !('serviceWorker' in navigator) || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && !app.info?.hasPush) await app.link.rpc('push.subscribe', { subscription: sub.toJSON() });
  } catch {}
}

async function forget() {
  if (!confirm('取消与这台 Mac 的配对？之后需要重新扫码。')) return;
  try { await app.link.rpc('device.forget'); } catch {}
  app.link?.close();
  const store = load(); delete store.desktop; save(store);
  app.view = { name: 'welcome' };
  render();
}

// ------------------------------------------------------------------ boot -------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.open?.address) openFromNotification(e.data.open.address); });
function openFromNotification(address) {
  if (app.link?.status === 'ready') openTerm(address);
  else app.pendingOpen = address;
}

(function boot() {
  const params = new URLSearchParams(location.search);
  const desktop = currentDesktop();
  if (location.hash.includes('p=') || !desktop) { app.view = { name: 'welcome' }; render(); return; }
  const target = params.get('t');
  if (target) history.replaceState(null, '', '/');
  render();
  const link = connect(desktop);
  if (target) link.addEventListener('ready', () => openTerm(target), { once: true });
})();
