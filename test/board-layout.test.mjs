// Metro / Git communication topology layout & canonical view-model tests (shared/board.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as boardMod from '../shared/board.js';

const { laneOf, layoutMetro, SIZE } = boardMod;

const sampleLane = (over = {}) => ({
  t: 't48',
  app: 'antigravity',
  model: 'pro',
  state: 'working',
  since: 1000,
  ended: null,
  where: 'herdr-relay / 1',
  agents: [
    { id: 's1', name: 'Frontend Audit', via: 'research', model: 'pro', state: 'done', start: 1100, end: 1500, prompt: 'Check UI', reply: 'Leak in EventSource', colorIdx: 0 },
    { id: 's2', name: 'VM Audit', via: 'research', model: 'pro', state: 'working', start: 1200, end: null, activity: 'Read vm.rs', prompt: 'Check VM', reply: null, terminal: 't6d', colorIdx: 1 },
    { id: 's3', name: 'Verify Fix', via: 'swarm', model: 'flash', state: 'working', start: 1600, end: null, activity: 'npm test', prompt: 'Run tests', reply: null, colorIdx: 2 },
  ],
  events: [
    { kind: 'spawn', id: 'sp1', at: 1100, from: 'main', to: 's1', title: 'Frontend Audit', detail: 'Check UI', via: 'research', model: 'pro' },
    { kind: 'spawn', id: 'sp2', at: 1200, from: 'main', to: 's2', title: 'VM Audit', detail: 'Check VM', via: 'research', model: 'pro' },
    { kind: 'message', id: 'm1', at: 1300, from: 's1', to: 's2', summary: '共享网关双跳线索', detail: 'Desktop gateway proxies twice' },
    { kind: 'return', id: 'r1', at: 1500, from: 's1', to: 'main', status: 'done', summary: 'Leak in EventSource', detail: 'Leak in EventSource' },
    { kind: 'spawn', id: 'sp3', at: 1600, from: 'main', to: 's3', title: 'Verify Fix', detail: 'Run tests', via: 'swarm', model: 'flash' },
  ],
  ...over,
});

test('laneOf resolves the focused terminal or a focused child subagent terminal back to its parent lane', () => {
  const l0 = sampleLane({ t: 't1', since: 5, ended: 10, agents: [] });
  const l1 = sampleLane({ t: 't1', since: 15, ended: 20, agents: [] });
  const l2 = sampleLane({ t: 't48', since: 30, ended: null });
  const board = { v: 2, lanes: [l0, l1, l2] };
  assert.equal(laneOf(board, 't48'), l2);
  assert.equal(laneOf(board, 't1'), l1, 'falls back to newest ended lane when none is live');
  assert.equal(laneOf(board, 't6d'), l2, 'focusing subagent pane t6d still shows parent t48 topology');
  assert.equal(laneOf(board, 't99'), null);
  assert.equal(laneOf(null, 't48'), null);
});

test('layoutMetro assigns rails with free-lane reuse, directional bridges, and single-tip stations', () => {
  const g = layoutMetro(sampleLane(), { now: 2600 });
  const byId = Object.fromEntries(g.rows.map((r) => [r.id, r]));

  assert.equal(byId.sp1.rail, 1, 's1 takes rail 1');
  assert.equal(byId.sp2.rail, 2, 's2 takes rail 2 while s1 is open');
  assert.ok(byId.sp1.curves.some((c) => c.kind === 'fork' && c.from === 0 && c.to === 1));
  assert.ok(byId.sp2.curves.some((c) => c.kind === 'fork' && c.from === 0 && c.to === 2));

  // Peer-to-peer message s1 (rail 1) -> s2 (rail 2) carries explicit direction & unoccluded tip outside 5px ring halo
  assert.deepEqual([byId.m1.bridge.from, byId.m1.bridge.to, byId.m1.bridge.dir], [1, 2, 1]);
  assert.equal(byId.m1.bridge.tip, byId.m1.bridge.x1 - 5.5);
  assert.ok(byId.m1.bridge.tip < byId.m1.x - 5, 'rightward arrow tip clears 10px destination ring halo');

  // s1 merges back to rail 0 at r1 -> frees rail 1
  assert.ok(byId.r1.curves.some((c) => c.kind === 'merge' && c.from === 1 && c.to === 0));

  // s3 spawns AFTER s1 merged -> reuses rail 1 instead of widening to rail 3
  assert.equal(byId.sp3.rail, 1, 'freed rail 1 is reused by s3');
  assert.equal(g.maxRail, 2, 'graph stays compact at 3 columns (0, 1, 2)');

  // s2 had m1 & r1 after sp2 -> sp2 is a static fork ring, and live-s2 is the sole spinning tip for s2;
  // s3 has no events after sp3 -> sp3 itself is the spinning tip without a duplicate live-s3 row!
  assert.equal(byId.sp2.station.shape, 'ring', 'historical spawn row never spins when live tip exists below');
  assert.equal(byId['live-s2'].station.shape, 'spin');
  assert.equal(byId['live-s2'].subline?.text, 'Read vm.rs', 'live tip displays current activity instead of initial prompt');
  assert.equal(byId.sp3.isTip, true);
  assert.equal(byId.sp3.station.shape, 'spin');
  assert.equal(byId.sp3.subline?.text, 'npm test');
  assert.deepEqual(g.rows.filter((r) => r.kind === 'live').map((r) => r.agent.id), ['s2']);
});

