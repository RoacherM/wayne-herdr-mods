// ios/src/conn.ts outside the phone: bundled with esbuild against a tiny fake "nsh" (signals that
// track the reads of the running effect, as nsh's do) and a fake WebSocket, so its reactive
// wiring can be checked in Node. The fake runtime is reachable as globalThis.__nsh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { b64, newBoxKeys } from '../shared/e2e.js';

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
    entryPoints: [new URL('../ios/src/conn.ts', import.meta.url).pathname],
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
async function booted() {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.__nshSaved = JSON.stringify({
    relay: 'https://relay.test', desktopId: 'd1', desktopKey: b64(newBoxKeys().publicKey), deviceSecret: b64(newBoxKeys().secretKey),
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
