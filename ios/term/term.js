/**
 * The terminal inside the native app's WebView: xterm.js with Unicode 15 graphemes, atomic
 * repaints (paint.js), VS15 text-style symbols (text-style.js), and finger scrolling (touch-scroll.js).
 * The connection and all controls live in the native app (QuickJS).
 *
 *   app → page  {t:'open', sized, reopened, cols, rows, hist?}  {t:'size', cols, rows}
 *               {t:'out', d:<base64>, fresh?, hist?, older?}  {t:'reset'}
 *               {t:'typing'}                             {t:'toLatest'}
 *               {t:'ping', id}
 *   page → app  {t:'ready', fit}   {t:'fit', fit}        {t:'ack', n}
 *               {t:'drawn', cursorHidden, appCursor}     {t:'atLatest', on}
 *               {t:'wheel', d}     {t:'coast', stop?, d?, v?, cell?}
 *               {t:'tap'}          {t:'openUrl', url}    {t:'copy', text}
 *               {t:'haptic'}       {t:'pong', id}        {t:'log', m}
 *               {t:'more', have}   (older history, DESIGN.md「往回翻历史」)
 *               {t:'diag', ev, ...}
 */
import { Terminal } from '@xterm/xterm';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { touchScroll } from '../../app/src/touch-scroll.js';
import { atomic, indexOf, SYNC_OFF, SYNC_ON } from '../../app/src/paint.js';
import { linkAt, rangeLength, safeHttpUrl, selectionFromCells, wordRangeAt } from '../../app/src/term-select.js';
import { textStyle } from '../../app/src/text-style.js';
import { coastSteps } from '../../shared/coast.js';
import { initial as historyInitial, MORE_MAX, step as historyStep, topLabel } from '../../app/src/history-more.js';

const post = (v) => window.nsh?.postMessage(JSON.stringify(v));
const diag = (ev, detail = {}) => post({ t: 'diag', ev, ...detail });
const enc = (s) => new TextEncoder().encode(s);
const CLEAR_2J = enc('\x1b[2J');
const CLEAR_J = enc('\x1b[J');
const ALT_ON = enc('\x1b[?1049h');
const ALT_OFF = enc('\x1b[?1049l');
const SYNC_WATCH_MS = 250;
const SYNC_UNLOCK_MS = 600;
const theme = { background: '#000000', foreground: '#f2f2f7', cursor: '#f2f2f7', selectionBackground: 'rgba(10, 132, 255, 0.36)' };
document.documentElement.style.background = theme.background;

