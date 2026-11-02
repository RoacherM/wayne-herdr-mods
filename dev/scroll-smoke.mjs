// Finger scrolling on the terminal page, as an iPhone, against dev/fake-desktop.mjs.
//   node dev/scroll-smoke.mjs "<pairing link>"
// Checks: a downward drag shows older lines (normal buffer), a flick coasts further, an upward
// drag comes back, a sideways drag does not scroll lines, and in a full-screen program with mouse
// reporting the drag reaches the program as wheel events.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const link = process.argv[2];
mkdirSync('dev/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const cdp = await page.createCDPSession();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
async function drag(x0, y0, x1, y1, { steps = 12, ms = 16, hold = 0 } = {}) {
  await touch('touchStart', x0, y0);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await pause(ms); }
  if (hold) await pause(hold);
  await touch('touchEnd');
}
// The first numbered line on screen: lower = further back in history.
const ydisp = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent);
  const n = rows.map((r) => /line-(\d+)/.exec(r)?.[1]).find(Boolean);
  return { y: n ? Number(n) : -1, last: rows.filter((r) => r.trim()).at(-1) ?? '' };
});
async function send(text) {
  await page.evaluate((t) => { const i = document.querySelector('.term-input'); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await page.evaluate(() => document.querySelector('.round.send').click());
}
const screen = () => page.evaluate(() => document.querySelector('.xterm-rows').innerText);

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.xterm-rows');

// 300 numbered lines of history.
await send('for i in $(seq 1 300); do echo line-$i; done; echo END_OF_LINES');
await page.waitForFunction(() => /END_OF_LINES\s*\n.*[%$#>]/s.test(document.querySelector('.xterm-rows').innerText) || document.querySelector('.xterm-rows').innerText.includes('line-300'), { timeout: 15_000 });
await pause(400);
const box = await page.evaluate(() => { const r = document.querySelector('.term-viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, h: r.height }; });
const mid = box.top + box.h / 2;

const s0 = await ydisp();
check('starts at the bottom', s0.y > 250, JSON.stringify(s0));
await drag(box.x, mid - 120, box.x, mid + 120, { steps: 15, ms: 20, hold: 150 }); // slow drag, rest, lift
await pause(200);
const s1 = await ydisp();
check('slow drag down shows older lines', s1.y < s0.y - 5, `viewportY ${s0.y} → ${s1.y}`);
await page.screenshot({ path: 'dev/shots/scroll-1-drag.png' });

await drag(box.x, mid - 100, box.x, mid + 100, { steps: 6, ms: 8 }); // flick
await pause(80);
const s2a = await ydisp();
await pause(900);
const s2 = await ydisp();
check('flick keeps coasting after the finger lifts', s2.y < s2a.y, `at lift ${s2a.y}, 0.9 s later ${s2.y}`);

await drag(box.x, mid + 150, box.x, mid - 150, { steps: 15, ms: 20, hold: 150 });
await pause(200);
const s3 = await ydisp();
check('drag up comes back toward the bottom', s3.y > s2.y, `${s2.y} → ${s3.y}`);

const s4a = await ydisp();
await drag(box.x + 100, mid, box.x - 100, mid + 10, { steps: 10, ms: 16 });
await pause(300);
const s4 = await ydisp();
check('sideways drag does not scroll lines', s4.y === s4a.y, `${s4a.y} → ${s4.y}`);

// Tap still works (no scroll, no error).
await touch('touchStart', box.x, mid); await touch('touchEnd');
await pause(200);
check('tap leaves the position alone', (await ydisp()).y === s4.y);

// Full-screen program with SGR mouse reporting: the drag must arrive as wheel reports.
await send("rm -f /tmp/relay-wheel.txt; printf '\\033[?1049hALT_SCREEN\\033[?1000h\\033[?1006h'; stty raw -echo; head -c 40 > /tmp/relay-wheel.txt; stty sane; printf '\\033[?1000l\\033[?1006l\\033[?1049l'; echo WHEEL_DONE");
await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('ALT_SCREEN'), { timeout: 10_000 });
await pause(300);
await drag(box.x, mid - 150, box.x, mid + 150, { steps: 20, ms: 16, hold: 150 });
await drag(box.x, mid - 150, box.x, mid + 150, { steps: 20, ms: 16, hold: 150 });
await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('WHEEL_DONE'), { timeout: 8_000 }).catch(() => {});
const wheel = await import('node:fs').then((fs) => { try { return fs.readFileSync('/tmp/relay-wheel.txt', 'latin1'); } catch { return ''; } });
check('alternate screen: drag reaches the program as mouse-wheel reports', /\x1b\[<64;/.test(wheel), JSON.stringify(wheel.slice(0, 40)));

console.log(`\n${pass}/${pass + fail} pass`);
await browser.close();
process.exit(fail ? 1 : 0);
