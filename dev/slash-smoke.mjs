// Slash commands from the phone, against a real Claude Code in dev/fake-desktop.mjs's scratch core.
//   node dev/slash-smoke.mjs "<pairing link>"
// Starts `claude` in the scratch shell, types "/he" in the message box and expects Claude Code's
// own command menu on the terminal, then send → the help panel; deleting the "/" clears its input.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const link = process.argv[2];
mkdirSync('dev/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const screen = () => page.evaluate(() => document.querySelector('.xterm-rows')?.innerText ?? '');
const waitScreen = (re, ms = 20000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.innerText ?? ''), { timeout: ms }, re.source).then(() => true, () => false);
const key = (label) => page.evaluate((l) => [...document.querySelectorAll('.key')].find((b) => b.innerText === l).click(), label);
async function setBox(text) {
  await page.focus('.term-input');
  await page.evaluate(() => document.querySelector('.term-input').select());
  await page.keyboard.press('Backspace');
  if (text) await page.type('.term-input', text, { delay: 60 });
}

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.xterm-rows');
// A folder Claude Code already trusts (the probe used it), so no trust question touches ~/.
await setBox('mkdir -p /tmp/slash-probe && cd /tmp/slash-probe && claude');
await page.click('.round.send');
const up = await waitScreen(/bypass permissions|\? for shortcuts|shift\+tab/, 30000);
check('Claude Code starts', up && !/trust this folder/.test(await screen()), up ? '' : (await screen()).split('\n').slice(-8).join(' | '));
await new Promise((r) => setTimeout(r, 1500));

await setBox('/he');
const menu = await waitScreen(/\/help/, 8000);
check('typing "/he" shows Claude Code\'s own command menu on the terminal', menu, menu ? '' : (await screen()).split('\n').slice(-12).join(' | '));
check('command-mode hint shows', await page.evaluate(() => !document.querySelector('.cmd-hint').hidden));
await page.screenshot({ path: 'dev/shots/slash-1-menu.png' });
await page.click('.round.send');
const help = await waitScreen(/Shortcuts|for commands/, 8000);
check('send runs it: the help panel opens', help);
check('box is empty again', (await page.$eval('.term-input', (i) => i.value)) === '');
await page.screenshot({ path: 'dev/shots/slash-2-help.png' });
await key('Esc');
await new Promise((r) => setTimeout(r, 800));

await setBox('/cle');
await waitScreen(/\/clear/, 8000);
await setBox('');
await new Promise((r) => setTimeout(r, 1000));
const tail = (await screen()).split('\n').filter((l) => l.includes('❯')).at(-1) ?? '';
check('deleting the "/" clears what was typed into Claude Code', !tail.includes('/cle'), JSON.stringify(tail.trim()));
check('hint gone after leaving command mode', await page.evaluate(() => document.querySelector('.cmd-hint').hidden));

// A normal message still goes through terminal.send (paste + enter), untouched by command mode.
await key('^C'); await key('^C');
await new Promise((r) => setTimeout(r, 1500));
await setBox('echo NORMAL_$((40+2))');
await page.click('.round.send');
check('normal messages still use the send path', await waitScreen(/NORMAL_42/, 10000));
console.log(`\n${pass}/${pass + fail} pass`);
await browser.close();
process.exit(fail ? 1 : 0);
