// Older history on the native app's terminal page (DESIGN.md「往回翻历史」), with real paints:
// a scratch herdr-core (HC_SESSION=relay-hsmoke) prints 3000 numbered lines; the page (headless
// Chrome, iPhone size) gets the first paint (150 rows), then asks on its own; each ask is answered
// the way host/phones.js more() does (attach again with twice `have`, at least 600, at most 5000)
// as a fresh `older` frame. Checks:
//   1. the background ask comes by itself after the first paint;
//   2. a reader in the middle of the history keeps the same line on screen when more arrives;
//   3. a paint in two pieces (larger than herdr-core's credit window: the rest comes a round trip
//      later) keeps the same line too, and is not taken for the end;
//   4. scrolling near the top asks again; at the end the top says 已到最早 and no more asks go.
// Needs: node ios/build-term.mjs, Google Chrome. Herdr.app's own core is never touched.
//   node dev/history-smoke.mjs       → exit code 1 on a failure
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { openCore } from '../host/hc.js';
import { TERM_HTML } from '../ios/src/term-html.ts';

const SESSION = 'relay-hsmoke';
const fail = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fail.push(what); };

{ const old = await openCore({ session: SESSION }); await old.call('server.stop').catch(() => {}); old.close(); await new Promise((r) => setTimeout(r, 400)); }
const core = await openCore({ session: SESSION });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 760, deviceScaleFactor: 3 });
  await page.evaluateOnNewDocument(() => {
    window.__posted = [];
    window.nsh = { postMessage: (m) => window.__posted.push(JSON.parse(m)) };
  });
  const file = join(mkdtempSync(join(tmpdir(), 'hsmoke-')), 'term.html');
  writeFileSync(file, TERM_HTML);
  await page.goto(`file://${file}`);
  await page.waitForFunction(() => window.__posted.some((m) => m.t === 'ready'));
  const fit = (await page.evaluate(() => window.__posted.find((m) => m.t === 'ready'))).fit;

  const script = `for i in $(seq 1 3000); do printf '\\033[3%dmrow %04d\\033[0m\\n' $((i % 7 + 1)) $i; done; sleep 100000`;
  const { address } = await core.call('terminal.run', { argv: ['/bin/sh', '-c', script], cwd: '/tmp', rm: true });
  await new Promise((r) => setTimeout(r, 1200));
  // The phone's typer leads at the page's grid, as on the phone.
  const typer = await core.call('terminal.attach', { terminal: address, cols: fit.cols, rows: fit.rows, history: 0 });
  core.on(typer.channel, { onData: (b) => core.credit(typer.channel, b.length), onResize: () => {}, onClose: () => {} });
  await new Promise((r) => setTimeout(r, 300));

  /** One view's paint, as the Mac sends it: all its bytes once quiet. */
  async function paint(history) {
    const reply = await core.call('terminal.attach', { terminal: address, cols: fit.cols, rows: fit.rows, history, observe: true, resize_notifications: true });
    const chunks = [];
    await new Promise((resolve) => {
      let quiet = setTimeout(resolve, 400);
      core.on(reply.channel, {
        onData: (b) => { chunks.push(Buffer.from(b)); core.credit(reply.channel, b.length); clearTimeout(quiet); quiet = setTimeout(resolve, 250); },
        onResize: () => {}, onClose: resolve,
      });
    });
    core.release(reply.channel);
    return Buffer.concat(chunks).toString('base64');
  }
  const send = (m) => page.evaluate((s) => window.dispatchEvent(new MessageEvent('message', { data: s })), JSON.stringify(m));
  const asks = () => page.evaluate(() => window.__posted.filter((m) => m.t === 'more').map((m) => m.have));
  /** A finger drag on the terminal, `dy` px down (older lines), in steps, then lifted with no flick. */
  const drag = (dy) => page.evaluate(async (dy) => {
    const vp = document.getElementById('vp');
    const t = (y) => new Touch({ identifier: 1, target: vp, clientX: 200, clientY: y });
    const fire = (type, y) => vp.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t(y)], changedTouches: [t(y)], bubbles: true, cancelable: true }));
    let y = 150;
    fire('touchstart', y);
    const step = Math.max(40, Math.ceil(dy / 30));
    for (let moved = 0; moved < dy; moved += step) { y += step; fire('touchmove', y); await new Promise((r) => setTimeout(r, 16)); }
    await new Promise((r) => setTimeout(r, 120)); // rest before lifting: no coast
    fire('touchend', y);
  }, dy);
  const view = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent.trim()).filter(Boolean);
    return { top: rows[0] ?? '', label: document.getElementById('hist').textContent, on: document.getElementById('hist').classList.contains('on') };
  });
  /** Answer the page's newest ask the way host/phones.js more() does (`split`: in two pieces). */
  async function answer({ split = false } = {}) {
    const have = (await asks()).at(-1);
    const want = Math.min(5000, Math.max(600, 2 * have));
    const d = await paint(want);
    if (!split) await send({ t: 'out', d, fresh: true, hist: want, older: true });
    else {
      const raw = Buffer.from(d, 'base64');
      const cut = Math.floor(raw.length / 3); // inside the history rows
      await send({ t: 'out', d: raw.subarray(0, cut).toString('base64'), fresh: true, hist: want, older: true });
      await new Promise((r) => setTimeout(r, 250));
      splitMid = (await view()).top;
      await send({ t: 'out', d: raw.subarray(cut).toString('base64') });
    }
    await new Promise((r) => setTimeout(r, 900)); // settles 600 ms after the last piece
    return want;
  }
  let splitMid = '';

  await send({ t: 'open', sized: true, reopened: false, cols: fit.cols, rows: fit.rows, hist: 150 });
  await send({ t: 'out', d: await paint(150) });
  await new Promise((r) => setTimeout(r, 300));
  check((await asks()).length === 0, 'no ask right at the first paint');
  await new Promise((r) => setTimeout(r, 2200)); // settle 600 ms + quiet 1200 ms
  check(JSON.stringify(await asks()) === '[150]', `the background ask goes by itself (${JSON.stringify(await asks())})`);

  // The reader scrolls up 60 rows (the first paint has 150), then the older history arrives.
  await drag(60 * 17);
  await new Promise((r) => setTimeout(r, 300));
  const before = (await view()).top;
  await answer();
  const after = (await view()).top;
  check(before && before === after, `the same line stays on screen (${before} → ${after})`);

  // A little further up, and the next ask is answered in two pieces.
  await drag(560 * 17); // to within a screen of the top of the 600 + screen rows it has
  await new Promise((r) => setTimeout(r, 300));
  const n0 = (await asks()).length;
  if (n0 === 2) {
    const b2 = (await view()).top;
    await answer({ split: true });
    const a2 = (await view()).top;
    check(b2 === splitMid && b2 === a2, `a paint in two pieces keeps the line through both (${b2} → ${splitMid} → ${a2})`);
    check((await view()).label !== '已到最早', 'and is not taken for the end');
  } else check(false, `the second ask went near the top (asks ${JSON.stringify(await asks())})`);

  // To the top: more is asked, and comes, until the end; then the top says so.
  let rounds = 0;
  for (; rounds < 8; rounds++) {
    const n = (await asks()).length;
    await drag(6000 * 17);
    await new Promise((r) => setTimeout(r, 400));
    if ((await asks()).length === n) break; // nothing more asked: the end
    await answer();
  }
  const end = await view();
  check(end.top.includes('row 0001') || end.top.includes('row 0'), `the earliest kept row is reachable (${end.top})`);
  check(end.on && end.label === '已到最早', `the top says 已到最早 (${end.label})`);
  // A reprint (fresh, not older) clears the buffer: that clear is not the reader scrolling up.
  // At the bottom there must be no ask at all; (near the top, asking again after a reprint is right.)
  await send({ t: 'toLatest' });
  await new Promise((r) => setTimeout(r, 300));
  const nEnd = (await asks()).length;
  await send({ t: 'out', d: await paint(150), fresh: true, hist: 150 });
  await new Promise((r) => setTimeout(r, 400));
  check((await asks()).length === nEnd, 'a reprint fires no spurious ask');
  console.log('asks:', JSON.stringify(await asks()));
} finally {
  await browser.close();
  await core.call('server.stop').catch(() => {});
  core.close();
}
if (fail.length) { console.log(`${fail.length} failed`); process.exit(1); }
console.log('OK');
process.exit(0);
