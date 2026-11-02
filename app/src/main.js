/**
 * herdr phone app (PWA). Screens: welcome/pairing → home (terminals grouped like Herdr.app) →
 * terminal (xterm.js + key bar + message box).
 *
 * All Mac traffic goes through Link (E2E encrypted). The terminal renders at the Mac's size and is
 * scaled down to fit the phone; "适配手机" makes the terminal itself the phone's size (the Mac
 * windows showing it shrink too). See DESIGN.md「多个窗口怎么同步」.
 */
import { Terminal } from '@xterm/xterm';
import { b64, boxKeysFromSecret, decodePairLink, newBoxKeys, unb64 } from '../../shared/e2e.js';
import { Link } from './link.js';
import { scanQr } from './scan.js';
import { touchScroll } from './touch-scroll.js';
import { commandText, keystrokes } from './live-command.js';
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
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
};
const icon = (name) => { const s = h('span', { class: 'ico' }); s.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`; return s; };

// ------------------------------------------------------------------ storage ----
// The device keypair lives in localStorage on this origin (the relay we paired with, which also
// serves this script). The pairing link and the E2E handshake protect the channel itself.
const STORE_KEY = 'herdr-relay';
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
  const link = new Link({ relay: desktop.relay, desktopId: desktop.id, desktopKey: desktop.k, deviceKeys: deviceKeys(), pair });
  app.link = link;
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
    ? (core === 'online' ? ['ok', '已连接'] : ['err', 'herdr 未运行'])
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
        h('h2', {}, space.name || base(space.folder) || '工作区'),
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
const KEYBAR = [
  ['Esc', ['esc']], ['Tab', ['tab']], ['^C', ['ctrl+c']], ['↑', ['up']], ['↓', ['down']], ['←', ['left']], ['→', ['right']],
  ['⏎', ['enter']], ['1', ['1']], ['2', ['2']], ['3', ['3']], ['y', ['y']], ['n', ['n']], ['^D', ['ctrl+d']], ['⇧Tab', ['shift+tab']],
];
const SEQ = { esc: '\x1b', tab: '\t', 'ctrl+c': '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', 'ctrl+d': '\x04', 'shift+tab': '\x1b[Z', 1: '1', 2: '2', 3: '3', y: 'y', n: 'n' };

function termTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { background: '#111110', foreground: '#e6e6e1', cursor: '#e6e6e1', selectionBackground: '#3a3a36' }
    : { background: '#fbfbf9', foreground: '#1a1a18', cursor: '#1a1a18', selectionBackground: '#d9d8d2' };
}

function openTerm(address) {
  app.term?.dispose();
  app.view = { name: 'term', address };
  const t0 = app.list.terminals.find((t) => t.address === address);
  const fitKey = `fit:${address}`;
  const page = {
    address, s: null, xterm: null, fit: load()[fitKey] === true, closed: false, cols: t0?.cols ?? 80, rows: t0?.rows ?? 24, unacked: 0, opening: false, early: [], typed: '',
  };
  app.term = page;

  const title = h('b', {}, t0?.app || t0?.program || address);
  const sub = h('span', { class: 'status' }, t0?.where ?? address);
  const fitBtn = h('button', { class: `icon-btn ${page.fit ? 'on' : ''}`, 'aria-label': '适配手机', onClick: toggleFit }, icon('fit'));
  const host = h('div', { class: 'xterm-host' });
  const viewport = h('div', { class: 'term-viewport' }, host);
  const notice = h('div', { class: 'term-notice', hidden: true });
  const input = h('textarea', { class: 'term-input', rows: 1, placeholder: '发消息', enterkeyhint: 'send', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const sendBtn = h('button', { class: 'round send', 'aria-label': '发送', onClick: () => submit(false) }, icon('send'));
  const micBtn = app.info?.voice && voiceSupported() ? h('button', { class: 'round mic', 'aria-label': '按住说话' }, icon('mic')) : null;
  const voiceHud = h('div', { class: 'voice-hud', hidden: true }, h('span', { class: 'voice-level' }), h('span', { class: 'voice-text' }, '松开识别 · 上滑取消'));
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const attachBtn = h('button', { class: 'round ghost', 'aria-label': '添加图片', onClick: () => picker.click() }, icon('plus'));
  const attachRow = h('div', { class: 'attachments', hidden: true });
  const cmdHint = h('div', { class: 'cmd-hint', hidden: true }, '命令模式：边打边进终端 · ↑↓ / Tab 选择 · 发送 = 回车');
  const keybar = h('div', { class: 'keybar' },
    h('button', { class: 'key', 'aria-label': '直接打字', onClick: () => { vibrate(); page.xterm?.focus(); } }, icon('kbd')),
    KEYBAR.map(([label, keys]) => h('button', { class: 'key', onClick: () => pressKeys(keys) }, label)));
  page.images = [];

  fill(root(), h('main', { class: 'screen term' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', 'aria-label': '返回', onClick: () => { app.view = { name: 'home' }; render(); } }, icon('back')),
      h('div', { class: 'bar-title' }, title, sub),
      fitBtn),
    viewport, notice,
    h('footer', { class: 'term-foot' }, voiceHud, keybar, attachRow, cmdHint,
      h('div', { class: 'composer' }, attachBtn, picker, h('div', { class: 'field-wrap' }, input), micBtn, sendBtn))));

  /** iMessage style: the mic while the box is empty, send once there is something to send. */
  function updateAction() {
    const has = input.value.trim() !== '' || page.images.length > 0;
    sendBtn.hidden = Boolean(micBtn) && !has;
    if (micBtn) micBtn.hidden = has;
  }
  function renderAttachments() {
    attachRow.hidden = page.images.length === 0;
    fill(attachRow, page.images.map((img) => h('div', { class: 'thumb' },
      h('img', { src: img.url, alt: '' }),
      h('button', { class: 'thumb-x', 'aria-label': '移除', onClick: () => { URL.revokeObjectURL(img.url); page.images.splice(page.images.indexOf(img), 1); renderAttachments(); updateAction(); } }, '×'))));
  }
  picker.addEventListener('change', async () => {
    const files = [...picker.files].slice(0, Math.max(0, 6 - page.images.length));
    picker.value = '';
    for (const file of files) {
      const blob = await shrinkImage(file);
      page.images.push({ blob, name: file.name || 'image', url: URL.createObjectURL(blob) });
    }
    renderAttachments();
    updateAction();
    mirror();
  });

  const xterm = new Terminal({
    cols: page.cols, rows: page.rows, scrollback: 3000, fontSize: 13, lineHeight: 1.0,
    fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace', theme: termTheme(), cursorBlink: false,
    allowProposedApi: false, convertEol: false, macOptionIsMeta: true,
  });
  page.xterm = xterm;
  xterm.open(host);
  const stopTouch = touchScroll(viewport, xterm); // xterm 6 ignores finger drags
  // Keystrokes typed straight into the terminal (hardware keyboard, or the 直接打字 button).
  xterm.onData((d) => { if (page.s) app.link.notify('term.input', { s: page.s, d }); });

  function write(b64data) {
    const bytes = unb64(b64data);
    xterm.write(bytes, () => {
      // Credit only what xterm has actually drawn: a slow phone slows the stream down.
      page.unacked += bytes.length;
      if (page.unacked >= 32 * 1024) { app.link.notify('term.ack', { s: page.s, n: page.unacked }); page.unacked = 0; }
    });
    clearTimeout(page.ackTimer);
    page.ackTimer = setTimeout(() => { if (page.unacked && page.s) { app.link.notify('term.ack', { s: page.s, n: page.unacked }); page.unacked = 0; } }, 100);
  }

  /**
   * Pick a font size so the Mac's columns fit the phone's width, but never below MIN_FONT (an
   * unreadable screen helps nobody): past that the terminal scrolls sideways. No CSS transform:
   * xterm measures its cells from the DOM, and a scaled parent breaks the measurement.
   */
  const MIN_FONT = 8, MAX_FONT = 14;
  function layout() {
    const w = viewport.clientWidth - 8;
    if (!w) return;
    const cell = xterm._core?._renderService?.dimensions?.css?.cell;
    const ratio = cell?.width ? cell.width / xterm.options.fontSize : 0.6;
    const want = Math.max(MIN_FONT, Math.min(MAX_FONT, Math.floor((w / page.cols / ratio) * 2) / 2));
    if (want !== xterm.options.fontSize) xterm.options.fontSize = want;
  }

  /** Cells that fit the phone at the base font size (used only for 适配手机). */
  function phoneSize() {
    // Measured at a comfortable 13px, whatever the current font is.
    const cell = xterm._core?._renderService?.dimensions?.css?.cell;
    const k = cell?.width ? 13 / xterm.options.fontSize : 1;
    const cw = (cell?.width || 7.8) * k;
    const ch = (cell?.height || 15) * k;
    const w = viewport.parentElement.clientWidth - 8;
    const free = window.innerHeight - viewport.getBoundingClientRect().top - $('.term-foot').offsetHeight - 8;
    return { cols: Math.max(20, Math.floor(w / cw)), rows: Math.max(8, Math.floor(free / ch)) };
  }

  function resizeTo(cols, rows) {
    if (cols === page.cols && rows === page.rows) return;
    page.cols = cols; page.rows = rows;
    xterm.resize(cols, rows);
    layout();
  }

  async function open() {
    if (page.opening || page.closed || app.link?.status !== 'ready') return;
    page.opening = true;
    page.early = [];
    try {
      const r = await app.link.rpc('term.open', { address, fit: page.fit ? phoneSize() : undefined });
      if (page.closed) { app.link.rpc('term.close', { s: r.s }).catch(() => {}); return; }
      page.s = r.s;
      page.typed = ''; // a new stream: whatever we typed before is the agent's business now
      xterm.reset();
      resizeTo(r.cols, r.rows);
      notice.hidden = true;
      const early = page.early.splice(0);
      for (const msg of early) onEvent(msg);
    } catch (e) {
      notice.hidden = false;
      notice.textContent = `打不开：${e.message}`;
    } finally { page.opening = false; }
  }

  function onList() {
    const t = app.list.terminals.find((x) => x.address === address);
    if (!t) { notice.hidden = false; notice.textContent = '这个终端已经结束。'; return; }
    title.textContent = t.app || t.program || address;
    sub.textContent = [t.where, t.state === 'blocked' ? (KIND_TEXT[t.kind] ?? '等你处理') : STATE_TEXT[t.state]].filter(Boolean).join(' · ');
    // Follow the Mac windows' size (the host restates it before every keystroke).
    if (!page.fit) resizeTo(t.cols, t.rows);
  }

  function onEvent(msg) {
    // The first paint can arrive before term.open's reply: hold it until we know our stream id.
    if (page.s === null && page.opening) { page.early.push(msg); return; }
    if (msg.s !== page.s) return;
    if (msg.ev === 'out') write(msg.d);
    else if (msg.ev === 'closed') {
      page.s = null;
      if (msg.reason === 'replaced' || page.closed) return;
      notice.hidden = false;
      notice.textContent = msg.reason === 'exited' ? `程序已退出${msg.exitCode !== null && msg.exitCode !== undefined ? `（${msg.exitCode}）` : ''}` : '连接断开，正在重连…';
      if (msg.reason !== 'exited') setTimeout(open, 800);
    }
  }

  /** Mirror a "/command" into the terminal as it is typed (see live-command.js). */
  function mirror() {
    const want = page.images.length ? '' : commandText(input.value);
    cmdHint.hidden = !want;
    input.closest('.composer')?.classList.toggle('cmd', Boolean(want));
    if (!page.s || want === page.typed) return;
    app.link.notify('term.input', { s: page.s, d: keystrokes(page.typed, want) });
    page.typed = want;
  }

  async function submit(force) {
    const text = input.value;
    if (page.s && page.typed && page.typed === commandText(text)) {
      // Already in the terminal, menu and all: Enter runs it (or picks the highlighted entry).
      app.link.notify('term.input', { s: page.s, d: '\r' });
      page.typed = '';
      input.value = '';
      autosize();
      mirror();
      updateAction();
      vibrate();
      return;
    }
    if (!text.trim() && !page.images.length) return;
    sendBtn.disabled = true;
    try {
      // Images first: each lands as a file beside the terminal (terminal.put); the message carries
      // their paths, which Claude Code and Codex pick up as image attachments.
      const paths = [];
      for (const [i, img] of page.images.entries()) {
        sendBtn.dataset.progress = `${i + 1}/${page.images.length}`;
        const id = await upload(app.link, img.blob);
        const r = await app.link.rpc('image.put', { id, address, name: img.name }, 30_000);
        paths.push(/\s/.test(r.path) ? `"${r.path}"` : r.path);
      }
      delete sendBtn.dataset.progress;
      await app.link.rpc('term.send', { address, text: [...paths, text.trim()].filter(Boolean).join(' '), force }, 20_000);
      input.value = '';
      for (const img of page.images) URL.revokeObjectURL(img.url);
      page.images = [];
      renderAttachments();
      autosize();
      updateAction();
      vibrate();
    } catch (e) {
      toast(e.message, 'err');
    } finally { sendBtn.disabled = false; delete sendBtn.dataset.progress; }
  }

  function pressKeys(keys) {
    vibrate(6);
    // Through the stream when open (instant, same path as typing), else through terminal.keys.
    if (page.s && keys.every((k) => SEQ[k] !== undefined)) app.link.notify('term.input', { s: page.s, d: keys.map((k) => SEQ[k]).join('') });
    else app.link.rpc('term.keys', { address, keys }).catch((e) => toast(e.message, 'err'));
  }

  async function toggleFit() {
    page.fit = !page.fit;
    const store = load(); store[fitKey] = page.fit; save(store);
    fitBtn.classList.toggle('on', page.fit);
    if (page.fit) toast('已适配手机：Mac 上这个窗格也会变窄。再点一次还原。');
    if (!page.s) return;
    const want = page.fit ? phoneSize() : null;
    try {
      await app.link.rpc('term.fit', { s: page.s, fit: want });
      if (want) resizeTo(want.cols, want.rows);
      else onList();
      layout();
    } catch (e) { toast(e.message, 'err'); }
  }

  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
  input.addEventListener('input', () => { autosize(); updateAction(); mirror(); });
  updateAction();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(e.metaKey || e.ctrlKey); }
  });
  sendBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); submit(true); });

  // ---- hold-to-talk: press the mic, speak, release → text lands in the message box (not sent).
  if (micBtn) {
    let rec = null;
    let startY = 0;
    let cancelled = false;
    let raf = 0;
    let limit = 0;
    const hud = (text, cls = '') => { voiceHud.hidden = !text; voiceHud.className = `voice-hud ${cls}`; $('.voice-text', voiceHud).textContent = text ?? ''; };
    const meter = () => {
      if (!rec) return;
      $('.voice-level', voiceHud).style.transform = `scaleX(${0.08 + rec.level() * 0.92})`;
      const left = Math.ceil((MAX_MS - (Date.now() - rec.started)) / 1000);
      if (left <= 10) $('.voice-text', voiceHud).textContent = `还剩 ${left} 秒 · 松开识别`;
      raf = requestAnimationFrame(meter);
    };
    const begin = async (e) => {
      e.preventDefault();
      if (rec || micBtn.disabled) return;
      startY = e.clientY;
      cancelled = false;
      micBtn.setPointerCapture?.(e.pointerId);
      try {
        rec = await startRecording();
      } catch (error) {
        toast(error.name === 'NotAllowedError' ? '没有麦克风权限：在 设置 → Safari → 麦克风 里允许' : `录音失败：${error.message}`, 'err');
        return;
      }
      vibrate(15);
      micBtn.classList.add('on');
      hud('松开识别 · 上滑取消', 'rec');
      meter();
      limit = setTimeout(() => finish(), MAX_MS);
    };
    const move = (e) => {
      if (!rec) return;
      const out = startY - e.clientY > 60;
      if (out !== cancelled) { cancelled = out; hud(out ? '松开取消' : '松开识别 · 上滑取消', out ? 'rec cancel' : 'rec'); vibrate(5); }
    };
    const finish = async () => {
      if (!rec) return;
      const r = rec;
      rec = null;
      clearTimeout(limit);
      cancelAnimationFrame(raf);
      micBtn.classList.remove('on');
      if (cancelled || Date.now() - r.started < 400) { r.cancel(); hud(null); if (!cancelled) toast('按住麦克风说话，松开识别'); return; }
      const blob = await r.stop();
      micBtn.disabled = true;
      hud('识别中…', 'busy');
      try {
        const { text } = await transcribe(app.link, blob, { address });
        if (!text) { toast('没听清，请再说一次'); return; }
        const at = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, at);
        const sep = before && !/\s$/.test(before) ? ' ' : '';
        input.value = before + sep + text + input.value.slice(at);
        autosize();
        updateAction();
        vibrate(10);
      } catch (error) {
        toast(error.message, 'err');
      } finally {
        micBtn.disabled = false;
        hud(null);
      }
    };
    micBtn.addEventListener('pointerdown', begin);
    micBtn.addEventListener('pointermove', move);
    micBtn.addEventListener('pointerup', finish);
    micBtn.addEventListener('pointercancel', () => { cancelled = true; finish(); });
    micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  const ro = new ResizeObserver(() => layout());
  ro.observe(viewport.parentElement);
  requestAnimationFrame(layout);

  Object.assign(page, {
    onEvent, onList,
    reopen() { page.s = null; open(); },
    lost() { if (page.s) { page.s = null; notice.hidden = false; notice.textContent = '连接断开，正在重连…'; } },
    dispose() {
      page.closed = true;
      ro.disconnect();
      stopTouch();
      clearTimeout(page.ackTimer);
      if (page.s && app.link?.status === 'ready') app.link.rpc('term.close', { s: page.s }).catch(() => {});
      xterm.dispose();
    },
  });
  onList();
  open();
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