const viewport = document.getElementById('vp');
const host = document.getElementById('host');
const FONT = 12;
const PAD_X = 12, PAD_Y = 8; // #vp padding: 4px top/bottom, 6px left/right
const MOUSE_REPORT = /^(\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

let cols = 80, rows = 24, sized = false, clearHistory = false;
const xterm = new Terminal({
  // Room for the most history the Mac sends (MORE_MAX rows) and the screen.
  cols, rows, scrollback: MORE_MAX + 200, fontSize: FONT, lineHeight: 1.0, theme,
  fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace', cursorBlink: false, macOptionIsMeta: true,
  allowProposedApi: true,
});
xterm.loadAddon(new UnicodeGraphemesAddon());
xterm.unicode.activeVersion = '15-graphemes';
xterm.open(host);

// No keyboard from the WebView: the native Input below is the only keyboard.
xterm.textarea?.setAttribute('inputmode', 'none');
xterm.textarea?.setAttribute('readonly', '');
if (xterm.textarea) xterm.textarea.focus = () => {};

const cellNow = () => xterm._core?._renderService?.dimensions?.css?.cell;

// ---- phone grid (fit): rows are counted with the keyboard down so popping the keyboard never redraws.
let lastWidth = 0, fullHeight = 0, lastFitKey = '', booted = false; // no 'fit' before 'ready': it carries the first grid
function fitNow() {
  const cell = cellNow();
  const w = viewport.clientWidth - PAD_X, h = viewport.clientHeight - PAD_Y;
  if (!cell?.width || !cell?.height || w <= 0 || h <= 0) return null;
  if (Math.abs(w - lastWidth) > 2) { lastWidth = w; fullHeight = h; }
  else if (h > fullHeight) fullHeight = h;
  return { cols: Math.floor(w / cell.width), rows: Math.floor((fullHeight || h) / cell.height) };
}
function reportFit() {
  if (!booted) return;
  const fit = fitNow();
  if (!fit) return;
  const key = `${fit.cols}x${fit.rows}`;
  if (key === lastFitKey) return;
  lastFitKey = key;
  diag('term.fit_change', { fit, vpW: viewport.clientWidth, vpH: viewport.clientHeight, fullH: fullHeight });
  post({ t: 'fit', fit });
}

// ---- render & sync diagnostics (geometry & control flags only; never logs terminal text)
let expectFrame = '';
let syncPending = null;
let lastVpKey = '';
let lastRoutineFrameAt = 0;
const ROUTINE_FRAME_MIN_MS = 500;

function bufferStats() {
  const b = xterm.buffer.active;
  let nonEmpty = 0;
  for (let y = 0; y < xterm.rows; y++) {
    if (b.getLine(b.viewportY + y)?.translateToString(true).trim()) nonEmpty++;
  }
  return {
    alt: b.type === 'alternate',
    cols: xterm.cols,
    rows: xterm.rows,
    baseY: b.baseY,
    vpY: b.viewportY,
    curY: b.cursorY,
    nonEmpty,
    st: Math.round(viewport.scrollTop),
    sl: Math.round(viewport.scrollLeft),
    vpW: viewport.clientWidth,
    vpH: viewport.clientHeight,
    hostW: host.scrollWidth,
    hostH: host.scrollHeight,
  };
}

function abortSyncWatch(why) {
  if (!syncPending) return;
  clearTimeout(syncPending.timer);
  clearTimeout(syncPending.unlockTimer);
  const p = syncPending;
  syncPending = null;
  diag('term.sync_abort', { why, from: p.from, to: p.to, waitMs: Math.round(performance.now() - p.t0) });
}

function armSyncWatch(from, to) {
  if (syncPending) {
    clearTimeout(syncPending.timer);
    clearTimeout(syncPending.unlockTimer);
  }
  const entry = { t0: performance.now(), from, to, stuck: false, timer: 0, unlockTimer: 0 };
  entry.timer = setTimeout(() => {
    if (syncPending !== entry) return;
    entry.stuck = true;
    diag('term.sync_stuck', { from, to, waitMs: Math.round(performance.now() - entry.t0), ...bufferStats() });
  }, SYNC_WATCH_MS);
  entry.unlockTimer = setTimeout(() => {
    if (syncPending !== entry) return;
    syncPending = null;
    xterm.write(SYNC_OFF);
    diag('term.sync_unlock', { from, to, waitMs: Math.round(performance.now() - entry.t0), ...bufferStats() });
  }, SYNC_UNLOCK_MS);
  syncPending = entry;
}

function finishSyncWatch(bytesLen, hasPaint, hasSyncOff, fresh) {
  if (!syncPending || (!hasPaint && !hasSyncOff)) return;
  clearTimeout(syncPending.timer);
  clearTimeout(syncPending.unlockTimer);
  const p = syncPending;
  syncPending = null;
  diag('term.sync_done', {
    from: p.from, to: p.to, waitMs: Math.round(performance.now() - p.t0),
    stuck: p.stuck, bytes: bytesLen, hasPaint, hasSyncOff, fresh,
  });
}

function inspectFrame(bytes, fresh, hasPaint) {
  const hasClear = indexOf(bytes, CLEAR_2J) >= 0 || indexOf(bytes, CLEAR_J) >= 0;
  const hasSyncOn = indexOf(bytes, SYNC_ON) >= 0;
  const hasSyncOff = indexOf(bytes, SYNC_OFF) >= 0;
  const hasAlt = indexOf(bytes, ALT_ON) >= 0 ? 'alt_on' : (indexOf(bytes, ALT_OFF) >= 0 ? 'alt_off' : '');
  const stateReason = expectFrame || (fresh ? 'fresh' : hasPaint ? 'paint' : hasClear ? 'clear' : hasAlt);
  if (stateReason) return { reason: stateReason, hasClear, hasSyncOn, hasSyncOff };
  if (bytes.length >= 32768) {
    const now = performance.now();
    if (now - lastRoutineFrameAt >= ROUTINE_FRAME_MIN_MS) {
      lastRoutineFrameAt = now;
      return { reason: 'large', hasClear, hasSyncOn, hasSyncOff };
    }
  }
  return { reason: '', hasClear, hasSyncOn, hasSyncOff };
}

// ---- follow latest & wheel tracking for full-screen programs
const follow = { x: true, y: true };
let placing = false, setLeft = 0, back = 0, lastAtLatest = true;

function latestRows() {
  const b = xterm.buffer.active;
  let last = b.cursorY;
  for (let y = xterm.rows - 1; y > b.cursorY; y--) {
    if (b.getLine(b.baseY + y)?.translateToString(true).trim()) { last = y; break; }
  }
  return { cursor: b.cursorY, last };
}
function atLatest(cell) {
  const { cursor, last } = latestRows();
  const top = viewport.scrollTop, bottom = top + viewport.clientHeight;
  return (last + 1) * cell.height <= bottom + 2 && (cursor * cell.height >= top - 2 || (last - cursor + 1) * cell.height > viewport.clientHeight);
}
function showLatest() {
  const on = back === 0 && follow.y && xterm.buffer.active.viewportY >= xterm.buffer.active.baseY;
  if (on !== lastAtLatest) { lastAtLatest = on; post({ t: 'atLatest', on }); }
}
function setBack(n) { back = n; showLatest(); }

function layout() {
  reportFit();
  const w = viewport.clientWidth, hgt = viewport.clientHeight;
  const vpKey = `${w}x${hgt}`;
  const vpChanged = booted && lastVpKey && vpKey !== lastVpKey;
  if (booted && w > 0 && hgt > 0) lastVpKey = vpKey;
  if (!follow.y || sel) {
    if (vpChanged) diag('term.viewport', { vpW: w, vpH: hgt, st: Math.round(viewport.scrollTop), hostH: host.scrollHeight, followY: false, cols, rows });
    if (sel) renderSel();
    return;
  }
  const cell = cellNow();
  if (!cell?.width) { setTimeout(layout, 60); return; }
  const b = xterm.buffer.active;
  if (follow.x) {
    const x = b.cursorX * cell.width;
    if (x < viewport.scrollLeft || x > viewport.scrollLeft + w - 2 * cell.width) viewport.scrollLeft = setLeft = Math.max(0, x - w / 3);
    else setLeft = viewport.scrollLeft;
  }
  const prevSt = viewport.scrollTop;
  if (!atLatest(cell)) {
    const { cursor, last } = latestRows();
    const want = Math.min((last + 1) * cell.height - hgt + cell.height / 2, Math.max(0, (cursor - 1) * cell.height));
    viewport.scrollTop = Math.max(0, want);
  }
  if (vpChanged || Math.abs(viewport.scrollTop - prevSt) > 200) {
    diag('term.viewport', {
      vpW: w, vpH: hgt, prevSt: Math.round(prevSt), st: Math.round(viewport.scrollTop),
      hostH: host.scrollHeight, followY: true, cols, rows,
    });
  }
}

// ---- link tap & long-press text selection with iOS-style drag handles
const selUi = document.getElementById('sel-ui');
const selStartEl = document.getElementById('sel-s');
const selEndEl = document.getElementById('sel-e');
const selBarEl = document.getElementById('sel-bar');
const selCopyBtn = document.getElementById('sel-copy');
const selOpenBtn = document.getElementById('sel-open');

let sel = null; // { start: { row, col }, end: { row, col }, url }
let lpAnchor = null;
let flashTimer = 0;

function cellAtPoint(clientX, clientY) {
  const cell = cellNow();
  const screen = xterm.element?.querySelector('.xterm-screen');
  if (!cell?.width || !cell?.height || !screen) return null;
  const rect = screen.getBoundingClientRect();
  const col = Math.max(0, Math.min(cols - 1, Math.floor((clientX - rect.left) / cell.width)));
  const screenRow = Math.max(0, Math.min(rows - 1, Math.floor((clientY - rect.top) / cell.height)));
  const b = xterm.buffer.active;
  const absRow = Math.max(0, Math.min(b.length - 1, b.viewportY + screenRow));
  return { col, absRow };
}

function clearSel() {
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
  lpAnchor = null;
  if (!sel) return;
  sel = null;
  xterm.clearSelection();
  if (selUi) selUi.style.display = 'none';
}

function placeHandle(el, x, y, cellH, edge) {
  const visible = y + cellH > 0 && y < window.innerHeight && x >= -4 && x <= window.innerWidth + 4;
  el.style.display = visible ? 'block' : 'none';
  if (!visible) return;
  const bar = el.firstElementChild;
  const dot = el.lastElementChild;
  const dotSz = 11;
  const top = edge === 'start';
  el.style.left = `${x}px`;
  el.style.top = `${top ? y - dotSz - 4 : y - 4}px`;
  el.style.height = `${cellH + dotSz + 14}px`;
  bar.style.top = `${top ? dotSz + 4 : 4}px`;
  bar.style.height = `${cellH}px`;
  dot.style.top = `${top ? 4 : cellH + 4}px`;
}

function renderSel() {
  if (!sel || !selUi) return;
  const cell = cellNow();
  const screen = xterm.element?.querySelector('.xterm-screen');
  if (!cell?.width || !cell?.height || !screen) return;
  const rect = screen.getBoundingClientRect();
  const vpY = xterm.buffer.active.viewportY;
  const sx = rect.left + sel.start.col * cell.width;
  const sy = rect.top + (sel.start.row - vpY) * cell.height;
  const ex = rect.left + sel.end.col * cell.width;
  const ey = rect.top + (sel.end.row - vpY) * cell.height;

  selUi.style.display = 'block';
  placeHandle(selStartEl, sx, sy, cell.height, 'start');
  placeHandle(selEndEl, ex, ey, cell.height, 'end');

  const url = sel.url || safeHttpUrl(xterm.getSelection());
  if (selOpenBtn) selOpenBtn.hidden = !url;
  const midX = sel.start.row === sel.end.row ? (sx + ex) / 2 : Math.min(window.innerWidth - 20, Math.max(20, (sx + ex) / 2));
  const barW = url ? 128 : 68;
  const clampedX = Math.max(barW / 2 + 8, Math.min(window.innerWidth - barW / 2 - 8, midX));
  const aboveY = sy - 50;
  const belowY = ey + cell.height + 24;
  const barY = aboveY >= 8 ? aboveY : Math.min(window.innerHeight - 44, Math.max(8, belowY));
  selBarEl.style.left = `${clampedX}px`;
  selBarEl.style.top = `${barY}px`;
}

function applySel(start, end, url = null) {
  const len = rangeLength(cols, start, end);
  if (len <= 0) { clearSel(); return; }
  sel = { start, end, url };
  xterm.select(start.col, start.row, len);
  renderSel();
}

function dragScrollEdge(clientY) {
  const cell = cellNow();
  const h = cell?.height || 14;
  if (clientY < 28) {
    if (viewport.scrollTop > 0) viewport.scrollTop -= h;
    else if (xterm.buffer.active.type === 'normal') xterm.scrollLines(-1);
  } else if (clientY > window.innerHeight - 28) {
    if (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1) viewport.scrollTop += h;
    else if (xterm.buffer.active.type === 'normal') xterm.scrollLines(1);
  }
}

function bindHandle(el, edge) {
  let anchor = null;
  el?.addEventListener('touchstart', (e) => {
    e.stopPropagation();
    if (!sel || e.touches.length !== 1) return;
    anchor = edge === 'start'
      ? { row: sel.end.row, col: Math.max(0, sel.end.col - 1) }
      : { row: sel.start.row, col: sel.start.col };
  }, { passive: true });
  el?.addEventListener('touchmove', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!anchor || e.touches.length !== 1) return;
    const t = e.touches[0];
    dragScrollEdge(t.clientY);
    const cellH = cellNow()?.height || 14;
    const pt = cellAtPoint(t.clientX, t.clientY + (edge === 'start' ? cellH * 0.5 : -cellH * 0.5));
    if (!pt) return;
    const next = selectionFromCells(xterm.buffer.active, cols, anchor, { row: pt.absRow, col: pt.col });
    applySel(next.start, next.end, null);
  }, { passive: false });
  const endDrag = (e) => { e.stopPropagation(); anchor = null; };
  el?.addEventListener('touchend', endDrag, { passive: true });
  el?.addEventListener('touchcancel', endDrag, { passive: true });
}
bindHandle(selStartEl, 'start');
bindHandle(selEndEl, 'end');

