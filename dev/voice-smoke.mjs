// Hold to talk in headless Chrome, with a fake microphone that is slow to start (as on iOS, where the
// first press also shows the permission prompt): a tap must not leave it recording.
//   node dev/fake-desktop.mjs   then   node dev/voice-smoke.mjs "<link>" [audio.wav]
//   With REAL_VOICE=1 for fake-desktop and a WAV, it also checks that the words reach the line.
import puppeteer from 'puppeteer-core';

const [link, wav] = process.argv.slice(2);
const MIC_DELAY_MS = 800;
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(wav ? [`--use-file-for-fake-audio-capture=${wav}`] : []), '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) process.exitCode = 1; };
const toasts = [];
await page.exposeFunction('__toast', (t) => toasts.push(t));
await page.evaluateOnNewDocument((delay, useReal) => {
  // A slow microphone, and a record of every stream it gave, to see that each one was stopped.
  window.__streams = [];
  // Without a WAV, a tone stands in for the microphone (headless Chrome on macOS can hang on a device).
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const tone = () => { const ctx = new AudioContext(), osc = ctx.createOscillator(), dst = ctx.createMediaStreamDestination(); osc.connect(dst); osc.start(); return dst.stream; };
  navigator.mediaDevices.getUserMedia = async (c) => {
    await new Promise((r) => setTimeout(r, delay));
    const s = useReal ? await real(c) : tone();
    window.__streams.push(s);
    return s;
  };
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__toast(n.textContent); })
    .observe(document, { childList: true, subtree: true });
  // The page reuses its toast element: record each new text too.
  new MutationObserver(() => { const t = document.querySelector('.toast'); if (t && t.textContent !== window.__last) window.__toast(window.__last = t.textContent); })
    .observe(document, { childList: true, subtree: true, characterData: true });
}, MIC_DELAY_MS, Boolean(wav));
const live = () => page.evaluate(() => window.__streams.filter((s) => s.getTracks().some((t) => t.readyState === 'live')).length);
const talk = () => page.$eval('.talk', (b) => ({ on: b.classList.contains('on'), text: b.textContent }));

await browser.defaultBrowserContext().overridePermissions(new URL(link).origin, ['microphone']);
await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => document.querySelector('.group.needs .trow, .trow').click());
await page.waitForSelector('.talk:not(.off)', { visible: true, timeout: 10_000 });
const box = await (await page.$('.talk')).boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

// 1. a tap, released before the microphone started: nothing records
await page.touchscreen.touchStart(cx, cy); await pause(150); await page.touchscreen.touchEnd();
await pause(MIC_DELAY_MS + 1200);
const tapped = await talk();
check(!tapped.on && tapped.text === '按住 说话', `a tap does not keep recording (${JSON.stringify(tapped)})`);
check(await live() === 0, 'the microphone is off after a tap');
check(toasts.includes('按住说话，松开输入') || await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent === '按住说话，松开输入')), 'a tap says how to use it');

// 2. hold: it records while held; slide up and release: cancelled, nothing typed
await page.touchscreen.touchStart(cx, cy); await pause(MIC_DELAY_MS + 900);
check((await talk()).on, 'holding records');
for (let i = 1; i <= 5; i++) await page.touchscreen.touchMove(cx, cy - 24 * i);
await pause(300);
await page.touchscreen.touchEnd(); await pause(800);
check(!(await talk()).on && await live() === 0, 'released: stopped, microphone off');
check(await page.$eval('.term-keys', (el) => el.value) === '', 'slide up cancels: nothing typed');

// 3. (with real recognition) hold for the sentence, release: the words go into the line
if (wav && process.env.REAL_VOICE) {
  await page.touchscreen.touchStart(cx, cy); await pause(6000); await page.touchscreen.touchEnd();
  await page.waitForFunction(() => document.querySelector('.term-keys').value.length > 0 || document.querySelector('.toast.err'), { timeout: 60_000 });
  const text = await page.$eval('.term-keys', (el) => el.value);
  check(text.length > 0, `recognized: ${JSON.stringify(text)}`);
}
console.log("toasts:", JSON.stringify(toasts), "streams:", await page.evaluate(() => window.__streams.length));
await browser.close();
