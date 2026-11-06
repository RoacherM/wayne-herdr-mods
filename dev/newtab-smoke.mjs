// Tap "+" on a space in the home screen → a new shell tab opens and accepts typing.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &
//   node dev/newtab-smoke.mjs "<pairing link>"
import puppeteer from 'puppeteer-core';
const link = process.argv[2];
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await pause(800);
await page.screenshot({ path: 'dev/shots/n1-home-plus.png' });
const rowsBefore = await page.$$eval('.trow', (r) => r.length);
await page.evaluate(() => [...document.querySelectorAll('.group')].find((g) => g.innerText.includes('SITE') || g.innerText.toLowerCase().includes('site')).querySelector('.group-add').click());
await page.waitForSelector('.screen.term .term-keys', { timeout: 15_000 });
const title = await page.$eval('.screen.term .bar-title', (e) => e.innerText);
await page.waitForFunction(() => /[%$#>]\s*$/m.test(document.querySelector('.xterm-rows')?.innerText ?? ''), { timeout: 10_000 }).catch(() => {});
await page.focus('.term-keys');
await page.keyboard.type('pwd; echo NEW_TAB_$((20+22))');
await page.keyboard.press('Enter');
await page.waitForFunction(() => (document.querySelector('.xterm-rows')?.innerText ?? '').includes('NEW_TAB_42'), { timeout: 15_000 });
const screen = await page.$eval('.xterm-rows', (e) => e.innerText.split('\n').filter((l) => l.trim()).slice(-3).join(' | '));
await page.screenshot({ path: 'dev/shots/n2-new-tab.png' });
await page.click('.bar .icon-btn[aria-label="返回"]');
await page.waitForFunction((n) => document.querySelectorAll('.trow').length > n, { timeout: 10_000 }, rowsBefore);
const rowsAfter = await page.$$eval('.trow', (r) => r.length);
console.log(JSON.stringify({ title, screen, rowsBefore, rowsAfter }));
await browser.close();
