// Scrolling on the PWA terminal page, as an iPhone, against dev/fake-desktop.mjs.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &; node dev/scroll-smoke.mjs "<pairing link>"
// Normal output: the phone layout scrolls natively and a tap brings up the keyboard. A full-screen
// program (vim, htop) shows xterm itself and a drag reaches it as the wheel. A coding agent's full
// screen is laid out for the phone too; a pull past its top reaches the agent as the wheel.
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const link = process.argv[2];
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
async function drag(x0, y0, x1, y1, { steps = 12, ms = 16 } = {}) {
  await touch('touchStart', x0, y0);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await pause(ms); }
  await touch('touchEnd');
}
async function send(text) { await page.focus('.term-keys'); await page.keyboard.type(text); await page.keyboard.press('Enter'); await page.evaluate(() => document.activeElement.blur()); }
const flowTop = () => page.evaluate(() => document.querySelector('.term-flow').scrollTop);
const shown = () => page.evaluate(() => (document.querySelector('.term-flow').hidden ? 'xterm' : 'flow'));
const keyboardUp = () => page.evaluate(() => document.activeElement?.classList.contains('term-keys'));
const flowText = () => page.evaluate(() => document.querySelector('.term-flow').innerText);
const readFile = (p) => { try { return readFileSync(p, 'latin1'); } catch { return ''; } };

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.term-flow');
await pause(800);

await send('for i in $(seq 1 300); do echo line-$i; done');
await page.waitForFunction(() => document.querySelector('.term-flow').innerText.includes('line-300'), { timeout: 15_000 });
await pause(400);
const box = await page.evaluate(() => { const r = document.querySelector('.term-flow').getBoundingClientRect(); return { x: r.left + r.width / 2, mid: r.top + r.height / 2 }; });
const t0 = await flowTop();
await cdp.send('Input.synthesizeScrollGesture', { x: box.x, y: box.mid, yDistance: 400, gestureSourceType: 'touch', speed: 1200 });
await pause(300);
check('a drag scrolls the history natively', (await flowTop()) < t0 - 100, `${t0} → ${await flowTop()}`);
await touch('touchStart', box.x, box.mid); await touch('touchEnd');
await pause(300);
check('a tap brings up the keyboard', await keyboardUp());
await page.evaluate(() => document.activeElement.blur());

// A full-screen program with mouse reporting: xterm itself; a drag arrives as wheel reports.
await send("rm -f /tmp/relay-wheel.txt; printf '\\033[?1049hALT_SCREEN\\033[?1000h\\033[?1006h'; stty raw -echo; head -c 40 > /tmp/relay-wheel.txt; stty sane; printf '\\033[?1000l\\033[?1006l\\033[?1049l'; echo WHEEL_DONE");
await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('ALT_SCREEN'), { timeout: 10_000 });
await pause(300);
check('a full-screen program shows xterm itself', (await shown()) === 'xterm');
for (let i = 0; i < 3; i++) await drag(box.x, box.mid - 150, box.x, box.mid + 150, { steps: 20 });
await page.waitForFunction(() => document.querySelector('.term-flow').innerText.includes('WHEEL_DONE'), { timeout: 8_000 }).catch(() => {});
check('… and a drag reaches it as the wheel', /\x1b\[<64;/.test(readFile('/tmp/relay-wheel.txt')), JSON.stringify(readFile('/tmp/relay-wheel.txt').slice(0, 30)));

// A coding agent's full screen: laid out for the phone; a pull past the top scrolls the agent.
await send("rm -f /tmp/relay-wheel2.txt; printf '\\033]7501;state=idle:app=claude\\033\\\\\\033[?1049h\\033[?1000h\\033[?1006h\\033[HAGENT_SCREEN top line'; stty raw -echo; head -c 20 > /tmp/relay-wheel2.txt; stty sane; printf '\\033[?1000l\\033[?1006l\\033[?1049l'; echo AGENT_DONE");
await page.waitForFunction(() => document.querySelector('.term-flow').innerText.includes('AGENT_SCREEN'), { timeout: 10_000 }).catch(() => {});
await pause(600);
check("an agent's full screen is laid out for the phone", (await shown()) === 'flow' && (await flowText()).includes('AGENT_SCREEN top line'));
for (let i = 0; i < 3; i++) await drag(box.x, box.mid - 100, box.x, box.mid + 200, { steps: 20 });
await page.waitForFunction(() => document.querySelector('.term-flow').innerText.includes('AGENT_DONE'), { timeout: 8_000 }).catch(() => {});
check('… and a pull past its top reaches the agent as the wheel', /\x1b\[<64;/.test(readFile('/tmp/relay-wheel2.txt')), JSON.stringify(readFile('/tmp/relay-wheel2.txt').slice(0, 30)));

console.log(`\n${pass}/${pass + fail} pass`);
await browser.close();
process.exit(fail ? 1 : 0);
