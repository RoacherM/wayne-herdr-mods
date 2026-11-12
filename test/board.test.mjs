// The observability board's memory (host/board.js): herdr-core's facts in, lanes of decisions and sub-agents out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard, emptyBoard, observe, NOTE, SAID } from '../host/board.js';

// A Claude Code terminal as herdr-core reports it (hc 0.1.20, t48 on 2026-11-12).
const agent = (over = {}) => ({ address: 't48', state: 'live', parent: null, cwd: '/w/herdr-relay', labels: { where: 'herdr-relay / 1' }, status: { app: 'claude-code', state: 'working', msg: 'Reading files' }, records: {}, ...over });
const subs = (lane) => lane.steps.flatMap((s) => s.subs);

test('a sub-agent inside the process is a record: it starts when the record appears and ends when it goes', () => {
  const board = emptyBoard();
  observe(board, [agent()], 1000);
  assert.equal(board.lanes.length, 1);
  assert.deepEqual(board.lanes[0].steps, [], 'no decision and no sub-agent: nothing on the lane yet');

  // The record exactly as the core sent it while a sub-agent ran.
  const records = { afb1cb2a78e47d02c: { app: 'claude-code', state: 'working', title: 'Probe subagent status reporting' } };
  assert.equal(observe(board, [agent({ records })], 2000), true);
  const [sub] = subs(board.lanes[0]);
  assert.deepEqual({ id: sub.id, kind: sub.kind, title: sub.title, state: sub.state, since: sub.since, ended: sub.ended }, { id: 'afb1cb2a78e47d02c', kind: 'in', title: 'Probe subagent status reporting', state: 'working', since: 2000, ended: null });
  assert.equal(board.lanes[0].steps[0].by, 'start', 'with no decision yet it hangs under a plain start step');

  assert.equal(observe(board, [agent({ records })], 2500), false, 'nothing new: no change, no write');

  observe(board, [agent({ records: {} })], 3000);
  assert.deepEqual({ state: sub.state, ended: sub.ended }, { state: 'done', ended: 3000 });
});

test('a label is a decision; sub-agents hang under the latest one', () => {
  const board = emptyBoard();
  observe(board, [agent({ labels: { [SAID]: '1794454000000|把指标统计做完' } })], 1000);
  observe(board, [agent({ labels: { [SAID]: '1794454000000|把指标统计做完' }, records: { a: { state: 'working', title: 'explore' } } })], 2000);
  observe(board, [agent({ labels: { [SAID]: '1794454000000|把指标统计做完', [NOTE]: '字段用 host 的名字' }, records: { a: { state: 'working', title: 'explore' } } })], 3000);
  observe(board, [agent({ labels: { [SAID]: '1794454000000|把指标统计做完', [NOTE]: '字段用 host 的名字' }, records: { a: { state: 'working', title: 'explore' }, b: { state: 'blocked', title: 'review' } } })], 4000);
  const lane = board.lanes[0];
  assert.deepEqual(lane.steps.map((s) => [s.by, s.at, s.text, s.subs.map((x) => x.id)]), [
    ['you', 1794454000000, '把指标统计做完', ['a']],
    ['agent', 3000, '字段用 host 的名字', ['b']],
  ]);
  assert.equal(lane.steps[1].subs[0].state, 'blocked');
  // The same label seen again is not a second decision.
  observe(board, [agent({ labels: { [SAID]: '1794454000000|把指标统计做完', [NOTE]: '字段用 host 的名字' } })], 5000);
  assert.equal(lane.steps.length, 2);
});

