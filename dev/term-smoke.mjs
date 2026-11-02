// The PWA terminal page, end to end: the phone's size (the default) and back to the Mac's; then, at the
// Mac's size, one input box, the phone's own layout (the Mac size never changes), the ＋ | 按住 说话 | ⌨ bar.
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
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await pause(600); await page.screenshot({ path: `dev/shots/term-${name}.png` }); };
const screen = () => page.evaluate(() => document.querySelector('.term-flow')?.innerText ?? '');
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

// --- the phone's size (the default): the terminal takes the phone's grid; back to the Mac's on the toggle
await openRow('herdr-relay · shell');
const grid = await page.evaluate(() => {
  const v = document.querySelector('.term-viewport'), c = document.querySelector('.xterm-rows > div');
  return { visible: !v.hidden, w: v.clientWidth, h: v.clientHeight, font: getComputedStyle(c).fontSize };
});
check(grid.visible, `the phone's size shows xterm itself (${JSON.stringify(grid)})`);
await until(`the terminal takes the phone's size (was ${before})`, () => { const [c] = size('herdr-relay · shell').split('x').map(Number); return c >= 40 && c <= 70; });
const phoneSize = size('herdr-relay · shell');
await page.focus('.term-keys');
await page.keyboard.type('echo fit-$((6*7))'); await page.keyboard.press('Enter');
await until('typing works at the phone size', async () => (await rows()).includes('fit-42'));
await shot('0-fit');
const fits = await page.evaluate(() => { const x = document.querySelector('.xterm-screen'), v = document.querySelector('.term-viewport'); return x.getBoundingClientRect().width <= v.clientWidth; });
check(fits, 'the grid fits the phone width');
check(size('herdr-relay · shell') === phoneSize, `the size holds after typing (${phoneSize})`);
await page.evaluate(() => document.activeElement?.blur());
await page.evaluate(() => document.querySelector('.icon-btn[aria-label="返回"]')?.click());
await until(`leaving gives the Mac its size back (${before})`, () => size('herdr-relay · shell') === before);
await openRow('herdr-relay · shell');
await until('opening again takes the phone size again', () => size('herdr-relay · shell') === phoneSize);
await page.evaluate(() => document.querySelector('.view-btn').click());
await until(`the toggle gives the Mac its size back (${before})`, () => size('herdr-relay · shell') === before);
check(await page.evaluate(() => localStorage.getItem('herdr-relay.size')) === 'keep', 'the choice is kept');
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
await until('Enter runs it (edits went in as backspaces)', async () => (await screen()).includes('hello-one-BOX\n'));
await until('the field is empty again', () => page.evaluate(() => document.querySelector('.term-keys').value === ''));
await page.keyboard.type("printf '%s ' $(seq 1 60); echo; printf '─%.0s' $(seq 1 110); echo; seq 1 40"); await page.keyboard.press('Enter');
await until('output shows', async () => (await screen()).includes('\n40'));
await pause(500);
await shot('1-shell');
const fitW = await page.evaluate(() => { const f = document.querySelector('.term-flow'); return { scroll: f.scrollWidth, client: f.clientWidth, bottom: f.scrollHeight - f.scrollTop - f.clientHeight }; });
check(fitW.scroll <= fitW.client, `nothing runs off the right edge (${fitW.scroll} ≤ ${fitW.client})`);
check(fitW.bottom < 4, 'it stays at the bottom while output comes');
check((await screen()).includes('1 2 3 4 5 6 7 8 9 10 11'), 'a long line wraps at the phone width');
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
await page.evaluate(() => document.querySelector('.group.needs .trow').click());
await until('blocked prompt shows', async () => (await screen()).includes('npm test'));
await until('bubble says the terminal asks', async () => (await bubble()).includes('终端在问你'));
check(await page.evaluate(() => [...document.querySelectorAll('.key.answer')].map((b) => b.innerText).join(' ')) === 'Esc ⏎ 1 2 3 y n', 'answer keys are blue');
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
await browser.close();
