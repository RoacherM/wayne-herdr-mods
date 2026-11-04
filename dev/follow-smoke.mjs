// Where the phone looks on a terminal taller than it can show, as an iPhone, against dev/fake-desktop.mjs.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &
//   node dev/follow-smoke.mjs "<pairing link>"
// A program shaped like Claude Code on a Mac window 160x100: output above, an input box near the bottom
// (the cursor there, hidden), a status line under it, and a new line of output every 300 ms.
// As a terminal: the phone shows the latest (input box and status line), and keeps showing it after
// a sideways pan; scrolled up by hand it stays put; ↓ brings the latest back. And ⏺ is drawn as text.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { openCore, CREDIT, u32 } from '../host/hc.js';

const link = process.argv[2];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// The Mac-size view (a Mac window leads), panned: the page asks for no grid of its own (DESIGN.md「手机布局」).
await page.evaluateOnNewDocument(() => { globalThis.__herdrPan = true; });
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const cdp = await page.createCDPSession();
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
async function drag(x0, y0, x1, y1, { steps = 12, ms = 16, hold = 150 } = {}) {
  await touch('touchStart', x0, y0);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await pause(ms); }
  await pause(hold); // the finger rests: no coast
  await touch('touchEnd');
}

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.term-viewport:not([hidden])');
await pause(2500);
const address = await page.evaluate(() => globalThis.__herdrTermAddress);

// The Mac window: 160x100, a tall Herdr.app pane, so the phone can show only part of it.
const mac = await openCore({ session: 'relay-ui' });
const view = await mac.call('terminal.attach', { terminal: address, cols: 160, rows: 100 });
mac.on(view.channel, { onData: (b) => mac.send(view.channel, CREDIT, u32(b.length)) });
await page.waitForFunction(() => globalThis.__herdrTerm.rows === 100, { timeout: 10_000 });

writeFileSync('/tmp/relay-agent.py', `import os, sys, time
n = 0
def draw():
    out = '\\x1b[H\\x1b[2J'
    first = max(1, n - 92)
    for y, i in enumerate(range(first, n + 1)):
        out += '\\x1b[%d;1H\\u23fa reply line %d' % (y + 1, i)
    out += '\\x1b[96;1H' + '-' * 100 + '\\x1b[97;1H> INPUT_BOX' + '\\x1b[98;1H' + '-' * 100 + '\\x1b[99;1H  STATUS_LINE model ctx'
    sys.stdout.write(out + '\\x1b[97;3H'); sys.stdout.flush()
sys.stdout.write('\\x1b[?25l')
while not os.path.exists('/tmp/relay-agent.stop'):
    n += 1; draw(); time.sleep(0.3)
sys.stdout.write('\\x1b[?25h\\x1b[2J\\x1b[H'); sys.stdout.flush()
`);
try { (await import('node:fs')).unlinkSync('/tmp/relay-agent.stop'); } catch {}
await page.focus('.term-keys');
await page.keyboard.type('python3 /tmp/relay-agent.py');
await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement.blur());
await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('INPUT_BOX'), { timeout: 10_000 });
await pause(1500);

// What of the screen the phone shows now: rows in the outer view, and whether ↓ shows.
const seen = () => page.evaluate(() => {
  const v = document.querySelector('.term-viewport'), rows = [...document.querySelectorAll('.xterm-rows > div')];
  const box = v.getBoundingClientRect();
  const vis = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top >= box.top - 1 && b.bottom <= box.bottom + 1; }).map((r) => r.textContent);
  return { input: vis.some((t) => t.includes('INPUT_BOX')), status: vis.some((t) => t.includes('STATUS_LINE')), first: vis.find((t) => t.trim()) ?? '', latestBtn: !document.querySelector('.term-latest').hidden, rows: vis.length, top: v.scrollTop, max: v.scrollHeight - v.clientHeight };
});
const s0 = await seen();
check('the phone shows the latest: the input box and the status line', s0.input && s0.status, JSON.stringify(s0));
check('… and the terminal is taller than the phone (else this proves nothing)', s0.max > 100, `${s0.rows} rows shown of 100, ${s0.max}px more`);

const box = await page.evaluate(() => { const r = document.querySelector('.term-viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
await drag(box.x + 120, box.y, box.x - 120, box.y);
await pause(1500); // more output comes
const s1 = await seen();
check('after a sideways pan, still at the latest as output comes', s1.input && s1.status && !s1.latestBtn, JSON.stringify(s1));

await drag(box.x, box.y - 150, box.x, box.y + 150);
await pause(300);
const s2 = await seen();
await pause(1500);
const s3 = await seen();
check('scrolled up by hand: the view stays there while output comes', !s2.status && s3.top === s2.top, `top ${s2.top} → ${s3.top}, status shown ${s3.status}`);
check('… and ↓ shows', s3.latestBtn);
await page.evaluate(() => document.querySelector('.term-latest').click());
await pause(1200);
const s4 = await seen();
check('↓: the latest again, and it keeps following', s4.input && s4.status && !s4.latestBtn, JSON.stringify(s4));

// ⏺ goes to xterm with VS15 (text style), still one cell: the text after it where Ghostty puts it.
const dot = await page.evaluate(() => {
  const b = globalThis.__herdrTerm.buffer.active;
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); if (l?.translateToString(true).includes('reply line')) { const c = l.getCell(0); return { chars: [...c.getChars()].map((ch) => ch.codePointAt(0).toString(16)), width: c.getWidth(), next: l.getCell(2)?.getChars() }; } }
  return null;
});
check('⏺ is drawn as text (VS15), one cell wide', dot && dot.chars.join(',') === '23fa,fe0e' && dot.width === 1 && dot.next === 'r', JSON.stringify(dot));

writeFileSync('/tmp/relay-agent.stop', '');
mac.release(view.channel);
mac.close();
await browser.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
