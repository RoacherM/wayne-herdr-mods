// The PWA terminal page, end to end: the Mac's size and layout (the phone never changes it), panned
// sideways on the phone; one input box; the ＋ | 按住 说话 | ⌨ bar.
//   npm run build; npm run relay:dev (another shell); node dev/fake-desktop.mjs > /tmp/fake.log &
//   node dev/term-smoke.mjs "<pairing link>"        → screenshots in dev/shots/term-*.png
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const link = process.argv[2];
mkdirSync('dev/shots', { recursive: true });
const hc = (...a) => JSON.parse(execFileSync('hc', a, { env: { ...process.env, HC_SESSION: 'relay-ui' } }).toString());
const where = (w) => hc('ls').terminals.find((t) => t.where === w).address;
const size = (w) => { const t = hc('get', where(w)); return `${t.cols}x${t.rows}`; };
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
// The Mac-size view (a Mac window leads), panned: the page asks for no grid of its own (DESIGN.md「手机布局」).
await page.evaluateOnNewDocument(() => { globalThis.__herdrPan = true; });
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await pause(600); await page.screenshot({ path: `dev/shots/term-${name}.png` }); };
const screen = () => page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '');
const lines = async () => (await screen()).split('\n').map((l) => l.trimEnd());
const bubble = () => page.evaluate(() => { const b = document.querySelector('.term-bubble'); return b && !b.hidden ? b.innerText : ''; });
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) process.exitCode = 1; };
const until = async (what, fn, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return check(true, what); await pause(150); } check(false, what); };
const clickText = (sel, t) => page.evaluate((s, x) => [...document.querySelectorAll(s)].find((b) => b.innerText.trim() === x)?.click(), sel, t);

await page.goto(link, { waitUntil: 'networkidle0' });
await clickText('button', '开始配对');
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });

const openRow = (w) => page.evaluate((a) => [...document.querySelectorAll('.trow')].find((b) => b.querySelector('.addr')?.innerText === a).click(), where(w));
const rows = () => page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '');
const before = size('herdr-relay · shell');

// --- the Mac's grid at the phone's font, wider than the phone; a swipe pans it
await openRow('herdr-relay · shell');
await until('the shell shows', async () => (await screen()).includes('%'));
const grid = await page.evaluate(() => {
  const v = document.querySelector('.term-viewport'), c = document.querySelector('.xterm-rows > div');
  return { visible: !v.hidden, scroll: v.scrollWidth, client: v.clientWidth, font: getComputedStyle(c).fontSize, cols: globalThis.__herdrTerm?.cols };
});
check(grid.visible && grid.font === '12px', `xterm itself at 12 px (${JSON.stringify(grid)})`);
check(grid.cols === Number(before.split('x')[0]), `the Mac's columns (${grid.cols}, the Mac has ${before})`);
check(grid.scroll > grid.client * 1.3, `wider than the phone: the left part shows (${grid.client} of ${grid.scroll} px)`);
const swipe = async (dx, dy) => {
  const r = await page.$eval('.term-viewport', (v) => { const b = v.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  const c = await page.target().createCDPSession();
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
  for (let i = 1; i <= 10; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x + (dx * i) / 10, y: r.y + (dy * i) / 10 }] }); await pause(16); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pause(400);
  return page.$eval('.term-viewport', (v) => v.scrollLeft);
};
const panned = await swipe(-200, 0);
check(panned > 100, `a swipe to the left shows the right part (scrollLeft ${panned})`);
await shot('0-panned');
check(await swipe(200, 0) < panned, 'and back');
await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]')?.click());
await pause(300);

// --- a shell at the Mac's size: type straight into its line
await openRow('herdr-relay · shell');
await until('the shell shows', async () => (await screen()).includes('%'));
check(size('herdr-relay · shell') === before, `the Mac size stays ${before} (now ${size('herdr-relay · shell')})`);
await page.focus('.term-keys');
await until('⌨ shows the keyboard is up', () => page.evaluate(() => document.querySelector('.round.on') !== null), 2000);
await page.keyboard.type('echo hello-one-box');
await until('typed text is in the shell line before Enter', async () => (await screen()).includes('echo hello-one-box'));
await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
await page.keyboard.type('BOX');
await page.keyboard.press('Enter');
await until('Enter runs it (edits went in as backspaces)', async () => (await lines()).includes('hello-one-BOX'));
await until('the field is empty again', () => page.evaluate(() => document.querySelector('.term-keys').value === ''));
await page.keyboard.type("seq 1 40; printf '%s ' $(seq 1 30); echo"); await page.keyboard.press('Enter');
await until('output shows', async () => (await lines()).includes('40'));
await pause(500);
await shot('1-shell');
const view = await page.evaluate(() => {
  const v = document.querySelector('.term-viewport'), t = globalThis.__herdrTerm, cell = t._core._renderService.dimensions.css.cell;
  const cy = (t.buffer.active.cursorY + 1) * cell.height;
  return { left: v.scrollLeft, cursorShown: cy > v.scrollTop && cy <= v.scrollTop + v.clientHeight + 1 };
});
check(view.left === 0 && view.cursorShown, `while typing, the cursor is in view (${JSON.stringify(view)})`);
check((await lines()).some((l) => /^1 2 3 .* 30$/.test(l.trim())), 'a long line stays one line, as on the Mac');
// The keyboard goes away but iOS sends no last viewport change: the stale half height must go on blur.
await page.evaluate(() => { const s = document.querySelector('.screen.term'); s.style.height = '400px'; s.style.transform = 'translateY(70px)'; });
await page.evaluate(() => document.activeElement?.blur());
await until('full height again after the keyboard goes', () => page.evaluate(() => {
  const s = document.querySelector('.screen.term');
  return !s.style.height && !s.style.transform && Math.abs(s.getBoundingClientRect().height - innerHeight) < 2;
}), 2000);
await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]')?.click());
check(size('herdr-relay · shell') === before, 'the Mac size never changed');