test('a terminal started with hc run is a sub-agent of its parent, with its own sub-agents under it', () => {
  const board = emptyBoard();
  const kid = { address: 't6d', state: 'live', parent: 't48', name: 'reviewer', template: 'reviewer', status: { app: 'pi', state: 'working' }, records: { r1: { state: 'working', title: 'bugs' } } };
  const plain = { address: 't6e', state: 'live', parent: 't48', name: 'tests', status: null }; // `hc run npm test`
  observe(board, [agent(), kid, plain], 1000);
  const [sub] = subs(board.lanes[0]);
  assert.deepEqual([sub.id, sub.kind, sub.title, sub.app], ['t6d', 'term', 'reviewer', 'pi']);
  assert.deepEqual(sub.subs.map((x) => x.title), ['bugs']);
  assert.equal(subs(board.lanes[0]).length, 1, 'a plain command is not a sub-agent');
  assert.equal(board.lanes.length, 1, 'a child is not a lane of its own');

  observe(board, [agent(), { ...kid, state: 'finished', status: null, records: {}, exit_code: 3 }], 2000);
  assert.deepEqual([sub.state, sub.ended, sub.subs[0].ended], ['failed', 2000, 2000]);
});

test('an agent that leaves its terminal ends the lane; the next one there starts a new lane', () => {
  const board = emptyBoard();
  observe(board, [agent({ records: { a: { state: 'working', title: 'x' } } })], 1000);
  observe(board, [agent({ status: null, records: {} })], 2000); // back at the shell: the core cleared the status
  assert.deepEqual([board.lanes[0].ended, board.lanes[0].state, subs(board.lanes[0])[0].ended], [2000, 'idle', 2000]);
  observe(board, [agent()], 3000);
  assert.deepEqual(board.lanes.map((l) => [l.since, l.ended]), [[1000, 2000], [3000, null]]);
  observe(board, [agent()], 3000 + 13 * 3600_000);
  assert.equal(board.lanes.length, 1, 'a lane that ended more than 12 hours ago is dropped');
});

test('the board is written whole to board.json after a change, and read back on the next start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const a = createBoard({ dir, now: () => 1000, delayMs: 5 });
  a.update([agent({ labels: { [NOTE]: '先交统计' } })]);
  await new Promise((r) => setTimeout(r, 40));
  const saved = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  assert.equal(saved.lanes[0].steps[0].text, '先交统计');
  assert.equal(saved.at, 1000);
  const b = createBoard({ dir, now: () => 2000, delayMs: 5 });
  assert.equal(b.board().lanes[0].steps[0].text, '先交统计');
  b.update([agent({ labels: { [NOTE]: '先交统计' } })]);
  assert.equal(b.board().lanes[0].steps.length, 1, 'the label it already took is not taken again after a restart');
});

test('a block still has a name and a state when the program said little', () => {
  const board = emptyBoard();
  const kids = [
    { address: 't7', state: 'live', parent: 't48', template: 'reviewer', status: null },        // started from a template, not reporting yet
    { address: 't8', state: 'live', parent: 't48', status: { state: 'working' } },              // no name, no template
  ];
  observe(board, [agent({ foreground: { cwd: '/w/now' }, records: { r1: { state: 'working', msg: 'doing' }, r2: { state: 'error' } } }), ...kids], 1000);
  const lane = board.lanes[0];
  assert.equal(lane.cwd, '/w/now', 'where the agent is now, not where its terminal started');
  assert.deepEqual(subs(lane).map((s) => [s.id, s.title, s.app, s.state]), [
    ['r1', 'doing', null, 'working'],
    ['r2', 'r2', null, 'error'],
    ['t7', 'reviewer', 'reviewer', 'working'],
    ['t8', 't8', null, 'working'],
  ]);
  observe(board, [agent({ records: { r1: { state: 'working', msg: 'doing' } } }), { ...kids[0], state: 'finished', exit_code: 0 }], 2000);
  assert.deepEqual(subs(lane).map((s) => [s.id, s.state]), [['r1', 'working'], ['r2', 'failed'], ['t7', 'done'], ['t8', 'done']], 'a record that vanished in error failed; a terminal that is gone without an exit code ended');
});

test('a lane keeps its latest 40 decisions; terminals on other machines are left out', () => {
  const board = emptyBoard();
  for (let i = 0; i < 45; i++) observe(board, [agent({ labels: { [NOTE]: `决定 ${i}` } }), agent({ address: 'vps/t3' })], 1000 + i);
  assert.equal(board.lanes.length, 1);
  assert.deepEqual([board.lanes[0].steps.length, board.lanes[0].steps[0].text, board.lanes[0].steps.at(-1).text], [40, '决定 5', '决定 44']);
});

