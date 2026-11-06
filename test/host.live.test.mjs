// Full path: real host service + real relay + simulated phone + a scratch herdr-core.
//   node --test test/host.live.test.mjs                                 (starts its own relay: test/local-relay.mjs)
//   RELAY=http://127.0.0.1:8799 node --test test/host.live.test.mjs   (or uses yours: npm run relay:dev)
// The scratch core (HC_SESSION=relay-live) is separate from Herdr.app's and is stopped at the end.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCore } from '../host/hc.js';
import { controlCall, startService } from '../host/service.js';
import { decodePairLink, newBoxKeys, phoneHandshake, unb64 } from '../shared/e2e.js';
import { startLocalRelay } from './local-relay.mjs';

const ownRelay = process.env.RELAY ? null : await startLocalRelay();
after(() => ownRelay?.stop());
const RELAY = process.env.RELAY ?? ownRelay.url;
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
  // The voice key lives in memory here: a test never writes the user's keychain.
  const keys = { value: null, read: async () => keys.value, save: async (k) => { keys.value = k; }, remove: async () => { keys.value = null; } };
  const svc = await startService({ relayUrl: RELAY, dataDir, coreOptions: { session: SESSION }, log: () => {}, voiceKeys: keys });
  t.after(() => svc.stop());
  await until('relay online + core online', async () => { const v = await controlCall(dataDir, 'status'); return v.relay === 'online' && v.core === 'online'; }, 20_000);

  // --- the voice key from Herdr.app's「手机」window (ctl voice.set / voice.off), not only the command line
  assert.equal((await controlCall(dataDir, 'status')).voice, null, 'no key yet');
  assert.equal((await controlCall(dataDir, 'voice.set', { key: ' abcdefgh1234 ' })).voice, '…1234', 'the window shows the last 4');
  assert.equal(keys.value, 'abcdefgh1234', 'saved, trimmed');
  await assert.rejects(controlCall(dataDir, 'voice.set', { key: 'abc def' }), /空格/, 'a key with a space is refused');
  await assert.rejects(controlCall(dataDir, 'voice.set', { key: '  ' }), /Key/, 'an empty key is refused');
  assert.equal((await controlCall(dataDir, 'voice.off')).voice, null, 'off');
  assert.equal(keys.value, null);

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
  let freshPaints = 0, phoneBytes = 0;
  const pump = () => {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.ev === 'out' && e.s === s) { const b = Buffer.from(e.d, 'base64'); phoneOut += b.toString(); unacked += b.length; phoneBytes += b.length; if (e.fresh) freshPaints++; events.splice(i--, 1); }
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

  // --- a program that reprints its whole history (DESIGN.md「重印整段对话」): a short one (`clear`)
  // reaches the phone as it is; a long one does not: a fresh paint of its end comes in its place.
  await until('bulk output done', () => { pump(); return /\nBULK_DONE\r?\n/.test(strip(phoneOut)); }, 30_000);
  notify('term.input', { s, d: 'clear; echo SMALL_$((3+4))\r' });
  await until('small reprint as it is', () => { pump(); return strip(phoneOut).includes('SMALL_7'); });
  assert.equal(freshPaints, 0, 'a short reprint needs no fresh paint');
  phoneOut = ''; phoneBytes = 0;
  notify('term.input', { s, d: "printf '\\033[H\\033[2J\\033[3J'; seq -f 'line %05g' 0 19999; echo REPRINT_$((5+6))\r" });
  await until('fresh paint after a long reprint', () => { pump(); return freshPaints === 1 && strip(phoneOut).includes('REPRINT_11'); }, 15_000);
  const seen = strip(phoneOut);
  assert.ok(seen.includes('line 19999'), 'the end of the reprint is there');
  assert.ok(!seen.includes('line 00000'), 'its start is not sent');
  assert.ok(phoneBytes < 120 * 1024, `sent ${phoneBytes} bytes, not the 260 KB reprint`);
  await sleep(300); pump();
  assert.equal(freshPaints, 1);
  // …and it is in the experience records (DESIGN.md「体验记录」), with its size.
  const recs = await until('reprint record', async () => {
    const day = (await import('node:fs/promises')).readdir(join(dataDir, 'metrics')).catch(() => []);
    const rows = [];
    for (const f of await day) if (f.endsWith('.jsonl')) rows.push(...(await readFile(join(dataDir, 'metrics', f), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const r = rows.filter((x) => x.ev === 'reprint');
    return r.length ? r : null;
  });
  assert.equal(recs.length, 1, 'the short `clear` is not recorded');
  assert.equal(recs[0].fresh, true);
  assert.ok(recs[0].kb > 64 && recs[0].src === 'mac', JSON.stringify(recs[0]));

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

  // --- an upload whose pieces went on this connection, used on the next (relay ↔ direct, a reconnect)
  const carried = await rpc('upload.put', { id: null, offset: 0, total: png.length, mime: 'image/png', data: png.toString('base64') });

  // --- close
  await rpc('term.close', { s });
  await until('closed event', () => events.some((e) => e.ev === 'closed' && e.s === s));

  // --- resume on a new connection with the same device key: `ready` comes with the welcome (one
  // round trip earlier), but the phone is online only once its sealed `auth` proves the key.
  ws.close();
  const onlineNow = async () => (await controlCall(dataDir, 'status')).devices.some((d) => d.online);
  await until('first connection gone', async () => !(await onlineNow()));
  const ws2 = await phoneSocket(`${RELAY.replace(/^http/, 'ws')}/v1/client/${offer.i}`);
  t.after(() => ws2.close());
  assert.equal(await next(ws2), '\u0000online');
  const hs2 = phoneHandshake(P, unb64(offer.k));
  ws2.send(hs2.hello);
  const c2 = hs2.finish(await next(ws2)).cipher;
  const ready2 = c2.open(await next(ws2));
  assert.equal(ready2.type, 'ready');
  assert.equal(ready2.paired, false);
  await sleep(300);
  assert.equal(await onlineNow(), false, 'not online before auth');
  ws2.send(c2.seal({ type: 'auth', mode: 'resume' }));
  await until('online after auth', onlineNow);
  ws2.send(c2.seal({ id: 99, m: 'terminals.list', p: {} }));
  assert.equal(c2.open(await next(ws2)).id, 99);
  ws2.send(c2.seal({ id: 100, m: 'image.put', p: { id: carried.id, address, name: 'carried.png' } }));
  let moved;
  do moved = c2.open(await next(ws2)); while (moved.id !== 100);
  assert.ok(moved.ok, `the upload survives the new connection: ${moved.e}`);
  assert.deepEqual(await readFile(moved.r.path), png);

  // --- a program asks: its screen is kept on the Mac (host/ask-samples.js), to teach the phone its menus
  const b64s = (x) => Buffer.from(x).toString('base64');
  await mac.call('terminal.run', { argv: ['/bin/sh', '-c', `printf '\\033]7501;state=blocked:kind=question:app=epi:msg=${b64s('Pick one')}\\033\\\\'; printf ' → Yes\\n   No\\n\\n ↑↓ navigate  enter select\\n'; sleep 30`], cwd: '/tmp', labels: { where: 'test · ask' }, rm: true });
  const kept = await until('the question is kept', async () => { const k = (await readdir(join(dataDir, 'asks')).catch(() => [])).filter((n) => n.endsWith('.json')); return k.length && k; });
  assert.equal(kept.length, 1);
  assert.match(kept[0], /-epi-question\.json$/);
  const meta = JSON.parse(await readFile(join(dataDir, 'asks', kept[0]), 'utf8'));
  assert.equal(meta.msg, 'Pick one');
  assert.match((await readFile(join(dataDir, 'asks', kept[0].replace('.json', '.bin')))).toString(), /→ Yes/);
});
