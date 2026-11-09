// The terminal page's stream and grid (app/src/term-session.js, DESIGN.md「终端会话状态机」): pure, so
// every path runs here in a few milliseconds. Both the PWA and the native app carry out these effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE, QUEUE_MAX, RETRY_MS, enqueue, initial, leadsAfterSize, step, termSession } from '../app/src/term-session.js';

const F = { cols: 57, rows: 46 }; // the phone's grid
const F2 = { cols: 94, rows: 27 }; // the phone turned
const M = { cols: 108, rows: 55 }; // a Mac window's

/** Step through events; returns the final state and every effect, in order. */
function run(events, st = initial('t1')) {
  const effects = [];
  for (const ev of events) { const r = step(st, ev); st = r.state; effects.push(...r.effects); }
  return { st, effects };
}
const of = (effects, type, m) => effects.filter((e) => e.type === type && (m === undefined || e.m === m));
const opened = (s = 7, epoch = 1, extra = {}) => ({ type: 'opened', r: { s, cols: F.cols, rows: F.rows, sized: true, ...extra }, epoch });
/** A page that is live on stream 7, at the phone's grid F. */
const live = () => run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' }, opened()]).st;

test('opens once the link and the page are both ready, with the measured grid and the lead', () => {
  const { st, effects } = run([{ type: 'fit', fit: F }, { type: 'link', ready: true }]);
  assert.equal(st.phase, 'waiting', 'not before the page can draw');
  assert.deepEqual(effects, []);
  const r = step(st, { type: 'view' });
  assert.deepEqual(r.effects, [{ type: 'rpc', m: 'term.open', p: { address: 't1', fit: F, lead: true }, epoch: 1 }]);
  assert.equal(r.state.phase, 'opening');
});

test('F7: the grid changed while term.open was out → one term.fit with the new grid right after', () => {
  const { effects } = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' }, { type: 'fit', fit: F2 }, opened()]);
  assert.deepEqual(of(effects, 'notify', 'term.fit'), [{ type: 'notify', m: 'term.fit', p: { s: 7, fit: F2 } }]);
});

test('F7: the grid was not measured at term.open → it goes out as soon as it is', () => {
  const { st, effects } = run([{ type: 'link', ready: true }, { type: 'view' }, opened(7, 1)]);
  assert.equal(of(effects, 'rpc', 'term.open')[0].p.fit, null);
  assert.deepEqual(of(effects, 'notify', 'term.fit'), [], 'nothing to send yet');
  assert.deepEqual(step(st, { type: 'fit', fit: F }).effects, [{ type: 'notify', m: 'term.fit', p: { s: 7, fit: F } }]);
});

test('the phone left while term.open was out → term.fit null right after (the Mac windows lead again)', () => {
  const { effects } = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' }, { type: 'away', on: true }, opened()]);
  assert.deepEqual(of(effects, 'notify', 'term.fit'), [{ type: 'notify', m: 'term.fit', p: { s: 7, fit: null } }]);
});

test('opened while away (a reconnect in the background) → no grid, so the phone does not take the lead', () => {
  const { effects } = run([{ type: 'fit', fit: F }, { type: 'away', on: true }, { type: 'link', ready: true }, { type: 'view' }]);
  assert.equal(of(effects, 'rpc', 'term.open')[0].p.fit, null);
});

test('away and back: term.fit null, then the grid; no repeat of the same grid', () => {
  const st = live();
  const { effects } = run([{ type: 'away', on: true }, { type: 'away', on: true }, { type: 'away', on: false }, { type: 'fit', fit: F }], st);
  assert.deepEqual(of(effects, 'notify', 'term.fit').map((e) => e.p.fit), [null, F]);
});

test('a size from a Mac window hands the lead over; reopening then asks for lead: false', () => {
  let st = live();
  st = run([{ type: 'stream', msg: { ev: 'size', s: 7, ...M } }], st).st;
  assert.equal(st.leads, false);
  const { effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } }, { type: 'retry' }], st);
  assert.equal(of(effects, 'rpc', 'term.open')[0].p.lead, false);
});

