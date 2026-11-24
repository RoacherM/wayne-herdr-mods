// ios/src/conn.ts outside the phone: bundled with esbuild against a tiny fake "nsh" (signals that
// track the reads of the running effect, as nsh's do) and a fake WebSocket, so its reactive
// wiring can be checked in Node. The fake runtime is reachable as globalThis.__nsh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { clean } from '../host/metrics.js';
import { b64, desktopAccept, newBoxKeys } from '../shared/e2e.js';

const FAKE_NSH = `
let running = null, batching = 0;
const queued = new Set();
function run(e) { const prev = running; running = e; try { e.fn(); } finally { running = prev; } }
function flush() { const list = [...queued]; queued.clear(); for (const e of list) run(e); }
export function signal(v) {
  const subs = new Set();
  const read = () => { if (running) subs.add(running); return v; };
  read.set = (nv) => { if (Object.is(nv, v)) return; v = nv; for (const e of subs) queued.add(e); if (!batching) flush(); };
  return read;
}
export function effect(fn) { run({ fn }); }
export function batch(fn) { batching++; try { return fn(); } finally { if (!--batching) flush(); } }
export const lifecycle = signal('active');
const store = new Map();
export const Storage = {
  getItem: async (k) => store.get(k) ?? globalThis.__nshSaved ?? null,
  setItem: async (k, v) => { store.set(k, v); },
  removeItem: async (k) => { store.delete(k); },
};
export const host = { available: () => false, post() {}, call: async () => ({}) };
globalThis.__nsh = { effect, lifecycle };
`;

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.all.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}

let bundled;
let loads = 0;
/** A fresh copy of conn.ts and its fake nsh (module state is per copy). */
async function loadConn() {
  bundled ??= (await build({
    entryPoints: [resolve('ios/src/conn.ts')],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    plugins: [{
      name: 'fake-nsh',
      setup(b) {
        b.onResolve({ filter: /^nsh$/ }, () => ({ path: 'nsh', namespace: 'fake' }));
        b.onResolve({ filter: /^websocket$/ }, () => ({ path: 'websocket', namespace: 'fake-ws' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: FAKE_NSH, loader: 'js' }));
        b.onLoad({ filter: /.*/, namespace: 'fake-ws' }, () => ({ contents: 'export const connect = null;', loader: 'js' }));
      },
    }],
  })).outputFiles[0].text;
  const src = `${bundled}\n//${++loads}`;
  const conn = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  return { conn, nsh: globalThis.__nsh };
}

/** conn.ts with a saved Mac booted onto a fake socket (OPEN, handshake not started). */
async function booted(desktopKeys = newBoxKeys()) {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.__nshSaved = JSON.stringify({
    relay: 'https://relay.test', desktopId: 'd1', desktopKey: b64(desktopKeys.publicKey), deviceSecret: b64(newBoxKeys().secretKey),
  });
  const { conn, nsh } = await loadConn();
  await conn.boot();
  delete globalThis.__nshSaved;
  assert.equal(FakeSocket.all.length, 1, 'boot opens the saved Mac');
  FakeSocket.all[0].open();
  return { conn, nsh, ws: FakeSocket.all[0], done: () => conn.forget().catch(() => {}) };
}

test('ios conn: clientLog inside an effect does not subscribe that effect to the link status', async (t) => {
  const { conn, nsh, done } = await booted();
  t.after(done);
  let runs = 0;
  nsh.effect(() => { runs++; conn.clientLog('info', 'nav.routes', { stack: ['home'] }); }); // App.tsx nav.routes shape
  for (const st of ['connecting', 'offline', 'connecting', 'ready', 'offline']) conn.status.set(st);
  assert.equal(runs, 1, `the effect re-ran ${runs - 1}x on status changes alone`);
});

test('ios conn: coming back to the foreground wakes the link on any screen', async (t) => {
  const { nsh, ws, done } = await booted();
  t.after(done);
  await new Promise((r) => setTimeout(r, 350)); // past wake()'s 300 ms debounce (a real lock takes longer)
  nsh.lifecycle.set('background');
  nsh.lifecycle.set('active'); // no HomeScreen / TermScreen mounted
  assert.ok(ws.sent.includes('ping'), 'wake() pinged the socket');
});

/** Play the Mac's side of one handshake on the fake socket, up to `ready` (shared/e2e.js). */
function macReady(ws, D) {
  ws.onmessage({ data: '\u0000online' });
  const desk = desktopAccept(D, ws.sent.at(-1));
  ws.onmessage({ data: desk.welcome });
  ws.onmessage({ data: desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }) });
}

