// app/src/paint.js on a real xterm (headless): repaints drawn in one frame, and the history on a
// terminal opened again — never lost, never doubled, whichever screen the phone and the program are on.
import assert from 'node:assert/strict';
import test from 'node:test';
import headless from '@xterm/headless';
import { atomic, SYNC_OFF } from '../app/src/paint.js';

const { Terminal } = headless;
const COLS = 40, ROWS = 5;
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// herdr-core's repaint, as crates/ghostty-vt paint() and viewers.rs paint_state() write it.
const RESET = '\x1b[!p\x1b[?2026l\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l'
  + '\x1b[?1015l\x1b[?1016l\x1b[?2004l\x1b[?1l\x1b[?66l\x1b[?2031l\x1b[?2048l\x1b[=0;1u\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[H\x1b[2J';
function repaint({ history = [], screen = [], alt = false }) {
  let out = `\x18${RESET}`;
  if (history.length && !alt) out += `${history.join('\r\n')}\x1b[0m\r\n${'\n'.repeat(ROWS)}\x1b[H\x1b[2J`;
  if (alt) out += '\x1b[?1049h';
  out += screen.map((l, i) => `\x1b[${i + 1};1H${l}`).join('');
  return enc(out);
}
const hist = (n) => Array.from({ length: n }, (_, i) => `h${i + 1}`);

async function term(...writes) {
  const t = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
  for (const w of writes) await new Promise((r) => t.write(w, r));
  return t;
}
const linesOf = (buf) => Array.from({ length: buf.length }, (_, y) => buf.getLine(y)?.translateToString(true) ?? '');
const count = (t, re) => linesOf(t.buffer.normal).filter((l) => re.test(l)).length;
const shown = (t) => { const b = t.buffer.active; return Array.from({ length: ROWS }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true) ?? ''); };

test('a repaint is drawn in one frame: sync on after the soft reset, off at the end', () => {
  const [before, out] = atomic(repaint({ screen: ['$ ls'] }));
  assert.equal(before.length, 0);
  const s = dec(out);
  assert.ok(s.startsWith('\x18\x1b[!p\x1b[?2026h'), JSON.stringify(s.slice(0, 16)));
  assert.ok(s.endsWith(dec(SYNC_OFF)));
  assert.equal(s.split('\x1b[?2026l').length - 1, 1, 'only the closing sync off');
  assert.ok(!s.includes('\x1b[3J'), 'no history cleared unless asked');
});

test('bytes before a repaint come first; bytes without one pass untouched', () => {
  const live = enc('live bytes');
  const [before, out] = atomic(new Uint8Array([...live, ...repaint({ screen: ['x'] })]));
  assert.equal(dec(before), 'live bytes');
  assert.ok(out);
  const [same, none] = atomic(live);
  assert.equal(none, null);
  assert.equal(dec(same), 'live bytes');
});

test('opened again on the main screen: the history once, not twice', async () => {
  const t = await term(repaint({ history: hist(20), screen: ['$ '] }));
  assert.equal(count(t, /^h\d+$/), 20);
  // Opened again, after five more lines scrolled off on the Mac: the repaint brings all 25.
  await new Promise((r) => t.write(atomic(repaint({ history: hist(25), screen: ['$ '] }), { clearHistory: true })[1], r));
  assert.equal(count(t, /^h\d+$/), 25);
  assert.deepEqual(linesOf(t.buffer.normal).filter((l) => /^h\d+$/.test(l)), hist(25));
  // Without clearing, it would have doubled: what the phone had before this fix.
  const u = await term(repaint({ history: hist(20), screen: ['$ '] }), atomic(repaint({ history: hist(25), screen: ['$ '] }))[1]);
  assert.equal(count(u, /^h\d+$/), 45);
});

test('the program left its full screen while the phone was away: the history once', async () => {
  // The phone shows the alternate screen; the repaint is of the main screen with its history.
  const t = await term(repaint({ history: hist(20), screen: ['$ '] }), repaint({ alt: true, screen: ['FULL SCREEN'] }));
  assert.equal(t.buffer.active.type, 'alternate');
  await new Promise((r) => t.write(atomic(repaint({ history: hist(20), screen: ['$ done'] }), { clearHistory: true })[1], r));
  assert.equal(t.buffer.active.type, 'normal');
  assert.equal(count(t, /^h\d+$/), 20);
  assert.equal(shown(t)[0], '$ done');
});

test('opened again under a full-screen program: the history stays (that repaint has none)', async () => {
  const t = await term(repaint({ history: hist(20), screen: ['$ '] }), repaint({ alt: true, screen: ['FULL SCREEN'] }));
  await new Promise((r) => t.write(atomic(repaint({ alt: true, screen: ['FULL SCREEN 2'] }), { clearHistory: true })[1], r));
  assert.equal(shown(t)[0], 'FULL SCREEN 2');
  assert.equal(count(t, /^h\d+$/), 20);
  // The program went full screen while the phone was away: the main-screen history stays too.
  const u = await term(repaint({ history: hist(20), screen: ['$ '] }));
  await new Promise((r) => u.write(atomic(repaint({ alt: true, screen: ['FULL'] }), { clearHistory: true })[1], r));
  assert.equal(u.buffer.active.type, 'alternate');
  assert.equal(count(u, /^h\d+$/), 20);
});