test('5 parallel active subagents with no subsequent events render 1 main + 5 tip rows (not 10 duplicate rows)', () => {
  const agents = ['perf', 'paradigm', 'ui-layout', 'verifier', 'monitor'].map((name, i) => ({
    id: `swarm:${name}`,
    name,
    via: 'swarm',
    model: null,
    state: i < 3 ? 'working' : 'waiting',
    start: 1000,
    end: null,
    activity: i < 3 ? `Read mod-${i}.ts` : null,
    prompt: `Long initial brief for ${name}`,
    colorIdx: i,
  }));
  const events = agents.map((a, i) => ({
    kind: 'spawn', id: `sp-${i + 1}`, at: 1000 + i, from: 'main', to: a.id, title: a.name, detail: a.prompt, via: 'swarm',
  }));
  const g = layoutMetro({ t: 't71', app: 'antigravity', model: 'Gemini 4 Carbon', state: 'done', since: 900, agents, events }, { now: 61_000 });

  assert.equal(g.rows.length, 6, '1 main + 5 single-tip spawn rows; zero redundant bottom live rows');
  assert.equal(g.rows.filter((r) => r.kind === 'live').length, 0);
  // Main root is coordinating active children -> hollow ring (working tone), NOT a solid green done dot!
  assert.deepEqual([g.rows[0].station.shape, g.rows[0].station.tone], ['ring', 'working']);
  // Active working vs parked waiting subagents are visually distinct
  const spinRows = g.rows.slice(1).filter((r) => r.station.shape === 'spin');
  const waitRows = g.rows.slice(1).filter((r) => r.station.shape === 'ring');
  assert.equal(spinRows.length, 3, 'only the 3 actively working agents spin');
  assert.equal(waitRows.length, 2, 'the 2 parked waiting agents show hollow rings');
  assert.equal(waitRows[0].subline, null, 'parked waiting agent without activity stays single-line compact');
  assert.match(spinRows[0].headline.right, /swarm · 1m/, 'falls back to via when model is null and includes live elapsed span');
});

test('5 concurrent subagents with cross-rail messages get 5 distinct rails without colliding on rail 4', () => {
  const agents = [1, 2, 3, 4, 5].map((n) => ({
    id: `a${n}`,
    name: `Worker ${n}`,
    via: 'swarm',
    state: n === 5 ? 'blocked' : n === 4 ? 'waiting' : 'working',
    msg: n === 5 ? 'Allow bash?' : null,
    start: n * 100,
    end: null,
    prompt: 'line1\nline2\n' + 'x'.repeat(80),
    colorIdx: n - 1,
  }));
  const events = [
    ...agents.map((a, i) => ({ kind: 'spawn', id: `sp${i + 1}`, at: a.start, from: 'main', to: a.id, title: a.name, detail: a.prompt })),
    { kind: 'message', id: 'm-peer', at: 900, from: 'a1', to: 'a5', summary: 'Check permission', detail: 'Check permission' },
    { kind: 'message', id: 'm-back', at: 950, from: 'a5', to: 'a4', summary: 'Ack', detail: 'Ack' },
  ];
  const g = layoutMetro({ t: 't2', state: 'working', agents, events }, { openIds: new Set(['live-a5']), now: 5000 });

  assert.equal(g.maxRail, 5, '5th concurrent agent gets rail 5 instead of colliding onto rail 4');
  assert.equal(g.railStep, 12, 'adaptive tighter rail step keeps 5+ rails compact in 368px sidebar');
  const spawnRails = g.rows.filter((r) => r.kind === 'spawn').map((r) => r.rail);
  assert.deepEqual(spawnRails, [1, 2, 3, 4, 5], 'every concurrent worker has its own distinct rail');
  const backMsg = g.rows.find((r) => r.id === 'm-back');
  assert.equal(backMsg.bridge.dir, -1);
  assert.equal(backMsg.bridge.tip, backMsg.bridge.x1 + 5.5);
  assert.ok(backMsg.bridge.tip > backMsg.x + 5, 'leftward arrow tip clears 10px destination ring halo on 12px compact rails');

  const live = g.rows.filter((r) => r.kind === 'live');
  assert.equal(live[0].agent.id, 'a5', 'blocked live station comes first');
  assert.equal(live.at(-1).agent.id, 'a4', 'waiting live station comes after working');
  assert.equal(live[0].station.shape, 'solid');
  assert.equal(live[0].station.tone, 'warn');
  assert.equal(live[0].expanded, true);
  assert.equal(live[0].subline, null, 'expanded row suppresses truncated subline to prevent duplicate text');
  assert.match(live[0].detail ?? '', /Allow bash\?/, 'blocked message is surfaced in detail');
});

