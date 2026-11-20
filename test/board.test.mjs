// The observability board's topology memory (host/board.js): herdr-core + session transcripts -> v2 Metro topology.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard, emptyBoard, observe } from '../host/board.js';

const mainTerm = (over = {}) => ({
  address: 't48',
  state: 'live',
  parent: null,
  pid: 100,
  cwd: '/w/herdr-relay',
  labels: { where: 'herdr-relay / 1' },
  status: { app: 'claude-code', state: 'working', msg: 'Editing' },
  records: {},
  ...over,
});

test('fuses transcript spawn/message/return topology with live herdr-core status', () => {
  const board = emptyBoard();
  const fakeReader = {
    read: () => ({
      sessionId: 'sess-1',
      model: 'fable-5-2',
      agents: [
        { id: 'sub-1', name: 'WebKit Audit', via: 'Explore', model: 'sonnet', state: 'done', start: 1100, end: 1800, prompt: 'Check leaks', reply: 'Found double-hop' },
        { id: 'sub-2', name: 'Security Review', via: 'agy', model: 'pro', state: 'working', start: 1200, end: null, prompt: 'Audit phones.js', reply: null },
      ],
      events: [
        { kind: 'spawn', id: 'sp1', at: 1100, from: 'main', to: 'sub-1', title: 'WebKit Audit', detail: 'Check leaks', via: 'Explore', model: 'sonnet' },
        { kind: 'spawn', id: 'sp2', at: 1200, from: 'main', to: 'sub-2', title: 'Security Review', detail: 'Audit phones.js', via: 'agy', model: 'pro' },
        { kind: 'message', id: 'm1', at: 1500, from: 'main', to: 'sub-2', summary: '重点看 RPC 白名单', detail: 'Focus on ALLOWED methods' },
        { kind: 'return', id: 'r1', at: 1800, from: 'sub-1', to: 'main', status: 'done', summary: 'Found double-hop', detail: 'Found double-hop' },
      ],
    }),
  };

  assert.equal(observe(board, [mainTerm({ status: { app: 'antigravity', state: 'working', msg: 'Casual Greeting' } })], 2000, {
    read: () => ({ ...fakeReader.read(), activity: 'Audit phones.js RPC whitelist' }),
  }), true);
  assert.equal(board.v, 2);
  const [lane] = board.lanes;
  assert.equal(lane.model, 'fable-5-2');
  assert.equal(lane.activity, 'Audit phones.js RPC whitelist', 'live transcript step overrides static session title while working');
  assert.deepEqual(lane.stats, { totalSubs: 2, running: 1, waiting: 0, blocked: 0, done: 1, failed: 0, stopped: 0, messages: 1 });
  assert.equal(lane.agents.length, 2);
  assert.deepEqual(lane.events.map((e) => e.kind), ['spawn', 'spawn', 'message', 'return']);
  assert.equal(observe(board, [mainTerm({ status: { app: 'antigravity', state: 'working', msg: 'Casual Greeting' } })], 2100, {
    read: () => ({ ...fakeReader.read(), activity: 'Audit phones.js RPC whitelist' }),
  }), false, 'unchanged snapshot produces no redundant write');

  observe(board, [mainTerm({ status: { app: 'antigravity', state: 'error', msg: 'Individual quota reached.' } })], 2200, {
    read: () => ({ ...fakeReader.read(), activity: 'Audit phones.js RPC whitelist' }),
  });
  assert.equal(board.lanes[0].activity, 'Individual quota reached.', 'herdr-core error/blocked/done msg wins when not working');
});

test('captures hc run child terminals and in-process records without relying on labels', () => {
  const board = emptyBoard();
  const kid = {
    address: 't6d', state: 'live', parent: 't48', name: 'reviewer', template: 'reviewer',
    status: { app: 'epi', state: 'blocked', msg: 'Allow bash?' }, records: {},
  };
  const plain = { address: 't6e', state: 'live', parent: 't48', name: 'npm test', status: null };

  observe(board, [
    mainTerm({
      labels: { 'wayne.note': 'ignored legacy label' },
      records: { r1: { state: 'working', title: 'Explore layout' } },
    }),
    kid,
    plain,
  ], 1500);

  const [lane] = board.lanes;
  assert.equal(lane.agents.length, 2, 'plain non-agent shell child is excluded; reviewer + record included');
  assert.equal(lane.events.some((e) => e.kind === 'note' || e.kind === 'prompt'), false, 'no note/prompt clutter');
  const termSub = lane.agents.find((a) => a.terminal === 't6d');
  assert.deepEqual([termSub.name, termSub.via, termSub.state], ['reviewer', 'epi', 'blocked']);
  assert.equal(lane.stats.blocked, 1);

  observe(board, [
    mainTerm({ records: {} }),
    { ...kid, state: 'finished', status: null, exit_code: 2 },
  ], 2500);

  assert.equal(lane.agents.find((a) => a.id === 'hc:t6d').state, 'failed');
  assert.equal(lane.agents.find((a) => a.id === 'rec:r1').state, 'done');
  const returns = lane.events.filter((e) => e.kind === 'return');
  assert.equal(returns.length, 2);
  assert.deepEqual(returns.map((e) => e.summary), ['', ''], 'no synthetic 已完成/执行失败 filler caption');
});

