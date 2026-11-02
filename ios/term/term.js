/**
 * The terminal inside the native app's WebView: xterm.js only. The connection lives in the app
 * (QuickJS); bytes come in and keystrokes go out as JSON strings over the WebView bridge.
 *
 *   app → page  {t:'size', cols, rows}   {t:'out', d:<base64>}   {t:'reset'}   {t:'focus'}
 *   page → app  {t:'ready'}   {t:'ack', n}   {t:'input', d}   {t:'log', m}
 */
import { Terminal } from '@xterm/xterm';
import { touchScroll } from '../../app/src/touch-scroll.js';

const post = (v) => window.nsh?.postMessage(JSON.stringify(v));
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const theme = dark
  ? { background: '#111110', foreground: '#e6e6e1', cursor: '#e6e6e1', selectionBackground: '#3a3a36' }
  : { background: '#fbfbf9', foreground: '#1a1a18', cursor: '#1a1a18', selectionBackground: '#d9d8d2' };
document.documentElement.style.background = theme.background;

const viewport = document.getElementById('vp');
const host = document.getElementById('host');
let cols = 80, rows = 24;
const xterm = new Terminal({ cols, rows, scrollback: 3000, fontSize: 13, lineHeight: 1.0, theme,
  fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace', cursorBlink: false, macOptionIsMeta: true });
xterm.open(host);
touchScroll(viewport, xterm);
xterm.onData((d) => post({ t: 'input', d }));

/** Font size that fits the Mac's columns in the phone's width (8–14 px; past 8 it scrolls sideways). */
function layout() {
  const w = viewport.clientWidth - 8;
  if (!w) return;
  const cell = xterm._core?._renderService?.dimensions?.css?.cell;
  const ratio = cell?.width ? cell.width / xterm.options.fontSize : 0.6;
  const want = Math.max(8, Math.min(14, Math.floor((w / cols / ratio) * 2) / 2));
  if (want !== xterm.options.fontSize) xterm.options.fontSize = want;
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
  else if (m.t === 'focus') xterm.focus();
});
window.addEventListener('error', (e) => post({ t: 'log', m: String(e.message) }));
requestAnimationFrame(layout);
post({ t: 'ready' });
