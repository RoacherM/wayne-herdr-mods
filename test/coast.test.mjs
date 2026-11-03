import test from 'node:test';
import assert from 'node:assert/strict';
import { coastSteps, LINES_PER_STEP, MAX_GAP_MS, MAX_STEPS } from '../shared/coast.js';

test('a flick moves the content as far as an iOS list would, fast at first, no slow drip at the end', () => {
  const t = coastSteps(2.5, 14);
  // iOS: 2.5 px/ms × 500 ms = 1250 px = 89 rows of 14 px; here each step is 3 lines.
  assert.ok(Math.abs(t.length * LINES_PER_STEP - 89) < 10, `${t.length} steps`);
  assert.ok(t.at(-1) > 300 && t.at(-1) < 700, `ends at ${t.at(-1)} ms`);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] <= MAX_GAP_MS + 17, `gap ${t[i] - t[i - 1]} ms at step ${i}`);
  const per = (a, b) => t.filter((x) => x >= a && x < b).length;
  assert.ok(per(0, 100) > 2 * per(200, 300) && per(200, 300) > 0, 'slows down');
  for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1], 'in time order');
});

test('the sign of the speed does not matter; a faster flick goes farther', () => {
  assert.deepEqual(coastSteps(-2, 14), coastSteps(2, 14));
  assert.ok(coastSteps(4, 14).length > coastSteps(2, 14).length);
});

test('no steps for a slow lift or a bad row height; never more than MAX_STEPS', () => {
  assert.deepEqual(coastSteps(0.1, 14), []); // slower than a row per 100 ms
  assert.deepEqual(coastSteps(2, 0), []);
  assert.deepEqual(coastSteps(2, NaN), []);
  assert.equal(coastSteps(1000, 1).length, MAX_STEPS);
});