test('links an hc child terminal onto a matching transcript subagent without duplicate rails', () => {
  const board = emptyBoard();
  const reader = {
    read: () => ({
      sessionId: 's1',
      model: 'pro',
      agents: [{ id: 'bg-t6d', name: 'reviewer', via: 'hc', model: 'gpt-6.1', terminal: 't6d', state: 'working', start: 1000, end: null, prompt: 'review diff', reply: null }],
      events: [{ kind: 'spawn', id: 'sp1', at: 1000, from: 'main', to: 'bg-t6d', title: 'reviewer', detail: 'review diff', via: 'hc' }],
    }),
  };
  const kid = { address: 't6d', state: 'live', parent: 't48', name: 'reviewer', status: { app: 'epi', state: 'blocked', msg: 'Question' } };
  observe(board, [mainTerm({ status: { app: 'antigravity', state: 'working' } }), kid], 1200, reader);
  const [lane] = board.lanes;
  assert.equal(lane.agents.length, 1, 'merged into a single subagent branch');
  assert.equal(lane.agents[0].terminal, 't6d');
  assert.equal(lane.agents[0].state, 'blocked', 'live hc blocked state wins');
});

test('persists board.json atomically, reloads v2 state, and drops lanes ended over 12 hours ago', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-v2-'));
  let changes = 0;
  const a = createBoard({ dir, now: () => 1000, delayMs: 5, pollMs: 0, onChange: () => { changes++; } });
  a.update([mainTerm({ records: { r1: { state: 'working', title: 'Audit' } } })]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(changes, 1, 'onChange fires once after debounced flush');
  a.dispose();

  const saved = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  assert.equal(saved.v, 2);
  assert.equal(saved.lanes[0].agents[0].name, 'Audit');

  const b = createBoard({ dir, now: () => 2000, delayMs: 5, pollMs: 0 });
  assert.equal(b.board().lanes[0].agents[0].name, 'Audit');
  b.update([mainTerm({ status: null, records: {} })]);
  assert.equal(b.board().lanes[0].ended, 2000);
  b.dispose();

  const c = createBoard({ dir, now: () => 2000 + 13 * 3600_000, delayMs: 5, pollMs: 0 });
  c.update([mainTerm()]);
  assert.equal(c.board().lanes.length, 1, 'old ended lane pruned after 12h');
  assert.equal(c.board().lanes[0].ended, null);
  c.dispose();
});

test('tracks foreground-only local agents without OSC 7501 and closes lanes when foreground returns to shell', () => {
  const board = emptyBoard();
  const droidTerm = {
    address: 't70', state: 'live', parent: null, pid: 500, cwd: '/w/app',
    foreground: { name: 'node', argv: ['node', '/Users/me/.local/bin/droid'], cwd: '/w/app', pid: 505 },
    status: null, records: {}, labels: { where: 'app / 1' },
  };
  const reader = {
    read: () => ({ sessionId: 'dr-1', model: 'claude-opus-5-5', state: 'working', activity: 'Simplify producer', agents: [], events: [] }),
  };
  observe(board, [droidTerm], 1000, reader);
  assert.equal(board.lanes.length, 1);
  assert.deepEqual([board.lanes[0].app, board.lanes[0].model, board.lanes[0].state, board.lanes[0].activity], ['droid', 'claude-opus-5-5', 'working', 'Simplify producer']);

  // Agent exits back to zsh, even if stale OSC status remained on the terminal
  observe(board, [{
    ...droidTerm,
    foreground: { name: 'zsh', argv: ['-zsh'], cwd: '/w/app', pid: 500 },
    status: { app: 'droid', state: 'done', msg: 'Bye' },
  }], 2000, reader);
  assert.equal(board.lanes[0].ended, 2000, 'shell in foreground closes the agent lane cleanly');
});

