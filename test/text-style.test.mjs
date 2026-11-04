// app/src/text-style.js: symbols iOS would draw as color emoji get VS15; nothing else changes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { textStyle } from '../app/src/text-style.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const VS15 = '︎', VS16 = '️';

test("Claude Code's ⏺ and the media symbols get VS15", () => {
  assert.equal(dec(textStyle(enc('⏺ Deploy'))), `⏺${VS15} Deploy`);
  for (const s of '⏸⏹⏺⏭⏮⏯⏱⏲⏏⌨') assert.equal(dec(textStyle(enc(`a${s}b`))), `a${s}${VS15}b`, s);
});

test('everything else passes untouched, the same bytes', () => {
  for (const s of ['plain', '● ⎿ ✳ ✻ ❯ ▶ ◀ ⚠ ⏵⏵ bypass', '中文 👍 ⚡', '\x1b[38;2;1;2;3m⏴\x1b[0m', '']) {
    const b = enc(s);
    assert.equal(textStyle(b), b, JSON.stringify(s));
  }
});

test('an explicit selector stays as it is', () => {
  assert.equal(dec(textStyle(enc(`⏺${VS15}x`))), `⏺${VS15}x`);
  assert.equal(dec(textStyle(enc(`⏺${VS16}x`))), `⏺${VS16}x`);
});

test('many in one burst, at the start and the end', () => {
  const s = '⏺'.repeat(200) + ' mid ' + '⏸';
  assert.equal(dec(textStyle(enc(s))), `${'⏺'.repeat(200).replaceAll('⏺', `⏺${VS15}`)} mid ⏸${VS15}`);
});
