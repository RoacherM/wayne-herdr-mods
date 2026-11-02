// Probe: how several viewers of one herdr-core terminal stay in sync.
//
// Part A runs on an isolated scratch core (HC_SESSION=relay-probe): it starts its own terminal,
// attaches viewers that stand in for "a Mac window" and "a phone", and checks the rules the
// design relies on. Nothing in it touches the user's terminals.
// Part B is read-only against the user's default core: list, layout doc, event snapshot.
//
//   node probe/sync.mjs            # both parts
//   node probe/sync.mjs --scratch  # part A only
import assert from 'node:assert/strict';
import { CLOSE, Core, DATA, FOCUS, RESIZE, size, sleep, strip } from './hc.mjs';

const SCRATCH = 'relay-probe';
const results = [];
const check = async (name, fn) => {
  try { const note = await fn(); results.push({ name, ok: true, note }); }
  catch (error) { results.push({ name, ok: false, note: error.message }); }
};

/** One attached viewer: collects output, tracks the size the core reports. */
async function viewer(core, terminal, { cols, rows, observe = false, label }) {
  const v = { label, out: '', closed: null, resized: [] };
  const r = await core.call('terminal.attach', { terminal, cols, rows, observe });
  v.channel = r.channel;
  core.on(r.channel, {
    onData: (b) => { v.out += b.toString('utf8'); },
    onResize: (c, rr) => v.resized.push([c, rr]),
    onClose: (reason) => { v.closed = reason ?? {}; },
  });
  v.type = (text) => core.send(v.channel, DATA, text);
  v.resize = (c, rr) => core.send(v.channel, RESIZE, size(c, rr));
  v.focus = () => core.send(v.channel, FOCUS, Buffer.from([1]));
  v.detach = () => core.send(v.channel, CLOSE);
  v.text = () => strip(v.out);
  return v;
}

const until = async (what, pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
};