test('computeStats, boardBadgeOf, stopped vs done vs failed returns, and boilerplate reply stripping', () => {
  assert.equal(typeof boardMod.computeStats, 'function');
  assert.equal(typeof boardMod.boardBadgeOf, 'function');

  const agents = [
    { id: 'a1', name: 'Fixer', state: 'done', start: 1000, end: 5000, colorIdx: 0 },
    { id: 'a2', name: 'Cancelled', state: 'stopped', start: 1000, end: 3000, colorIdx: 1 },
    { id: 'a3', name: 'Broken', state: 'failed', start: 1000, end: 2000, colorIdx: 2 },
    { id: 'a4', name: 'Monitor', state: 'waiting', start: 1000, end: null, colorIdx: 3 },
  ];
  const events = [
    { kind: 'spawn', id: 'sp1', at: 1000, from: 'main', to: 'a1', title: 'Fixer', detail: 'Go' },
    { kind: 'spawn', id: 'sp2', at: 1000, from: 'main', to: 'a2', title: 'Cancelled', detail: 'Go' },
    { kind: 'spawn', id: 'sp3', at: 1000, from: 'main', to: 'a3', title: 'Broken', detail: 'Go' },
    { kind: 'return', id: 'r3', at: 2000, from: 'a3', to: 'main', status: 'failed', summary: 'Exit code 1', detail: 'Exit code 1' },
    { kind: 'return', id: 'r2', at: 3000, from: 'a2', to: 'main', status: 'stopped', summary: '', detail: null },
    { kind: 'return', id: 'r1', at: 5000, from: 'a1', to: 'main', status: 'done', summary: 'Agent "Fixer" finished', detail: 'Agent "Fixer" finished' },
  ];
  const stats = boardMod.computeStats(agents, events);
  assert.deepEqual(stats, { totalSubs: 4, running: 0, waiting: 1, blocked: 0, done: 1, failed: 1, stopped: 1, messages: 0 });
  assert.deepEqual(boardMod.boardBadgeOf(stats), { kind: 'none', count: 0, tone: 'neutral' });
  assert.deepEqual(boardMod.boardBadgeOf({ ...stats, running: 2 }), { kind: 'running', count: 2, tone: 'accent' });
  assert.deepEqual(boardMod.boardBadgeOf({ ...stats, running: 2, blocked: 1 }), { kind: 'blocked', count: 1, tone: 'warn' });

  const g = layoutMetro({ t: 't6r', state: 'done', stats, agents, events }, { now: 6000 });
  const byId = Object.fromEntries(g.rows.map((r) => [r.id, r]));

  // All remaining open subs are only `waiting` (0 running/blocked) -> main root CAN show solid green done dot
  assert.deepEqual([byId.main.station.shape, byId.main.station.tone], ['solid', 'ok']);
  // Failed vs Stopped vs Done returns have distinct icons and station shapes
  assert.deepEqual([byId.r3.headline.icon, byId.r3.station.shape, byId.r3.station.tone], ['fail', 'solid', 'bad']);
  assert.deepEqual([byId.r2.headline.icon, byId.r2.station.shape, byId.r2.station.tone], ['stop', 'ring', 'muted']);
  assert.deepEqual([byId.r1.headline.icon, byId.r1.station.shape, byId.r1.station.tone], ['merge', 'solid', 'rail']);
  // Boilerplate `Agent "Fixer" finished` stripped -> compact single-line return row!
  assert.equal(byId.r1.subline, null);
  assert.equal(byId.r1.h, SIZE.rowH);
});

