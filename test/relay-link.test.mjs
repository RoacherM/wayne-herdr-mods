// Desktop outbound relay WebSocket (host/relay-link.js): reconnect, connect timeout, and stale-socket isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayLink } from '../host/relay-link.js';
import { desktopIdFor, newSignKeys } from '../shared/e2e.js';

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closedWith = null;
    this.listeners = new Map();
    FakeSocket.all.push(this);
  }
  addEventListener(type, fn, opts) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: Boolean(opts?.once) });
    this.listeners.set(type, list);
  }
  send(data) { this.sent.push(data); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    const ev = { code, reason };
    const list = this.listeners.get('close') ?? [];
    this.listeners.delete('close');
    for (const item of list) item.fn(ev);
    this.onclose?.(ev);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(data) {
    this.onmessage?.({ data });
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    const ev = { code, reason };
    const list = this.listeners.get('close') ?? [];
    this.listeners.delete('close');
    for (const item of list) item.fn(ev);
    this.onclose?.(ev);
  }
}

async function setupLink(t, extra = {}) {
  const prevWs = globalThis.WebSocket;
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = prevWs; });
  const signKeys = newSignKeys();
  const desktopId = await desktopIdFor(signKeys.publicKey);
  const logs = [];
  const statuses = [];
  const events = [];
  const link = createRelayLink({
    relayUrl: 'https://relay.test',
    desktopId,
    signKeys,
    log: (line) => logs.push(line),
    onOpen: (cid) => events.push(['open', cid]),
    onData: (cid, d) => events.push(['data', cid, d]),
    onClose: (cid) => events.push(['close', cid]),
    onStatus: (st, detail) => statuses.push([st, detail]),
    ...extra,
  });
  t.after(() => link.dispose());
  return { link, logs, statuses, events, sockets: FakeSocket.all };
}

test('kick() while connecting tears down the stalled socket and ignores late open/message so it cannot self-replace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { link, logs, events, sockets } = await setupLink(t);
  assert.equal(sockets.length, 1);
  const first = sockets[0];
  assert.equal(first.readyState, 0);

  // Wake-up kick while first socket is still hanging in CONNECTING
  link.kick();
  assert.equal(first.readyState, 3, 'stalled socket must be closed before dialing a replacement');
  assert.equal(sockets.length, 2);
  const second = sockets[1];
  second.open();
  assert.equal(link.status(), 'online');

  // Even if first somehow raced past close() and emitted open/message late, it must be immediately closed and ignored
  first.open();
  first.frame(JSON.stringify({ t: 'open', c: 'stale-client' }));
  assert.equal(first.readyState, 3, 'late-opening superseded socket is closed again');
  assert.equal(events.length, 0, 'frames from superseded socket are ignored');
  assert.equal(logs.filter((l) => l.includes('[relay] online')).length, 1, 'superseded socket must not log online');

  // Heartbeat keeps running on the active second socket, not hijacked by first
  t.mock.timers.tick(20_000);
  assert.deepEqual(second.sent, ['ping']);
  assert.deepEqual(first.sent, []);
  second.frame('pong');
  assert.equal(link.status(), 'online');
});

test('stalled connect aborts after 15s connect timeout instead of hanging for 75s, then reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { link, logs, sockets } = await setupLink(t);
  assert.equal(sockets.length, 1);
  const first = sockets[0];

  t.mock.timers.tick(14_999);
  assert.equal(first.readyState, 0, 'still waiting just before timeout');
  assert.equal(sockets.length, 1);

  t.mock.timers.tick(1);
  assert.equal(first.readyState, 3, 'stalled socket closed at 15s');
  assert.equal(link.status(), 'offline');
  assert.ok(logs.some((l) => l.includes('connect timeout')), 'logs connect timeout');

  // Backoff retry dials a fresh socket
  t.mock.timers.tick(2_000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(link.status(), 'online');
});

