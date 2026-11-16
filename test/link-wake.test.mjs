// Link.wake() back from the background (app/src/link.js, DESIGN.md「安全」 reconnects): a socket
// that says OPEN but died while the phone slept must be dropped within `wakePong`, not after 30–50 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_TIMEOUTS } from '../app/src/direct.js';
import { Link } from '../app/src/link.js';
import { desktopAccept, newBoxKeys } from '../shared/e2e.js';

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.all.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(d) { this.onmessage?.({ data: d }); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeLink(t) {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  const link = new Link({
    relay: 'https://relay.test', desktopId: 'd1', desktopKey: newBoxKeys().publicKey,
    deviceKeys: newBoxKeys(), timeouts: { ping: 60_000, silent: 60_000, ...t },
  });
  FakeSocket.all[0].open();
  return link;
}

test('wake: an OPEN socket that answers nothing within wakePong is dropped and replaced at once', async (t) => {
  const link = makeLink({ wakePong: 40 });
  t.after(() => link.close());
  const first = FakeSocket.all[0];
  link.wake();
  assert.ok(first.sent.includes('ping'), 'wake pings the open socket');
  await sleep(80);
  assert.equal(first.readyState, 3, 'the silent socket is closed');
  assert.equal(FakeSocket.all.length, 2, 'a new socket is opened without the backoff delay');
  assert.equal(link.ws, FakeSocket.all[1]);
});

test('wake: a pong within wakePong keeps the socket', async (t) => {
  const link = makeLink({ wakePong: 60 });
  t.after(() => link.close());
  const first = FakeSocket.all[0];
  link.wake();
  await sleep(10);
  first.frame('pong');
  await sleep(100);
  assert.equal(first.readyState, 1);
  assert.equal(FakeSocket.all.length, 1);
  assert.equal(link.ws, first);
});

test('wake: close() cancels the pending wake check', async () => {
  const link = makeLink({ wakePong: 30 });
  link.wake();
  link.close();
  await sleep(60);
  assert.equal(FakeSocket.all.length, 1, 'no reconnect after close');
});

test('wake: long asleep still drops at once (no wait for the pong)', async (t) => {
  const link = makeLink({ wakePong: 10_000, asleep: 5 });
  t.after(() => link.close());
  await sleep(20);
  link.wake();
  assert.equal(FakeSocket.all.length, 2);
});

test('wake: while waiting to retry (no socket), it connects at once', async (t) => {
  const link = makeLink({ wakePong: 10_000 });
  t.after(() => link.close());
  FakeSocket.all[0].onclose(); // dropped: a retry is due in 700 ms
  assert.equal(link.ws, null);
  link.wake();
  assert.equal(FakeSocket.all.length, 2);
  assert.equal(link.ws, FakeSocket.all[1]);
  assert.equal(link.attempt, 0, 'the backoff starts over');
});

test('wake: a socket still connecting is left to its connect deadline', async (t) => {
  const link = makeLink({ wakePong: 20 });
  t.after(() => link.close());
  FakeSocket.all[0].onclose();
  link.wake(); // a new socket, CONNECTING
  const connecting = FakeSocket.all[1];
  link.wake();
  await sleep(50);
  assert.equal(link.ws, connecting);
  assert.deepEqual(connecting.sent, [], 'no ping before it opens');
});

test('wake: a pong in the same millisecond as the ping still counts', async (t) => {
  const link = makeLink({ wakePong: 30 });
  t.after(() => link.close());
  const first = FakeSocket.all[0];
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen; // lastHeard before the ping and at the pong are the same number
  try {
    first.frame('x'); // any frame: lastHeard = frozen
    link.wake();
    first.frame('pong');
  } finally { Date.now = realNow; }
  await sleep(60);
  assert.equal(link.ws, first, 'the answered socket is kept');
  assert.equal(FakeSocket.all.length, 1);
});

// Direct link (direct.js): the socket is a WebRTC data channel, used once. A missed wake check
// closes this Link for good and Duo falls back to the relay, with direct retries 3 s … 5 min apart,
// so its budget must not be tighter than the direct link's own silence rule.
test('direct: the wake budget is no tighter than the direct link silence rule', () => {
  assert.ok(DIRECT_TIMEOUTS.wakePong >= DIRECT_TIMEOUTS.silent, `wakePong ${DIRECT_TIMEOUTS.wakePong} < silent ${DIRECT_TIMEOUTS.silent}`);
});

function makeDirect(t) {
  const made = [];
  const link = new Link({
    desktopKey: newBoxKeys().publicKey, deviceKeys: newBoxKeys(),
    timeouts: { ...DIRECT_TIMEOUTS, ...t },
    socket: () => { const s = new FakeSocket('direct'); made.push(s); return s; },
  });
  made[0].open(); // straight to the handshake: hello sent
  return { link, made };
}

test('direct: a late answer within wakePong keeps the channel', async (t) => {
  const { link, made } = makeDirect({ wakePong: 80 });
  t.after(() => link.close());
  link.wake();
  assert.ok(made[0].sent.includes('ping'));
  await sleep(40); // later than a relay pong would be
  made[0].frame('pong');
  await sleep(80);
  assert.equal(link.closed, false);
  assert.equal(link.ws, made[0]);
});

test('direct: silence after wake closes this one-use Link (no new socket; Duo takes over)', async (t) => {
  const { link, made } = makeDirect({ wakePong: 30 });
  t.after(() => link.close());
  const statuses = [];
  link.addEventListener('status', (e) => statuses.push(e.detail.status));
  link.wake();
  await sleep(70);
  assert.equal(link.closed, true);
  assert.equal(link.status, 'offline');
  assert.deepEqual(statuses, ['offline']);
  assert.equal(made.length, 1, 'a direct Link never opens a second channel');
});

function macHandshake(ws, D) {
  ws.frame('\u0000online');
  const desk = desktopAccept(D, ws.sent.at(-1));
  ws.frame(desk.welcome);
  ws.frame(desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }));
  return desk;
}