test('layoutMetro handles solo main root, nested subagent forks, and CJK detail height without clipping', () => {
  const solo = layoutMetro({
    t: 't48', app: 'antigravity', model: 'Gemini 4 Carbon (High)',
    state: 'working', activity: 'Run unit test suite', since: 1000, agents: [], events: [],
  });
  assert.equal(solo.rows.length, 1);
  assert.equal(solo.rows[0].kind, 'main');
  assert.equal(solo.rows[0].trunkTop, false);
  assert.equal(solo.rows[0].trunkBottom, false);
  assert.equal(solo.rows[0].h, SIZE.subRowH);
  assert.deepEqual(layoutMetro(null).rows, []);

  // CJK multiline detail gets enough height (22 CJK chars wrap a ~34 half-width column)
  const cjk = '这是一段包含中文字符的子代理完整审查结论，确保在窄侧栏展开时不会被腰斩截断。'.repeat(4);
  const openSolo = layoutMetro(
    { t: 't49', state: 'error', msg: cjk, agents: [], events: [] },
    { openIds: new Set(['main']) },
  );
  const asciiSameLen = layoutMetro(
    { t: 't49', state: 'error', msg: 'a'.repeat(cjk.length), agents: [], events: [] },
    { openIds: new Set(['main']) },
  );
  assert.equal(openSolo.rows[0].expanded, true);
  assert.equal(openSolo.rows[0].subline, null);
  assert.ok(openSolo.rows[0].h > asciiSameLen.rows[0].h, 'CJK text allocates taller wrapped height than equal-length ASCII');

  // Nested subagent (`from: "lead-1"`) forks from lead-1's rail 1 -> rail 2 cleanly
  const nested = layoutMetro({
    t: 't50', state: 'working',
    agents: [
      { id: 'lead-1', name: 'Lead', state: 'working', start: 100, end: null, colorIdx: 0 },
      { id: 'helper-1', name: 'Helper', parentAgent: 'lead-1', state: 'working', start: 200, end: null, colorIdx: 1 },
    ],
    events: [
      { kind: 'spawn', id: 'sp-lead', at: 100, from: 'main', to: 'lead-1', title: 'Lead' },
      { kind: 'spawn', id: 'sp-help', at: 200, from: 'lead-1', to: 'helper-1', title: 'Helper' },
    ],
  });
  const nById = Object.fromEntries(nested.rows.map((r) => [r.id, r]));
  assert.equal(nById['sp-lead'].rail, 1);
  assert.deepEqual([nById['sp-help'].curves[0].from, nById['sp-help'].curves[0].to], [1, 2]);
});

test('normalizeSubState, formatting helpers, ended lanes, runtime-only subs, and 7-agent rail cap', () => {
  const { normalizeSubState, span, laneTitle, SUB_STATES } = boardMod;
  assert.deepEqual(SUB_STATES, ['working', 'waiting', 'blocked', 'done', 'failed', 'stopped']);
  assert.equal(normalizeSubState('working', { failed: true }), 'failed');
  assert.equal(normalizeSubState('working', { stopped: true }), 'stopped');
  assert.equal(normalizeSubState('stopped'), 'stopped');
  assert.equal(normalizeSubState('working', { ended: true }), 'done');
  assert.equal(normalizeSubState('error'), 'blocked');
  assert.equal(normalizeSubState('waiting'), 'waiting');
  assert.equal(normalizeSubState(null), 'working');

  assert.deepEqual([span(45_000), span(12 * 60_000), span(2 * 3600_000), span(75 * 60_000)], ['45s', '12m', '2h', '1h15m']);
  assert.equal(laneTitle({ t: 't9', cwd: '/Users/me/Projects/aed/' }), 'aed');
  assert.equal(laneTitle({ t: 't9' }), 't9');
  assert.equal(laneTitle(null), '');

  const endedG = layoutMetro({ t: 't9', ended: 5000, since: 1000, state: 'idle', agents: [], events: [] });
  assert.equal(endedG.header.muted, true);
  assert.deepEqual([endedG.rows[0].station.shape, endedG.rows[0].station.tone], ['ring', 'muted']);

  // Runtime-only open subagents (no spawn event) + >6 concurrent agents cap cleanly at maxRails (6)
  const seven = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `rt-${n}`, name: `R${n}`, state: 'working', start: 100, end: null, colorIdx: n,
  }));
  const g7 = layoutMetro({
    t: 't7', state: 'blocked', agents: seven,
    events: seven.map((a, i) => ({ kind: 'spawn', id: `sp-${i}`, at: i, from: 'main', to: a.id, title: a.name }))
      .concat([{ kind: 'message', id: 'm-tail', at: 50, from: 'main', to: 'rt-7', summary: '@rt-7 [done] ping' }]),
  });
  assert.equal(g7.maxRail, SIZE.maxRails);
  assert.deepEqual([g7.rows[0].station.shape, g7.rows[0].station.tone], ['solid', 'warn']);
  assert.equal(g7.rows.find((r) => r.id === 'm-tail').subline?.text, 'ping');

  // Unspawned runtime agent forks from rail 0 directly on its live row
  const rtOnly = layoutMetro({
    t: 't8', state: 'working',
    agents: [{ id: 'rec:1', name: 'InProc', state: 'working', start: 100, end: null, colorIdx: 0 }],
    events: [],
  });
  assert.equal(rtOnly.rows[1].kind, 'live');
  assert.equal(rtOnly.rows[1].curves[0].kind, 'fork');
});

