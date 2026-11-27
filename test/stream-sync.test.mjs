// Regression tests for the 2026-11-24 15:35 black-block stream sync bugs in host/phones.js:
//  1. Duplicate same-size onResize (e.g. 57x47 -> 57x47) must not emit a no-op `size` event.
//  2. Within 2000ms of a resize, a program's ESC[2J clear frame before its ESC[3J reprint must be
//     held by reprint() instead of leaking a blank screen to the phone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhones } from '../host/phones.js';
import { newBoxKeys, phoneHandshake } from '../shared/e2e.js';

async function harness() {
  const hostKeys = newBoxKeys();
  const phoneKeys = newBoxKeys();
  const device = { id: 'dev-1', name: 'Test iPhone', pub: Buffer.from(phoneKeys.publicKey).toString('base64') };
  const handlers = new Map();
  const early = new Map(); // frames herdr-core sent before the attach reply settled (hc.js holds them)
  let nextCh = 1;
  const termRec = { address: 't1', state: 'live', cols: 57, rows: 47 };
  let attachCalls = 0;
  let holdAttach = null; // while set, the next attach resolves when it is called
  const attachLog = [];
  const core = {
    async call(method, params) {
      if (method === 'terminal.attach') {
        attachCalls++;
        const ch = nextCh++;
        const reply = { channel: ch, resize_notifications: true, terminal: { cols: params.cols, rows: params.rows } };
        attachLog.push([ch, holdAttach === true ? 'held' : 'now']);
        if (holdAttach === true) return new Promise((resolve) => { holdAttach = () => resolve(reply); });
        return reply;
      }
      return {};
    },
    on(ch, h) { handlers.set(ch, h); for (const fn of early.get(ch) ?? []) fn(h); early.delete(ch); },
    send() {},
    credit() {},
    release(ch) { handlers.delete(ch); early.delete(ch); },
  };

  let cipher;
  const rx = [];
  const rawRx = [];
  const phones = createPhones({
    state: {
      boxKeys: hostKeys,
      desktopName: 'TestMac',
      deviceByKey: (pub) => (pub === device.pub ? device : null),
      deviceById: () => device,
      updateDevice: async () => {},
    },
    pairing: { dropped() {} },
    push: { publicKey: '' },
    terminals: { core: () => core, get: () => termRec, state: () => 'online', list: () => [termRec], layout: () => [] },
    link: () => ({
      send(_cid, text) {
        if (!cipher) rawRx.push(text);
        else rx.push(cipher.open(text));
      },
      close() {},
    }),
  });

  phones.open('c1');
  const hs = phoneHandshake(phoneKeys, hostKeys.publicKey);
  await phones.data('c1', hs.hello);
  cipher = hs.finish(rawRx.shift()).cipher;
  while (rawRx.length) rx.push(cipher.open(rawRx.shift()));
  await phones.data('c1', cipher.seal({ type: 'auth', mode: 'resume' }));
  rx.length = 0;

  let rid = 0;
  const rpc = async (m, p) => {
    const id = ++rid;
    await phones.data('c1', cipher.seal({ id, m, p }));
    const idx = rx.findIndex((msg) => msg.id === id);
    assert.ok(idx >= 0, `expected reply for ${m}`);
    const [reply] = rx.splice(idx, 1);
    assert.ok(reply.ok, reply.e);
    return reply.r;
  };

  const notify = async (m, p) => { await phones.data('c1', cipher.seal({ m, p })); };
  return { handlers, early, rx, rpc, notify, termRec, attachLog, getAttachCalls: () => attachCalls, holdNextAttach: () => { holdAttach = true; }, finishAttach: () => holdAttach?.() };
}

test('no-op same-size onResize does not emit a duplicate size event', async () => {
  const { handlers, rx, rpc } = await harness();
  const opened = await rpc('term.open', { address: 't1', fit: { cols: 57, rows: 47 } });
  const viewCh = [...handlers.keys()].at(-1);
  const view = handlers.get(viewCh);
  assert.ok(view?.onResize);

  // Duplicate same-size notification (what herdr-core sends on attach/reattach)
  view.onResize(57, 47);
  assert.equal(rx.filter((m) => m.ev === 'size').length, 0, 'same-size resize must not emit size event');

  // Actual size change still emits `size`
  view.onResize(129, 68);
  const sizes = rx.filter((m) => m.ev === 'size');
  assert.equal(sizes.length, 1);
  assert.deepEqual({ s: sizes[0].s, cols: sizes[0].cols, rows: sizes[0].rows }, { s: opened.s, cols: 129, rows: 68 });
});

