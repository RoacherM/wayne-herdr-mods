/**
 * The terminal inside the native app's WebView: xterm.js with Unicode 15 graphemes, atomic
 * repaints (paint.js), VS15 text-style symbols (text-style.js), and finger scrolling (touch-scroll.js).
 * The connection and all controls live in the native app (QuickJS).
 *
 *   app → page  {t:'open', sized, reopened, cols, rows}  {t:'size', cols, rows}
 *               {t:'out', d:<base64>, fresh?}            {t:'reset'}
 *               {t:'typing'}                             {t:'toLatest'}
 *   page → app  {t:'ready', fit}   {t:'fit', fit}        {t:'ack', n}
 *               {t:'drawn', cursorHidden, appCursor}     {t:'atLatest', on}
 *               {t:'wheel', d}     {t:'coast', stop?, d?, v?, cell?}
 *               {t:'tap'}          {t:'log', m}
 */
import { Terminal } from '@xterm/xterm';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { touchScroll } from '../../app/src/touch-scroll.js';
import { atomic, SYNC_ON } from '../../app/src/paint.js';
import { textStyle } from '../../app/src/text-style.js';
import { coastSteps } from '../../shared/coast.js';

const post = (v) => window.nsh?.postMessage(JSON.stringify(v));
const theme = { background: '#0b0b0c', foreground: '#e6e6e1', cursor: '#e6e6e1', selectionBackground: '#3a3a36' };
document.documentElement.style.background = theme.background;

const viewport = document.getElementById('vp');
const host = document.getElementById('host');
const FONT = 12;
const PAD_X = 12, PAD_Y = 8; // #vp padding: 4px top/bottom, 6px left/right
const MOUSE_REPORT = /^(\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

let cols = 80, rows = 24, sized = false, clearHistory = false;
const xterm = new Terminal({
  cols, rows, scrollback: 3000, fontSize: FONT, lineHeight: 1.0, theme,
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
  post({ t: 'fit', fit });
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
  if (!follow.y) return;
  const cell = cellNow();
  if (!cell?.width) { setTimeout(layout, 60); return; }
  const b = xterm.buffer.active;
  const w = viewport.clientWidth, hgt = viewport.clientHeight;
  if (follow.x) {
    const x = b.cursorX * cell.width;
    if (x < viewport.scrollLeft || x > viewport.scrollLeft + w - 2 * cell.width) viewport.scrollLeft = setLeft = Math.max(0, x - w / 3);
    else setLeft = viewport.scrollLeft;
  }
  if (atLatest(cell)) return;
  const { cursor, last } = latestRows();
  const want = Math.min((last + 1) * cell.height - hgt + cell.height / 2, Math.max(0, (cursor - 1) * cell.height));
  viewport.scrollTop = Math.max(0, want);
}

viewport.addEventListener('scroll', () => {
  const cell = cellNow();
  if (!cell?.height || placing) return;
  if (Math.abs(viewport.scrollLeft - setLeft) > 1) follow.x = false;
  const y = atLatest(cell);
  if (y !== follow.y) { follow.y = y; showLatest(); }
}, { passive: true });
xterm.onScroll(showLatest);
xterm.buffer.onBufferChange(() => { if (xterm.buffer.active.type !== 'alternate') setBack(0); showLatest(); layout(); });
new ResizeObserver(layout).observe(viewport);

const wheelReport = (up) => {
  const b = up ? 64 : 65;
  const sgr = String(xterm._core?.coreMouseService?.activeEncoding ?? '').startsWith('SGR');
  return sgr ? `\x1b[<${b};2;2M` : `\x1b[M${String.fromCharCode(32 + b, 34, 34)}`;
};

const stopTouch = touchScroll(viewport, xterm, {
  onTap: () => post({ t: 'tap' }),
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
function write(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let last = bytes;
  if (sized) {
    const [before, repaint] = atomic(bytes, { clearHistory });
    if (repaint) {
      clearHistory = false;
      if (before.length) xterm.write(textStyle(before));
      last = repaint;
    }
  }
  xterm.write(textStyle(last), () => {
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
    sized = Boolean(m.sized);
    if (!sized) { xterm.reset(); resizeTo(m.cols, m.rows); }
    else if (m.reopened) clearHistory = true;
    reportFit();
  } else if (m.t === 'out') {
    if (m.fresh) clearHistory = true;
    write(m.d);
  } else if (m.t === 'size') {
    if (sized) xterm.write(SYNC_ON, () => resizeTo(m.cols, m.rows));
    else resizeTo(m.cols, m.rows);
  } else if (m.t === 'reset') {
    xterm.reset();
  } else if (m.t === 'typing' || m.t === 'toLatest') {
    toLatest();
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
