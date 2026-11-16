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
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: FAKE_NSH, loader: 'js' }));
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

test('ios conn: { ev: "board" } increments boardSeq without leaking into onStream', async (t) => {
  const D = newBoxKeys();
  const { conn, ws, done } = await booted(D);
  t.after(() => { ws.onclose?.(); return done(); });

  ws.onmessage({ data: '\u0000online' });
  const desk = desktopAccept(D, ws.sent.at(-1));
  ws.onmessage({ data: desk.welcome });
  ws.onmessage({ data: desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false, board: true }) });

  const streamed = [];
  conn.setStreamListener((m) => streamed.push(m));
  assert.equal(conn.boardSeq(), 0);

  ws.onmessage({ data: desk.cipher.seal({ ev: 'board' }) });
  ws.onmessage({ data: desk.cipher.seal({ ev: 'out', s: 1, d: 'aGVsbG8=' }) });
  assert.equal(conn.boardSeq(), 1);
  assert.equal(conn.boardTarget(), null);
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].ev, 'out');
});

test('ios conn: scoped { ev: "board", t }, foreground resume refresh, and tracked board.get RPC', async (t) => {
  const D = newBoxKeys();
  const { conn, nsh, ws, done } = await booted(D);
  t.after(() => { ws.onclose?.(); return done(); });

  ws.onmessage({ data: '\u0000online' });
  const desk = desktopAccept(D, ws.sent.at(-1));
  ws.onmessage({ data: desk.welcome });
  ws.onmessage({ data: desk.cipher.seal({ type: 'ready', desktopName: 'Mac', deviceId: 'p1', paired: false, board: true }) });

  const parentLane = { t: 't48', agents: [{ id: 'hc:t6d', terminal: 't6d' }] };
  const seen = [];
  nsh.effect(() => { seen.push(`${conn.boardSeq()}:${conn.boardTarget() ?? '*'}`); });
  assert.deepEqual(seen, ['0:*'], 'initial active boot does not bump boardSeq');

  // Scoped push for t48: matches t48 and its child pane t6d, skips unrelated t99.
  ws.onmessage({ data: desk.cipher.seal({ ev: 'board', t: 't48' }) });
  assert.equal(conn.boardSeq(), 1);
  assert.equal(conn.boardTarget(), 't48');
  assert.equal(conn.boardTouchesTerminal(conn.boardTarget(), 't48', parentLane), true);
  assert.equal(conn.boardTouchesTerminal(conn.boardTarget(), 't6d', parentLane), true);
  assert.equal(conn.boardTouchesTerminal(conn.boardTarget(), 't99', { t: 't99', agents: [] }), false);
  assert.equal(conn.boardTouchesTerminal(conn.boardTarget(), 't99', null), false);
  assert.equal(conn.boardTouchesTerminal(null, 't99', null), true);

  // Foreground resume while link is ready bumps boardSeq with unscoped null target in one batch.
  await new Promise((r) => setTimeout(r, 320));
  nsh.lifecycle.set('background');
  nsh.lifecycle.set('active');
  assert.equal(conn.boardSeq(), 2);
  assert.equal(conn.boardTarget(), null);
  assert.deepEqual(seen, ['0:*', '1:t48', '2:*']);

  // board.get is in TRACKED_RPC and logs compact rpc.board.get telemetry.
  let cursor = 1;
  const drain = () => {
    const out = [];
    for (; cursor < ws.sent.length; cursor++) {
      try { out.push(desk.cipher.open(ws.sent[cursor])); } catch {}
    }
    return out;
  };
  drain();
  const getP = conn.rpc('board.get', { address: 't48' });
  const req = drain().find((f) => f.m === 'board.get');
  assert.ok(req, 'board.get RPC sent');
  ws.onmessage({ data: desk.cipher.seal({ id: req.id, ok: true, r: { lane: { t: 't48', stats: { totalSubs: 3 } }, at: 123 } }) });
  const got = await getP;
  assert.equal(got.lane.t, 't48');
  const rpcLog = drain().find((f) => f.m === 'client.log' && f.p?.event === 'rpc.board.get');
  assert.ok(rpcLog, 'expected client.log notification for rpc.board.get');
  assert.equal(rpcLog.p.detail.address, 't48');
  assert.equal(rpcLog.p.detail.subs, 3);
});