// Live log 2026-11-07: term.open went out with fit null (page not ready yet); the Mac-size `size`
// replayed from `early` flipped leads to false, so the next reconnect gave up the lead.
test('leadsAfterSize: a size other than the grid sent hands the lead over; with no grid sent (none yet, or away) it stays', () => {
  assert.equal(leadsAfterSize(true, JSON.stringify(F), M), false);
  assert.equal(leadsAfterSize(false, JSON.stringify(F), F), true);
  for (const sent of ['', 'null']) {
    assert.equal(leadsAfterSize(true, sent, M), true, `fitSent ${JSON.stringify(sent)}`);
    assert.equal(leadsAfterSize(false, sent, F), false, `fitSent ${JSON.stringify(sent)}`);
  }
});

test('a Mac size replayed before the open answered (fit null at open) does not give up the lead', () => {
  const { st } = run([{ type: 'link', ready: true }, { type: 'view' }, { type: 'stream', msg: { ev: 'size', s: 7, ...M } }, opened(7, 1)]);
  assert.equal(st.leads, true);
});

test('events before term.open answered are drawn after the open, in order', () => {
  const out = { ev: 'out', s: 7, d: 'aGk=' };
  const size = { ev: 'size', s: 7, ...F };
  const { effects } = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' },
    { type: 'stream', msg: size }, { type: 'stream', msg: out }, opened()]);
  assert.deepEqual(of(effects, 'view').map((e) => e.msg.t), ['open', 'size', 'out']);
});

test('F10: input while the stream is reopening is held and goes in after the reopen, in order', () => {
  let { st, effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } },
    { type: 'input', m: 'term.input', p: { d: 'ab' } }, { type: 'input', m: 'term.input', p: { d: 'cd' } }], live());
  assert.deepEqual(of(effects, 'notify'), [], 'nothing sent into a closed stream');
  assert.deepEqual(of(effects, 'retry'), [{ type: 'retry', ms: RETRY_MS }]);
  assert.equal(of(effects, 'notice').at(-1).text, NOTICE.held, 'the page says the input will follow');
  ({ st, effects } = run([{ type: 'retry' }, opened(8, 1)], st));
  assert.deepEqual(of(effects, 'notify').map((e) => [e.m, e.p]), [['term.input', { d: 'ab', s: 8 }], ['term.input', { d: 'cd', s: 8 }]]);
  assert.equal(st.queue.length, 0);
});

test('F1: a control key while the stream is down is dropped, not replayed after the reopen', () => {
  let { st, effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } },
    { type: 'input', m: 'term.press', p: { keys: ['enter'] } }], live());
  assert.equal(of(effects, 'notice').at(-1).text, NOTICE.pressLost, 'the page says the key did not go out');
  ({ st, effects } = run([{ type: 'retry' }, opened(8, 1)], st));
  assert.deepEqual(of(effects, 'notify', 'term.press'), [], 'the key is not replayed');
  assert.equal(of(effects, 'notice').at(-1).text, NOTICE.dropped(1), '有 1 次输入没发出去');
});

test('F1: a key before the first open says the terminal is still opening (pressEarly), not disconnected', () => {
  const opening = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' }]).st;
  const { st, effects } = run([{ type: 'input', m: 'term.press', p: { keys: ['enter'] } }], opening);
  assert.equal(of(effects, 'notice').at(-1).text, NOTICE.pressEarly, 'nothing was disconnected yet');
  assert.equal(st.dropped, 1);
  const { effects: effects2 } = run([{ type: 'input', m: 'term.press', p: { keys: ['esc'] } }], live());
  assert.deepEqual(of(effects2, 'notify').map((e) => e.m), ['term.press'], 'live: the key goes out');
});

