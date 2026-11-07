// Link.wake() back from the background (app/src/link.js, DESIGN.md「安全」 reconnects): a socket
// that says OPEN but died while the phone slept must be dropped within `wakePong`, not after 30–50 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_TIMEOUTS } from '../app/src/direct.js';
import { Link } from '../app/src/link.js';
import { newBoxKeys } from '../shared/e2e.js';

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
