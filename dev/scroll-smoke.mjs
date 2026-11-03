// Scrolling on the PWA terminal page, as an iPhone, against dev/fake-desktop.mjs.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &; node dev/scroll-smoke.mjs "<pairing link>"
// The terminal is the Mac's grid, wider than the phone. Normal output: a drag up or down scrolls the
// history, a sideways drag pans, a tap brings up the keyboard. A full-screen program (vim, htop, a
// coding agent) gets a drag as the wheel; ↓ and typing take an agent back to its latest.
import { readFileSync, writeFileSync } from 'node:fs';
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
async function drag(x0, y0, x1, y1, { steps = 12, ms = 16, hold = 0 } = {}) {
  await touch('touchStart', x0, y0);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await pause(ms); }
  if (hold) await pause(hold); // the finger rests before it lifts: no coasting
  await touch('touchEnd');
}
async function send(text) { await page.focus('.term-keys'); await page.keyboard.type(text); await page.keyboard.press('Enter'); await page.evaluate(() => document.activeElement.blur()); }
const viewY = () => page.evaluate(() => { const b = globalThis.__herdrTerm.buffer.active; return { y: b.viewportY, base: b.baseY }; });
const shown = () => page.evaluate(() => (document.querySelector('.term-viewport').hidden ? 'none' : 'xterm'));
const keyboardUp = () => page.evaluate(() => document.activeElement?.classList.contains('term-keys'));
const rowsText = () => page.evaluate(() => document.querySelector('.xterm-rows').textContent);
const readFile = (p) => { try { return readFileSync(p, 'latin1'); } catch { return ''; } };

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.term-viewport:not([hidden])');
await pause(800);