test('F1: text and a key while down: only the text goes out after the reopen, in order', () => {
  const { st, effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } },
    { type: 'input', m: 'term.input', p: { d: 'ab' } },
    { type: 'input', m: 'term.press', p: { keys: ['c'], mods: ['ctrl'] } },
    { type: 'input', m: 'term.input', p: { d: 'cd' } },
    { type: 'retry' }, opened(8, 1)], live());
  assert.deepEqual(of(effects, 'notify').map((e) => [e.m, e.p]),
    [['term.input', { d: 'ab', s: 8 }], ['term.input', { d: 'cd', s: 8 }]]);
  assert.ok(of(effects, 'notice').some((e) => e.text === NOTICE.pressLost));
});

test('F10: after the program exited, input is not kept; the notice gives the exit code', () => {
  const { st, effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'exited', exitCode: 1 } }], live());
  assert.equal(st.phase, 'exited');
  assert.deepEqual(effects, [{ type: 'notice', text: NOTICE.exited(1) }], 'no retry after an exit');
  assert.deepEqual(run([{ type: 'input', m: 'term.input', p: { d: 'z' } }, { type: 'retry' }], st).effects, []);
});

test('F10: input held over a reconnect goes in before a later exit: nothing lost', () => {
  const { effects } = run([{ type: 'link', ready: false }, { type: 'input', m: 'term.input', p: { d: 'y' } },
    { type: 'link', ready: true }, opened(8, 2), { type: 'stream', msg: { ev: 'closed', s: 8, reason: 'exited', exitCode: 0 } }], live());
  assert.deepEqual(of(effects, 'notify', 'term.input').map((e) => e.p), [{ d: 'y', s: 8 }]);
  assert.equal(of(effects, 'notice').at(-1).text, NOTICE.exited(0));
});

test('F10: the program exited before the reopen answered → the held input is reported lost', () => {
  const { st, effects } = run([{ type: 'link', ready: false }, { type: 'input', m: 'term.input', p: { d: 'y' } },
    { type: 'link', ready: true }, { type: 'stream', msg: { ev: 'closed', s: 8, reason: 'exited', exitCode: 2 } }, opened(8, 2)], live());
  assert.equal(st.phase, 'exited');
  assert.deepEqual(of(effects, 'notify', 'term.input'), []);
  assert.equal(of(effects, 'notice').at(-1).text, `${NOTICE.exited(2)}；${NOTICE.dropped(1)}`);
});

test('F10: more inputs than QUEUE_MAX while down: the rest are counted and reported', () => {
  let st = run([{ type: 'link', ready: false }], live()).st;
  for (let i = 0; i < QUEUE_MAX + 3; i++) st = step(st, { type: 'input', m: 'term.input', p: { d: 'k' } }).state;
  assert.equal(st.queue.length, QUEUE_MAX);
  const { effects } = run([{ type: 'link', ready: true }, opened(8, 2)], st);
  assert.equal(of(effects, 'notify', 'term.input').length, QUEUE_MAX);
  assert.ok(of(effects, 'notice').some((e) => e.text === NOTICE.dropped(3)));
});

test('the link is lost during term.open → no "cannot open"; it opens again once the link is back', () => {
  let { st, effects } = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' },
    { type: 'link', ready: false }, { type: 'openFailed', message: '连接已断开', epoch: 1 }]);
  assert.equal(st.phase, 'waiting');
  assert.ok(!of(effects, 'notice').some((e) => e.text.startsWith('打不开')));
  ({ effects } = run([{ type: 'link', ready: true }], st));
  assert.deepEqual(of(effects, 'rpc', 'term.open').map((e) => e.epoch), [2]);
});

test('F4: the link moved to another connection while term.open was out → opened on the new one at once; the old answer is closed', () => {
  let { st, effects } = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' },
    { type: 'link', ready: true, renewed: true }]);
  assert.deepEqual(of(effects, 'rpc').map((e) => [e.m, e.epoch]), [['term.open', 1], ['term.open', 2]], 'no wait for the old answer');
  ({ st, effects } = run([opened(7, 1)], st));
  assert.deepEqual(effects, [{ type: 'rpc', m: 'term.close', p: { s: 7 } }], 'the old answer: closed, no third open');
  assert.equal(st.phase, 'opening');
  ({ st } = run([opened(8, 2)], st));
  assert.equal(st.phase, 'live');
  assert.equal(st.s, 8);
});

