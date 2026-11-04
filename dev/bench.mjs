// The phone experience, measured the same way each time (DESIGN.md「体验记录」): a simulated iPhone
// does a fixed script against dev/fake-desktop.mjs, on each path, and the page's own metrics
// (app/src/metrics.js) are read back.
//   npm run build; npm run relay:dev      # in another shell
//   node dev/bench.mjs [--rounds 30] [--only direct,relay]
//
// Paths: direct (WebRTC), relay, and relay with 150 ms more round trip (a phone on a mobile network
// far from the relay; a WebSocket wrapper on the page holds every message 75 ms each way).
// Script per path: open a terminal again and again, type one key at a time into a quiet shell,
// tap key bar keys, drag the terminal, leave the page and come back.
//
// Prints p50/p95 per path, appends one line per path to bench/results.jsonl (with the commit), and
// writes bench/report.html. Exits 1 when a median got more than 20% (and 10 ms) slower than the
// last run of the same path.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { openCore } from '../host/hc.js';
import { clean, MEASURES, summarize } from '../host/metrics.js';
import { renderReport } from '../host/metrics-report.js';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i < 0 ? dflt : process.argv[i + 1]; };
const ROUNDS = Number(arg('--rounds', 20));
const SCROLL_ONLY = process.argv.includes('--scroll'); // only the full-screen scrolling part
const SCENARIOS = [
  { name: 'direct', direct: true, delay: 0 },
  { name: 'relay', direct: false, delay: 0 },
  { name: 'relay+150ms', direct: false, delay: 150 },
  // A phone on a slow, busy mobile network: 150 ms more round trip, and 1 Mbit/s towards the phone.
  { name: 'relay+150ms+1Mbps', direct: false, delay: 150, bw: 125 },
].filter((s) => !arg('--only') || arg('--only').split(',').includes(s.name));
const root = new URL('..', import.meta.url).pathname;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const commit = (() => {
  try {
    const at = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() ? `${at}+` : at;
  } catch { return ''; }
})();

