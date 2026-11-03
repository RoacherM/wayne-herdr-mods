import test from 'node:test';
import assert from 'node:assert/strict';
import { coastSteps, MAX_STEPS } from '../shared/coast.js';

test('a flick coasts for about two seconds, fast at first, then slower', () => {
  const t = coastSteps(2, 14);
  assert.ok(t.length > 50 && t.length < 100, `${t.length} steps`);
  assert.ok(t.at(-1) > 1500 && t.at(-1) < 2500, `ends at ${t.at(-1)} ms`);
  const per = (a, b) => t.filter((x) => x >= a && x < b).length;
  assert.ok(per(0, 300) > 2 * per(600, 900), 'slows down');
  for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1], 'in time order');
});

test('the sign of the speed does not matter; a faster flick goes farther', () => {
  assert.deepEqual(coastSteps(-2, 14), coastSteps(2, 14));
  assert.ok(coastSteps(4, 14).length > coastSteps(2, 14).length);
});

test('no steps for a slow lift or a bad row height; never more than MAX_STEPS', () => {
  assert.deepEqual(coastSteps(0.02, 14), []);
  assert.deepEqual(coastSteps(2, 0), []);
  assert.deepEqual(coastSteps(2, NaN), []);
  assert.equal(coastSteps(1000, 1).length, MAX_STEPS);
});
