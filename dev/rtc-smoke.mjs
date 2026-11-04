// The direct link (app/src/direct.js, host/rtc-link.js) in headless Chrome as an iPhone.
//   node dev/fake-desktop.mjs > /tmp/fake.log   then   node dev/rtc-smoke.mjs "<link>"
// Chrome hides its own addresses behind mDNS names (*.local) like Safari does, so this also
// checks that the Mac connects to such a phone.
import puppeteer from 'puppeteer-core';

const [link] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => { console.log('[pageerror]', e.message); process.exitCode = 1; });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) process.exitCode = 1; };
const via = () => page.evaluate(() => globalThis.__herdrLink?.via);
const until = (fn, ms) => page.waitForFunction(fn, { timeout: ms, polling: 100 }).then(() => true, () => false);
const rows = () => page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '');
// Median round trip of a small call, over the link in use or over the relay one.
const rtt = (over) => page.evaluate(async (over) => {
  const l = globalThis.__herdrLink, target = over === 'relay' ? l.relay : l;
  const times = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); await target.rpc('terminals.list'); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  return { p50: times[15], p90: times[27] };
}, over);

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });

// 1. Direct after pairing, without doing anything.
const t0 = Date.now();
check(await until(() => globalThis.__herdrLink?.via === 'direct', 15_000), `it goes direct by itself (${Date.now() - t0} ms after the list)`);
check(await until(() => document.querySelector('#status')?.innerText.includes('已直连'), 3000), 'the status says so: 已直连');
const direct = await rtt('direct'), relay = await rtt('relay');
console.log(`     round trip: direct p50 ${direct.p50.toFixed(1)} ms p90 ${direct.p90.toFixed(1)} ms; relay p50 ${relay.p50.toFixed(1)} ms p90 ${relay.p90.toFixed(1)} ms`);
// On this machine both are under a millisecond with a local relay; the gap shows against the real one.
if (relay.p50 > 20) check(direct.p50 < relay.p50 / 4, 'direct is much quicker than the relay');
else check(direct.p50 < 20, 'direct answers within 20 ms (a local relay: nothing to compare)');

// 2. A terminal works over it: output in, typing out.
await page.evaluate(async () => {
  const { terminals } = await globalThis.__herdrLink.rpc('terminals.list');
  const shell = terminals.find((t) => t.where === 'herdr-relay · shell').address;
  [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.addr')?.innerText === shell).click();
});
await page.waitForFunction(() => document.querySelector('.xterm-rows'), { timeout: 10_000 });
await pause(800);
await page.focus('.term-keys');
await page.keyboard.type('echo direct-$((6*7))'); await page.keyboard.press('Enter');
check(await until(() => document.querySelector('.xterm-rows')?.innerText.includes('direct-42'), 8000), 'a terminal works over it');

// 3. A long message (more than one 16 KB piece) comes through whole.
const read = await page.evaluate(async () => {
  const l = globalThis.__herdrLink;
  const t = (await l.rpc('terminals.list')).terminals.find((x) => x.where === 'herdr-relay · shell');
  await l.rpc('term.send', { address: t.address, text: "seq -f 'line-%g-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' 1 2000" });
  await new Promise((r) => setTimeout(r, 800));
  const r = await l.rpc('term.read', { address: t.address, lines: 2000 }).catch((e) => ({ error: e.message }));
  return { len: JSON.stringify(r).length, error: r.error };
});
check(!read.error && read.len > 40_000, `a reply of ${read.len} bytes comes through in pieces${read.error ? ` (${read.error})` : ''}`);

// 4. The direct one drops: the relay one takes over at once, the terminal keeps working, direct comes back.
await page.evaluate(() => globalThis.__herdrLink.direct.ws.close());
check(await until(() => globalThis.__herdrLink.via === 'relay', 3000), 'when it drops, the relay one takes over');
await pause(1200);
await page.focus('.term-keys');
await page.keyboard.type('echo relay-$((6*8))'); await page.keyboard.press('Enter');
check(await until(() => document.querySelector('.xterm-rows')?.innerText.includes('relay-48'), 8000), 'the terminal opened again and works over the relay');
check(await until(() => globalThis.__herdrLink.via === 'direct', 20_000), 'and goes direct again a few seconds later');
await pause(1200);
await page.focus('.term-keys');
await page.keyboard.type('echo back-$((6*9))'); await page.keyboard.press('Enter');
check(await until(() => document.querySelector('.xterm-rows')?.innerText.includes('back-54'), 8000), 'the terminal works direct again');

// 5. Relay only, when asked (for comparing).
await page.evaluate(() => localStorage.setItem('herdr-relay.direct', 'off'));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4 || document.querySelector('.xterm-rows'), { timeout: 25_000 });
await pause(4000);
check(await via() === 'relay', 'with direct off it stays on the relay');
await page.evaluate(() => localStorage.removeItem('herdr-relay.direct'));
await browser.close();
