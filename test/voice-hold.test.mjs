// The hold-to-talk reducer (app/src/voice-hold.js, iOS): a release while voice.start is in
// flight must still cancel the recording — the old code read phase '' and did nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { initial, step, voiceHold } from '../app/src/voice-hold.js';

const go = (evs) => evs.reduce(({ state, fx }, ev) => { const r = step(state, ev); return { state: r.state, fx: [...fx, ...r.fx] }; }, { state: initial(), fx: [] });

test('release before voice.start returns still cancels, with the hold-longer hint', () => {
  const { state, fx } = go([{ type: 'press' }, { type: 'release' }, { type: 'started' }]);
  assert.equal(state.phase, ''); // old behaviour left it 'rec' and recorded to the 60 s limit
  assert.deepEqual(fx, ['start', 'cancel', 'hint']);
});

test('press then started then release finishes the recording', () => {
  const { state, fx } = go([{ type: 'press' }, { type: 'started' }, { type: 'release' }]);
  assert.equal(state.phase, 'rec'); // 'finish' is in flight; 'done' settles it
  assert.deepEqual(fx, ['start', 'recording', 'finish']);
});

test('a second press during start does not start twice', () => {
  const { fx } = go([{ type: 'press' }, { type: 'press' }]);
  assert.deepEqual(fx, ['start']);
});

test('dispose while starting makes the late started cancel', () => {
  const { state, fx } = go([{ type: 'press' }, { type: 'dispose' }, { type: 'started' }]);
  assert.equal(state.phase, '');
  assert.ok(state.gone);
  assert.deepEqual(fx, ['start', 'cancel']);
});

test('dispose while recording cancels', () => {
  const { state, fx } = go([{ type: 'press' }, { type: 'started' }, { type: 'dispose' }]);
  assert.equal(state.phase, '');
  assert.ok(state.gone, 'the page is gone: a later press must not record');
  assert.deepEqual(fx, ['start', 'recording', 'cancel']);
  assert.deepEqual(step(state, { type: 'press' }).fx, []);
});

test('startFailed lands back on idle', () => {
  const { state, fx } = go([{ type: 'press' }, { type: 'startFailed' }]);
  assert.equal(state.phase, '');
  assert.deepEqual(fx, ['start']);
});

test('busy then done settles to idle', () => {
  const { state } = go([{ type: 'press' }, { type: 'started' }, { type: 'release' }, { type: 'busy' }, { type: 'done' }]);
  assert.equal(state.phase, '');
});

test('cancel tap while recording cancels', () => {
  const { state, fx } = go([{ type: 'press' }, { type: 'started' }, { type: 'cancel' }]);
  assert.equal(state.phase, '');
  assert.deepEqual(fx, ['start', 'recording', 'cancel']);
});

test('step never mutates the input state', () => {
  const st = { phase: 'starting', held: true, gone: false };
  const before = JSON.stringify(st);
  step(st, { type: 'release' });
  step(st, { type: 'started' });
  assert.equal(JSON.stringify(st), before);
});

test('the session object steps and forwards effects to run', () => {
  const seen = [];
  const s = voiceHold((fx) => seen.push(...fx));
  s.send({ type: 'press' });
  s.send({ type: 'started' });
  assert.equal(s.state.phase, 'rec');
  assert.deepEqual(seen, ['start', 'recording']);
});

test('initial: idle, not held, page alive', () => {
  assert.deepEqual(initial(), { phase: '', held: false, gone: false });
});

test('cancel, busy and done outside rec are no-ops', () => {
  for (const from of [initial(), step(initial(), { type: 'press' }).state]) {
    for (const ev of [{ type: 'cancel' }, { type: 'busy' }, { type: 'done' }]) {
      const r = step(from, ev);
      assert.equal(r.state, from, `${ev.type} in ${from.phase || 'idle'}`);
      assert.deepEqual(r.fx, []);
    }
  }
});

test('a failed or finished start leaves held off', () => {
  const failed = step(step(initial(), { type: 'press' }).state, { type: 'startFailed' }).state;
  assert.equal(failed.held, false);
  const done = go([{ type: 'press' }, { type: 'started' }, { type: 'release' }, { type: 'busy' }, { type: 'done' }]).state;
  assert.equal(done.held, false);
});
