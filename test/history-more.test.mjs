// When the terminal page asks for older history, and what its top line says (app/src/history-more.js,
// DESIGN.md「往回翻历史」). Pure: every path runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MORE_MAX, initial, step, topLabel } from '../app/src/history-more.js';

function run(events, st = initial()) {
  const asks = [];
  for (const ev of events) { const r = step(st, ev); st = r.state; if (r.ask !== null) asks.push(r.ask); }
  return { st, asks };
}
const first = { type: 'painted', promised: 150, baseY: 151, older: false };

test('nothing is asked before the first paint says how much it brought', () => {
  assert.deepEqual(run([{ type: 'idle' }, { type: 'near' }]).asks, []);
});

test('one background ask after the first paint is quiet; never two while one is out', () => {
  const { st, asks } = run([first, { type: 'idle' }, { type: 'idle' }, { type: 'near' }]);
  assert.deepEqual(asks, [150]);
  assert.equal(st.pending, true);
  assert.equal(topLabel(st), '加载更早…');
});

test('each paint of older history lets the next ask go, with what that paint promised', () => {
  const { asks, st } = run([
    first, { type: 'idle' },
    { type: 'painted', promised: 600, baseY: 600, older: true }, { type: 'near' },
    { type: 'painted', promised: 1200, baseY: 1200, older: true }, { type: 'near' },
  ]);
  assert.deepEqual(asks, [150, 600, 1200]);
  assert.equal(st.earliest, false);
  assert.equal(run([first, { type: 'idle' }, { type: 'painted', promised: 600, baseY: 600, older: true }, { type: 'idle' }]).asks.length, 1, 'the background ask runs once');
});

test('a paint short of what it promised is all there is: no more asks, the top says so', () => {
  const short = run([first, { type: 'idle' }, { type: 'painted', promised: 2000, baseY: 1600, older: true }, { type: 'near' }]);
  assert.deepEqual(short.asks, [150]);
  assert.equal(topLabel(short.st), '已到最早');
  // Within the slack of a couple of rows (a wrapped line), it is not short.
  assert.equal(run([{ type: 'painted', promised: 150, baseY: 148, older: false }]).st.earliest, false);
  // A short history from the start: nothing is ever asked.
  const tiny = run([{ type: 'painted', promised: 150, baseY: 30, older: false }, { type: 'idle' }, { type: 'near' }]);
  assert.deepEqual(tiny.asks, []);
  assert.equal(topLabel(tiny.st), '已到最早');
});

test('an older paint that brought no new rows, or one at the cap, is the end too', () => {
  const same = run([first, { type: 'near' }, { type: 'painted', promised: 600, baseY: 151, older: true }, { type: 'near' }]);
  assert.deepEqual(same.asks, [150]);
  assert.equal(same.st.earliest, true);
  const cap = run([{ type: 'painted', promised: MORE_MAX, baseY: MORE_MAX, older: true }, { type: 'near' }]);
  assert.deepEqual(cap.asks, []);
  assert.equal(cap.st.earliest, true);
});

test('an ask that got no paint frees the next one; a reprint starts over', () => {
  assert.deepEqual(run([first, { type: 'near' }, { type: 'near' }, { type: 'timeout' }, { type: 'near' }]).asks, [150, 150]);
  // A reprint (fresh, not older) after the end was reached: 150 rows again, so asking makes sense again.
  const again = run([first, { type: 'idle' }, { type: 'painted', promised: 600, baseY: 300, older: true }, first, { type: 'idle' }]);
  assert.deepEqual(again.asks, [150, 150]);
  assert.equal(topLabel(again.st), '加载更早…');
  assert.equal(topLabel(initial()), '');
});