test('ios conn: linkEpoch moves with each ready, in the same batch as status (TermScreen reopens on it)', async (t) => {
  const D = newBoxKeys();
  const { conn, nsh, ws, done } = await booted(D);
  t.after(() => { ws.onclose(); return done(); }); // not ready: forget() does not wait for the Mac's answer
  const seen = [];
  nsh.effect(() => { seen.push(`${conn.status()}#${conn.linkEpoch()}`); });
  macReady(ws, D);
  macReady(ws, D); // the Mac restarted: a new session on the same socket
  assert.equal(conn.linkEpoch(), 2);
  assert.deepEqual(seen.filter((x) => x.startsWith('ready')), ['ready#1', 'ready#2'], `never "ready" with the old epoch: ${seen.join(' ')}`);
});

test('ios conn: native metrics queue connect/open/echo/resume/drop and pass host clean()', async (t) => {
  const D = newBoxKeys();
  const { conn, nsh, ws, done } = await booted(D);
  t.after(() => { for (const s of FakeSocket.all) s.onclose?.(); return done(); });

  ws.onmessage({ data: '\u0000online' });
  const desk = desktopAccept(D, ws.sent.at(-1));
  ws.onmessage({ data: desk.welcome });
  ws.onmessage({ data: desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }) });
  await Promise.resolve();
  await Promise.resolve();

  // Simulate opening a terminal, WebView ready, stream output arriving, and WebView drawn.
  conn.termOpening('t1', false);
  conn.termWebReady(95);
  conn.termRpcOpened(210);
  conn.termOutputArrived();
  conn.termDrawn();

  // Simulate typing into a quiet terminal after > 300 ms, then output + drawn (echo).
  await new Promise((r) => setTimeout(r, 320));
  conn.termTyped();
  conn.termOutputArrived();
  conn.termDrawn();

  const answerMetricsPut = () => {
    const frames = ws.sent.slice(1).map((f) => { try { return desk.cipher.open(f); } catch { return null; } }).filter(Boolean);
    const collected = [];
    for (const f of frames) {
      if (f.m === 'metrics.put') {
        collected.push(...f.p.events.map((e) => clean(e, f.p.ctx)));
        ws.onmessage({ data: desk.cipher.seal({ id: f.id, ok: true, r: { kept: f.p.events.length } }) });
      }
    }
    return collected;
  };

  // Entering background flushes immediately while socket is still open.
  nsh.lifecycle.set('background');
  const firstBatch = answerMetricsPut();
  await new Promise((r) => setTimeout(r, 10));

  // Returning to active wakes link, answers pong, and paints resume.
  await new Promise((r) => setTimeout(r, 320)); // past wake() 300 ms debounce
  nsh.lifecycle.set('active');
  ws.onmessage({ data: 'pong' });
  await new Promise((r) => setTimeout(r, 10));
  conn.termOutputArrived();
  conn.termDrawn();

  // Drop socket, reconnect on the new socket, and flush the second batch (rtt, wake, resume, drop, connect).
  ws.onclose({ code: 1006 });
  await new Promise((r) => setTimeout(r, 750));
  const ws2 = FakeSocket.all.at(-1);
  ws2.open();
  ws2.onmessage({ data: '\u0000online' });
  const desk2 = desktopAccept(D, ws2.sent.at(-1));
  ws2.onmessage({ data: desk2.welcome });
  ws2.onmessage({ data: desk2.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }) });

  const flushDone = conn.flushMetrics();
  const frames2 = ws2.sent.slice(1).map((f) => { try { return desk2.cipher.open(f); } catch { return null; } }).filter(Boolean);
  const put2 = frames2.find((f) => f.m === 'metrics.put');
  assert.ok(put2, 'second metrics.put RPC was sent after reconnect');
  ws2.onmessage({ data: desk2.cipher.seal({ id: put2.id, ok: true, r: { kept: put2.p.events.length } }) });
  await flushDone;

  const cleaned = [...firstBatch, ...put2.p.events.map((e) => clean(e, put2.p.ctx))];
  assert.equal(cleaned.every(Boolean), true, 'every native metric passes host clean()');
  const kinds = new Set(cleaned.map((e) => e.ev));
  for (const want of ['connect', 'link', 'op', 'open', 'echo', 'rtt', 'wake', 'resume', 'drop']) {
    assert.ok(kinds.has(want), `expected ${want} in ${[...kinds].join(',')}`);
  }
});