const stopBarTouch = (e) => e.stopPropagation();
selBarEl?.addEventListener('touchstart', stopBarTouch, { passive: true });
selBarEl?.addEventListener('touchend', stopBarTouch, { passive: true });
selCopyBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const text = xterm.getSelection();
  clearSel();
  if (text) post({ t: 'copy', text });
});
selOpenBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const url = sel?.url || safeHttpUrl(xterm.getSelection());
  clearSel();
  if (url) post({ t: 'openUrl', url });
});

viewport.addEventListener('scroll', () => {
  if (sel) renderSel();
  const cell = cellNow();
  if (!cell?.height || placing) return;
  if (Math.abs(viewport.scrollLeft - setLeft) > 1) follow.x = false;
  const y = atLatest(cell);
  if (y !== follow.y) { follow.y = y; showLatest(); }
  histLabel();
}, { passive: true });
xterm.onScroll(() => { showLatest(); if (sel) renderSel(); histNear(); });
xterm.buffer.onBufferChange(() => {
  clearSel();
  if (xterm.buffer.active.type !== 'alternate') setBack(0);
  diag('term.buffer_change', bufferStats());
  showLatest();
  layout();
});
new ResizeObserver(layout).observe(viewport);

const wheelReport = (up) => {
  const b = up ? 64 : 65;
  const sgr = String(xterm._core?.coreMouseService?.activeEncoding ?? '').startsWith('SGR');
  return sgr ? `\x1b[<${b};2;2M` : `\x1b[M${String.fromCharCode(32 + b, 34, 34)}`;
};

