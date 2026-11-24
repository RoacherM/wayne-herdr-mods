import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import {
  linkAt,
  rangeLength,
  safeHttpUrl,
  selectionFromCells,
  trimUrlPunctuation,
  wordRangeAt,
} from '../app/src/term-select.js';

const { Terminal } = headless;

function makeTerm(text, cols = 30, rows = 10) {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  return new Promise((resolve) => term.write(text, () => resolve(term)));
}

test('safeHttpUrl allows http/https and rejects unsafe schemes or garbage', () => {
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHttpUrl('  http://localhost:3000/test  '), 'http://localhost:3000/test');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('file:///etc/passwd'), null);
  assert.equal(safeHttpUrl('tel:123456'), null);
  assert.equal(safeHttpUrl('not a url'), null);
  assert.equal(safeHttpUrl(`https://example.com/${'a'.repeat(5000)}`), null);
});

test('trimUrlPunctuation strips prose punctuation but preserves balanced parens', () => {
  assert.equal(trimUrlPunctuation('https://example.com/path.'), 'https://example.com/path');
  assert.equal(trimUrlPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)).'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(trimUrlPunctuation('https://example.com/a],'), 'https://example.com/a');
  assert.equal(trimUrlPunctuation('https://example.com/zh。'), 'https://example.com/zh');
});

test('linkAt finds plain and soft-wrapped URLs across rows', async () => {
  const term = await makeTerm('see (https://example.com/very/long/wrapped/path?x=1&y=2). ok', 24, 10);
  // Row 0 (24 cols): "see (https://example.com"
  // Row 1 (24 cols): "/very/long/wrapped/path?"
  // Row 2: "x=1&y=2). ok" → "x=1&y=2" is cols 0..6, exclusive end col 7
  const hit0 = linkAt(term, 8, 0);
  const hit1 = linkAt(term, 5, 1);
  const hit2 = linkAt(term, 2, 2);
  const miss = linkAt(term, 1, 0);
  const missEnd = linkAt(term, 10, 2);

  assert.equal(hit0?.url, 'https://example.com/very/long/wrapped/path?x=1&y=2');
  assert.equal(hit1?.url, hit0?.url);
  assert.equal(hit2?.url, hit0?.url);
  assert.deepEqual(hit0?.start, { row: 0, col: 5 });
  assert.deepEqual(hit0?.end, { row: 2, col: 7 });
  assert.equal(miss, null);
  assert.equal(missEnd, null);
});

test('linkAt finds OSC 8 hyperlinks across wrapped rows and rejects non-http OSC 8 schemes', async () => {
  const term = await makeTerm(
    'go \x1b]8;;https://github.com/org/repo\x07a very long wrapped osc link\x1b]8;;\x07 \x1b]8;;javascript:alert(1)\x07bad\x1b]8;;\x07',
    20,
    6,
  );
  // Row 0 (20 cols): "go a very long wrapp" -> link starts at col 3
  // Row 1 (20 cols): "ed osc link bad" -> link ends at col 11 exclusive
  const hitRow0 = linkAt(term, 5, 0);
  const hitRow1 = linkAt(term, 4, 1);
  assert.equal(hitRow0?.kind, 'osc8');
  assert.equal(hitRow0?.url, 'https://github.com/org/repo');
  assert.deepEqual(hitRow0?.start, { row: 0, col: 3 });
  assert.deepEqual(hitRow0?.end, { row: 1, col: 11 });
  assert.deepEqual(hitRow1, hitRow0);

  const bad = linkAt(term, 13, 1);
  assert.equal(bad, null);
  assert.equal(linkAt(term, -1, 0), null);
  assert.equal(linkAt(term, 20, 0), null);
  assert.equal(linkAt(term, 0, -1), null);
  assert.equal(linkAt(term, 0, 99), null);
});

test('wordRangeAt selects full word/path, whole URL, trailing empty area, or returns null on blank line', async () => {
  const term = await makeTerm('edit ios/App.tsx and https://nsh.dev/docs\r\n   \r\n你好世界 test', 50, 6);

  const pathSel = wordRangeAt(term, 9, 0);
  assert.deepEqual(pathSel?.start, { row: 0, col: 5 });
  assert.deepEqual(pathSel?.end, { row: 0, col: 16 });
  assert.equal(pathSel?.url, null);

  const urlSel = wordRangeAt(term, 25, 0);
  assert.equal(urlSel?.url, 'https://nsh.dev/docs');
  assert.deepEqual(urlSel?.start, { row: 0, col: 21 });
  assert.deepEqual(urlSel?.end, { row: 0, col: 41 });

  // Tapping past end of row anchors to last word on that row ('test', cols 9..13)
  const pastEnd = wordRangeAt(term, 40, 2);
  assert.deepEqual(pastEnd?.start, { row: 2, col: 9 });
  assert.deepEqual(pastEnd?.end, { row: 2, col: 13 });

  // Tapping a single space selects that 1 cell
  const spaceSel = wordRangeAt(term, 4, 0);
  assert.deepEqual(spaceSel?.start, { row: 0, col: 4 });
  assert.deepEqual(spaceSel?.end, { row: 0, col: 5 });

  // Blank line & out-of-bounds return null
  assert.equal(wordRangeAt(term, 2, 1), null);
  assert.equal(wordRangeAt(term, -1, 0), null);
  assert.equal(wordRangeAt(term, 50, 0), null);
  assert.equal(wordRangeAt(term, 0, 99), null);

  // Wide CJK word (each char = 2 cols, cols 0..8)
  const cjkSel = wordRangeAt(term, 3, 2);
  assert.deepEqual(cjkSel?.start, { row: 2, col: 0 });
  assert.deepEqual(cjkSel?.end, { row: 2, col: 8 });
});

test('selectionFromCells handles normal, reversed, same-row, multi-line, and wide-char bounds', async () => {
  const term = await makeTerm('hello world\r\n中文ab', 20, 6);
  const buf = term.buffer.active;

  // Same-row reversed
  const sameRow = selectionFromCells(buf, 20, { row: 0, col: 4 }, { row: 0, col: 1 });
  assert.deepEqual(sameRow.start, { row: 0, col: 1 });
  assert.deepEqual(sameRow.end, { row: 0, col: 5 });
  assert.equal(sameRow.length, 4);

  // Normal multi-line: row 0 col 6 ('w') to row 1 col 3 (right half of '文' -> expands to col 4 exclusive)
  const fwd = selectionFromCells(buf, 20, { row: 0, col: 6 }, { row: 1, col: 3 });
  assert.deepEqual(fwd.start, { row: 0, col: 6 });
  assert.deepEqual(fwd.end, { row: 1, col: 4 });
  assert.equal(fwd.length, rangeLength(20, fwd.start, fwd.end));
  assert.equal(fwd.length, 18);

  // Reversed endpoints produce the exact same span (left half of '文' starts at col 2)
  const rev = selectionFromCells(buf, 20, { row: 1, col: 2 }, { row: 0, col: 6 });
  assert.deepEqual(rev, fwd);
  assert.equal(rangeLength(20, { row: 1, col: 5 }, { row: 0, col: 1 }), 0);
});
