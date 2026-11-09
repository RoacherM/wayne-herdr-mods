// Link steps that must never wait forever (app/src/link.js, DESIGN.md「终端会话状态机」 其它隐式状态机):
// every step from socket open to ready has a deadline, and an error that is not final retries.
import test from 'node:test';
import assert from 'node:assert/strict';
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

function makeLink(t = {}, { desktopKeys = newBoxKeys(), pair } = {}) {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  const link = new Link({
    relay: 'https://relay.test', desktopId: 'd1', desktopKey: desktopKeys.publicKey, pair,
    deviceKeys: newBoxKeys(), timeouts: { ping: 60_000, silent: 60_000, handshake: 40, ...t },
  });
  const statuses = [];
  link.addEventListener('status', (e) => statuses.push(e.detail.status));
  FakeSocket.all[0].open();
  return { link, first: FakeSocket.all[0], statuses };
}

test('F3: the relay opened the socket but never said online/offline → dropped after the handshake deadline', async (t) => {
  const { link, first } = makeLink();
  t.after(() => link.close());
  await sleep(80);
  assert.equal(first.readyState, 3, 'not left in connecting');
  assert.equal(link.ws, null);
  assert.equal(link.status, 'offline');
});

test('desktop offline: no deadline while the relay says the Mac is away (the socket stays)', async (t) => {
  const { link, first } = makeLink();
  t.after(() => link.close());
  first.frame('\u0000offline');
  await sleep(80);
  assert.equal(first.readyState, 1);
  assert.equal(link.status, 'offline');
});

test('S8: the handshake fails on the phone (not a final error) → shown as error, then the socket is dropped and retried', async (t) => {
  const { link, first, statuses } = makeLink({ handshake: 60_000 });
  t.after(() => link.close());
  const fatals = [];
  link.addEventListener('fatal', (e) => fatals.push(e.detail.code));
  first.frame('\u0000online');
  first.frame('not a welcome');
  assert.deepEqual(fatals, ['handshake']);
  assert.equal(link.status, 'error', 'the error stays shown while waiting to retry');
  assert.equal(first.readyState, 3, 'not kept open with no deadline');
  assert.equal(link.ws, null);
  assert.ok(link.retryTimer, 'a retry is scheduled');
  assert.deepEqual(statuses, ['connecting', 'error']);
});

test('a final error (revoked) closes the link for good: no retry', async () => {
  const { link, first } = makeLink({ handshake: 60_000 });
  first.frame('\u0000online');
  first.frame(JSON.stringify({ code: 'revoked', error: '已移除' }));
  assert.equal(link.closed, true);
  assert.equal(link.status, 'error');
  await sleep(10);
  assert.equal(FakeSocket.all.length, 1);
});

test('F10: waiting for the SAS confirmation on the Mac has no deadline: a person decides, however long', async (t) => {
  const D = newBoxKeys();
  const { link, first } = makeLink({}, { desktopKeys: D, pair: { token: 'tok', name: 'iPhone' } });
  t.after(() => link.close());
  const sas = [];
  link.addEventListener('confirm', (e) => sas.push(e.detail.sas));
  first.frame('\u0000online');
  const desk = desktopAccept(D, first.sent.at(-1));
  first.frame(desk.welcome);
  assert.deepEqual(desk.cipher.open(first.sent.at(-1)), { type: 'auth', mode: 'pair', token: 'tok', name: 'iPhone' });
  first.frame(desk.cipher.seal({ type: 'confirm', sas: desk.sas, desktopName: 'Mac' }));
  assert.deepEqual(sas, [desk.sas]);
  await sleep(120); // 3× the handshake deadline
  assert.equal(first.readyState, 1, 'the pairing socket is still open');
  assert.equal(link.ws, first);
  assert.equal(FakeSocket.all.length, 1);
  first.frame(desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: true }));
  assert.equal(link.status, 'ready');
});
