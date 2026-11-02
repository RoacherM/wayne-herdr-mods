/**
 * The terminal inside the native app's WebView: xterm.js only. The connection lives in the app
 * (QuickJS); bytes come in and keystrokes go out as JSON strings over the WebView bridge.
 *
 *   app → page  {t:'size', cols, rows}   {t:'out', d:<base64>}   {t:'reset'}   {t:'typing'}
 *   page → app  {t:'ready'}   {t:'ack', n}   {t:'tap'}   {t:'log', m}
 *
 * The page takes no typing of its own: the app's keyboard is the only way in (one input box: the
 * program's own line). A tap asks the app to show its keyboard; while the user types, the view
 * follows the cursor, so the line being typed stays in sight on a terminal wider than the phone.
 */
import { Terminal } from '@xterm/xterm';
import { touchScroll } from '../../app/src/touch-scroll.js';

const post = (v) => window.nsh?.postMessage(JSON.stringify(v));
// Always dark, as terminal apps are: the native page around it is dark too.
const theme = { background: '#0b0b0c', foreground: '#e6e6e1', cursor: '#e6e6e1', selectionBackground: '#3a3a36' };
document.documentElement.style.background = theme.background;

const viewport = document.getElementById('vp');
const host = document.getElementById('host');
let cols = 80, rows = 24;
const xterm = new Terminal({ cols, rows, scrollback: 3000, fontSize: 13, lineHeight: 1.0, theme,
  fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace', cursorBlink: false, macOptionIsMeta: true });
xterm.open(host);
touchScroll(viewport, xterm);
// No keyboard from the page: xterm's hidden textarea must not take focus.
xterm.textarea?.setAttribute('inputmode', 'none');
xterm.textarea?.setAttribute('readonly', '');
xterm.textarea?.addEventListener('focus', () => xterm.textarea.blur());

// A tap (no drag) asks the app for its keyboard.
let tapAt = null;
viewport.addEventListener('touchstart', (e) => { const t = e.touches[0]; tapAt = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
viewport.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (tapAt && Math.hypot(t.clientX - tapAt.x, t.clientY - tapAt.y) > 8) tapAt = null; }, { passive: true });
viewport.addEventListener('touchend', () => { if (tapAt) post({ t: 'tap' }); tapAt = null; });

/** Keep the cursor in sight: bottom of the history, and inside the viewport both ways. */
let typingUntil = 0;
function follow() {
  const cell = xterm._core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width) return;
  const b = xterm.buffer.active;
  if (b.viewportY !== b.baseY) xterm.scrollToBottom();
  const x = 6 + b.cursorX * cell.width, y = 4 + b.cursorY * cell.height;
  if (x < viewport.scrollLeft + 24 || x > viewport.scrollLeft + viewport.clientWidth - 32) viewport.scrollLeft = Math.max(0, x - viewport.clientWidth * 0.6);
  if (y < viewport.scrollTop || y + cell.height > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = Math.max(0, y + cell.height * 2 - viewport.clientHeight);
}

const FONT = 12; // px: the phone's own text size when the terminal fits it
const PAD_X = 12, PAD_Y = 8; // #vp padding, both sides (build-term.mjs)
const cellAt = (px) => {
  const cell = xterm._core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width) return null;
  const k = px / xterm.options.fontSize;
  return { width: cell.width * k, height: cell.height * k };
};

/** Font size for the terminal's columns: FONT when it fits the phone, smaller (to 8 px) for a wide Mac size. */
function layout() {
  const w = viewport.clientWidth - PAD_X, h = viewport.clientHeight - PAD_Y;
  const cell = cellAt(FONT);
  if (!w || !h || !cell) { setTimeout(layout, 100); return; } // the renderer has not measured yet
  const want = Math.max(8, Math.min(FONT, Math.floor((w / cols / (cell.width / FONT)) * 2) / 2));
  // Cells are measured at the current size: measure again at the new one.
  if (want !== xterm.options.fontSize) { xterm.options.fontSize = want; setTimeout(layout, 50); }
}
new ResizeObserver(layout).observe(viewport);

let unacked = 0, ackTimer = 0;
function flush() { if (unacked) { post({ t: 'ack', n: unacked }); unacked = 0; } }
function write(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  xterm.write(bytes, () => {
    // Credit only what is drawn: a slow phone slows the stream.
    unacked += bytes.length;
    if (Date.now() < typingUntil) follow();
    if (unacked >= 32 * 1024) flush();
  });
  clearTimeout(ackTimer);
  ackTimer = setTimeout(flush, 100);
}

window.addEventListener('message', (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.t === 'out') write(m.d);
  else if (m.t === 'size') { if (m.cols !== cols || m.rows !== rows) { cols = m.cols; rows = m.rows; xterm.resize(cols, rows); } layout(); }
  else if (m.t === 'reset') xterm.reset();
  else if (m.t === 'typing') { typingUntil = Date.now() + 1500; follow(); }
});
window.addEventListener('error', (e) => post({ t: 'log', m: String(e.message) }));
requestAnimationFrame(layout);
post({ t: 'ready' });
