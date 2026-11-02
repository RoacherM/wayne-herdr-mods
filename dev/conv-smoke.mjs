// The conversation view (app/src/conversation.js, host/transcripts.js) in headless Chrome as an iPhone.
//   node dev/fake-desktop.mjs > /tmp/fake.log   then   node dev/conv-smoke.mjs "<link>" "<transcript>"
// fake-desktop prints both: LINK … and CONV … (a made-up Claude Code transcript of 150 turns).
import { appendFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const [link, convFile] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) process.exitCode = 1; };
const line = (type, content) => JSON.stringify({ parentUuid: null, isSidechain: false, type, message: { role: type, content }, timestamp: new Date().toISOString() });
const say = (text) => appendFile(convFile, `${line('assistant', [{ type: 'text', text }])}\n`);
const convText = () => page.$eval('.conv', (el) => el.innerText);
const scroll = () => page.$eval('.conv', (el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => localStorage.removeItem('herdr-relay.mode'));
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => r.innerText.includes('claude')).click());

// 1. A Claude Code terminal opens in the conversation view, on the newest turn.
await page.waitForFunction(() => document.querySelector('.conv:not([hidden]) .msg'), { timeout: 10_000 });
await pause(300);
check(await page.$eval('.term-flow', (el) => el.hidden) && await page.$eval('.term-viewport', (el) => el.hidden), 'the terminal is hidden: the conversation shows');
check((await convText()).includes('第 150 处改好了'), 'the newest turn is there');
let s = await scroll();
check(s.height - s.top - s.client <= 2, 'it opens at the bottom');
check(await page.$$eval('.conv .tool', (t) => t.filter((x) => x.querySelector('.tool-out')).length) > 0, 'tool cards have their output');
check(!(await convText()).includes('hidden'), 'thinking is not shown');

// 2. Up to the top: older pages come in above, and what was on screen stays put.
const anchor = async () => page.evaluate(() => {
  const el = [...document.querySelectorAll('.conv .msg.user')].find((m) => m.getBoundingClientRect().top > 100);
  return el ? { text: el.innerText, top: el.getBoundingClientRect().top } : null;
});
let moved = 0, steps = 0;
for (; steps < 200; steps++) {
  const before = await page.$$eval('.conv .msg', (m) => m.length);
  await page.$eval('.conv', (el) => { el.scrollTop = Math.max(0, el.scrollTop - 700); el.dispatchEvent(new Event('scroll')); });
  const a = await anchor();
  await pause(120);
  const after = await page.$$eval('.conv .msg', (m) => m.length);
  if (a && after > before) {
    const b = await page.evaluate((text) => [...document.querySelectorAll('.conv .msg.user')].find((m) => m.innerText === text)?.getBoundingClientRect().top, a.text);
    moved = Math.max(moved, Math.abs((b ?? 9999) - a.top));
  }
  if ((await convText()).includes('已经是最早的消息') && (await scroll()).top <= 0) break;
}
check((await convText()).includes('第 1 个问题'), `older pages reach the first turn (${steps} scrolls)`);
check(moved <= 2, `a page coming in above does not move the text on screen (${moved.toFixed(1)} px)`);
const firsts = await page.$$eval('.conv .msg.user', (m) => m.map((x) => Number(/第 (\d+) 个问题/.exec(x.innerText)?.[1])).filter(Boolean));
check(firsts.length === 150 && firsts.every((n, i) => n === i + 1), `every turn once, in order (${firsts.length})`);

// 3. Read up there while a reply comes in: the place holds. At the bottom: it follows.
s = await scroll();
await say('上面读书的时候来的回复');
await page.waitForFunction(() => document.querySelector('.conv').innerText.includes('上面读书的时候来的回复'), { timeout: 5000 });
check((await scroll()).top === s.top, 'reading further up: a new reply does not move the page');
await page.$eval('.conv', (el) => { el.scrollTop = el.scrollHeight; });
await say('到底部以后来的回复');
await page.waitForFunction(() => document.querySelector('.conv').innerText.includes('到底部以后来的回复'), { timeout: 5000 });
await pause(100);
s = await scroll();
check(s.height - s.top - s.client <= 2, 'at the bottom: it follows the new reply');

// 4. The agent's text is text: no HTML runs.
await say('<img src=x onerror="window.__xss=1"> **粗体**');
await page.waitForFunction(() => document.querySelector('.conv').innerText.includes('粗体'), { timeout: 5000 });
await pause(300);
check(await page.evaluate(() => window.__xss === undefined && !document.querySelector('.conv img')), 'HTML in a reply is shown as text, not run');

// 5. The terminal is one tap away, and back.
await page.click('.mode-btn');
await pause(500);
check(await page.$eval('.conv', (el) => el.hidden), 'the button shows the terminal');
check(await page.evaluate(() => localStorage.getItem('herdr-relay.mode')) === 'term', 'the choice is kept');
await page.click('.mode-btn');
await pause(300);
check(!(await page.$eval('.conv', (el) => el.hidden)), 'and the conversation again');

// 6. Send from the conversation view: answer the question first (keys), then a message.
await page.evaluate(() => [...document.querySelectorAll('.key')].find((b) => b.innerText === '1').click());
await page.evaluate(() => [...document.querySelectorAll('.key')].find((b) => b.innerText === '⏎').click());
await pause(1500);
await page.type('.conv-input', 'hello from the conversation');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelector('.conv .msg.user.pending'), { timeout: 5000 }).catch(() => {});
check(await page.$eval('.conv', (el) => el.innerText.includes('hello from the conversation')), 'what was sent shows at once');
check(await page.$eval('.conv-input', (el) => el.value === ''), 'the box is empty after sending');
await page.click('.mode-btn');
await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.innerText ?? '').includes('hello from the conversation') || (document.querySelector('.term-flow')?.innerText ?? '').includes('hello from the conversation'), { timeout: 8000 }).then(() => check(true, 'the terminal got it'), () => check(false, 'the terminal got it'));
await page.click('.mode-btn');
await page.screenshot({ path: 'dev/shots/conv.png' });
await browser.close();