test('deduplicates Claude toolu_* (agentId) against herdr-core rec:<agentId>, propagates blocked msg, and splits 6-state stats', () => {
  const board = emptyBoard();
  let seenSince = null;
  const reader = {
    read: (term) => {
      seenSince = term.since;
      return {
        sessionId: 'sess-6st',
        model: 'opus-5-5',
        agents: [
          { id: 'toolu_01W9ft', agentId: 'a7806236', name: 'Fix I-016', via: 'general-purpose', state: 'working', activity: 'Run cargo test', start: 1100, end: null, prompt: 'Fix file safety', reply: null },
          { id: 'swarm:verifier', name: 'verifier', via: 'swarm', state: 'waiting', start: 1150, end: null, prompt: 'Gatekeeper', reply: null },
          { id: 'hc-rev', name: 'reviewer', via: 'hc', terminal: 't6d', state: 'working', start: 1200, end: null, prompt: 'Review diff', reply: null },
          { id: 'swarm:cancelled', name: 'cancelled', via: 'swarm', state: 'stopped', start: 1250, end: 1400, prompt: 'Old slice', reply: null },
          { id: 'cmd-fail', name: 'smoke', via: 'claude', state: 'failed', start: 1300, end: 1450, prompt: 'Run smoke', reply: 'exit 1' },
          { id: 'sub-done', name: 'done-worker', via: 'Explore', state: 'done', start: 1350, end: 1500, prompt: 'Scan', reply: 'Clean' },
        ],
        events: [
          { kind: 'spawn', id: 'sp-1', at: 1100, from: 'main', to: 'toolu_01W9ft', title: 'Fix I-016' },
          { kind: 'message', id: 'm-1', at: 1420, from: 'sub-done', to: 'swarm:verifier', summary: 'Handoff' },
        ],
      };
    },
  };
  const kidBlocked = {
    address: 't6d', state: 'live', parent: 't48', name: 'reviewer',
    status: { app: 'epi', state: 'blocked', msg: 'Allow bash: git diff?' },
  };
  // Tick 1: herdr-core record appears before transcript flushes -> creates rec:a7806236 runtime rail
  observe(board, [mainTerm({ since: 950, records: { a7806236: { state: 'working', title: 'Fix I-016' } } })], 1000);
  assert.equal(board.lanes[0].events.some((e) => e.id === 'rt-sp-rec:a7806236'), true);

  // Tick 2: transcript flushes with toolu_01W9ft (agentId: a7806236) -> upgrades & deduplicates runtime rail + spawn
  observe(board, [
    mainTerm({
      since: 950,
      records: { a7806236: { state: 'working', title: 'Fix I-016' } },
    }),
    kidBlocked,
  ], 1600, reader);

  assert.equal(seenSince, 950, 'passes terminal/lane since timestamp into sessionReader.read');
  const [lane] = board.lanes;
  assert.equal(lane.agents.length, 6, 'herdr-core rec:a7806236 merged into toolu_01W9ft without duplicate rail');
  assert.equal(lane.events.some((e) => e.id === 'rt-sp-rec:a7806236'), false, 'no duplicate synthetic spawn event for rec:<agentId>');

  const fixSub = lane.agents.find((a) => a.id === 'toolu_01W9ft');
  assert.equal(fixSub.agentId, 'a7806236');
  assert.equal(fixSub.activity, 'Run cargo test');

  const blockedSub = lane.agents.find((a) => a.terminal === 't6d');
  assert.equal(blockedSub.state, 'blocked');
  assert.equal(blockedSub.msg, 'Allow bash: git diff?', 'hc child blocked msg passthrough');

  assert.deepEqual(lane.stats, {
    totalSubs: 6,
    running: 1,
    waiting: 1,
    blocked: 1,
    done: 1,
    failed: 1,
    stopped: 1,
    messages: 1,
  });
});

test('uses herdr-core created_ms / finished_ms for root lane since and child hc sub-terminal timestamps', () => {
  const board = emptyBoard();
  let seenSince = null;
  const reader = {
    read: (term) => {
      seenSince = term.since;
      return { sessionId: 's-cms', model: 'carbon-high', agents: [], events: [] };
    },
  };
  const rootCreated = 1_794_797_000_000;
  const kidCreated = 1_794_797_100_000;
  const kidFinished = 1_794_797_400_000;
  const now = 1_794_800_600_000;

  const root = mainTerm({ address: 't70', created_ms: rootCreated, finished_ms: null });
  delete root.since;
  const finishedKid = {
    address: 't73', state: 'finished', parent: 't70', name: 'worker-pane', template: 'worker',
    created_ms: kidCreated, finished_ms: kidFinished, exit_code: 0, status: null, records: {},
  };

  observe(board, [root, finishedKid], now, reader);
  const [lane] = board.lanes;
  assert.equal(lane.since, rootCreated, 'lane.since uses herdr-core created_ms rather than now');
  assert.equal(seenSince, rootCreated, 'sessionReader receives real created_ms so idle cwd sessions are not rejected');
  const kidSub = lane.agents.find((a) => a.id === 'hc:t73');
  assert.equal(kidSub.start, kidCreated);
  assert.equal(kidSub.end, kidFinished);
});

