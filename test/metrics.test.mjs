import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clean, createMetricsStore, quantile, summarize } from '../host/metrics.js';
import { renderReport } from '../host/metrics-report.js';

const T = new Date(2026, 10, 4, 12).getTime();
const ctx = { src: 'phone', ver: 'abc·1', os: '18.6', browser: 'safari', standalone: true, w: 390, h: 844 };

test('clean keeps listed fields and drops the rest', () => {
  const e = clean({ t: T, ev: 'echo', via: 'direct', net: 31.6, paint: 48.2, text: 'secret' }, { ...ctx, extra: 'x' });
  assert.deepEqual(e, { t: T, ev: 'echo', via: 'direct', ...ctx, net: 32, paint: 48 });
});

test('clean refuses unknown events, wrong types and long strings', () => {
  assert.equal(clean({ t: T, ev: 'keylog', data: 'ls' }), null);
  assert.equal(clean({ t: T, ev: 'echo', net: '31', paint: 40 }), null);
  assert.equal(clean({ t: T, ev: 'echo', net: 31 }), null); // paint missing
  assert.equal(clean({ t: T, ev: 'op', op: 'x'.repeat(41) }), null);
  assert.equal(clean({ t: 'now', ev: 'link', status: 'ready' }), null);
  assert.equal(clean({ t: T, ev: 'echo', net: Infinity, paint: 1 }), null);
});

test('clean allows null where nothing came, and an unknown path becomes empty', () => {
  assert.deepEqual(clean({ t: T, ev: 'resume', via: 'carrier-pigeon', away: 9000, ready: null, paint: null }),
    { t: T, ev: 'resume', via: '', away: 9000, ready: null, paint: null });
});

test('put writes one line per kept event, per day, with the device id cut short', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
  const store = createMetricsStore({ dir, now: () => T });
  const r = await store.put({ id: 'abcdef0123456789' }, { ctx, events: [
    { t: T, ev: 'echo', via: 'relay', net: 80, paint: 95 },
    { t: T - 86_400_000, ev: 'open', via: 'relay', ms: 400, again: false },
    { t: T, ev: 'bogus' },
  ] });
  assert.equal(r.kept, 2);
  assert.deepEqual((await readdir(join(dir, 'metrics'))).sort(), ['2026-11-03.jsonl', '2026-11-04.jsonl']);
  const line = JSON.parse(await readFile(join(dir, 'metrics', '2026-11-04.jsonl'), 'utf8'));
  assert.equal(line.dev, 'abcdef01');
  assert.equal((await store.read(7)).length, 2);
  assert.equal((await store.read(1)).length, 1);
});

test('put refuses a batch that is too big, and old days are removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
  await mkdir(join(dir, 'metrics'));
  await writeFile(join(dir, 'metrics', '2026-09-01.jsonl'), '{}\n');
  await writeFile(join(dir, 'metrics', 'report.html'), 'keep');
  const store = createMetricsStore({ dir, now: () => T });
  await assert.rejects(store.put({ id: 'x' }, { ctx, events: Array(501).fill({ t: T, ev: 'link', status: 'ready' }) }));
  await store.put({ id: 'x' }, { ctx, events: [{ t: T, ev: 'link', status: 'ready' }] });
  assert.deepEqual((await readdir(join(dir, 'metrics'))).sort(), ['2026-11-04.jsonl', 'report.html']);
});

test('rtt may carry the direct path as WebRTC sees it', () => {
  assert.deepEqual(clean({ t: T, ev: 'rtt', via: 'direct', ms: 40.4, n: 3, ice: 11.6, pair: 'host/host' }), { t: T, ev: 'rtt', via: 'direct', ms: 40, n: 3, ice: 12, pair: 'host/host' });
  assert.deepEqual(clean({ t: T, ev: 'rtt', via: 'relay', ms: 90, n: 1 }), { t: T, ev: 'rtt', via: 'relay', ms: 90, n: 1 });
  assert.equal(summarize([clean({ t: T, ev: 'rtt', via: 'direct', ms: 40, n: 3, ice: 12, pair: 'host/host' }, ctx)]).groups.phone.measures['rtt.ice'].all.direct.p50, 12);
});

test('quantile is nearest rank', () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(quantile(v, 0.5), 50);
  assert.equal(quantile(v, 0.95), 100);
  assert.equal(quantile([7], 0.95), 7);
  assert.equal(quantile([], 0.5), null);
});

test('summarize splits by source and path, per day', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(clean({ t: T + i, ev: 'echo', via: i % 2 ? 'direct' : 'relay', net: 10 + i, paint: 20 + i }, ctx));
  rows.push(clean({ t: T - 86_400_000, ev: 'echo', via: 'direct', net: 5, paint: 6 }, ctx));
  rows.push(clean({ t: T, ev: 'echo', via: 'relay', net: 300, paint: 320 }, { ...ctx, src: 'sim:relay+150' }));
  rows.push(clean({ t: T, ev: 'op', via: 'direct', op: 'key', key: 'Esc' }, ctx));
  rows.push(clean({ t: T, ev: 'link', via: 'relay', status: 'offline' }, ctx));
  const s = summarize(rows);
  assert.deepEqual(Object.keys(s.groups).sort(), ['phone', 'sim:relay+150']);
  const g = s.groups.phone;
  assert.deepEqual(g.days, ['2026-11-03', '2026-11-04']);
  assert.equal(g.measures['echo.paint'].all.direct.n, 11);
  assert.equal(g.measures['echo.paint'].all.relay.p50, 28); // relay paints 20,22,…,38
  assert.equal(g.measures['echo.paint'].daily.direct[0].p50, 6);
  assert.deepEqual(g.keys, { 'key:Esc': 1 });
  assert.equal(g.drops[1].n, 1);
  assert.equal(s.groups['sim:relay+150'].measures['echo.net'].all.relay.p50, 300);
});

test('the report page carries the data and cannot be broken out of', () => {
  const rows = [clean({ t: T, ev: 'op', via: 'direct', op: 'key', key: '</script><b>' }, ctx)];
  const html = renderReport(summarize(rows));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal(html.match(/<\/script>/g).length, 1);
  assert.ok(html.includes('\\u003c/script>'));
});
