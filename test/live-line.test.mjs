// The phone keyboard → the program's own input line (app/src/live-line.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_GAP_MS, LiveLine, PASTE_LF, imageInput, keystrokes, pasteText } from '../app/src/live-line.js';

const make = () => { const out = []; const line = new LiveLine((d) => out.push(d)); return { line, out }; };

test('each change goes in as keystrokes; edits back up to the common prefix', () => {
  const { line, out } = make();
  line.set('he'); line.set('hello'); line.set('help');
  assert.deepEqual(out, ['he', 'llo', '\x7f\x7fp']);
  assert.equal(line.typed, 'help');
});

test('a line break goes in as a pasted LF, not Enter', () => {
  const { line, out } = make();
  line.set('a\nb');
  assert.deepEqual(out, [`a${PASTE_LF}b`]);
  line.set('a');
  assert.deepEqual(out.at(-1), '\x7f\x7f'); // backspace over the b and the line break
});

test('nothing goes in while an input method composes; the result does', () => {
  const { line, out } = make();
  line.compose(true);
  line.set('ni'); line.set('nih'); line.set('你好');
  assert.deepEqual(out, []);
  line.compose(false);
  assert.deepEqual(out, ['你好']);
});

test('held while the program asks; what was typed meanwhile goes in after', () => {
  const { line, out } = make();
  line.set('ok');
  line.hold(true);
  line.set('ok then');
  assert.deepEqual(out, ['ok']);
  assert.equal(line.pending, ' then');
  line.hold(false);
  assert.deepEqual(out, ['ok', ' then']);
  assert.equal(line.pending, '');
});

test('submit is Enter and starts a new burst', () => {
  const { line, out } = make();
  line.set('/help');
  assert.equal(line.submit(), true);
  assert.deepEqual(out, ['/help', '\r']);
  assert.equal(line.value, '');
  line.set('x');
  assert.deepEqual(out.at(-1), 'x');
});

test('submit refuses while held text waits (Enter would answer the question)', () => {
  const { line, out } = make();
  line.hold(true);
  line.set('later');
  assert.equal(line.submit(), false);
  assert.deepEqual(out, []);
  assert.equal(line.value, 'later');
});

test('commit hands what went in to the program: no backspaces into it afterwards', () => {
  const { line, out } = make();
  line.set('git ch');
  line.commit(); // e.g. Tab from the key bar: the shell completes the word, we no longer know the line
  assert.equal(line.value, '');
  line.set('x');
  assert.deepEqual(out, ['git ch', 'x']);
});

test('commit keeps text that has not gone in yet', () => {
  const { line } = make();
  line.set('a');
  line.hold(true);
  line.set('abc');
  line.commit();
  assert.equal(line.value, 'bc');
  assert.equal(line.typed, '');
});

test('backspace on an empty burst goes straight to the program', () => {
  const { line, out } = make();
  assert.equal(line.backspace(), true);
  assert.deepEqual(out, ['\x7f']);
  line.set('a');
  assert.equal(line.backspace(), false, 'the field deletes its own text');
});

test('pasteText brackets text and drops a forged end marker', () => {
  assert.equal(pasteText('/tmp/a.png'), '\x1b[200~/tmp/a.png\x1b[201~');
  assert.equal(pasteText('a\x1b[201~b'), '\x1b[200~ab\x1b[201~');
});

test('keystrokes: backspaces to the common prefix, in code points', () => {
  assert.equal(keystrokes('', '/co'), '/co');
  assert.equal(keystrokes('/compact', '/cl'), '\x7f'.repeat(6) + 'l');
  assert.equal(keystrokes('/co', ''), '\x7f\x7f\x7f');
  assert.equal(keystrokes('/表', '/表格'), '格'); // not UTF-16 units
});

// Probe 2026-11-07 (Claude Code 2.1.316, Codex 0.163.0, agy 1.5.3): a pasted image path becomes an
// attachment and each adds its own space. A space of ours lands before the chip (Claude), doubles
// (Codex) or stays in the line (agy); sent apart it costs agy a second full reprint.
test('an uploaded image goes in as one bracketed paste, with no separate space', () => {
  const one = imageInput('/tmp/t1/shot.png', 0, 1);
  assert.deepEqual(one, { d: pasteText('/tmp/t1/shot.png'), after: 0 }, 'a single image: one write, no pause after');
  assert.equal(imageInput('/tmp/a b/截图 1.png', 0, 1).d, pasteText('"/tmp/a b/截图 1.png"'), 'a path with spaces is quoted');
  const writes = ['/p/1.png', '/p/2.png', '/p/3.png'].map((p, i, all) => imageInput(p, i, all.length));
  assert.deepEqual(writes.map((w) => w.after), [IMAGE_GAP_MS, IMAGE_GAP_MS, 0], 'the pause is only between images');
  assert.ok(writes.every((w) => !w.d.endsWith(' ')), 'no trailing space');
});
