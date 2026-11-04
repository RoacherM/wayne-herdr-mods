import assert from 'node:assert/strict';
import test from 'node:test';
import { wheelSteps } from '../shared/wheel.js';
import { scrollWatch } from '../host/scroll-watch.js';

test('wheelSteps counts wheel reports, and only pure wheel input', () => {
  assert.equal(wheelSteps('\x1b[<64;2;2M'.repeat(5)), 5);
  assert.equal(wheelSteps('\x1b[<65;10;3M\x1b[M`""'), 2);
  assert.equal(wheelSteps('\x1b[<0;2;2M'), 0); // a click
  assert.equal(wheelSteps('\x1b[<64;2;2Mx'), 0); // and a letter
  assert.equal(wheelSteps(''), 0);
  assert.equal(wheelSteps(null), 0);
});

test('scrollWatch: phone steps count for w, coast steps do not; one record per gesture', async () => {
  let t = 0;
  const records = [];
  const w = scrollWatch({ record: (e) => records.push(e), now: () => t });
  w.steps(3); assert.equal(w.w, 3);
  w.steps(2, true); assert.equal(w.w, 3);
  assert.equal(w.waiting(), 0);
  t = 7; w.output(5000); // the program answered after 7 ms
  assert.equal(w.waiting(), Infinity);
  w.sent(5000); assert.equal(w.behind(), 5000);
  w.acked(3000); assert.equal(w.behind(), 2000);
  w.steps(1); t = 12; w.output(4000); w.sent(4000);
  w.stop();
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], ms: undefined }, { ev: 'macscroll', steps: 4, coast: 2, prog: 5, progMax: 7, kb: 9, behind: 6, ms: undefined });
});

test('scrollWatch: no gesture, no record; output outside a gesture is not counted', () => {
  const records = [];
  const w = scrollWatch({ record: (e) => records.push(e) });
  w.output(100); w.sent(100); w.stop();
  assert.equal(records.length, 0);
  assert.equal(w.behind(), 100);
});
