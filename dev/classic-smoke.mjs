// Claude Code in classic mode (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1) on the phone: its output goes
// into the terminal's own history, so the phone scrolls it locally, with no wheel sent to the Mac.
// Set up by hand in the scratch core (docs/plan-conversation-direct.md, C):
//   two Claude Code terminals labelled where="cc / classic" and where="cc / full", each with some output;
//   node dev/fake-desktop.mjs (without stopping that core), then node dev/classic-smoke.mjs "<link>"
import puppeteer from 'puppeteer-core';

const [link] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) process.exitCode = 1; };

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 2, { timeout: 25_000 });

async function look(where) {
  await page.evaluate(async (where) => {
    const { terminals } = await globalThis.__herdrLink.rpc('terminals.list');
    const t = terminals.find((x) => x.where === where).address;
    [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.addr')?.innerText === t).click();
  }, where);
  await page.waitForFunction(() => globalThis.__herdrTerm, { timeout: 10_000 });
  await pause(2500);
  return page.evaluate(() => {
    const b = globalThis.__herdrTerm.buffer.active;
    return { type: b.type, above: b.length - globalThis.__herdrTerm.rows };
  });
}

const classic = await look('cc / classic');
console.log('     classic:', JSON.stringify(classic));
check(classic.type === 'normal', 'classic mode: the normal screen, not the alternate one');
check(classic.above > 100, `its output is in the history the phone has (${classic.above} lines above the screen)`);
// A drag down shows older lines here; it sends nothing to the Mac (no wheel).
await page.evaluate(() => { const l = globalThis.__herdrLink; const n = l.notify.bind(l); globalThis.__sent = []; l.notify = (m, p) => { globalThis.__sent.push(m); n(m, p); }; });
const cdp = await page.createCDPSession();
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
const box = await page.evaluate(() => { const r = document.querySelector('.term-viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const before = await page.evaluate(() => globalThis.__herdrTerm.buffer.active.viewportY);
await touch('touchStart', box.x, box.y - 150);
for (let i = 1; i <= 20; i++) { await touch('touchMove', box.x, box.y - 150 + i * 15); await pause(16); }
await touch('touchEnd');
await pause(600);
const after = await page.evaluate(() => globalThis.__herdrTerm.buffer.active.viewportY);
const sent = await page.evaluate(() => globalThis.__sent);
check(before - after > 10 && !sent.includes('term.input'), `scrolling up is local: ${before - after} lines, nothing sent`);

await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => globalThis.__herdrLink?.status === 'ready' && document.querySelectorAll('.trow').length >= 2, { timeout: 25_000 });
const full = await look('cc / full');
console.log('     fullscreen:', JSON.stringify(full));
check(full.type === 'alternate', 'fullscreen mode (the default with "tui": "fullscreen"): the alternate screen; scrolling there needs the wheel');
await browser.close();
