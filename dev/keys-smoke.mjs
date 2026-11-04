// The key bar, as an iPhone, against dev/fake-desktop.mjs: what each key sends (a raw reader prints it),
// what fits without scrolling the bar, 粘贴, and an arrow held down.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &
//   node dev/keys-smoke.mjs "<pairing link>"
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const link = process.argv[2];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
await browser.defaultBrowserContext().overridePermissions(new URL(link).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
const page = await browser.newPage();
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const cdp = await page.createCDPSession();

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.term-viewport:not([hidden])');
await pause(2000);
// Rows joined where the terminal wrapped them (the phone's grid is narrow).
const lines = () => page.evaluate(() => { const b = globalThis.__herdrTerm.buffer.active, out = []; for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l.isWrapped && out.length) out[out.length - 1] += l.translateToString(true); else out.push(l.translateToString(true)); } return out.filter((l) => l.trim()); });
// Reads the terminal raw (no echo, no line editing) until a '.', then prints the bytes as hex.
writeFileSync('/tmp/relay-raw.py', `import os, sys, termios, tty
old = termios.tcgetattr(0); tty.setraw(0); d = b''
try:
    while not d.endswith(b'.'): d += os.read(0, 256)
finally: termios.tcsetattr(0, termios.TCSADRAIN, old)
print('RAW', d[:-1].hex())
`);
const fresh = async () => {
  await page.focus('.term-keys');
  await page.keyboard.type('clear; python3 /tmp/relay-raw.py'); await page.keyboard.press('Enter'); await pause(900);
};
const raw = async () => {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const l = (await lines()).find((x) => x.startsWith('RAW')); if (l !== undefined) return Buffer.from(l.slice(4).trim(), 'hex').toString('latin1'); await pause(100); }
  return null;
};
const center = async (label) => {
  const el = await page.$(`.key[data-label="${label}"]`);
  await el.evaluate((e) => e.scrollIntoView({ inline: 'center' }));
  const b = await el.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const tap = async (label) => { const p = await center(label); await page.touchscreen.tap(p.x, p.y); await pause(120); };
const endCat = async () => { await page.keyboard.type('.'); await pause(300); };

const shown = await page.$$eval('.key', (bs) => bs.filter((b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0; }).map((b) => b.dataset.label));
check('without scrolling the bar: 粘贴 Esc ⇧Tab ^C ↑ ↓ ⏎', ['粘贴', 'Esc', '⇧Tab', '^C', '↑', '↓', '⏎'].every((k) => shown.includes(k)), shown.join(' '));

await fresh();
for (const k of ['Esc', '⇧Tab', '↑', '↓', '←', '→', 'Tab', '1', 'y', '^R', '^L']) await tap(k);
let lost = await page.evaluate(() => document.activeElement?.className);
await endCat();
let got = await raw();
check('each key sends its bytes', got === '\x1b\x1b[Z\x1b[A\x1b[B\x1b[D\x1b[C\t1y\x12\x0c', JSON.stringify(got));
check('… and the keyboard stays up', lost === 'term-keys', lost);

await fresh();
await page.evaluate(() => navigator.clipboard.writeText('line one\nline two'));
await tap('粘贴');
await pause(500);
await endCat();
got = await raw();
check('粘贴: the clipboard goes in as one bracketed paste', got === '\x1b[200~line one\nline two\x1b[201~', JSON.stringify(got));

await fresh();
await tap('换行');
await endCat();
got = await raw();
check('换行: a pasted new line (Claude Code: a new line, not send)', got === '\x1b[200~\n\x1b[201~', JSON.stringify(got));

await fresh();
const p = await center('↑');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
await pause(1100);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await pause(400);
await endCat();
const n = ((await raw()) ?? '').split('\x1b[A').length - 1;
check('↑ held for 1.1 s repeats, as on a keyboard', n >= 6 && n <= 14, `${n} times`);

await fresh();
const q = await center('↓');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [q] });
for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: q.x - i * 25, y: q.y }] }); await pause(16); }
await pause(600);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await pause(400);
await endCat();
const m = ((await raw()) ?? '').split('\x1b[B').length - 1;
check('sliding the bar sideways from ↓ sends nothing', m === 0, `${m} times`);

await browser.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
