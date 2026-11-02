// Scrolling on the PWA terminal page, as an iPhone, against dev/fake-desktop.mjs.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &; node dev/scroll-smoke.mjs "<pairing link>"
// Normal output: the phone layout scrolls natively and a tap brings up the keyboard. A full-screen
// program (vim, htop) shows xterm itself and a drag reaches it as the wheel. A coding agent's full
// screen is laid out for the phone too; a pull past its top reaches the agent as the wheel. All that at
// the Mac's size; then at the phone's size: xterm itself, and the agent's ↓ works the same.
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

await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('herdr-relay.size')) localStorage.setItem('herdr-relay.size', 'keep'); });
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

// Scrolled up, then typing: the agent's view goes back to the latest first, so what you send and
// its answer are in view (the agent gets the wheel-downs, then the key).
writeFileSync('/tmp/relay-readz.py', "import os\nb=b''\nwhile not b.endswith(b'Z'): b+=os.read(0,1)\nopen('/tmp/relay-wheel3.txt','wb').write(b)\n");
await send("rm -f /tmp/relay-wheel3.txt; printf '\\033]7501;state=idle:app=claude\\033\\\\\\033[?1049h\\033[?1000h\\033[?1006h\\033[HAGENT_TWO top line'; stty raw -echo; python3 /tmp/relay-readz.py; stty sane; printf '\\033[?1000l\\033[?1006l\\033[?1049l'; echo AGENT2_DONE");
await page.waitForFunction(() => document.querySelector('.term-flow').innerText.includes('AGENT_TWO'), { timeout: 10_000 }).catch(() => {});
await pause(600);
for (let i = 0; i < 2; i++) await drag(box.x, box.mid - 100, box.x, box.mid + 200, { steps: 20 });
await pause(300);
check('scrolled up: a ↓ button offers the latest', await page.$eval('.term-latest', (b) => !b.hidden));
await page.focus('.term-keys');
await page.keyboard.type('Z');
await page.waitForFunction(() => document.querySelector('.term-flow').innerText.includes('AGENT2_DONE'), { timeout: 8_000 }).catch(() => {});
const got = readFile('/tmp/relay-wheel3.txt');
const ups = (got.match(/\x1b\[<64;/g) ?? []).length, downs = (got.match(/\x1b\[<65;/g) ?? []).length;
check('typing takes the agent back to the latest first', ups > 0 && downs >= ups && /(\x1b\[<65;2;2M)+Z$/.test(got), `${ups} up, ${downs} down, ends ${JSON.stringify(got.slice(-14))}`);
check('… and the ↓ button goes', await page.$eval('.term-latest', (b) => b.hidden));
await page.evaluate(() => document.activeElement?.blur());

// The phone's size: xterm itself, also for an agent; a drag on it scrolls the agent, ↓ and typing as above.
await page.evaluate(() => document.querySelector('.view-btn').click());
await pause(800);
const rowsText = () => page.evaluate(() => document.querySelector('.xterm-rows').textContent);
check("the phone's size shows xterm itself", (await shown()) === 'xterm');
await send("rm -f /tmp/relay-wheel3.txt; printf '\\033]7501;state=idle:app=claude\\033\\\\\\033[?1049h\\033[?1000h\\033[?1006h\\033[HAGENT_FIT top line'; stty raw -echo; python3 /tmp/relay-readz.py; stty sane; printf '\\033[?1000l\\033[?1006l\\033[?1049l'; echo AGENT3_DONE");
await page.waitForFunction(() => document.querySelector('.xterm-rows').textContent.includes('AGENT_FIT'), { timeout: 10_000 }).catch(() => {});
await pause(600);
check("… also for an agent's full screen", (await shown()) === 'xterm' && (await rowsText()).includes('AGENT_FIT'));
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
// its latest. The first drag learns how it scrolls.
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
await drag(box.x, box.mid - 120, box.x, box.mid - 120 + cellH * 4, { steps: 8, ms: 30 }); // the first drag learns how it scrolls
await pause(1000);
check('how the agent scrolls was learned (5 lines a step, its rows)', await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('herdr-relay.wheel') || '{}').claude; return v?.s === 5 && v.t === 0 && v.b === 2; }), await page.evaluate(() => localStorage.getItem('herdr-relay.wheel')));
await page.evaluate(() => document.querySelector('.term-latest:not([hidden])')?.click());
await pause(1200);
check('↓: the live screen again, at the latest', (await topRow()) === 300, `top row ${await topRow()}, was ${r0}`);
const springs = await page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].every((d) => !d.style.transform));
check('the text moved ahead of the redraw is back in place', springs);

// Once it is learned, a drag scrolls the agent's own view (wheel steps as the finger moves); ↓ back.
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
