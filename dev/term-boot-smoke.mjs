// Needs: node ios/build-term.mjs (writes ios/src/term-html.ts) and Google Chrome. No relay, no desktop.
// The native app's terminal page boots in headless Chrome at an iPhone size; on boot it must post
// exactly one {t:'ready', fit} with the measured grid and no {t:'fit'} before it (DESIGN.md「终端页怎么显示」).
//   node dev/term-boot-smoke.mjs        → exit code 1 if it does not
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { TERM_HTML } from '../ios/src/term-html.ts';

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 760, deviceScaleFactor: 3 });
  await page.evaluateOnNewDocument(() => {
    window.__posted = [];
    window.nsh = { postMessage: (m) => window.__posted.push(JSON.parse(m)) };
  });
  const file = join(mkdtempSync(join(tmpdir(), 'term-boot-')), 'term.html');
  writeFileSync(file, TERM_HTML);
  await page.goto(`file://${file}`);
  await new Promise((r) => setTimeout(r, 1500));
  const posted = await page.evaluate(() => window.__posted);
  const boot = posted.filter((m) => m.t === 'fit' || m.t === 'ready');
  console.log('boot messages:', JSON.stringify(boot));
  const ready = boot.filter((m) => m.t === 'ready');
  if (ready.length !== 1 || !ready[0].fit?.cols || !ready[0].fit?.rows) { console.log('FAIL: want one ready with a fit'); failed = true; }
  if (boot[0]?.t !== 'ready') { console.log(`FAIL: ${boot.indexOf(ready[0])} fit message(s) before ready`); failed = true; }
  // After boot, a new size (the phone turned) still reports its grid.
  await page.setViewport({ width: 760, height: 390, deviceScaleFactor: 3 });
  await new Promise((r) => setTimeout(r, 500));
  const turned = (await page.evaluate(() => window.__posted)).filter((m) => m.t === 'fit');
  console.log('after turning:', JSON.stringify(turned));
  if (turned.length !== 1 || turned[0].fit.cols <= ready[0]?.fit?.cols) { console.log('FAIL: want one fit for the wider grid'); failed = true; }
  if (!failed) console.log('OK');
} finally { await browser.close(); }
process.exit(failed ? 1 : 0);
