// The phone's own layout of a Mac-size terminal (app/src/reflow.js), fed real terminal bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import xtermPkg from '@xterm/xterm';
import { blocks, layout } from '../app/src/reflow.js';

const { Terminal } = xtermPkg;
const theme = { background: '#0b0b0c', foreground: '#e6e6e1' };
async function screen(bytes, cols = 40, rows = 10) {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise((r) => t.write(bytes, r));
  const b = t.buffer.active;
  return { t, lines: layout(b, cols, theme, { cursor: { x: b.cursorX, y: b.baseY + b.cursorY } }) };
}
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('a row the terminal wrapped is one line again', async () => {
  const { lines } = await screen('x'.repeat(50) + '\r\nnext');
  assert.equal(text(lines[0].html), 'x'.repeat(50));
  assert.equal(text(lines[1].html).trim(), 'next');
});

test("a program's own wrap at the edge joins; short lines and new items do not", async () => {
  const { lines } = await screen('● This is a long answer that the program\r\n  wrapped itself.\r\nshort line\r\n● next item\r\n');
  assert.equal(text(lines[0].html), '● This is a long answer that the program wrapped itself.');
  assert.equal(text(lines[1].html), 'short line');
  assert.equal(text(lines[2].html), '● next item');
});

test('CJK words join without a space', async () => {
  const { lines } = await screen('网页版现在是这套界面，已经部署好了用手\r\n机浏览器打开就能试。');
  assert.equal(text(lines[0].html).trimEnd(), '网页版现在是这套界面，已经部署好了用手机浏览器打开就能试。');
});

test('rules are cut, tables stay one sideways block', async () => {
  const { lines } = await screen(`${'─'.repeat(40)}\r\n┌──┬──┐\r\n│a │b │\r\n└──┴──┘\r\ntext`);
  assert.deepEqual(lines.slice(0, 5).map((l) => l.kind), ['rule', 'tbl', 'tbl', 'tbl', 'text']);
  const html = blocks(lines);
  assert.match(html[0], /^<div class="rule">/);
  assert.match(html[1], /^<div class="tbl"><div>┌──┬──┐\n│a │b │\n└──┴──┘<\/div><\/div>$/);
});

test('colours, bold and the cursor stay; trailing blanks go', async () => {
  const { lines } = await screen('\x1b[1;31mred\x1b[0m plain   \x1b[44m   \x1b[0m\r\n> ab');
  assert.match(lines[0].html, /^<span style="color:#ff6b6b;font-weight:700">red<\/span> plain$/);
  assert.match(lines[1].html, /^&gt; ab<span class="cur"> <\/span>$/);
});

test('a redrawn screen shows the latest state (Claude Code redraws its input box)', async () => {
  const { lines } = await screen('answer\r\n> old\r\x1b[2K> new');
  assert.deepEqual(lines.map((l) => text(l.html)).filter((s) => s.trim()), ['answer', '> new ']);
});