test('genuine code 4000 stops auto-reconnect until kick(), while heartbeat timeout reconnects automatically', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { link, statuses, events, sockets } = await setupLink(t);
  const first = sockets[0];
  first.open();
  assert.equal(link.status(), 'online');

  // Client multiplexing works on active socket; unknown cid is ignored both ways
  first.frame(JSON.stringify({ t: 'data', c: 'unknown', d: 'ignored' }));
  first.frame(JSON.stringify({ t: 'close', c: 'unknown' }));
  link.send('unknown', 'ignored');
  link.close('unknown');
  assert.equal(first.sent.length, 0);
  first.frame(JSON.stringify({ t: 'open', c: 'c1' }));
  first.frame(JSON.stringify({ t: 'data', c: 'c1', d: 'hello' }));
  link.send('c1', 'reply');
  assert.deepEqual(JSON.parse(first.sent.at(-1)), { t: 'data', c: 'c1', d: 'reply' });
  link.close('c1', 'done');
  assert.deepEqual(JSON.parse(first.sent.at(-1)), { t: 'close', c: 'c1', reason: 'done' });
  assert.deepEqual(events, [['open', 'c1'], ['data', 'c1', 'hello'], ['close', 'c1']]);

  // Another desktop instance replaces us with code 4000 (including null reason fallback) -> stay offline, no auto-reconnect
  first.drop(4000, null);
  assert.equal(link.status(), 'offline');
  assert.deepEqual(statuses.at(-1), ['offline', 'replaced']);
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 1, 'no auto-reconnect after genuine 4000');

  // Explicit kick() recovers
  link.kick();
  assert.equal(sockets.length, 2);
  const second = sockets[1];
  second.open();
  assert.equal(link.status(), 'online');

  // Still alive at 60s (under DEAD_MS=65s), then heartbeat timeout (4002) at 80s triggers automatic reconnect
  t.mock.timers.tick(60_000);
  assert.equal(second.readyState, 1, 'still open before DEAD_MS');
  t.mock.timers.tick(20_000);
  assert.equal(second.closedWith?.code, 4002);
  assert.equal(second.closedWith?.reason, 'heartbeat timeout');
  t.mock.timers.tick(5_000);
  assert.equal(sockets.length, 3);

  // dispose() stops further reconnects and ignores subsequent kick()
  link.dispose();
  assert.equal(link.status(), 'stopped');
  link.kick();
  t.mock.timers.tick(60_000);
  assert.equal(sockets.length, 3, 'no socket dialed after dispose()');
});

test('handles auth rejection log, duplicate open/close frames, binary frames, and WebSocket constructor errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { logs, events, sockets } = await setupLink(t);
  const first = sockets[0];
  first.open();

  // Binary frame + duplicate open + relay-initiated close + malformed JSON
  first.frame(new TextEncoder().encode(JSON.stringify({ t: 'open', c: 'c2' })));
  first.frame(JSON.stringify({ t: 'open', c: 'c2' }));
  first.frame('not-json');
  first.frame(JSON.stringify({ t: 'close', c: 'c2' }));
  assert.deepEqual(events, [['open', 'c2'], ['close', 'c2'], ['open', 'c2'], ['close', 'c2']]);

  // Normal 1006 close does NOT log auth rejection, and schedules retry with backoff
  first.drop(1006, 'gone');
  assert.equal(logs.some((l) => l.includes('中继拒绝了连接')), false);
  t.mock.timers.tick(2_000);
  assert.equal(sockets.length, 2);
  const second = sockets[1];
  second.open();
  assert.ok(logs.at(-1).includes('attempt=1'));

  // 30s stable connection resets retry attempt counter; code 1008 logs auth rejection
  t.mock.timers.tick(30_000);
  second.frame('pong');
  second.drop(1008, 'policy');
  assert.equal(logs.filter((l) => l.includes('中继拒绝了连接')).length, 1);

  // Next connect throws synchronously -> logs error and schedules another retry
  const RealFake = globalThis.WebSocket;
  let threw = false;
  globalThis.WebSocket = class extends RealFake {
    constructor(url) {
      if (!threw) { threw = true; throw new Error('network down'); }
      super(url);
    }
  };
  t.mock.timers.tick(2_000);
  assert.ok(logs.some((l) => l.includes('无法连接中继：network down')));
  t.mock.timers.tick(4_000);
  assert.equal(sockets.length, 3, 'retried after constructor failure');
  sockets[2].open();
  sockets[2].drop(1006, 'desktop auth failed: bad signature');
  assert.equal(logs.filter((l) => l.includes('中继拒绝了连接')).length, 2);
});