test('observability: connected decomposes wsMs/roomMs/hsMs and distinguishes wake_asleep vs wake_closed vs wake_ok', async (t) => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  const D = newBoxKeys();
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const link = new Link({
      relay: 'https://relay.test', desktopId: 'd1', desktopKey: D.publicKey,
      deviceKeys: newBoxKeys(), timeouts: { ping: 60_000, silent: 60_000, asleep: 30_000, wakePong: 4_000 },
    });
    t.after(() => link.close());
    const connected = [], dropped = [], wakes = [], wakeOks = [];
    link.addEventListener('connected', (e) => connected.push(e.detail));
    link.addEventListener('dropped', (e) => dropped.push(e.detail));
    link.addEventListener('wake', (e) => wakes.push(e.detail));
    link.addEventListener('wake_ok', (e) => wakeOks.push(e.detail));

    clock += 120; // ws open after 120 ms
    FakeSocket.all[0].open();
    clock += 45; // relay room online after 45 ms
    FakeSocket.all[0].frame('\u0000online');
    const desk = desktopAccept(D, FakeSocket.all[0].sent.at(-1));
    clock += 85; // handshake + ready after 85 ms
    FakeSocket.all[0].frame(desk.welcome);
    FakeSocket.all[0].frame(desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }));

    assert.deepEqual(connected[0], { why: 'boot', ms: 250, wsMs: 120, roomMs: 45, hsMs: 85, attempt: 0 });

    // Exact boundary (30 s === asleep) still pings rather than dropping; pong clears wakePingAt.
    clock += 30_000;
    link.wake();
    assert.deepEqual(wakes.at(-1), { action: 'ping', idleMs: 30_000, rs: 1 });
    clock += 32;
    FakeSocket.all[0].frame('pong');
    assert.deepEqual(wakeOks.at(-1), { rttMs: 32 });

    // Long sleep (35 s > 30 s asleep) while socket STILL says OPEN (rs=1) → wake_asleep.
    clock += 35_000;
    link.wake();
    assert.equal(wakes.at(-1).action, 'wake_asleep');
    assert.deepEqual(dropped.at(-1), {
      reason: 'wake_asleep', stage: 'ready', ready: true, upMs: 65_032, idleMs: 35_000, code: 0, rs: 1,
    });

    // Reconnect completes with why='wake_asleep'.
    FakeSocket.all[1].open();
    macHandshake(FakeSocket.all[1], D);
    assert.equal(connected.at(-1).why, 'wake_asleep');

    // Long sleep (40 s) where iOS ALREADY closed the socket (rs=3) → labeled wake_closed, NOT wake_asleep.
    clock += 40_000;
    FakeSocket.all[1].readyState = 3;
    link.wake();
    assert.equal(wakes.at(-1).action, 'wake_closed');
    assert.equal(dropped.at(-1).reason, 'wake_closed');
    assert.equal(dropped.at(-1).rs, 3);

    // Drop while still CONNECTING (rs=0, stage='connect') vs OPEN before hello (rs=1, stage='online') vs no socket (rs=-1).
    FakeSocket.all[2].onclose({ code: 1006 });
    assert.deepEqual(dropped.at(-1), {
      reason: 'ws_close', stage: 'connect', ready: false, upMs: null, idleMs: 0, code: 1006, rs: 0,
    });
    link.wake(); // no socket → action='connect', rs=-1
    assert.deepEqual(wakes.at(-1), { action: 'connect', idleMs: 0, rs: -1 });
    FakeSocket.all[3].open();
    FakeSocket.all[3].onclose({ code: 1001 });
    assert.equal(dropped.at(-1).stage, 'online');
    assert.equal(dropped.at(-1).code, 1001);
  } finally {
    Date.now = realNow;
  }
});