async function scratch() {
  const a = await Core.open(SCRATCH); // stands in for the Herdr.app window process
  const b = await Core.open(SCRATCH); // stands in for the relay serving a phone
  const events = [];
  const sub = await b.call('events.subscribe', {});
  b.on(sub.channel, { onData: (buf) => { for (const line of buf.toString().split('\n').filter(Boolean)) events.push(JSON.parse(line)); } });

  const run = await a.call('terminal.run', { argv: ['/bin/sh'], cwd: '/tmp', labels: { probe: 'relay' }, rm: true });
  const t = run.address;
  const get = () => a.call('terminal.get', { terminal: t });

  const mac = await viewer(a, t, { cols: 120, rows: 40, label: 'mac' });
  const mac2 = await viewer(a, t, { cols: 100, rows: 30, label: 'mac-window-2' });
  const phone = await viewer(b, t, { cols: 44, rows: 20, observe: true, label: 'phone' });

  await check('each viewer gets a first paint of the current screen', async () => {
    await until('three first paints', () => mac.out && mac2.out && phone.out);
    return `paint bytes mac=${mac.out.length} mac2=${mac2.out.length} phone=${phone.out.length}`;
  });

  await check('latest-attached non-observer sets the size; observer does not', async () => {
    await until('size 100x30', async () => { const g = await get(); return g.cols === 100 && g.rows === 30; });
    return '100x30 (mac-window-2 attached last; the 44x20 observer was ignored)';
  });

  await check('output typed by one viewer reaches every viewer', async () => {
    mac.type('echo PROBE_$((40+2))\r');
    await until('PROBE_42 on all three', () => [mac, mac2, phone].every((v) => v.text().includes('PROBE_42')));
    return 'mac, mac2 and phone all saw PROBE_42';
  });

  await check('an observer cannot type', async () => {
    phone.type('echo OBSERVER_TYPED\r');
    await sleep(800);
    assert.ok(!mac.text().includes('OBSERVER_TYPED'), 'observer input reached the program');
    return 'input from observe:true was dropped';
  });

  // The phone takes over: it re-attaches as an active viewer.
  phone.detach();
  await sleep(200);
  const phoneLive = await viewer(b, t, { cols: 44, rows: 20, label: 'phone-active' });

  await check('an active phone viewer becomes the size leader', async () => {
    await until('size 44x20', async () => { const g = await get(); return g.cols === 44 && g.rows === 20; });
    return 'terminal resized to the phone (44x20): every Mac window now shows a 44-column program';
  });

  await check('typing on the phone reaches the Mac windows', async () => {
    phoneLive.type('echo FROM_PHONE\r');
    await until('FROM_PHONE on mac', () => mac.text().includes('FROM_PHONE') && mac2.text().includes('FROM_PHONE'));
    return 'mac and mac2 saw FROM_PHONE';
  });

  await check('focus on a Mac window takes the size back', async () => {
    mac.focus();
    await until('size 120x40', async () => { const g = await get(); return g.cols === 120 && g.rows === 40; });
    return 'FOCUS from mac → 120x40';
  });

  await check('the phone detaching leaves the Mac size alone', async () => {
    phoneLive.detach();
    await sleep(300);
    const g = await get();
    assert.deepEqual([g.cols, g.rows], [120, 40]);
    return '120x40 kept';
  });

  await check('terminal.send pastes and submits like a person', async () => {
    const r = await b.call('terminal.send', { terminal: t, text: 'echo VIA_SEND', timeout: 10 });
    await until('VIA_SEND on mac', () => mac.text().includes('VIA_SEND'), 15000);
    return `send result ${JSON.stringify(r)}`;
  });

  await check('terminal.keys presses named keys', async () => {
    await b.call('terminal.keys', { terminal: t, keys: ['ctrl+c'] });
    return 'ctrl+c accepted';
  });

  await check('events stream reports size and labels changes to every subscriber', async () => {
    await a.call('terminal.label', { terminal: t, labels: { seen: 'yes' } });
    await until('labels event', () => events.some((e) => e.params?.type === 'labels' && e.params?.terminal === t));
    const types = [...new Set(events.map((e) => e.params?.type ?? e.method))];
    return `event types seen: ${types.join(', ')}`;
  });

  // The design's default: the phone stays an observer and types through RPC, not the stream.
  const watcher = await viewer(b, t, { cols: 44, rows: 20, observe: true, label: 'phone-observer' });

  await check('observer typing via terminal.keys reaches the program and keeps the Mac size', async () => {
    const before = await get();
    const t1 = Date.now();
    for (const k of ['e', 'c', 'h', 'o', 'space', 'k', 'e', 'y', 's', 'enter']) await b.call('terminal.keys', { terminal: t, keys: [k] });
    const perKey = (Date.now() - t1) / 10;
    await until('keys on mac', () => mac.text().includes('\nkeys'));
    const after = await get();
    assert.deepEqual([after.cols, after.rows], [before.cols, before.rows], 'size changed');
    return `${before.cols}x${before.rows} unchanged; ${perKey.toFixed(0)} ms per terminal.keys call`;
  });

  await check('terminal.keys: a bare capital is lowercased, shift+x is a capital', async () => {
    await b.call('terminal.keys', { terminal: t, keys: ['echo'.split(''), 'space', 'A', 'shift+b', 'enter'].flat() });
    await until('aB on mac', () => /\naB\r?\n/.test(mac.text()));
    return '"A" arrived as a, "shift+b" as B: text with capitals must not go through keys';
  });

  await check('a phone attached active at the current size types without resizing', async () => {
    const g0 = await get();
    const p = await viewer(b, t, { cols: g0.cols, rows: g0.rows, label: 'phone-matched' });
    p.type('echo Matched_Size\r');
    await until('Matched_Size on mac', () => mac.text().includes('Matched_Size'));
    const g1 = await get();
    assert.deepEqual([g1.cols, g1.rows], [g0.cols, g0.rows]);
    mac.resize(130, 42); // a person drags the Mac window meanwhile
    await until('130x42', async () => (await get()).cols === 130);
    p.resize(130, 42); // the phone follows the size event instead of fighting it
    p.type('echo Still_Fine\r');
    await until('Still_Fine on mac', () => mac.text().includes('Still_Fine'));
    const g2 = await get();
    assert.deepEqual([g2.cols, g2.rows], [130, 42]);
    p.detach();
    return `${g0.cols}x${g0.rows} kept while typing; after the Mac resize the phone followed to 130x42`;
  });

  await check('observer stream also carries what the Mac windows type', async () => {
    mac.type('echo MAC_TYPED\r');
    await until('MAC_TYPED on observer', () => watcher.text().includes('MAC_TYPED'));
    return 'phone-observer saw MAC_TYPED';
  });
  watcher.detach();

  await check('an active phone leaving hands the size back without a Mac focus', async () => {
    const p = await viewer(b, t, { cols: 50, rows: 18, label: 'phone-active-2' });
    await until('size 50x18', async () => { const g = await get(); return g.cols === 50; });
    p.detach();
    await until('size back to a Mac viewer', async () => { const g = await get(); return g.cols !== 50; }, 3000);
    const g = await get();
    return `back to ${g.cols}x${g.rows} once the phone detached`;
  });

  await check('a shared doc is versioned: a stale writer is refused', async () => {
    const d0 = await a.call('doc.get', { name: 'probe-layout' });
    await a.call('doc.set', { name: 'probe-layout', value: { by: 'mac' }, version: d0.version });
    let refused = false;
    try { await b.call('doc.set', { name: 'probe-layout', value: { by: 'phone' }, version: d0.version }); }
    catch (error) { refused = error.data?.kind ?? true; }
    assert.ok(refused, 'stale write was accepted');
    await until('doc event', () => events.some((e) => e.params?.type === 'doc'));
    return `stale write refused (${refused}); subscribers got a doc event`;
  });

  await check('program exit closes every attached stream with a reason', async () => {
    mac.type('exit\r');
    await until('mac closed', () => mac.closed && mac2.closed);
    return `close reason ${JSON.stringify(mac.closed)}`;
  });

  await a.call('server.stop').catch(() => {}); // our own scratch core only
  a.close(); b.close();
}

