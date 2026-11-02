// Drive the PWA as an iPhone against dev/fake-desktop.mjs and screenshot each screen into dev/shots.
//   node dev/ui-smoke.mjs "<pairing link>"   (the link's origin must serve the built app)
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const link = process.argv[2];
mkdirSync('dev/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[console]', m.type(), m.text()); });
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await pause(700); await page.screenshot({ path: `dev/shots/${name}.png` }); console.log('shot', name); };
const clickText = async (text) => {
  const ok = await page.evaluate((t) => { const el = [...document.querySelectorAll('button')].find((b) => b.innerText.includes(t)); if (el) { el.click(); return true; } return false; }, text);
  if (!ok) throw new Error(`no button ${text}`);
};
const screenText = () => page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '');

await page.goto(link, { waitUntil: 'networkidle0' });
await shot('1-welcome');
await clickText('开始配对');
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await shot('2-home');

// Open the blocked claude terminal from the "needs you" group.
await page.evaluate(() => document.querySelector('.group.needs .trow').click());
await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.innerText ?? '').includes('npm test'), { timeout: 15_000 });
await shot('3-term-blocked');
console.log('scale', await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-host')).transform));

// Answer with the "1" key, then watch it go to working.
await page.evaluate(() => [...document.querySelectorAll('.key')].find((b) => b.innerText === '1').click());
await clickText('⏎');
await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.innerText ?? '').includes('你选了'), { timeout: 10_000 });
await shot('4-term-answered');

// Fit to phone.
await page.click('.bar .icon-btn[aria-label="适配手机"]');
await pause(1200);
await shot('5-term-fit');
await page.click('.bar .icon-btn[aria-label="适配手机"]');

// Back home, open the zsh shell, type through the composer.
await page.click('.bar .icon-btn[aria-label="返回"]');
await page.waitForSelector('.trow');
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((b) => b.innerText.includes('zsh')).click());
await page.waitForSelector('.term-input');
await pause(800);
await shot('6a-composer-empty');
// attach an image, then send it with text: the message carries the file's path
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.round.ghost[aria-label="添加图片"]')]);
await chooser.accept([new URL('../app/static/icon-192.png', import.meta.url).pathname]);
await page.waitForSelector('.thumb img');
await page.type('.term-input', 'echo hello from phone $((6*7))');
await shot('6b-composer-image');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /\.png/.test(document.querySelector('.xterm-rows')?.innerText ?? ''), { timeout: 15_000 });
await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.innerText ?? '').includes('hello from phone 42'), { timeout: 15_000 }).catch(async () => console.log('screen:', await screenText()));
await shot('6-term-shell');

await page.click('.bar .icon-btn[aria-label="返回"]');
await page.click('.bar .icon-btn[aria-label="设置"]');
await shot('7-settings');

await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.click('.bar .icon-btn[aria-label="返回"]');
await shot('8-home-dark');

console.log(errors.length ? `PAGE ERRORS: ${errors.length}` : 'no page errors');
await browser.close();
