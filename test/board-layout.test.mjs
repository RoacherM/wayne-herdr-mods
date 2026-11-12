// Where the board's rows and lines go (herdr-app/mods/wayne-board/layout.js): a git graph of one agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, laneOf, tally, SIZE } from '../herdr-app/mods/wayne-board/layout.js';

const sub = (id, state, over = {}) => ({ id, kind: 'in', title: id, state, since: 1, ended: state === 'done' || state === 'failed' ? 2 : null, subs: [], ...over });
const lane = (t, steps, over = {}) => ({ t, since: 1, ended: null, state: 'working', steps, ...over });
const stop = (row) => row.y + SIZE.dotY;

test('the panel shows the agent of one terminal: the one there now, else the last one that was there', () => {
  const board = { lanes: [lane('t1', [], { since: 1, ended: 5 }), lane('t2', []), lane('t1', [], { since: 9, ended: 12 }), lane('t3', [], { since: 2, ended: 3 }), lane('t3', [], { since: 4 })] };
  assert.equal(laneOf(board, 't2'), board.lanes[1]);
  assert.equal(laneOf(board, 't1'), board.lanes[2], 'both ended: the later one');
  assert.equal(laneOf(board, 't3'), board.lanes[4], 'the one still there');
  assert.equal(laneOf(board, 't9'), null);
  assert.equal(laneOf(null, 't1'), null);
});

test('the agent is one line down rail 0: the terminal on top, then its decisions, the latest first', () => {
  const { rows, wires, height } = layout(lane('t1', [{ by: 'you', at: 1, text: 'a', subs: [] }, { by: 'agent', at: 2, text: 'b', subs: [] }]));
  const first = SIZE.pad + SIZE.headH, second = first + SIZE.decH + SIZE.groupGap;
  assert.deepEqual(rows.map((r) => [r.kind, r.step?.text, r.rail, r.y, r.h]), [
    ['head', undefined, 0, SIZE.pad, SIZE.headH],
    ['dec', 'b', 0, first, SIZE.decH],   // the latest is on top and tall
    ['dec', 'a', 0, second, SIZE.shutH], // an old decision is short
  ]);
  assert.deepEqual(wires, [{ kind: 'line', rail: 0, y: SIZE.pad + SIZE.dotY, h: second - SIZE.pad, status: 'spine' }], 'one line from the terminal to the first decision');
  assert.equal(height, second + SIZE.shutH + SIZE.pad);
  assert.ok(rows.every((r) => !('w' in r) && !('x' in r)), 'no widths: a row reaches the right edge of the panel');
  assert.deepEqual(layout(lane('t1', [])).wires, [], 'no decision yet: no line');
});

test('sub-agents are a branch: it leaves the line just above their decision and runs up rail 1, the ones needing you on top', () => {
  const { rows, wires, height } = layout(lane('t1', [{ by: 'you', at: 1, text: 'a', subs: [sub('old', 'done'), sub('draft', 'working', { since: 5 }), sub('review', 'blocked', { since: 9 })] }]));
  const top = SIZE.pad + SIZE.headH;
  assert.deepEqual(rows.slice(1).map((r) => [r.kind, r.sub?.id ?? r.step.text, r.rail, r.y - top]), [
    ['agent', 'review', 1, 0],
    ['agent', 'draft', 1, SIZE.agentH],
    ['agent', 'old', 1, SIZE.agentH * 2],
    ['dec', 'a', 0, SIZE.agentH * 3],
  ]);
  const dec = rows.at(-1), [spine, ...branch] = wires;
  assert.equal(spine.h, stop(dec) - stop(rows[0]));
  // A stretch has the color of what it still carries: past the working one only the blocked one is left.
  assert.deepEqual(branch, [
    { kind: 'line', rail: 1, y: stop(rows[1]), h: SIZE.agentH, status: 'blocked' },
    { kind: 'line', rail: 1, y: stop(rows[2]), h: SIZE.agentH, status: 'blocked' },
    { kind: 'line', rail: 1, y: stop(rows[3]), h: dec.y - SIZE.bend - stop(rows[3]), status: 'blocked' },
    { kind: 'fork', rail: 0, y: dec.y, status: 'blocked' },
  ]);
  assert.equal(height, dec.y + SIZE.decH + SIZE.pad);
  const calm = layout(lane('t1', [{ by: 'you', at: 1, text: 'a', subs: [sub('old', 'done'), sub('draft', 'working')] }])).wires.slice(1).map((w) => w.status);
  assert.deepEqual(calm, ['working', 'working', 'working'], 'the branch is lit as far as its working stop; an ended stop below it is on the way');
});

