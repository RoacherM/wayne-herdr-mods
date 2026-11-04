// The phone's own layout (DESIGN.md「手机布局」), as an iPhone, against dev/fake-desktop.mjs.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &
//   node dev/layout-smoke.mjs "<pairing link>"
// A Mac window (a typing viewer at 160x50, as Herdr.app) is on the terminal. The device used last
// sets the size: the phone opens it → the phone's grid; the Mac types → the Mac's; the phone types →
// the phone's again. The phone locks or leaves → the Mac's at once, nobody touching the Mac.
import puppeteer from 'puppeteer-core';
import { openCore, CREDIT, DATA, u32 } from '../host/hc.js';

const link = process.argv[2];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
const address = await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).querySelector('.addr').innerText);

// The Mac window, attached first and typed into: it leads at 160x50.
const mac = await openCore({ session: 'relay-ui' });
const view = await mac.call('terminal.attach', { terminal: address, cols: 160, rows: 50 });
mac.on(view.channel, { onData: (b) => mac.send(view.channel, CREDIT, u32(b.length)) });
const macTypes = () => mac.send(view.channel, DATA, Buffer.from(' \x7f')); // a space and its backspace
const coreSize = async () => { const t = await mac.call('terminal.get', { terminal: address }); return `${t.cols}x${t.rows}`; };
const phone = () => page.evaluate(() => {
  const v = document.querySelector('.term-viewport'), t = globalThis.__herdrTerm;
  return { size: t ? `${t.cols}x${t.rows}` : '', pan: v ? v.scrollWidth - v.clientWidth : -1, tall: v ? v.scrollHeight - v.clientHeight : -1 };
});
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await pause(100); } return v; };
macTypes();
await pause(300);
check('the Mac window leads first', (await coreSize()) === '160x50', await coreSize());

await page.evaluate((a) => [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.addr').innerText === a).click(), address);
await page.waitForSelector('.term-viewport:not([hidden])');
let p = await until(async () => { const x = await phone(); return x.size && x.size !== '160x50' && (await coreSize()) === x.size ? x : null; });
const phoneSize = p?.size;
check('the phone opens it: the terminal takes the phone\'s grid', Boolean(phoneSize), `core ${await coreSize()}, phone ${JSON.stringify(p ?? await phone())}`);
check('… which fits the phone: no sideways pan, no up-down scroll', p && p.pan <= 1 && p.tall <= 1, JSON.stringify(p));
await page.focus('.term-keys');
await page.keyboard.type('stty size');
await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement.blur());
const said = await until(() => page.evaluate((s) => document.querySelector('.xterm-rows').textContent.includes(s), phoneSize.split('x').reverse().join(' ')));
check('… and the program sees it (stty size)', Boolean(said));

macTypes();
p = await until(async () => { const x = await phone(); return x.size === '160x50' ? x : null; });
check('the Mac types: the Mac\'s size again, on the phone too (panned)', (await coreSize()) === '160x50' && p?.pan > 100, `core ${await coreSize()}, phone ${JSON.stringify(p ?? await phone())}`);

await page.focus('.term-keys');
await page.keyboard.type('x');
await page.keyboard.press('Backspace');
p = await until(async () => { const x = await phone(); return x.size === phoneSize ? x : null; });
check('the phone types: the phone\'s grid again', (await coreSize()) === phoneSize && Boolean(p), `core ${await coreSize()}`);
await page.evaluate(() => document.activeElement.blur());

// A reconnect (or a switch between relay and direct) while the phone leads: the size never leaves
// the phone's grid, not even for a moment (the program would redraw twice).
const seen = new Set();
let sampling = true;
const sampler = (async () => { while (sampling) { seen.add(await coreSize()); await pause(20); } })();
for (let i = 0; i < 3; i++) { await page.evaluate(() => globalThis.__herdrLink.dispatchEvent(new CustomEvent('ready', { detail: {} }))); await pause(1200); }
sampling = false; await sampler;
check('opened again 3 times while the phone leads: the size stays the phone\'s', seen.size === 1 && seen.has(phoneSize), [...seen].join(', '));

const visibility = (state) => page.evaluate((s) => { Object.defineProperty(document, 'visibilityState', { value: s, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, state);
await visibility('hidden');
const back = await until(async () => (await coreSize()) === '160x50');
check('the phone locks: the Mac\'s size at once, nobody touching the Mac', Boolean(back), await coreSize());
await visibility('visible');
const again = await until(async () => (await coreSize()) === phoneSize);
check('the phone is back on the page: the phone\'s grid', Boolean(again), await coreSize());

await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]').click());
const left = await until(async () => (await coreSize()) === '160x50');
check('the phone leaves the page: the Mac\'s size', Boolean(left), await coreSize());

mac.release(view.channel);
mac.close();
await browser.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