await send('for i in $(seq 1 300); do echo line-$i; done');
await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('line-300'), { timeout: 15_000 });
await pause(400);
const box = await page.evaluate(() => { const r = document.querySelector('.term-viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, mid: r.top + r.height / 2 }; });
const v0 = await viewY();
await page.evaluate(() => { const l = globalThis.__herdrLink; const n = l.notify.bind(l); globalThis.__sent = []; l.notify = (m, p) => { globalThis.__sent.push(m); n(m, p); }; });
await drag(box.x, box.mid - 150, box.x, box.mid + 150, { steps: 20 });
await pause(2500); // the coast slows down as iOS scrolling does: about 2 s
const v1 = await viewY();
const sentNow = await page.evaluate(() => globalThis.__sent.filter((m) => m === 'term.input').length);
check('a drag down scrolls the history, on the phone only', v1.y < v0.y - 5 && sentNow === 0, `line ${v0.y} → ${v1.y} (of ${v0.base}); ${sentNow} sent`);
await drag(box.x + 100, box.mid, box.x - 100, box.mid, { steps: 16 });
await pause(400);
const left = await page.$eval('.term-viewport', (v) => v.scrollLeft);
check('a sideways drag pans, and leaves the history where it was', left > 80 && (await viewY()).y === v1.y, `scrollLeft ${left}, line ${(await viewY()).y}`);
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
await page.waitForFunction(() => document.querySelector('.xterm-rows').innerText.includes('WHEEL_DONE'), { timeout: 8_000 }).catch(() => {});
check('… and a drag reaches it as the wheel', /\x1b\[<64;/.test(readFile('/tmp/relay-wheel.txt')), JSON.stringify(readFile('/tmp/relay-wheel.txt').slice(0, 30)));

// A coding agent's full screen: a drag scrolls its own view; typing takes it back to the latest
// first, so what you send and its answer are in view (the agent gets the wheel-downs, then the key).
writeFileSync('/tmp/relay-readz.py', "import os\nb=b''\nwhile not b.endswith(b'Z'): b+=os.read(0,1)\nopen('/tmp/relay-wheel3.txt','wb').write(b)\n");
await send("rm -f /tmp/relay-wheel3.txt; printf '\\033]7501;state=idle:app=claude\\033\\\\\\033[?1049h\\033[?1000h\\033[?1006h\\033[HAGENT_FIT top line'; stty raw -echo; python3 /tmp/relay-readz.py; stty sane; printf '\\033[?1000l\\033[?1006l\\033[?1049l'; echo AGENT3_DONE");
await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('AGENT_FIT'), { timeout: 10_000 }).catch(() => {});
await pause(600);
check("an agent's full screen shows as on the Mac", (await shown()) === 'xterm' && (await rowsText()).includes('AGENT_FIT'));
for (let i = 0; i < 2; i++) await drag(box.x, box.mid - 100, box.x, box.mid + 200, { steps: 20 });
await pause(300);
check('a drag scrolls it up: ↓ shows', await page.$eval('.term-latest', (b) => !b.hidden));
await page.focus('.term-keys');
await page.keyboard.type('Z');
await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('AGENT3_DONE'), { timeout: 8_000 }).catch(() => {});
const got3 = readFile('/tmp/relay-wheel3.txt');
const ups3 = (got3.match(/\x1b\[<64;/g) ?? []).length, downs3 = (got3.match(/\x1b\[<65;/g) ?? []).length;
check('typing takes it back to the latest first', ups3 > 0 && downs3 >= ups3 && /(\x1b\[<65;\d+;\d+M)+Z$/.test(got3), `${ups3} up, ${downs3} down, ends ${JSON.stringify(got3.slice(-14))}`);
check('… and the ↓ button goes', await page.$eval('.term-latest', (b) => b.hidden));

// An agent that moves its view 5 lines per wheel step (as Claude Code moves several); row-300 is
// its latest. As Rex's phone app does: one wheel step per row the finger moves, sent at once,
// nothing moved ahead of the agent's redraw, and a flick keeps sending steps while it coasts.
writeFileSync('/tmp/relay-scroller.py', `import os, re, shutil, sys
cols, rows = shutil.get_terminal_size()
top = 300
def draw():
    out = '\\x1b[H\\x1b[2J' + ''.join('\\x1b[%d;1Hrow-%03d of the agent talk' % (y + 1, top + y) for y in range(rows - 2))
    sys.stdout.write(out + '\\x1b[%d;1H> INPUT' % rows); sys.stdout.flush()
sys.stdout.write('\\x1b]7501;state=idle:app=claude\\x1b\\\\\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h'); draw()
buf = b''
while True:
    buf += os.read(0, 64)
    if b'Z' in buf: break
    for m in re.finditer(rb'\\x1b\\[<(6[45]);\\d+;\\d+M', buf):
        top = max(0, top - 5) if m.group(1) == b'64' else min(300, top + 5)
    buf = buf[buf.rfind(b'M') + 1:] if b'M' in buf else buf
    draw()
sys.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l'); sys.stdout.flush()
`);
await send("stty raw -echo; python3 /tmp/relay-scroller.py; stty sane; echo SCROLLER_DONE");
await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('> INPUT'), { timeout: 10_000 }).catch(() => {});
await pause(500);
const topRow = () => page.evaluate(() => Number(/row-(\d+)/.exec(document.querySelector('.xterm-rows').textContent)?.[1] ?? NaN));
const cellH = await page.evaluate(() => document.querySelector('.xterm-rows > div').getBoundingClientRect().height);
const r0 = await topRow();
// A slow drag of 7 rows, the finger resting before it lifts (no coast). The first ~8 px only decide
// the direction, as on iOS.
const y0 = box.mid - 120;
await touch('touchStart', box.x, y0);
for (let i = 1; i <= 8; i++) { await touch('touchMove', box.x, y0 + (cellH * 7 * i) / 8); await pause(i === 4 ? 400 : 30); if (i === 4) globalThis.during = await topRow(); }
await pause(200);
await touch('touchEnd');
await pause(800);
const slow = (r0 - (await topRow())) / 5;
check('a slow drag sends one wheel step per row the finger moves', slow >= 5 && slow <= 7, `${slow} steps for 7 rows (top row ${r0} → ${await topRow()})`);
check('… at once: the agent has moved while the finger is still down', globalThis.during < r0, `top row ${globalThis.during} half way`);
const faked = await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].some((d) => d.style.transform));
check('nothing on the phone moves ahead of the redraw', !faked);
await page.evaluate(() => document.querySelector('.term-latest:not([hidden])')?.click());
await pause(1200);
check('↓: the live screen again, at the latest', (await topRow()) === 300, `top row ${await topRow()}, was ${r0}`);
await drag(box.x, box.mid - 150, box.x, box.mid - 150 + cellH * 3, { steps: 3, ms: 16 }); // a flick
await pause(300);
const at300 = await topRow();
await pause(1500);
const at1800 = await topRow();
check('a flick keeps scrolling after the finger lifts', at1800 < at300 && at300 < 300, `top row ${at300} at +300 ms, ${at1800} at +1800 ms`);
await page.evaluate(() => document.querySelector('.term-latest:not([hidden])')?.click());
await pause(1500);

// A long drag scrolls the agent's own view (wheel steps as the finger moves); ↓ back.
await drag(box.x, box.mid - 200, box.x, box.mid + 100, { steps: 30 });
await pause(1500);
check('a drag scrolls the agent\'s own view up', (await topRow()) < 300, `top row ${await topRow()}`);
await page.evaluate(() => document.querySelector('.term-latest:not([hidden])')?.click());
await pause(1500);
check('↓: the latest again', (await topRow()) === 300, `top row ${await topRow()}`);
await page.focus('.term-keys'); await page.keyboard.type('Z');
await page.evaluate(() => document.activeElement?.blur());
await pause(500);

console.log(`\n${pass}/${pass + fail} pass`);
await browser.close();
process.exit(fail ? 1 : 0);