test('F4: link lost and back while term.open was out → opened again at once; the old failure changes nothing', () => {
  const { st, effects } = run([{ type: 'link', ready: true }, { type: 'view' }, { type: 'link', ready: false },
    { type: 'link', ready: true }, { type: 'openFailed', message: '连接已断开', epoch: 1 }]);
  assert.deepEqual(of(effects, 'rpc', 'term.open').map((e) => e.epoch), [1, 2]);
  assert.deepEqual(of(effects, 'notice'), []);
  assert.equal(st.phase, 'opening');
});

test('ready again on another connection while live → reopen there (the old stream stays behind)', () => {
  const { st, effects } = run([{ type: 'link', ready: true, renewed: true }], live());
  assert.deepEqual(of(effects, 'rpc').map((e) => e.m), ['term.open']);
  assert.equal(st.phase, 'opening');
  assert.deepEqual(run([opened(9, 2)], st).effects.find((e) => e.type === 'view').msg.reopened, true);
});

test('a real open failure says so and keeps nothing; the next link ready tries again', () => {
  const { st, effects } = run([{ type: 'link', ready: true }, { type: 'view' }, { type: 'input', m: 'term.input', p: { d: 'a' } },
    { type: 'openFailed', message: '没有这个终端', epoch: 1 }]);
  assert.equal(st.phase, 'failed');
  assert.equal(of(effects, 'notice').at(-1).text, `${NOTICE.cannotOpen('没有这个终端')}；${NOTICE.dropped(1)}`);
  const again = run([{ type: 'link', ready: false }, { type: 'link', ready: true }], st);
  assert.equal(of(again.effects, 'rpc', 'term.open').length, 1);
});

test('F3: replaced: no retry, nothing held, the page says why', () => {
  const { st, effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'replaced' } }, { type: 'retry' },
    { type: 'input', m: 'term.input', p: { d: 'a' } }], live());
  assert.equal(st.phase, 'replaced');
  assert.deepEqual(effects, [{ type: 'notice', text: NOTICE.replaced }]);
});

test('F3: replaced before the reopen answered → the held input is dropped and counted (DESIGN rule 3)', () => {
  const { st, effects } = run([{ type: 'link', ready: false }, { type: 'input', m: 'term.input', p: { d: 'y' } },
    { type: 'link', ready: true }, { type: 'stream', msg: { ev: 'closed', s: 8, reason: 'replaced' } }, opened(8, 2)], live());
  assert.equal(st.phase, 'replaced');
  assert.deepEqual(st.queue, []);
  assert.deepEqual(of(effects, 'notify', 'term.input'), []);
  assert.equal(of(effects, 'notice').at(-1).text, `${NOTICE.replaced}；${NOTICE.dropped(1)}`);
  const again = run([{ type: 'link', ready: false }, { type: 'link', ready: true }, opened(9, 3)], st);
  assert.deepEqual(of(again.effects, 'notify', 'term.input'), [], 'not sent by a later open either');
});

test('the page goes away while term.open is out → the stream that answers is closed at once', () => {
  const { st, effects } = run([{ type: 'link', ready: true }, { type: 'view' }, { type: 'dispose' }, opened(7, 1)]);
  assert.equal(st.phase, 'disposed');
  assert.deepEqual(of(effects, 'rpc', 'term.close'), [{ type: 'rpc', m: 'term.close', p: { s: 7 } }]);
});

test('dispose while live closes the stream once', () => {
  const { effects } = run([{ type: 'dispose' }, { type: 'dispose' }], live());
  assert.deepEqual(of(effects, 'rpc', 'term.close'), [{ type: 'rpc', m: 'term.close', p: { s: 7 } }]);
});

test('an older Mac (no sizes in the stream): the phone never sends a grid', () => {
  const { effects } = run([{ type: 'link', ready: true }, { type: 'fit', fit: F }, { type: 'view' }, opened(7, 1, { sized: false }),
    { type: 'fit', fit: F2 }, { type: 'away', on: true }]);
  assert.deepEqual(of(effects, 'notify', 'term.fit'), []);
  assert.deepEqual(of(effects, 'view')[0].msg, { t: 'open', sized: false, reopened: false, cols: F.cols, rows: F.rows });
});