const stopTouch = touchScroll(viewport, xterm, {
  onTap(pt) {
    if (sel) { clearSel(); return; }
    if (pt) {
      const cell = cellAtPoint(pt.clientX, pt.clientY);
      const link = cell ? linkAt(xterm, cell.col, cell.absRow) : null;
      if (link) {
        if (flashTimer) clearTimeout(flashTimer);
        xterm.select(link.start.col, link.start.row, rangeLength(cols, link.start, link.end));
        flashTimer = setTimeout(() => { flashTimer = 0; if (!sel) xterm.clearSelection(); }, 180);
        post({ t: 'openUrl', url: link.url });
        return;
      }
    }
    post({ t: 'tap' });
  },
  onLongPress(pt) {
    const cell = cellAtPoint(pt.clientX, pt.clientY);
    if (!cell) return;
    const hit = wordRangeAt(xterm, cell.col, cell.absRow);
    if (!hit) return;
    lpAnchor = { row: hit.start.row, col: hit.start.col };
    post({ t: 'haptic' });
    applySel(hit.start, hit.end, hit.url);
  },
  onLongPressMove(pt) {
    if (!lpAnchor) return;
    dragScrollEdge(pt.clientY);
    const cell = cellAtPoint(pt.clientX, pt.clientY);
    if (!cell) return;
    const next = selectionFromCells(xterm.buffer.active, cols, lpAnchor, { row: cell.absRow, col: cell.col });
    applySel(next.start, next.end, null);
  },
  onLongPressEnd() { lpAnchor = null; },
  remoteCoast(v, cell) {
    if (xterm.modes.mouseTrackingMode === 'none') return false;
    if (!v) { post({ t: 'coast', stop: true }); return true; }
    const up = v > 0;
    const n = coastSteps(v, cell).length;
    post({ t: 'coast', d: wheelReport(up), v: Math.abs(v), cell });
    setBack(Math.max(0, back + (up ? n : -n)));
    return true;
  },
});

