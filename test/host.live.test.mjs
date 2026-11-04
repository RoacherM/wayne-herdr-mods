// Full path: real host service + real relay + simulated phone + a scratch herdr-core.
//   RELAY=http://127.0.0.1:8799 node --test test/host.live.test.mjs   (npm run relay:dev first)
// The scratch core (HC_SESSION=relay-live) is separate from Herdr.app's and is stopped at the end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCore } from '../host/hc.js';
import { controlCall, startService } from '../host/service.js';
import { decodePairLink, newBoxKeys, phoneHandshake, unb64 } from '../shared/e2e.js';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8799';
const SESSION = 'relay-live';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?!>=]*[ -/]*[@-~]/g, '').replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b./g, '');

function phoneSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); ws.q = []; ws.w = [];
    ws.onmessage = (m) => (ws.w.length ? ws.w.shift()(m.data) : ws.q.push(m.data));
    ws.onopen = () => resolve(ws); ws.onerror = () => reject(new Error('ws error'));
  });
}
const next = (ws, ms = 15000) => ws.q.length ? Promise.resolve(ws.q.shift()) : new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms); ws.w.push((d) => { clearTimeout(t); res(d); });
});
async function until(what, fn, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(80); }
}

test('pair, list, stream, type, send, keys — through the relay', { timeout: 120_000 }, async (t) => {
  const mac = await openCore({ session: SESSION }); // stands in for Herdr.app
  t.after(async () => { await mac.call('server.stop').catch(() => {}); mac.close(); });
  const run = await mac.call('terminal.run', { argv: ['/bin/sh'], cwd: '/tmp', labels: { where: 'test · sh' }, rm: true });
  const address = run.address;
  const macView = await mac.call('terminal.attach', { terminal: address, cols: 120, rows: 40 });
  let macOut = '';
  mac.on(macView.channel, { onData: (b) => { macOut += b.toString(); mac.send(macView.channel, 1, Buffer.from(Uint32Array.of(b.length).buffer)); } });

  const dataDir = await mkdtemp(join(tmpdir(), 'herdr-relay-'));
  const svc = await startService({ relayUrl: RELAY, dataDir, coreOptions: { session: SESSION }, log: () => {} });
  t.after(() => svc.stop());
  await until('relay online + core online', async () => { const v = await controlCall(dataDir, 'status'); return v.relay === 'online' && v.core === 'online'; }, 20_000);

  // --- pairing
  const offer = decodePairLink((await controlCall(dataDir, 'pair.start')).pairing.offer.link);
  const P = newBoxKeys();
  const ws = await phoneSocket(`${RELAY.replace(/^http/, 'ws')}/v1/client/${offer.i}`);
  t.after(() => ws.close());
  assert.equal(await next(ws), '\u0000online');
  const hs = phoneHandshake(P, unb64(offer.k));
  ws.send(hs.hello);
  const { cipher, sas } = hs.finish(await next(ws));
  const rx = async () => cipher.open(await next(ws));
  ws.send(cipher.seal({ type: 'auth', mode: 'pair', token: offer.t, name: '测试 iPhone' }));
  assert.equal((await rx()).sas, sas);
  const req = await until('pair request', async () => (await controlCall(dataDir, 'status')).pairing.request);
  assert.equal(req.sas, sas);
  await controlCall(dataDir, 'pair.decide', { allow: true });
  const ready = await rx();
  assert.equal(ready.type, 'ready');
  assert.equal(ready.paired, true);

  // --- RPC plumbing
  let id = 0;
  const events = [];
  const waiting = new Map();
  (async () => { for (;;) { let msg; try { msg = await rx(); } catch { return; } if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else events.push(msg); } })();
  const rpc = (m, p) => new Promise((resolve, reject) => {
    const rid = ++id;
    waiting.set(rid, (msg) => (msg.ok ? resolve(msg.r) : reject(new Error(msg.e))));
    ws.send(cipher.seal({ id: rid, m, p }));
  });
  const notify = (m, p) => ws.send(cipher.seal({ m, p }));
  let phoneOut = '';
  let unacked = 0;
  let s;
  const pump = () => {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.ev === 'out' && e.s === s) { const b = Buffer.from(e.d, 'base64'); phoneOut += b.toString(); unacked += b.length; events.splice(i--, 1); }
    }
    if (unacked) { notify('term.ack', { s, n: unacked }); unacked = 0; }
  };

  // --- list
  const list = await rpc('terminals.list');
  assert.equal(list.core, 'online');
  const row = list.terminals.find((x) => x.address === address);
  assert.ok(row, 'scratch terminal listed');
  assert.equal(row.where, 'test · sh');
  assert.equal(row.cols, 120);

  // --- open at the Mac's size, see the first paint
  const opened = await rpc('term.open', { address });
  s = opened.s;
  assert.deepEqual([opened.cols, opened.rows], [120, 40]);
  await until('first paint', () => { pump(); return phoneOut.length > 0; });

  // --- Mac types: the phone sees it
  mac.send(macView.channel, 0, Buffer.from('echo FROM_MAC_$((1+1))\r'));
  await until('phone sees mac output', () => { pump(); return strip(phoneOut).includes('FROM_MAC_2'); });

  // --- phone types through the stream: the Mac sees it, and the size stays 120x40
  notify('term.input', { s, d: 'echo FROM_PHONE_$((2+3))\r' });
  await until('mac sees phone output', () => strip(macOut).includes('FROM_PHONE_5'));
  const g1 = await mac.call('terminal.get', { terminal: address });
  assert.deepEqual([g1.cols, g1.rows], [120, 40], 'phone typing must not change the size');

  // --- a lot of output: credit keeps flowing (more than the 256 KiB initial window)
  notify('term.input', { s, d: 'yes 0123456789abcdef0123456789abcdef | head -n 20000; echo BULK_DONE\r' });
  await until('bulk output arrives', () => { pump(); return strip(phoneOut).includes('BULK_DONE'); }, 30_000);

  // --- message box path (terminal.send) and keys
  await rpc('term.send', { address, text: 'echo VIA_SEND' });
  await until('send path', () => { pump(); return strip(phoneOut).includes('VIA_SEND'); }, 15_000);
  await rpc('term.keys', { address, keys: ['ctrl+c'] });
  await assert.rejects(rpc('term.keys', { address, keys: ['rm -rf'] }), /无效的按键/);

  // --- image: chunked upload → terminal.put → a real file beside the terminal
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let up = await rpc('upload.put', { id: null, offset: 0, total: png.length, mime: 'image/png', data: png.subarray(0, 40).toString('base64') });
  up = await rpc('upload.put', { id: up.id, offset: 40, total: png.length, data: png.subarray(40).toString('base64') });
  const put = await rpc('image.put', { id: up.id, address, name: '截图 1.png' });
  assert.match(put.path, /\.png$/);
  assert.deepEqual(await readFile(put.path), png);
  await assert.rejects(rpc('image.put', { id: up.id, address, name: 'again.png' }), /过期/);
  // The phone puts the path into the program's line itself (live-line.js); here it is a shell word.
  notify('term.input', { s, d: `echo "${put.path}" IMG_IN_SHELL\r` });
  await until('path typed in a shell', () => { pump(); return strip(phoneOut).includes(`${put.path} IMG_IN_SHELL`); }, 15_000);

  // --- new tab: a login shell in the space, labelled for Herdr.app, opened right away
  const doc = await mac.call('doc.get', { name: 'herdr-app' });
  await mac.call('doc.set', { name: 'herdr-app', version: doc.version, value: { spaces: [{ id: 'sp-test', name: 'test', folder: '/tmp', tabs: [{ id: 'tb-test', name: '', root: { content: { terminal: address } } }] }] } });
  await until('layout seen', async () => (await rpc('terminals.list')).layout.some((sp) => sp.id === 'sp-test'));
  const made = await rpc('term.new', { space: 'sp-test' });
  const rec = await mac.call('terminal.get', { terminal: made.address });
  assert.equal(rec.labels['herdr.space'], 'sp-test');
  assert.equal(rec.argv.at(-1), '-l');
  assert.equal(rec.keep, true);
  const o2 = await rpc('term.open', { address: made.address });
  await rpc('term.close', { s: o2.s });
  await mac.call('terminal.kill', { terminal: made.address }).catch(() => {});
  await assert.rejects(rpc('term.new', { space: 'nope' }), /没有这个工作区/);

  // --- methods outside the whitelist never reach herdr-core
  await assert.rejects(rpc('machine.exec', { argv: ['id'] }), /未知方法/);

  // --- the phone's own grid (DESIGN.md「手机布局」): opened with `fit`, the terminal takes it; the
  // phone away (`term.fit` with none), the Mac window leads again; typed on the phone, the phone's.
  const sizeNow = async () => { const g = await mac.call('terminal.get', { terminal: address }); return `${g.cols}x${g.rows}`; };
  const sizeIs = (want) => until(`size ${want}`, async () => (await sizeNow()) === want, 3000);
  const fitted = await rpc('term.open', { address, fit: { cols: 44, rows: 20 } });
  await sizeIs('44x20');
  notify('term.fit', { s: fitted.s, fit: null });
  await sizeIs('120x40');
  notify('term.fit', { s: fitted.s, fit: { cols: 44, rows: 20 } }); // back on the page
  await sizeIs('44x20');
  mac.send(macView.channel, 0, Buffer.from(' \x7f')); // DATA: the Mac types: the Mac leads
  await sizeIs('120x40');
  notify('term.input', { s: fitted.s, d: ' \x7f' }); // the phone types: the phone leads
  await sizeIs('44x20');
  notify('term.fit', { s: fitted.s, fit: { cols: 50, rows: 22 } }); // the phone turned
  await sizeIs('50x22');
  notify('term.fit', { s: fitted.s, fit: { cols: 5000, rows: 22 } }); // nonsense: the phone gives way
  await sizeIs('120x40');
  await rpc('term.close', { s: fitted.s });
  assert.equal(await sizeNow(), '120x40');
  await assert.rejects(rpc('term.fit', { s, fit: { cols: 44, rows: 20 } }), /未知方法/); // a notification only

  // --- close
  await rpc('term.close', { s });
  await until('closed event', () => events.some((e) => e.ev === 'closed' && e.s === s));

  // --- resume on a new connection with the same device key
  const ws2 = await phoneSocket(`${RELAY.replace(/^http/, 'ws')}/v1/client/${offer.i}`);
  t.after(() => ws2.close());
  assert.equal(await next(ws2), '\u0000online');
  const hs2 = phoneHandshake(P, unb64(offer.k));
  ws2.send(hs2.hello);
  const c2 = hs2.finish(await next(ws2)).cipher;
  ws2.send(c2.seal({ type: 'auth', mode: 'resume' }));
  const ready2 = c2.open(await next(ws2));
  assert.equal(ready2.type, 'ready');
  assert.equal(ready2.paired, false);
});