// ---- the stand-in Mac. Its scratch core (session relay-ui, never Herdr.app's) starts empty: a
// run that died early leaves its terminals behind.
{ const old = await openCore({ session: 'relay-ui' }); await old.call('server.stop').catch(() => {}); old.close?.(); await pause(500); }
const dataDir = await mkdtemp(join(tmpdir(), 'herdr-bench-'));
const desk = spawn(process.execPath, [join(root, 'dev/fake-desktop.mjs')], { env: { ...process.env, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
let deskLog = '';
desk.stderr.on('data', (b) => { deskLog += b; });
const link = await new Promise((resolve, reject) => {
  let out = '';
  desk.stdout.on('data', (b) => { out += b; const m = /LINK (\S+)/.exec(out); if (m) resolve(m[1]); });
  desk.on('exit', (code) => reject(new Error(`fake-desktop exited ${code}\n${deskLog}`)));
  setTimeout(() => reject(new Error(`no pairing link in 30 s\n${deskLog}`)), 30_000);
});
// The full-screen program to scroll, on the stand-in Mac's core.
const core = await openCore({ session: 'relay-ui' });
mkdirSync('/tmp/bench-scroll', { recursive: true }); // the list shows where a terminal runs: this is how the script finds it
await core.call('terminal.run', { argv: ['python3', join(root, 'dev/scroll-app.py')], cwd: '/tmp/bench-scroll', rm: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const stop = async (code) => { await browser.close().catch(() => {}); core.close?.(); desk.kill('SIGTERM'); process.exit(code); };
process.on('SIGINT', () => stop(130));

const IPHONE = { viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' };

// ---- pair once; every path below reuses the same phone (same localStorage)
{
  const page = await browser.newPage();
  await page.emulate(IPHONE);
  await page.evaluateOnNewDocument(() => { globalThis.__herdrSim = 'pair'; }); // its records are not a real phone's
  await page.goto(link, { waitUntil: 'networkidle0' });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
  await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
  await page.close();
}
const home = new URL(link); home.hash = '';

async function run(sc) {
  const page = await browser.newPage();
  await page.emulate(IPHONE);
  page.on('pageerror', (e) => console.log(`[${sc.name}] pageerror`, e.message));
  if (process.env.BENCH_CONSOLE) page.on('console', (m) => console.log(`[${sc.name}]`, m.text()));
  await page.evaluateOnNewDocument((sc) => {
    globalThis.__herdrSim = sc.name;
    localStorage.setItem('herdr-relay.direct', sc.direct ? 'on' : 'off');
    document.addEventListener('visibilitychange', () => console.log('vis', document.visibilityState));
    if (!sc.delay) return;
    const half = sc.delay / 2;
    const WS = WebSocket;
    // Towards the phone, a link of `bw` bytes/ms: messages queue behind each other, as on a slow network.
    let free = 0;
    const arrive = (size) => {
      const t = performance.now();
      if (!sc.bw) return half;
      free = Math.max(free, t) + size / sc.bw;
      return free - t + half;
    };
    globalThis.WebSocket = class extends WS {
      send(d) { setTimeout(() => { try { super.send(d); } catch {} }, half); }
      get onmessage() { return this._om; }
      set onmessage(fn) { this._om = fn; super.onmessage = fn ? (m) => setTimeout(() => fn.call(this, m), arrive(m.data?.length ?? m.data?.byteLength ?? 0)) : null; }
    };
  }, sc);
  await page.goto(home.href, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
  const openShell = () => page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
  await openShell();
  await page.waitForSelector('.term-viewport:not([hidden])');
  // The path settles (direct comes up a moment after the relay).
  const want = sc.direct ? 'direct' : 'relay';
  await page.waitForFunction((want) => globalThis.__herdrLink?.via === want && globalThis.__herdrLink?.status === 'ready', { timeout: 20_000 }, want).catch(() => {});
  await pause(1500);
  const via = await page.evaluate(() => globalThis.__herdrLink?.via);
  if (via !== want) console.log(`[${sc.name}] the link is on ${via}, not ${want}`);

  if (!SCROLL_ONLY) await everyday(page, openShell, sc);
  await scrollProgram(page, sc);
  await page.evaluate(() => globalThis.__herdrMetrics.flush());
  await pause(500);
  const events = await page.evaluate(() => globalThis.__herdrMetrics.all());
  await page.close();
  return events.map((e) => clean(e, { src: `sim:${sc.name}`, ver: commit })).filter(Boolean);
}

/** The stand-in Mac's own records (macscroll) made between t0 and t1, as this path's. */
async function macRows(t0, t1, name) {
  const out = [];
  for (const f of (await readdir(join(dataDir, 'metrics')).catch(() => [])).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dataDir, 'metrics', f), 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (r.src === 'mac' && r.t >= t0 && r.t <= t1) out.push({ ...r, src: `sim:${name}` });
    }
  }
  return out;
}


// A full-screen program (dev/scroll-app.py, a stand-in for Claude Code's full-screen view): slow
// drags and flicks. What it measures: the phone's scroll lag, and the Mac's bytes on the way.
async function scrollProgram(page, sc) {
  await page.evaluate(() => document.querySelector('[aria-label="返回"]')?.click());
  await pause(400);
  const found = await page.evaluate(() => { const r = [...document.querySelectorAll('.trow')].find((x) => x.textContent.includes('bench-scroll')); r?.click(); return r ? '' : [...document.querySelectorAll('.trow')].map((x) => x.textContent).join(' | '); });
  if (found) throw new Error(`no bench-scroll terminal in the list: ${found}`);
  await page.waitForSelector('.term-viewport:not([hidden])');
  await page.waitForFunction(() => globalThis.__herdrTerm?.buffer.active.type === 'alternate', { timeout: 15_000 });
  await pause(1500);
  const cdp = await page.createCDPSession();
  const box = await page.evaluate(() => { const r = document.querySelector('.term-viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, top: r.y + 60, bottom: r.y + r.height - 60 }; });
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: box.x, y }] });
  const drag = async (from, to, moves, gap, rest) => {
    await touch('touchStart', from);
    for (let s = 1; s <= moves; s++) { await touch('touchMove', from + (to - from) * s / moves); await pause(gap); }
    if (rest) await pause(rest); // the finger rests before it lifts: no coast
    await touch('touchEnd');
  };
  for (let i = 0; i < Math.ceil(ROUNDS / 4); i++) {
    // A slow drag down (older lines), about 1 s, then a flick back up.
    await drag(box.top, box.bottom, 60, 16, 150);
    await pause(2500 + sc.delay * 4);
    await drag(box.bottom, box.top, 8, 16, 0);
    await pause(3500 + sc.delay * 4);
  }
}

// Open, type, key bar, drag the shell's history, leave and come back.
async function everyday(page, openShell, sc) {
  // 1. open the terminal again and again
  for (let i = 0; i < Math.ceil(ROUNDS / 4); i++) {
    await page.evaluate(() => document.querySelector('.term-back, [aria-label="返回"]')?.click());
    await page.waitForFunction(() => document.querySelector('.term-viewport')?.hidden !== false || !document.querySelector('.term-viewport'), { timeout: 5000 }).catch(() => {});
    await pause(300);
    await openShell();
    await page.waitForSelector('.term-viewport:not([hidden])');
    await pause(900);
  }

  // 2. type one key at a time into a quiet shell, then clear the line
  await page.focus('.term-keys');
  // The gap leaves the shell quiet before the next key (metrics.js QUIET_MS), on a slow path too.
  for (let i = 0; i < ROUNDS; i++) { await page.keyboard.type('x'); await pause(450 + sc.delay * 2); }
  await page.keyboard.down('Control'); await page.keyboard.press('u'); await page.keyboard.up('Control');
  await pause(500);
  await page.evaluate(() => document.activeElement?.blur());

  // 3. key bar: up and down walk the shell's history (each one prints)
  await page.focus('.term-keys');
  await page.keyboard.type('echo bench'); await page.keyboard.press('Enter'); await pause(600);
  for (let i = 0; i < Math.ceil(ROUNDS / 4); i++) {
    for (const label of ['↑', '↓']) {
      await page.evaluate((label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)?.click(), label);
      await pause(450);
    }
  }
  await page.evaluate(() => document.activeElement?.blur());

  // 4. drag the terminal up and down (fill it first so there is something to scroll)
  await page.focus('.term-keys');
  await page.keyboard.type('seq 1 400'); await page.keyboard.press('Enter'); await pause(1200);
  await page.evaluate(() => document.activeElement?.blur());
  const cdp = await page.createCDPSession();
  const box = await page.evaluate(() => { const r = document.querySelector('.term-viewport').getBoundingClientRect(); return { x: r.x + r.width / 2, top: r.y + 80, bottom: r.y + r.height - 80 }; });
  const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: box.x, y }] });
  for (let i = 0; i < Math.ceil(ROUNDS / 4); i++) {
    const [from, to] = i % 2 ? [box.bottom, box.top] : [box.top, box.bottom];
    await touch('touchStart', from);
    for (let s = 1; s <= 12; s++) { await touch('touchMove', from + (to - from) * s / 12); await pause(16); }
    await touch('touchEnd');
    await pause(1200);
  }

  // 5. leave the page and come back (short and long away)
  // Away: another tab comes to the front (the page really is hidden: no frames, slow timers), then
  // this one again. A long away is also what iOS does to a page in the background: on return the
  // link has heard nothing for a long time, so it reconnects (the same path as link.js wake()).
  const other = await browser.newPage();
  for (let i = 0; i < Math.ceil(ROUNDS / 4); i++) {
    const long = i % 2 === 1;
    await other.bringToFront();
    await pause(long ? 4000 : 800);
    if (long) await page.evaluate(() => { const l = globalThis.__herdrLink; for (const x of [l.relay, l.direct]) if (x) x.lastHeard = 0; });
    await page.bringToFront();
    await pause(6000); // more than the 5 s after which a return with nothing drawn is recorded as such
  }
  await other.close();

}