test('observability: desktop restart / offline on same socket records drop upMs and resets connect marks', (t) => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  const D = newBoxKeys();
  const realNow = Date.now;
  let clock = 2_000_000;
  Date.now = () => clock;
  try {
    const link = new Link({
      relay: 'https://relay.test', desktopId: 'd1', desktopKey: D.publicKey,
      deviceKeys: newBoxKeys(), timeouts: { ping: 60_000, silent: 60_000 },
    });
    t.after(() => link.close());
    const connected = [], dropped = [];
    link.addEventListener('connected', (e) => connected.push(e.detail));
    link.addEventListener('dropped', (e) => dropped.push(e.detail));

    FakeSocket.all[0].open();
    macHandshake(FakeSocket.all[0], D);
    clock += 5_000;
    FakeSocket.all[0].frame('\u0000offline');
    assert.equal(dropped.at(-1).reason, 'desktop_offline');
    assert.equal(dropped.at(-1).upMs, 5_000);

    // Desktop stays away 60 s, then comes back: connect.ms measures only the new handshake, not the 60 s outage.
    clock += 60_000;
    FakeSocket.all[0].frame('\u0000online');
    const desk2 = desktopAccept(D, FakeSocket.all[0].sent.at(-1));
    clock += 70;
    FakeSocket.all[0].frame(desk2.welcome);
    FakeSocket.all[0].frame(desk2.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }));
    assert.deepEqual(connected.at(-1), { why: 'desktop_online', ms: 70, wsMs: 0, roomMs: 0, hsMs: 70, attempt: 0 });

    // Direct \0online while already ready (desktop replaced socket without offline gap) → desktop_restart.
    clock += 9_000;
    FakeSocket.all[0].frame('\u0000online');
    assert.equal(dropped.at(-1).reason, 'desktop_restart');
    assert.equal(dropped.at(-1).upMs, 9_000);
    const desk3 = desktopAccept(D, FakeSocket.all[0].sent.at(-1));
    clock += 50;
    FakeSocket.all[0].frame(desk3.welcome);
    FakeSocket.all[0].frame(desk3.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }));
    assert.deepEqual(connected.at(-1), { why: 'desktop_online', ms: 50, wsMs: 0, roomMs: 0, hsMs: 50, attempt: 0 });
  } finally {
    Date.now = realNow;
  }
});