test('ios conn: ready sends terminals.list before pendingLogs and coalesces overlapping refresh() calls', async (t) => {
  const D = newBoxKeys();
  const { conn, ws, done } = await booted(D);
  t.after(() => { ws.onclose?.(); return done(); });

  // Queue logs while still connecting (before ready)
  conn.clientLog('info', 'nav.routes', { stack: ['home'] });
  conn.clientLog('info', 'link.wake', { action: 'connecting' });

  ws.onmessage({ data: '\u0000online' });
  const desk = desktopAccept(D, ws.sent.at(-1));
  ws.onmessage({ data: desk.welcome });
  ws.onmessage({ data: desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }) });
  await Promise.resolve();
  await Promise.resolve();

  const opened = ws.sent.slice(1).map((f) => desk.cipher.open(f));
  const listIdx = opened.findIndex((m) => m.m === 'terminals.list');
  const firstLogIdx = opened.findIndex((m) => m.m === 'client.log');
  assert.ok(listIdx >= 0 && firstLogIdx >= 0, 'both terminals.list and pending client.log were sent');
  assert.ok(listIdx < firstLogIdx, `terminals.list (${listIdx}) must be queued before pendingLogs (${firstLogIdx})`);

  // Calling refresh() 3 more times while the first terminals.list RPC is still in flight coalesces into 1 follow-up
  const p1 = conn.refresh();
  const p2 = conn.refresh();
  const p3 = conn.refresh();
  const afterCoalesce = ws.sent.slice(1).map((f, i) => (i < opened.length ? opened[i] : desk.cipher.open(f)));
  const inFlightLists = afterCoalesce.filter((m) => m.m === 'terminals.list');
  assert.equal(inFlightLists.length, 1, 'overlapping refresh() calls must not send duplicate in-flight RPCs');

  // Answer first terminals.list -> exactly 1 coalesced trailing refresh fires
  ws.onmessage({ data: desk.cipher.seal({ id: inFlightLists[0].id, ok: true, r: { terminals: [], layout: [] } }) });
  await Promise.all([p1, p2, p3]);
  const trailing = ws.sent.slice(1 + afterCoalesce.length).map((f) => desk.cipher.open(f)).filter((m) => m.m === 'terminals.list');
  assert.equal(trailing.length, 1, 'exactly one trailing refresh runs for dirty coalesced calls');
  ws.onmessage({ data: desk.cipher.seal({ id: trailing[0].id, ok: true, r: { terminals: [], layout: [] } }) });
});

test('ios conn: coalesceAsync cancel() and canRetry()=false reset dirty cleanly', async (t) => {
  const { conn, done } = await booted();
  t.after(done);
  let calls = 0;
  let release;
  let allow = false;
  const loader = conn.coalesceAsync(async () => {
    calls++;
    await new Promise((r) => { release = r; });
  }, () => allow);

  const p1 = loader.trigger();
  loader.trigger(); // sets dirty while in-flight
  release();
  await p1;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1, 'canRetry()=false suppresses trailing run');

  // Next single trigger with allow=true must NOT run twice from stale dirty flag
  allow = true;
  const p2 = loader.trigger();
  release();
  await p2;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2, 'dirty was cleared when canRetry() was false');

  // Default canRetry: single trigger runs once (dirty starts false), overlapping triggers run twice
  let defCalls = 0;
  let defRelease;
  const defLoader = conn.coalesceAsync(async () => {
    defCalls++;
    await new Promise((r) => { defRelease = r; });
  });
  const dp1 = defLoader.trigger();
  defRelease();
  await dp1;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(defCalls, 1, 'single trigger runs exactly once');
  const dp2 = defLoader.trigger();
  defLoader.trigger();
  defRelease();
  await dp2;
  await new Promise((r) => setTimeout(r, 0));
  defRelease();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(defCalls, 3, 'default canRetry allows trailing coalesced run');

  // cancel() stops in-flight trailing run and future triggers
  const p3 = loader.trigger();
  loader.trigger();
  loader.cancel();
  release();
  await p3;
  await loader.trigger();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 3, 'cancel() prevents trailing retry and subsequent calls');
});