async function readOnly() {
  const core = await Core.open();
  await check('[default core] terminals and where they sit in Herdr.app', async () => {
    const { terminals } = await core.call('terminal.list', {});
    return terminals.map((t) => `${t.address} ${t.cols}x${t.rows} "${t.labels?.where ?? ''}" ${t.status?.app ?? t.foreground?.name ?? ''}${t.status?.state ? ':' + t.status.state : ''}`).join(' | ');
  });
  await check('[default core] Herdr.app layout doc is one shared document', async () => {
    const doc = await core.call('doc.get', { name: 'herdr-app' });
    const spaces = doc.value?.spaces ?? [];
    const tabs = spaces.reduce((n, s) => n + (s.tabs?.length ?? 0), 0);
    return `herdr-app v${doc.version}: ${spaces.length} spaces, ${tabs} tabs (no per-window field)`;
  });
  await check('[default core] events.subscribe gives a snapshot with a seq', async () => {
    const sub = await core.call('events.subscribe', {});
    return `seq=${sub.seq}, ${sub.terminals.length} terminals in the snapshot`;
  });
  core.close();
}

const onlyScratch = process.argv.includes('--scratch');
const t0 = Date.now();
await scratch().catch((error) => results.push({ name: 'scratch core', ok: false, note: error.stack }));
if (!onlyScratch) await readOnly().catch((error) => results.push({ name: 'default core', ok: false, note: error.stack }));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.note ?? ''}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed in ${Date.now() - t0} ms`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