test('events for another stream id are ignored', () => {
  assert.deepEqual(run([{ type: 'stream', msg: { ev: 'out', s: 99, d: 'eA==' } }], live()).effects, []);
});

test('step never changes the state it was given', () => {
  const st = live();
  const before = JSON.stringify(st);
  for (const ev of [{ type: 'fit', fit: F2 }, { type: 'away', on: true }, { type: 'link', ready: false }, { type: 'dispose' },
    { type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } }, { type: 'input', m: 'term.input', p: { d: 'a' } }]) step(st, ev);
  assert.equal(JSON.stringify(st), before);
});

test('term.open failed on an older connection (the link moved meanwhile) → no notice, open again on this one', () => {
  const { st, effects } = run([{ type: 'link', ready: true }, { type: 'view' }, { type: 'link', ready: true, renewed: true },
    { type: 'openFailed', message: '连接已断开', epoch: 1 }]);
  assert.deepEqual(of(effects, 'notice'), []);
  assert.deepEqual(of(effects, 'rpc', 'term.open').map((e) => e.epoch), [1, 2]);
  assert.equal(st.phase, 'opening');
});

test('a late openFailed after the open answered changes nothing', () => {
  assert.deepEqual(run([{ type: 'openFailed', message: 'x', epoch: 1 }], live()).effects, []);
});

test('unknown events and stream kinds are ignored', () => {
  const st = live();
  assert.deepEqual(step(st, { type: 'nope' }), { state: st, effects: [] });
  assert.deepEqual(step(st, { type: 'stream', msg: { ev: 'toString', s: 7 } }), { state: st, effects: [] });
});

test('termSession: send() steps the state and hands the effects to run, with the session', () => {
  const seen = [];
  const ses = termSession('t1', (effects, s) => seen.push([effects.map((e) => e.type), s.state.phase]));
  ses.send({ type: 'link', ready: true });
  const fx = ses.send({ type: 'view' });
  assert.equal(fx[0].m, 'term.open');
  assert.deepEqual(seen, [[[], 'waiting'], [['rpc'], 'opening']], 'run sees the new state');
});

// ---- edges the mutation run found unpinned (ub-mode mutator, 2026-11-09)

test('before the first open the page follows the Mac size (sized false), and term.open leads', () => {
  assert.equal(initial('t1').sized, false);
  assert.equal(of(run([{ type: 'link', ready: true }, { type: 'view' }]).effects, 'rpc', 'term.open')[0].p.lead, true);
});

test('reopened while the phone still leads → lead: true', () => {
  const { effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } }, { type: 'retry' }], live());
  assert.equal(of(effects, 'rpc', 'term.open')[0].p.lead, true);
});

test('typing while live goes straight out, with no pause', () => {
  assert.deepEqual(step(live(), { type: 'input', m: 'term.input', p: { d: 'a' } }).effects,
    [{ type: 'notify', m: 'term.input', p: { d: 'a', s: 7 }, after: 0 }]);
});

test('the "held" notice shows once per wait, and not before the first open', () => {
  const first = run([{ type: 'link', ready: true }, { type: 'view' }, { type: 'input', m: 'term.input', p: { d: 'a' } }]);
  assert.deepEqual(of(first.effects, 'notice'), [], 'the first open: nothing to say yet');
  const { effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } },
    { type: 'input', m: 'term.input', p: { d: 'a' } }, { type: 'input', m: 'term.input', p: { d: 'b' } }], live());
  assert.deepEqual(of(effects, 'notice').map((e) => e.text), [NOTICE.lost, NOTICE.held]);
  const down = run([{ type: 'link', ready: false }, { type: 'input', m: 'term.input', p: { d: 'a' } }], live());
  assert.deepEqual(of(down.effects, 'notice').map((e) => e.text), [NOTICE.lost, NOTICE.held]);
});