test("a sub-agent's own sub-agents branch off it one rail further, and sit above it", () => {
  const flow = sub('flow', 'working', { kind: 'term', subs: [sub('bugs', 'done'), sub('perf', 'working')] });
  const { rows, wires } = layout(lane('t1', [{ by: 'you', at: 1, text: 'a', subs: [flow, sub('plain', 'done')] }]));
  assert.deepEqual(rows.slice(1).map((r) => [r.sub?.id ?? 'dec', r.rail]), [['perf', 2], ['bugs', 2], ['flow', 1], ['plain', 1], ['dec', 0]]);
  const [perf, bugs, flowRow] = rows.slice(1);
  assert.deepEqual(wires.slice(1, 5), [
    { kind: 'line', rail: 2, y: stop(perf), h: SIZE.agentH, status: 'working' },
    { kind: 'line', rail: 2, y: stop(bugs), h: flowRow.y - SIZE.bend - stop(bugs), status: 'working' },
    { kind: 'fork', rail: 1, y: flowRow.y, status: 'working' },
    { kind: 'line', rail: 1, y: flowRow.y, h: SIZE.dotY, status: 'working' }, // from the bend down to flow's own stop
  ]);
});

test('deep nesting stops taking new rails, so a row keeps room for its words in a narrow panel', () => {
  let deep = sub('d0', 'working');
  for (let i = 1; i < 6; i++) deep = sub(`d${i}`, 'working', { subs: [deep] });
  const { rows, wires } = layout(lane('t1', [{ by: 'start', at: 1, text: '', subs: [deep] }]));
  assert.deepEqual(rows.filter((r) => r.kind === 'agent').map((r) => [r.sub.id, r.rail]), [['d0', 3], ['d1', 3], ['d2', 3], ['d3', 3], ['d4', 2], ['d5', 1]]);
  assert.equal(wires.filter((w) => w.kind === 'fork').length, 3, 'on the last rail the line just goes on');
  assert.deepEqual(wires.filter((w) => w.rail === 3).map((w) => w.h), [SIZE.agentH, SIZE.agentH, SIZE.agentH, SIZE.agentH - SIZE.dotY - SIZE.bend]);
});

test('an old decision whose sub-agents all ended folds them into one pile; a click turns it around', () => {
  const steps = [{ by: 'you', at: 1, text: 'a', subs: [sub('x', 'done', { subs: [sub('y', 'failed')] })] }, { by: 'you', at: 2, text: 'b', subs: [] }];
  const folded = layout(lane('t1', steps)).rows.slice(1);
  assert.deepEqual(folded.map((r) => [r.kind, r.step.text, r.rail, r.h]), [['dec', 'b', 0, SIZE.decH], ['pile', 'a', 1, SIZE.pileH], ['dec', 'a', 0, SIZE.shutH]]);
  assert.deepEqual([folded[1].count, folded[1].tally], [2, { blocked: 0, working: 0, failed: 1, done: 1 }]);
  const opened = layout(lane('t1', steps), new Set([folded[2].key])).rows.slice(1);
  assert.deepEqual(opened.map((r) => [r.kind, r.h]), [['dec', SIZE.decH], ['agent', SIZE.agentH], ['agent', SIZE.agentH], ['dec', SIZE.decH]]);
  // An old decision with a sub-agent still at work stays open by itself.
  steps[0].subs.push(sub('z', 'working'));
  assert.equal(layout(lane('t1', steps)).rows.find((r) => r.step?.text === 'a').open, true);
});

test('counting sub-agents by state; no lane, nothing to draw', () => {
  assert.deepEqual(tally([sub('a', 'error'), sub('b', 'idle'), sub('c', 'working'), sub('d', 'failed')]), { blocked: 1, working: 1, failed: 1, done: 1 });
  assert.deepEqual(layout(null), { rows: [], wires: [], height: SIZE.pad });
});

test('a pile also counts the sub-agents the host no longer keeps', () => {
  const steps = [{ by: 'you', at: 1, text: 'a', dropped: { done: 3, failed: 1 }, subs: [sub('x', 'done', { dropped: { done: 2, failed: 0 } })] }, { by: 'you', at: 2, text: 'b', subs: [] }];
  const pile = layout(lane('t1', steps)).rows.find((r) => r.kind === 'pile');
  assert.deepEqual([pile.count, pile.tally], [7, { blocked: 0, working: 0, failed: 1, done: 6 }]);
});