test('post-resize ESC[2J clear before ESC[3J reprint is held instead of flushing a black frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { handlers, rx, rpc, getAttachCalls } = await harness();
  await rpc('term.open', { address: 't1', fit: { cols: 57, rows: 47 } });
  const viewCh = [...handlers.keys()].at(-1);
  const view = handlers.get(viewCh);
  const beforeReattach = getAttachCalls();

  // Resize triggers agy's two-step clear: first a 107B ESC[2J clear, then ESC[3J + huge reprint
  view.onResize(129, 68);
  // First, herdr-core's own PAINT (contains ESC[2J) must NOT be trapped by reprint()
  const paint = Buffer.from('\x18\x1b[!p\x1b[?2026l\x1b[H\x1b[2Jreal content');
  view.onData(paint);
  t.mock.timers.tick(10);
  assert.equal(rx.filter((m) => m.ev === 'out').length, 1, 'herdr-core PAINT must pass through');
  rx.length = 0;

  // Now program sends standalone ESC[2J clear, then 15ms later sends ESC[3J + >64KB reprint
  view.onData(Buffer.from('\x1b[?2026h\x1b[H\x1b[2J\x1b[?2026l'));
  t.mock.timers.tick(15);
  assert.equal(rx.filter((m) => m.ev === 'out').length, 0, 'post-resize ESC[2J clear must be held, not sent as blank frame');

  view.onData(Buffer.concat([Buffer.from('\x1b[3J'), Buffer.alloc(70 * 1024, 0x61)]));
  t.mock.timers.tick(150);
  await Promise.resolve();
  // Dropped and reattached for fresh paint — never forwarded the blank ESC[2J frame
  assert.equal(getAttachCalls(), beforeReattach + 1, 'reprint should reattach view channel for fresh paint');
  assert.equal(rx.filter((m) => m.ev === 'out').length, 0, 'dropped reprint must not leak blank ESC[2J frame');

  // After endReprint finishes, normal agent ESC[2J screen redraws must flush immediately (not held 1000ms)
  const freshViewCh = [...handlers.keys()].at(-1);
  const freshView = handlers.get(freshViewCh);
  freshView.onData(Buffer.from('\x1b[?2026h\x1b[H\x1b[2Jlive redraw\x1b[?2026l'));
  t.mock.timers.tick(10);
  assert.equal(rx.filter((m) => m.ev === 'out').length, 1, 'post-reprint normal ESC[2J redraw must not be held');
});

// Older history (term.more, DESIGN.md「往回翻历史」): what a re-attach must not let through.
// Note: with a `fit`, open() attaches the typer first, so the view is the LAST channel, not 1.
test('a dropped reprint keeps being dropped while the fresh view attaches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handlers, rx, rpc, holdNextAttach, finishAttach } = await harness();
  await rpc('term.open', { address: 't1', fit: { cols: 57, rows: 47 } });
  const view = handlers.get([...handlers.keys()].at(-1));
  holdNextAttach();
  view.onData(Buffer.concat([Buffer.from('\x1b[3J'), Buffer.alloc(70 * 1024, 0x61)]));
  t.mock.timers.tick(150); // quiet: endReprint starts reattach(), its attach held
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  view.onData(Buffer.from('LEAKED_DROPPED_REPRINT_BYTES'));
  finishAttach();
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(10);
  assert.deepEqual(rx.filter((m) => m.ev === 'out').map((m) => Buffer.from(m.d, 'base64').toString()), [], 'nothing of the dropped reprint reaches the phone');
});

test('a resize on the old view while more() attaches does not go out ahead of the new paint', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { handlers, early, rx, rpc, notify, holdNextAttach, finishAttach } = await harness();
  const opened = await rpc('term.open', { address: 't1', fit: { cols: 57, rows: 47 } });
  const viewCh = [...handlers.keys()].at(-1);
  holdNextAttach();
  await notify('term.more', { s: opened.s, have: 150 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r)); // the attach is out, held
  // herdr-core: the new view's paint at the old grid, then the resize on both views.
  early.set(viewCh + 1, [
    (h) => h.onData(Buffer.from('PAINT_AT_OLD_GRID')),
    (h) => h.onResize(120, 40),
  ]);
  handlers.get(viewCh).onResize(120, 40); // the old view, still current while the attach is out
  finishAttach();
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(10);
  const order = rx.filter((m) => m.ev === 'size' || m.ev === 'out').map((m) => (m.ev === 'size' ? `size ${m.cols}x${m.rows}` : Buffer.from(m.d, 'base64').toString()));
  // The old view's resize is ignored; the new view's own RESIZE flushes its paint first (in step).
  assert.deepEqual(order, ['PAINT_AT_OLD_GRID', 'size 120x40'], `paint and size stay in step (${JSON.stringify(order)})`);
});
