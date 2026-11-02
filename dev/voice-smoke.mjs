// Voice input end to end in headless Chrome: a fake microphone plays a WAV, the page records it with
// MediaRecorder, uploads it, the Mac recognizes it, and the text lands in the message box.
//   REAL_VOICE=1 node dev/fake-desktop.mjs   then   node dev/voice-smoke.mjs "<link>" <audio.wav> <holdMs>
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const [link, wav, holdMs = '11000'] = process.argv.slice(2);
mkdirSync('dev/shots', { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const toasts = [];
await page.exposeFunction('__toast', (t) => toasts.push(t));
await page.evaluateOnNewDocument(() => new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__toast(n.textContent); }).observe(document.documentElement, { childList: true, subtree: true }));

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((b) => b.innerText.includes('claude')).click());
await page.waitForSelector('.round.mic', { visible: true, timeout: 10_000 });
const mic = await page.$('.round.mic');
const box = await mic.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const result = {};

// 1. a short tap is not a recording
await page.mouse.move(cx, cy); await page.mouse.down(); await pause(150); await page.mouse.up(); await pause(600);
result.tapToast = toasts.at(-1) ?? null;

// 2. hold, slide up, release → cancelled, nothing uploaded
await page.mouse.move(cx, cy); await page.mouse.down(); await pause(1500);
await page.mouse.move(cx, cy - 120, { steps: 5 }); await pause(300);
result.cancelHud = await page.$eval('.voice-hud', (el) => `${el.className} | ${el.textContent}`);
await page.mouse.up(); await pause(800);
result.afterCancel = await page.$eval('.term-input', (el) => el.value);

// 3. hold for the whole sentence, release → text in the box
await page.mouse.move(cx, cy); await page.mouse.down(); await pause(1200);
result.recordingHud = await page.$eval('.voice-hud', (el) => `${el.className} | ${el.textContent}`);
await page.screenshot({ path: 'dev/shots/v1-recording.png' });
await pause(Number(holdMs) - 1200);
const released = Date.now();
await page.mouse.up();
await pause(300);
result.busyHud = await page.$eval('.voice-hud', (el) => `${el.className} | ${el.textContent}`);
await page.waitForFunction(() => document.querySelector('.term-input').value.length > 0 || document.querySelector('.toast.err'), { timeout: 60_000 });
result.releaseToText = Date.now() - released;
result.text = await page.$eval('.term-input', (el) => el.value);
result.sendVisible = await page.$eval('.round.send', (el) => !el.hidden);
result.micHidden = await page.$eval('.round.mic', (el) => el.hidden);
result.errors = toasts.filter((t) => /失败|错误|无效/.test(t));
await page.screenshot({ path: 'dev/shots/v2-recognized.png' });

// 4. send it: the text reaches the terminal
await page.click('.round.send');
await page.waitForFunction((t) => (document.querySelector('.xterm-rows')?.innerText ?? '').includes(t.slice(0, 6)), { timeout: 15_000 }, result.text).then(() => { result.reachedTerminal = true; }, () => { result.reachedTerminal = false; });
await pause(800);
await page.screenshot({ path: 'dev/shots/v3-sent.png' });
console.log(JSON.stringify(result, null, 2));
await browser.close();