// --- claude, blocked: typing waits, the answer keys are blue
await openRow('herdr-relay · claude');
await until('blocked prompt shows', async () => (await screen()).includes('npm test'));
await until('bubble says the terminal asks', async () => (await bubble()).includes('终端在问你'));
check(await page.evaluate(() => [...document.querySelectorAll('.key.answer')].map((b) => b.innerText).join(' ')) === 'Esc ↑ ↓ ⏎ ← → 1 2 3 y n', 'answer keys are blue (arrows too)');
await page.focus('.term-keys');
await page.keyboard.type('later');
await until('typed text is held', async () => (await bubble()).includes('等你回答后输入：later'));
await shot('2-blocked');
await clickText('.key', '1'); await clickText('.key', '⏎');
await until('answer lands; held text follows', async () => (await screen()).includes('你选了 1'));
await until('held text went in (bubble gone)', async () => !(await bubble()), 8000);
await page.keyboard.press('Enter');
await until('then Enter sends the held text', async () => (await screen()).includes('你选了 later'), 12_000);
await shot('3-answered');

// --- Antigravity, blocked on「Approve plan」with its input line (cursor shown): typing goes straight in
await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]')?.click());
await openRow('plan · agy');
await until('plan prompt shows', async () => (await screen()).includes('/artifact to review'));
await pause(500);
check(!(await bubble()), 'no "terminal asks" bubble while the program takes free text');
check(await page.evaluate(() => document.querySelector('.key.answer') !== null), 'the answer keys are still blue');
await page.focus('.term-keys');
await page.keyboard.type('ok');
await page.keyboard.press('Enter');
await until('typed answer reaches the program', async () => (await screen()).includes('收到 ok'));
await shot('4-plan');

// --- blocked, cursor hidden, but no menu to answer: a tap on the bubble lets typing in
await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]')?.click());
await openRow('plan · stuck');
await until('stuck prompt shows', async () => (await screen()).includes('要你看一下'));
await page.focus('.term-keys');
await page.keyboard.type('go');
await until('typing is held', async () => (await bubble()).includes('等你回答后输入：go'));
await page.evaluate(() => document.querySelector('.term-bubble').click());
await until('the tap lets it in (bubble gone)', async () => !(await bubble()));
await page.keyboard.press('Enter');
await until('then Enter sends it', async () => (await screen()).includes('收到 go'));

// --- a menu as Claude Code draws it (dev/fake-menu.mjs), answered with the key bar's ↑↓ and ⏎
const marked = async () => (await lines()).find((l) => l.includes('❯'))?.trim() ?? '';
const lit = () => page.evaluate(() => [...document.querySelectorAll('.key.sent')].map((b) => b.innerText).join(' '));
await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]')?.click());
await openRow('ask · claude');
await until('the menu shows', async () => (await marked()) === '❯ 1. 全部');
// Lit in the same task as the click: nothing from the network can come in between.
check(await page.evaluate(() => { const b = [...document.querySelectorAll('.key')].find((k) => k.innerText.trim() === '↓'); b.click(); return b.classList.contains('sent'); }), 'a key stays lit after the press, until the program draws');
await until('↓ moves the mark', async () => (await marked()) === '❯ 2. 只要手机');
await until('and the key goes out', async () => !(await lit()), 4000);
await shot('5-menu');
await clickText('.key', '⏎');
await until('⏎ picks it: the next question', async () => (await screen()).includes('新功能叫什么名字？'));
await clickText('.key', '↓'); await until('↓ again', async () => (await marked()) === '❯ 2. prompt (Recommended)');
await clickText('.key', '⏎');
await until('the Submit step', async () => (await screen()).includes('Review your answers'));
await clickText('.key', '⏎');
await until('the program got both answers', async () => (await screen()).includes('答案：只要手机 / prompt (Recommended)'));
await until('then it asks for permission', async () => (await screen()).includes('Do you want to proceed?'), 4000);
await clickText('.key', '↓'); await until('↓ on the permission prompt', async () => (await marked()).startsWith("❯ 2. Yes, and don't ask again"));
await clickText('.key', '⏎');
await until('the permission answer lands', async () => (await screen()).includes("授权：Yes, and don't ask again"));
await browser.close();