test('createBoard with polling uses non-blocking prepareAsync + readBound instead of sync discovery on update()', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-async-'));
  let syncReadCalls = 0;
  let asyncPrepareCalls = 0;
  let bound = false;
  let nowVal = 1000;
  let resolveUpdated;
  const updated = new Promise((r) => { resolveUpdated = r; });

  const sessionReader = {
    read: () => { syncReadCalls++; return null; },
    readBound: () => (bound ? { sessionId: 'async-s1', model: 'neon-high', state: 'working', activity: 'Ready', agents: [], events: [] } : null),
    needsPrepare: () => !bound,
    prepareAsync: async () => {
      asyncPrepareCalls++;
      await Promise.resolve();
      bound = true;
    },
  };

  let changes = 0;
  const svc = createBoard({
    dir,
    now: () => nowVal,
    delayMs: 5,
    pollMs: 2000,
    sessionReader,
    onChange: (doc) => {
      changes++;
      if (doc.lanes[0]?.sessionId === 'async-s1') resolveUpdated();
    },
  });
  t.after(() => svc.dispose());

  svc.update([mainTerm({ address: 't90', status: { app: 'antigravity', state: 'working', msg: 'Init' } })]);
  assert.equal(syncReadCalls, 0, 'update() never falls back to blocking sync read() when prepareAsync is supported');
  assert.equal(asyncPrepareCalls, 1, 'update() kicks off background prepareAsync');
  await updated;
  assert.equal(svc.board().lanes[0].sessionId, 'async-s1', 'async prepare updates lane once resolved');
  assert.equal(svc.board().lanes[0].model, 'neon-high');
  assert.equal(syncReadCalls, 0);
  assert.ok(changes >= 1);

  // Synchronous observe() also batches root terminals through sessionReader.prepare(), preserving earliest since
  const prepared = [];
  const syncBoard = emptyBoard();
  observe(syncBoard, [
    mainTerm({ address: 't91', pid: 111, created_ms: 900, cwd: '/w/a' }),
    mainTerm({ address: 't92', pid: 0, foreground: { name: 'agy', pid: 222, cwd: '/w/b' }, created_ms: 950, cwd: null }),
  ], 1500, {
    prepare: (specs) => prepared.push(specs),
    read: () => null,
  });
  observe(syncBoard, [
    mainTerm({ address: 't91', pid: 111, created_ms: 800, cwd: null }),
    mainTerm({ address: 't92', pid: 0, foreground: { name: 'agy', pid: 222 }, created_ms: 1200, cwd: null }),
  ], 2000, {
    prepare: (specs) => prepared.push(specs),
    read: () => null,
  });
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared[0].map((s) => [s.address, s.pid, s.cwd, s.since]), [['t91', 111, '/w/a', 900], ['t92', 222, '/w/b', 950]]);
  assert.deepEqual(prepared[1].map((s) => [s.address, s.cwd, s.since]), [['t91', '/w/a', 800], ['t92', '/w/b', 950]]);

  // Overlapping update while prepareAsync is in flight coalesces into one follow-up refresh
  let releaseFirst;
  let calls = 0;
  let doneSecond;
  const secondFinished = new Promise((r) => { doneSecond = r; });
  const coalescingReader = {
    read: () => null,
    readBound: () => null,
    needsPrepare: () => calls < 2,
    prepareAsync: () => {
      calls++;
      if (calls === 1) return new Promise((r) => { releaseFirst = r; });
      doneSecond();
      return Promise.resolve();
    },
  };
  const svc2 = createBoard({ dir: mkdtempSync(join(tmpdir(), 'board-coal-')), delayMs: 5, pollMs: 2000, sessionReader: coalescingReader });
  t.after(() => svc2.dispose());
  svc2.update([mainTerm({ address: 't93' })]);
  svc2.update([mainTerm({ address: 't93', status: { app: 'claude-code', state: 'done' } })]);
  assert.equal(calls, 1, 'second update while refreshing queues pendingRefresh instead of overlapping');
  releaseFirst();
  await secondFinished;
  assert.equal(calls, 2, 'queued pendingRefresh runs once first prepareAsync finishes');
});