test('ios ws-queue: QueuedWebSocket serializes bursts, reads messages, and handles errors/overflow/close', async () => {
  const { createQueuedWebSocket } = await import('../ios/src/ws-queue.ts');
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // 1. 30-frame burst + inbound read + clean close with custom 4000 code
  const delivered = [];
  const incoming = [];
  let inFlight = 0;
  let closed = null;
  let disposed = 0;
  const readQueue = ['hello-from-mac'];
  let releaseRead;
  let closeCalls = 0;
  const fakeConn = {
    closeCode: null,
    closeReason: null,
    async write(data) {
      if (inFlight >= 1) throw new Error('WebSocket outbound queue is full');
      inFlight++;
      await Promise.resolve();
      delivered.push(data);
      inFlight--;
    },
    async read() {
      if (readQueue.length) return readQueue.shift();
      return new Promise((r) => { releaseRead = r; });
    },
    async close(code = 1000, reason = '') {
      closeCalls++;
      closed = { code, reason };
      this.closeCode = code;
      this.closeReason = reason;
      releaseRead?.(null);
    },
    dispose() { disposed++; },
  };

  const QueuedWS = createQueuedWebSocket(async () => fakeConn);
  const ws = new QueuedWS('wss://relay.test/v1/client/d1');
  ws.send('ignored-before-open');
  let opened = false;
  let closeEv = null;
  ws.onopen = () => { opened = true; };
  ws.onmessage = (ev) => incoming.push(ev.data);
  ws.onclose = (ev) => { closeEv = ev; };

  await tick();
  assert.equal(opened, true);
  assert.equal(ws.readyState, 1);
  assert.deepEqual(incoming, ['hello-from-mac']);

  for (let i = 0; i < 30; i++) ws.send(`frame-${i}`);
  await tick();
  assert.equal(delivered.length, 30, 'all 30 burst frames delivered without queue overflow');
  assert.deepEqual(delivered, Array.from({ length: 30 }, (_, i) => `frame-${i}`));

  ws.close(3000, 'replaced');
  ws.close(3000, 'duplicate');
  await tick();
  assert.equal(closeCalls, 1, 'second close() is a no-op');
  assert.deepEqual(closed, { code: 3000, reason: 'replaced' });
  assert.equal(ws.readyState, 3);
  assert.equal(disposed, 1);
  assert.equal(closeEv?.code, 3000);

  // Boundary code 4999 + socket without handlers never throws
  const NoHandlerWS = createQueuedWebSocket(async () => ({
    closeCode: null, closeReason: null,
    async write() {},
    async read() { return 'orphan-msg'; },
    async close() {},
    dispose() {},
  }));
  const wsNoH = new NoHandlerWS('wss://relay.test/noh');
  wsNoH.close(4999, 'max-valid');
  assert.equal(wsNoH.readyState, 3);
  const wsMaxCode = new NoHandlerWS('wss://relay.test/max');
  let maxEv = null;
  wsMaxCode.onclose = (ev) => { maxEv = ev; };
  wsMaxCode.close(4999, 'ok');
  assert.equal(maxEv?.code, 4999);

  // 2. Dial failure triggers onerror + onclose(1006)
  const DialFailWS = createQueuedWebSocket(async () => { throw new Error('tls failed'); });
  const wsFail = new DialFailWS('wss://relay.test/bad');
  let errSeen = null;
  let failClose = null;
  wsFail.onerror = (e) => { errSeen = e; };
  wsFail.onclose = (ev) => { failClose = ev; };
  await tick();
  assert.ok(errSeen instanceof Error);
  assert.equal(failClose?.code, 1006);
  assert.equal(failClose?.reason, 'tls failed');

  // 3. Close while connecting closes & disposes late-resolving conn, normalizes invalid close code
  let resolveLate;
  let lateClosed = false;
  let lateDisposed = 0;
  const LateWS = createQueuedWebSocket(() => new Promise((r) => { resolveLate = r; }));
  const wsLate = new LateWS('wss://relay.test/late');
  let lateCloseEv = null;
  wsLate.onclose = (ev) => { lateCloseEv = ev; };
  wsLate.close(1005, 'invalid-code');
  assert.equal(lateCloseEv?.code, 1000, 'invalid client close code normalized to 1000');
  resolveLate({
    closeCode: null, closeReason: null,
    async write() {}, async read() { return null; },
    async close() { lateClosed = true; },
    dispose() { lateDisposed++; },
  });
  await tick();
  assert.equal(lateClosed, true);
  assert.equal(lateDisposed, 1);

  // 4. Write failure triggers onerror + onclose(1006) and disposes
  let writeDisposed = 0;
  const WriteErrWS = createQueuedWebSocket(async () => ({
    closeCode: null, closeReason: null,
    async write() { throw new Error('broken pipe'); },
    async read() { return new Promise(() => {}); },
    async close() {},
    dispose() { writeDisposed++; },
  }));
  const wsWE = new WriteErrWS('wss://relay.test/we');
  let weClose = null;
  wsWE.onclose = (ev) => { weClose = ev; };
  await tick();
  wsWE.send('boom');
  await tick();
  assert.equal(weClose?.code, 1006);
  assert.equal(weClose?.reason, 'broken pipe');
  assert.equal(writeDisposed, 1);

  // 5. Queue overflow beyond 512 frames closes cleanly instead of unbounded buffering
  let overflowDisposed = 0;
  const SlowWS = createQueuedWebSocket(async () => ({
    closeCode: null, closeReason: null,
    write() { return new Promise(() => {}); }, // stalls after 1st frame dequeued
    read() { return new Promise(() => {}); },
    async close() {},
    dispose() { overflowDisposed++; },
  }));
  const wsSlow = new SlowWS('wss://relay.test/slow');
  let overflowClose = null;
  wsSlow.onclose = (ev) => { overflowClose = ev; };
  await tick();
  for (let i = 0; i < 514; i++) wsSlow.send(`f-${i}`);
  assert.equal(overflowClose?.code, 1006);
  assert.equal(overflowClose?.reason, 'send queue overflow');
  assert.equal(overflowDisposed, 1);

  // 6. Remote peer close (read() -> null) and read() error both finishClose cleanly
  const PeerCloseWS = createQueuedWebSocket(async () => ({
    closeCode: 4001, closeReason: 'peer-gone',
    async write() {},
    async read() { return null; },
    async close() {},
    dispose() {},
  }));
  const wsPeer = new PeerCloseWS('wss://relay.test/peer');
  let peerClose = null;
  wsPeer.onclose = (ev) => { peerClose = ev; };
  await tick();
  assert.deepEqual(peerClose, { code: 4001, reason: 'peer-gone' });

  const ReadErrWS = createQueuedWebSocket(async () => ({
    closeCode: null, closeReason: null,
    async write() {},
    async read() { throw new Error('eof reset'); },
    async close() {},
    dispose() {},
  }));
  const wsRE = new ReadErrWS('wss://relay.test/re');
  let reClose = null;
  wsRE.onclose = (ev) => { reClose = ev; };
  await tick();
  assert.deepEqual(reClose, { code: 1006, reason: 'eof reset' });
});