function toLatest() {
  stopTouch();
  if (back > 0) {
    const d = wheelReport(false).repeat(back + 2);
    setBack(0);
    if (xterm.modes.mouseTrackingMode !== 'none') post({ t: 'wheel', d });
  }
  xterm.scrollToBottom();
  follow.x = follow.y = true;
  showLatest();
  layout();
}

xterm.onData((d) => {
  if (!MOUSE_REPORT.test(d)) return;
  post({ t: 'wheel', d });
  const ups = (d.match(/\x1b\[<64;|\x1b\[M`/g) ?? []).length;
  const downs = (d.match(/\x1b\[<65;|\x1b\[Ma/g) ?? []).length;
  if (ups || downs) setBack(Math.max(0, back + ups - downs));
});

function resizeTo(c, r) {
  if (c === cols && r === rows) return;
  clearSel();
  cols = c; rows = r;
  xterm.resize(cols, rows);
  layout();
}

// ---- output & credit ack (every 8 KB or 30 ms, matching PWA scroll-throttle cadence)
let unacked = 0, ackTimer = 0;
function flush() {
  if (ackTimer) { clearTimeout(ackTimer); ackTimer = 0; }
  if (unacked) { post({ t: 'ack', n: unacked }); unacked = 0; }
}
// Older history (DESIGN.md「往回翻历史」): history-more.js decides, the page measures and draws.
const histEl = document.getElementById('hist');
const HIST_IDLE_MS = 1200, HIST_IDLE_MAX_MS = 4000, HIST_TIMEOUT_MS = 12000;
// A paint larger than herdr-core's credit window (256 KB: ~5000 colored rows) comes in pieces, the
// next only after the phone acks: a round trip apart. An older-history paint is COLLECTED and
// written once, when no piece came for this long (each piece pushes it on, up to the cap): writing
// a half paint would splice the sync bytes into a multibyte character, measure a partial history
// (and call it the end), and move the reader's line. The old screen stays until then.
const HIST_SETTLE_MS = 350, HIST_SETTLE_MAX_MS = 900;
let hist = historyInitial();
let histPromise = null;   // the history rows the next paint brings (open / a fresh frame), or null
let histIdle = 0, histIdleSince = 0, histTimeout = 0;
// An older-history paint being collected: { parts, promised, keep, timer, since }. keep: rows from
// the reader's top line to the bottom of the history before it (null: at the bottom).
let olderBuf = null;
const normalBuffer = () => xterm.buffer.active.type === 'normal';
const atTop = () => normalBuffer() && xterm.buffer.active.viewportY === 0 && viewport.scrollTop <= 1;
function histLabel() {
  const text = atTop() ? topLabel(hist) : '';
  if (histEl.textContent !== text) histEl.textContent = text;
  histEl.classList.toggle('on', Boolean(text));
}
function histRun(ev) {
  const r = historyStep(hist, ev);
  hist = r.state;
  if (r.ask !== null) {
    clearTimeout(histTimeout);
    histTimeout = setTimeout(() => { histTimeout = 0; histRun({ type: 'timeout' }); }, HIST_TIMEOUT_MS);
    diag('term.more', { have: r.ask, why: ev.type, baseY: xterm.buffer.active.baseY, vpY: xterm.buffer.active.viewportY });
    post({ t: 'more', have: r.ask });
  }
  histLabel();
}
/** Within a screen of the top of the history: time for more. */
function histNear() {
  // While a paint is written, xterm fires onScroll for the clear itself: not the reader scrolling.
  if (olderBuf) return;
  if (normalBuffer() && xterm.buffer.active.viewportY <= xterm.rows) histRun({ type: 'near' });
  else histLabel();
}
/** The background ask, once the first paint is quiet for a moment (output pushes it on, up to a cap). */
function histArmIdle() {
  if (hist.prefetched || hist.earliest) return;
  const now = performance.now();
  if (!histIdle) histIdleSince = now;
  clearTimeout(histIdle);
  const wait = Math.max(0, Math.min(HIST_IDLE_MS, histIdleSince + HIST_IDLE_MAX_MS - now));
  histIdle = setTimeout(() => { histIdle = 0; if (normalBuffer()) histRun({ type: 'idle' }); }, wait);
}
/** Credit for bytes we have not drawn yet (a collected paint): herdr-core must not stop at its window. */
function ackNow(n) {
  unacked += n;
  if (unacked >= 8 * 1024) flush();
  else if (!ackTimer) ackTimer = setTimeout(flush, 30);
}
/** Every piece of the older-history paint is here: write it once, keep the reader's line. */
function flushOlder() {
  const buf = olderBuf;
  olderBuf = null;
  clearTimeout(buf.timer);
  const all = new Uint8Array(buf.parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of buf.parts) { all.set(part, at); at += part.length; }
  diag('term.more_paint', { promised: buf.promised, bytes: all.length, parts: buf.parts.length, ms: Math.round(performance.now() - buf.since) });
  writeRaw(all, { fresh: true, older: true, promised: buf.promised, keep: buf.keep });
}
function collectOlder(bytes) {
  clearTimeout(olderBuf.timer);
  olderBuf.parts.push(bytes);
  ackNow(bytes.length);
  const wait = Math.max(0, Math.min(HIST_SETTLE_MS, olderBuf.since + HIST_SETTLE_MAX_MS - performance.now()));
  olderBuf.timer = setTimeout(flushOlder, wait);
}

function write(b64, fresh = false, older = false) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (older && fresh) {
    if (olderBuf) { clearTimeout(olderBuf.timer); flushOlder(); } // a newer one replaces it
    const b = xterm.buffer.active;
    const keep = normalBuffer() && b.viewportY < b.baseY ? b.baseY - b.viewportY : null;
    olderBuf = { parts: [], promised: histPromise, keep, timer: 0, since: performance.now() };
    histPromise = null;
  }
  if (olderBuf) { collectOlder(bytes); return; }
  writeRaw(bytes, { fresh, older, promised: histPromise, keep: null });
}

function writeRaw(bytes, { fresh = false, older = false, promised = null, keep = null } = {}) {
  const t0 = performance.now();
  let last = bytes;
  let hasPaint = false;
  if (sized) {
    const [before, repaint] = atomic(bytes, { clearHistory });
    if (repaint) {
      hasPaint = true;
      clearHistory = false;
      if (before.length) xterm.write(textStyle(before));
      last = repaint;
    }
  }
  if (hasPaint && histPromise !== null) { promised = histPromise; histPromise = null; }
  const info = inspectFrame(bytes, fresh, hasPaint);
  if (info.reason) expectFrame = '';
  finishSyncWatch(bytes.length, hasPaint, info.hasSyncOff, fresh);
  if (!hasPaint && hist.promised && !hist.prefetched) histArmIdle(); // output after the first paint: not quiet yet
  xterm.write(textStyle(last), () => {
    if (hasPaint && promised !== null) {
      clearTimeout(histTimeout); histTimeout = 0;
      if (keep !== null && normalBuffer()) xterm.scrollToLine(Math.max(0, xterm.buffer.active.baseY - keep));
      histRun({ type: 'painted', promised, baseY: normalBuffer() ? xterm.buffer.active.baseY : 0, older });
      histArmIdle();
      histNear(); // still near the top (a fast reader): the next step goes now
    }
    if (info.reason) {
      diag('term.frame', {
        reason: info.reason, bytes: bytes.length, fresh, hasPaint,
        hasClear: info.hasClear, hasSyncOn: info.hasSyncOn, hasSyncOff: info.hasSyncOff,
        writeMs: Math.round(performance.now() - t0),
        ...bufferStats(),
      });
    }
    post({
      t: 'drawn',
      cursorHidden: xterm._core?.coreService?.isCursorHidden !== false,
      appCursor: Boolean(xterm.modes.applicationCursorKeysMode),
    });
    if (follow.y && !placing) { placing = true; requestAnimationFrame(() => { placing = false; layout(); }); }
    unacked += bytes.length;
    if (unacked >= 8 * 1024) flush();
    else if (!ackTimer) ackTimer = setTimeout(flush, 30);
  });
}

window.addEventListener('message', (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.t === 'open') {
    clearSel();
    abortSyncWatch('open');
    sized = Boolean(m.sized);
    expectFrame = 'open';
    diag('term.open_view', { sized, reopened: Boolean(m.reopened), cols: m.cols, rows: m.rows, prev: `${cols}x${rows}`, fit: fitNow() });
    if (!sized) { xterm.reset(); resizeTo(m.cols, m.rows); }
    else if (m.reopened) clearHistory = true;
    // A Mac that sends history on request says how much the first paint brings (older ones: none).
    if (olderBuf) { clearTimeout(olderBuf.timer); olderBuf = null; }
    hist = historyInitial();
    histPromise = sized && m.hist ? Number(m.hist) : null;
    histLabel();
    reportFit();
  } else if (m.t === 'out') {
    if (m.fresh) {
      clearSel(); clearHistory = true;
      if (m.hist) histPromise = Number(m.hist);
    }
    write(m.d, Boolean(m.fresh), Boolean(m.fresh && m.older));
  } else if (m.t === 'size') {
    const from = `${cols}x${rows}`, to = `${m.cols}x${m.rows}`;
    if (m.cols === cols && m.rows === rows) {
      diag('term.size_noop', { from, to, sized });
      return;
    }
    expectFrame = 'size';
    diag('term.size', { from, to, sized, vpW: viewport.clientWidth, vpH: viewport.clientHeight });
    if (sized) {
      armSyncWatch(from, to);
      xterm.write(SYNC_ON, () => resizeTo(m.cols, m.rows));
    } else {
      resizeTo(m.cols, m.rows);
    }
  } else if (m.t === 'reset') {
    clearSel();
    abortSyncWatch('reset');
    xterm.reset();
  } else if (m.t === 'typing' || m.t === 'toLatest') {
    clearSel();
    toLatest();
  } else if (m.t === 'ping') {
    post({ t: 'pong', id: m.id });
  }
});
window.addEventListener('error', (e) => post({ t: 'log', m: String(e.message) }));
function bootReady(tries = 0) {
  const fit = fitNow();
  if (!fit && tries < 15) {
    requestAnimationFrame(() => bootReady(tries + 1));
    return;
  }
  if (fit && cols === 80 && rows === 24) resizeTo(fit.cols, fit.rows);
  lastFitKey = fit ? `${fit.cols}x${fit.rows}` : ''; // 'ready' carries this grid: no 'fit' for it as well
  booted = true;
  layout();
  post({ t: 'ready', fit });
}
requestAnimationFrame(() => bootReady(0));