test('trimming old decisions never takes one whose sub-agent is still at work', () => {
  const board = emptyBoard();
  const records = { r: { state: 'working', title: 'long job' } };
  observe(board, [agent({ labels: { [NOTE]: '决定 0' }, records })], 1000);
  for (let i = 1; i <= 44; i++) observe(board, [agent({ labels: { [NOTE]: `决定 ${i}` }, records })], 1000 + i);
  observe(board, [agent({ labels: { [NOTE]: '决定 44' }, records })], 2000);
  const lane = board.lanes[0];
  assert.equal(lane.steps.length, 40);
  assert.deepEqual([lane.steps[0].text, lane.steps[0].subs.map((s) => [s.id, s.since])], ['决定 0', [['r', 1000]]], 'the running sub-agent keeps its decision and its start time');
  assert.equal(subs(lane).length, 1, 'and is not added a second time');
});

test('an agent that runs for days keeps at most 60 sub-agents per decision and counts the rest', () => {
  const board = emptyBoard();
  for (let i = 0; i < 100; i++) {
    observe(board, [agent({ records: { [`r${i}`]: { state: 'working', title: `job ${i}` }, keep: { state: 'working', title: 'still running' } } })], 1000 + 2 * i);
    observe(board, [agent({ records: { keep: { state: 'working', title: 'still running' } } })], 1001 + 2 * i);
  }
  const [step] = board.lanes[0].steps;
  assert.deepEqual([step.subs.length, step.dropped], [60, { done: 41, failed: 0 }]);
  assert.ok(step.subs.some((s) => s.id === 'keep' && !s.ended), 'the one at work stays');
  assert.equal(step.subs.at(-1).id, 'r99', 'the latest ended ones stay');
});

test('the latest decision is never trimmed away, even when every older one still has a sub-agent at work', () => {
  const board = emptyBoard();
  const records = {};
  for (let i = 0; i < 40; i++) {
    observe(board, [agent({ labels: { [NOTE]: `note ${i}` }, records: { ...records } })], 1000 + 2 * i);
    records[`r${i}`] = { state: 'working', title: `job ${i}` };
    observe(board, [agent({ labels: { [NOTE]: `note ${i}` }, records: { ...records } })], 1001 + 2 * i);
  }
  observe(board, [agent({ labels: { [NOTE]: 'note 40' }, records: { ...records } })], 2000);
  observe(board, [agent({ labels: { [NOTE]: 'note 40' }, records: { ...records, r40: { state: 'working', title: 'job 40' } } })], 2001);
  const steps = board.lanes[0].steps;
  assert.deepEqual([steps.length, steps.at(-1).text, steps.at(-1).subs.map((s) => s.id)], [41, 'note 40', ['r40']], 'over the limit rather than a sub-agent under the wrong decision');
});

test('a dropped sub-agent leaves its count behind: itself, everything under it, and how each ended', () => {
  const board = emptyBoard();
  const kid = { address: 't9', state: 'live', parent: 't48', name: 'big', status: { state: 'working' }, records: {} };
  for (let i = 0; i < 70; i++) { // a terminal sub-agent with 70 ended sub-agents of its own (10 of them already only counted)
    observe(board, [agent(), { ...kid, records: { [`k${i}`]: { state: i % 7 ? 'working' : 'error' } } }], 1000 + i);
    observe(board, [agent(), kid], 1000 + i);
  }
  observe(board, [agent()], 2000); // it ends
  for (let i = 0; i < 60; i++) { observe(board, [agent({ records: { [`s${i}`]: { state: 'error' } } })], 3000 + i); observe(board, [agent()], 3000 + i); }
  const [step] = board.lanes[0].steps;
  assert.equal(step.subs.length, 60);
  assert.deepEqual(step.dropped, { done: 1 + 60, failed: 10 }, 'the big one, its 60 that ended well and its 10 that failed');
  assert.equal(step.subs.filter((s) => s.state === 'failed').length, 60);
});