test('link lost while term.open is out: nothing yet (openFailed says it); while retrying: wait for the link', () => {
  const opening = run([{ type: 'link', ready: true }, { type: 'view' }]).st;
  const r = step(opening, { type: 'link', ready: false });
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.phase, 'opening');
  assert.equal(r.state.linkReady, false);
  const retrying = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } }], live()).st;
  const { st, effects } = run([{ type: 'link', ready: false }, { type: 'retry' }], retrying);
  assert.equal(st.phase, 'waiting');
  assert.deepEqual(of(effects, 'rpc'), [], 'no term.open while the link is down');
  assert.deepEqual(of(effects, 'notice').map((e) => e.text), [NOTICE.lost]);
});

test('ready again on the same connection changes nothing', () => {
  assert.deepEqual(step(live(), { type: 'link', ready: true }).effects, []);
});

test('the lost-input count adds the overflow; after it is reported it starts from 0', () => {
  let st = run([{ type: 'link', ready: false }], live()).st;
  for (let i = 0; i < QUEUE_MAX + 2; i++) st = step(st, { type: 'input', m: 'term.input', p: { d: 'k' } }).state;
  const failed = run([{ type: 'link', ready: true }, { type: 'openFailed', message: '没有这个终端', epoch: 2 }], st);
  assert.equal(of(failed.effects, 'notice').at(-1).text, `${NOTICE.cannotOpen('没有这个终端')}；${NOTICE.dropped(QUEUE_MAX + 2)}`);
  const again = run([{ type: 'link', ready: false }, { type: 'link', ready: true }, opened(9, 3)], failed.st);
  assert.ok(!of(again.effects, 'notice').some((e) => e.text.includes('没发出去')), 'not reported twice');
});

test('typing during a quick reopen (relay ↔ direct) is held without a notice: it goes in a moment later', () => {
  const { st, effects } = run([{ type: 'link', ready: true, renewed: true }, { type: 'input', m: 'term.input', p: { d: 'a' } }], live());
  assert.deepEqual(of(effects, 'notice'), []);
  assert.equal(st.queue.length, 1);
});

test('after an exit or a takeover, the next link ready opens the terminal again (as before the session module)', () => {
  for (const reason of ['exited', 'replaced']) {
    const { effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason, exitCode: 0 } },
      { type: 'link', ready: false }, { type: 'link', ready: true }], live());
    assert.equal(of(effects, 'rpc', 'term.open').length, 1, reason);
  }
});

test('F2: after a reopen the new grid goes first, then the held input (the order it must reach the Mac)', () => {
  const { effects } = run([{ type: 'stream', msg: { ev: 'closed', s: 7, reason: 'closed' } },
    { type: 'input', m: 'term.input', p: { d: 'ab' } }, { type: 'retry' }, { type: 'fit', fit: F2 }, opened(8, 1)], live());
  assert.deepEqual(of(effects, 'notify').map((e) => e.m), ['term.fit', 'term.input']);
});

test('F5: enqueue: one failing step does not stop the later ones (a plain .then chain would)', async () => {
  const ran = [], warned = [];
  const warn = console.warn; console.warn = (m) => warned.push(m);
  try {
    let q = Promise.resolve();
    q = enqueue(q, () => { throw new Error('notify threw'); });
    q = enqueue(q, () => { ran.push('a'); });
    q = enqueue(q, async () => { await null; throw new Error('async'); });
    q = enqueue(q, () => { throw null; }); // eslint-disable-line no-throw-literal
    q = enqueue(q, () => { throw new Error(''); });
    q = enqueue(q, () => { ran.push('b'); });
    await q;
    assert.deepEqual(warned, ['term input: notify threw', 'term input: async', 'term input: null', 'term input: ']);
    let plain = Promise.resolve().then(() => { throw new Error('x'); });
    plain = plain.then(() => ran.push('plain'));
    await plain.catch(() => {});
  } finally { console.warn = warn; }
  assert.deepEqual(ran, ['a', 'b'], 'the plain chain skipped its next step: that is the bug enqueue prevents');
});
