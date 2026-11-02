// How far a full-screen program's view moved between two screens (touch-scroll.js shiftOf).
import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftOf } from '../app/src/touch-scroll.js';

// A screen like Claude Code's: a header, lines from `top`, an input box that stays.
const screen = (top, rows = 20) => ['  Claude Code header', ...Array.from({ length: rows - 3 }, (_, i) => `line ${top + i} of the talk`), '──────────', '> type here'];

test('the view went up 5 lines: the text moved down 5 rows', () => {
  assert.equal(shiftOf(screen(100), screen(95), true), 5);
});
test('the view went down 3 lines', () => {
  assert.equal(shiftOf(screen(100), screen(103), false), 3);
});
test('no shift: the same screen, or a new one', () => {
  assert.equal(shiftOf(screen(100), screen(100), true), 0);
  assert.equal(shiftOf(screen(100), Array.from({ length: 20 }, (_, i) => `other ${i}`), true), 0);
});
test('blank rows and the header and input box do not count', () => {
  const blanks = (top) => ['hdr', ...Array.from({ length: 16 }, (_, i) => (i % 2 ? '' : `text ${top + i}`)), '> box'];
  assert.equal(shiftOf(blanks(50), blanks(46), true), 4);
});