test('ios conn: LanDuo promotes LAN direct socket, idles relay, and falls back on LAN drop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const D = newBoxKeys();
  const { conn, ws: relayWs, done } = await booted(D);
  t.after(() => { for (const s of FakeSocket.all) s.onclose?.(); return done(); });

  relayWs.onmessage({ data: '\u0000online' });
  const relayDesk = desktopAccept(D, relayWs.sent.at(-1));
  relayWs.onmessage({ data: relayDesk.welcome });
  relayWs.onmessage({
    data: relayDesk.cipher.seal({
      type: 'ready',
      desktopName: 'Mac',
      deviceId: 'p1',
      paired: false,
      lan: ['ws://192.168.1.9:54321/v1/lan'],
    }),
  });
  await Promise.resolve();
  assert.equal(conn.connVia(), 'relay');

  // LanDuo schedules LAN probe 100ms after relay ready
  t.mock.timers.tick(120);
  const lanWs = FakeSocket.all.find((s) => s.url === 'ws://192.168.1.9:54321/v1/lan');
  assert.ok(lanWs, 'LanDuo dialed advertised LAN endpoint');

  // Complete E2E handshake directly on LAN socket (no \0online relay frame)
  lanWs.open();
  const lanDesk = desktopAccept(D, lanWs.sent.at(-1));
  lanWs.onmessage({ data: lanDesk.welcome });
  lanWs.onmessage({
    data: lanDesk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false }),
  });
  for (let i = 0; i < 6; i++) await Promise.resolve();

  assert.equal(conn.connVia(), 'direct', 'connVia promoted to direct LAN');
  const relayPlain = relayWs.sent
    .slice(1)
    .map((f) => { try { return relayDesk.cipher.open(f); } catch { return null; } })
    .filter(Boolean);
  assert.ok(relayPlain.some((m) => m.m === 'link.idle'), 'relay notified link.idle when LAN took over');

  // LAN drops (walking onto 5G) -> instantaneously falls back to warm relay
  lanWs.onclose({ code: 1006, reason: 'network' });
  await Promise.resolve();
  assert.equal(conn.connVia(), 'relay', 'fell back to relay immediately on LAN drop');
  assert.equal(conn.status(), 'ready', 'warm relay stayed ready');
});