const rows = [];
const dump = process.argv.includes('--dump'); // every event to bench/events.json
for (const sc of SCENARIOS) {
  process.stdout.write(`${sc.name} … `);
  const t0 = Date.now();
  const mine = await run(sc);
  await pause(1200); // the Mac's last gesture record
  mine.push(...await macRows(t0, Date.now(), sc.name));
  rows.push(...mine);
  console.log(`${mine.length} events, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// ---- results
const summary = summarize(rows);
const keys = MEASURES.map(([k]) => k);
const pad = (s, n) => String(s).padStart(n);
console.log(`\n${'path'.padEnd(13)}${keys.map((k) => pad(k, 18)).join('')}`);
const history = existsSync(join(root, 'bench/results.jsonl')) ? readFileSync(join(root, 'bench/results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const lines = [];
let worse = 0;
for (const sc of SCENARIOS) {
  const g = summary.groups[`sim:${sc.name}`];
  if (!g) continue;
  const via = sc.direct ? 'direct' : 'relay';
  const measures = Object.fromEntries(keys.map((k) => [k, g.measures[k].all[via]]));
  console.log(`${sc.name.padEnd(13)}${keys.map((k) => pad(measures[k].n ? `${measures[k].p50} / ${measures[k].p95}` : '—', 18)).join('')}`);
  const before = history.filter((h) => h.scenario === sc.name).pop();
  for (const k of keys) {
    const a = before?.measures?.[k]?.p50, b = measures[k].p50;
    if (a && b && b > a * 1.2 && b - a > 10) { worse++; console.log(`  ↑ ${k} 中位数 ${a} → ${b} ms（上次 ${before.commit}）`); }
  }
  lines.push({ t: Date.now(), commit, scenario: sc.name, via: g.measures['echo.paint'].all[via].n ? via : '', measures });
}
console.log('(each cell: p50 / p95 ms)');
mkdirSync(join(root, 'bench'), { recursive: true });
// Only a whole run is a baseline for the next one.
if (!SCROLL_ONLY && !arg('--rounds') && !arg('--only')) for (const l of lines) appendFileSync(join(root, 'bench/results.jsonl'), JSON.stringify(l) + '\n');
if (dump) writeFileSync(join(root, 'bench/events.json'), JSON.stringify(rows, null, 1));
writeFileSync(join(root, 'bench/report.html'), renderReport(summary, { title: `模拟跑分（${commit}）` }));
const stored = (await readdir(join(dataDir, 'metrics')).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
console.log(`\nbench/results.jsonl +${!SCROLL_ONLY && !arg('--rounds') && !arg('--only') ? lines.length : 0}; bench/report.html; the stand-in Mac stored ${stored.length ? 'the records' : 'NOTHING'} (metrics.put)`);
await stop(worse || !stored.length ? 1 : 0);
