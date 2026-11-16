// Phone <-> Host encrypted board topology RPC (`board.get`), `{ev:'board'}` push, and old/new client compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard } from '../host/board.js';
import { createPhones } from '../host/phones.js';
import { createState } from '../host/state.js';
import { b64, newBoxKeys, phoneHandshake } from '../shared/e2e.js';
import { initial, step } from '../app/src/term-session.js';

async function setupPhoneSession({ withBoard = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phone-board-'));
  const state = await createState({ dir });
  const phoneKeys = newBoxKeys();
  await state.addDevice({ name: 'Herdr iPhone', pub: b64(phoneKeys.publicKey) });

  const outbox = [];
  let phones;
  const board = withBoard ? createBoard({
    dir,
    delayMs: 10,
    pollMs: 0,
    sessionReader: { read: () => null },
    onChange: (_doc, info) => phones?.broadcast('board', info || {}),
  }) : undefined;

  phones = createPhones({
    state,
    pairing: { dropped() {}, ask: async () => 'denied' },
    push: { publicKey: 'vapid-pub', sendTo: async () => {} },
    terminals: {
      state: () => 'online',
      list: () => [],
      layout: () => [],
      icons: () => ({}),
      core: () => null,
      get: () => null,
    },
    board,
    link: () => ({
      send: (_cid, frame) => outbox.push(frame),
      close: () => {},
    }),
  });

  phones.open('c1');
  const hs = phoneHandshake(phoneKeys, state.boxKeys.publicKey);
  await phones.data('c1', hs.hello);
  const welcome = outbox.shift();
  const { cipher } = hs.finish(welcome);
  const earlyReady = cipher.open(outbox.shift());
  await phones.data('c1', cipher.seal({ type: 'auth', mode: 'resume' }));

  const call = async (id, m, p = {}) => {
    await phones.data('c1', cipher.seal({ id, m, p }));
    return cipher.open(outbox.shift());
  };

  return {
    dir,
    board,
    cipher,
    outbox,
    earlyReady,
    call,
    cleanup: () => {
      board?.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('ready advertises board:true and board.get resolves both root and child hc terminal lanes', async (t) => {
  const ctx = await setupPhoneSession({ withBoard: true });
  t.after(ctx.cleanup);

  assert.equal(ctx.earlyReady.type, 'ready');
  assert.equal(ctx.earlyReady.board, true);

  // Empty before any agent runs
  const emptyRes = await ctx.call(1, 'board.get', { address: 't10' });
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.r.lane, null);
  assert.equal(typeof emptyRes.r.at, 'number');

  // Update board with root agent t10 and child hc worker t11 -> broadcasts {ev:'board'} after debounce
  ctx.board.update([
    {
      address: 't10',
      state: 'live',
      cwd: '/tmp/proj',
      labels: { where: 'proj / 1' },
      foreground: { name: 'agy', cwd: '/tmp/proj' },
      status: { app: 'antigravity', state: 'working', msg: 'Auditing code' },
    },
    {
      address: 't11',
      parent: 't10',
      state: 'live',
      name: 'Reviewer worker',
      foreground: { name: 'claude' },
      status: { app: 'claude', state: 'working' },
    },
  ]);

  await new Promise((r) => setTimeout(r, 35));
  assert.equal(ctx.outbox.length, 1, 'debounced board flush broadcasts once');
  const pushed = ctx.cipher.open(ctx.outbox.shift());
  assert.deepEqual(pushed, { ev: 'board', t: 't10' }, 'single-lane update includes targeted t hint');

  // Simultaneous multi-lane update omits t so all open screens refresh
  ctx.board.update([
    {
      address: 't10', state: 'live', cwd: '/tmp/proj',
      foreground: { name: 'agy', cwd: '/tmp/proj' },
      status: { app: 'antigravity', state: 'working', msg: 'Step 2' },
    },
    {
      address: 't11', parent: 't10', state: 'live', name: 'Reviewer worker',
      foreground: { name: 'claude' }, status: { app: 'claude', state: 'working' },
    },
    {
      address: 't20', state: 'live', cwd: '/tmp/other',
      foreground: { name: 'claude', cwd: '/tmp/other' },
      status: { app: 'claude', state: 'working', msg: 'Other repo' },
    },
  ]);
  await new Promise((r) => setTimeout(r, 35));
  const multiPushed = ctx.cipher.open(ctx.outbox.shift());
  assert.deepEqual(multiPushed, { ev: 'board' }, 'multi-lane update omits t');

  // Querying root terminal t10
  const rootRes = await ctx.call(2, 'board.get', { address: 't10' });
  assert.equal(rootRes.ok, true);
  assert.equal(rootRes.r.lane.t, 't10');
  assert.equal(rootRes.r.lane.stats.running, 1);
  assert.equal(rootRes.r.lane.rtMap, undefined, 'internal runtime map stripped');

  // Querying child hc terminal t11 resolves to parent lane t10 via laneOf
  const childRes = await ctx.call(3, 'board.get', { address: 't11' });
  assert.equal(childRes.ok, true);
  assert.equal(childRes.r.lane.t, 't10');

  // Invalid address is rejected at the trust boundary
  const badRes = await ctx.call(4, 'board.get', { address: '../etc/passwd;rm' });
  assert.equal(badRes.ok, false);
  assert.match(badRes.e, /无效的终端地址/);
});

test('compatibility: host without board reports board:false, and old term-session ignores {ev:"board"}', async (t) => {
  const ctx = await setupPhoneSession({ withBoard: false });
  t.after(ctx.cleanup);

  assert.equal(ctx.earlyReady.board, false);
  const res = await ctx.call(1, 'board.get', { address: 't1' });
  assert.equal(res.ok, false);
  assert.match(res.e, /不可用/);

  // Old phone page running term-session.js receives {ev:'board'} while opening & live: zero disruption
  let st = initial('t1');
  st = step(st, { type: 'link', ready: true }).state;
  st = step(st, { type: 'view' }).state;
  assert.equal(st.phase, 'opening');
  st = step(st, { type: 'stream', msg: { ev: 'board' } }).state;
  st = step(st, { type: 'opened', r: { s: 7, cols: 80, rows: 24, sized: true }, epoch: st.epoch }).state;
  assert.equal(st.phase, 'live');
  const afterLive = step(st, { type: 'stream', msg: { ev: 'board', t: 't1' } });
  assert.equal(afterLive.state, st);
  assert.deepEqual(afterLive.effects, []);

  const listRes = await ctx.call(2, 'terminals.list', {});
  assert.equal(listRes.ok, true);
  assert.equal(listRes.r.terminals?.some?.((x) => 'subs' in x) ?? false, false);
});
