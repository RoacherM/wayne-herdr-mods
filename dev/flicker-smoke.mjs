// Flicker on the PWA terminal page, counted frame by frame, as an iPhone, against dev/fake-desktop.mjs.
//   npm run build; npm run relay:dev; node dev/fake-desktop.mjs > /tmp/fake.log &
//   node dev/flicker-smoke.mjs "<pairing link>"
//
// Every frame xterm draws on the phone is checked (xterm's onRender, the buffer as it was drawn):
//   - A program draws its own size into the screen (`SIZE 110x34`) and a ruler exactly as wide as
//     the screen. A "Mac window" (a viewer of our own on the scratch core) resizes the terminal 12
//     times. A frame is bad when it shows a size other than the phone's grid, or a ruler that
//     wrapped or falls short: bytes drawn for one size on a grid of another.
//   - The terminal is opened again on the same page (as on a switch between relay and direct, or a
//     reconnect). A frame is bad when it differs from the screen before and after: a blank or a
//     half-drawn screen.
// And character widths: each one ends where herdr-core's Ghostty puts the cursor after it.
// Prints the counts; exits 1 if any check failed.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { openCore, RESIZE, CREDIT, size, u32 } from '../host/hc.js';

const link = process.argv[2];
const SESSION = 'relay-ui';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(link, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.includes('开始配对')).click());
await page.waitForFunction(() => document.querySelectorAll('.trow').length >= 4, { timeout: 25_000 });
await page.evaluate(() => [...document.querySelectorAll('.trow')].find((r) => /^zsh/.test(r.querySelector('b')?.textContent ?? '')).click());
await page.waitForSelector('.term-viewport:not([hidden])');
await pause(3000); // the direct link comes up (and opens the terminal again there): let it settle
const address = await page.evaluate(() => globalThis.__herdrTermAddress);

// A full-screen program that draws its size: on start and on every SIGWINCH.
writeFileSync('/tmp/relay-size.py', `import os, signal, shutil, sys, time
def draw(*_):
    c, r = shutil.get_terminal_size()
    out = '\\x1b[H\\x1b[2J' + 'SIZE %dx%d' % (c, r) + '\\x1b[2;1H' + '#' * c
    for y in range(3, r):
        out += '\\x1b[%d;1H' % y + ('row %d ' % y) * 3
    sys.stdout.write(out + '\\x1b[%d;1HEND' % r); sys.stdout.flush()
signal.signal(signal.SIGWINCH, draw)
sys.stdout.write('\\x1b[?1049h'); draw()
while not os.path.exists('/tmp/relay-size.stop'): time.sleep(0.05)
sys.stdout.write('\\x1b[?1049l'); sys.stdout.flush()
`);
try { (await import('node:fs')).unlinkSync('/tmp/relay-size.stop'); } catch {}
await page.focus('.term-keys');
await page.keyboard.type('for i in $(seq 1 100); do echo pre-$i; done; python3 /tmp/relay-size.py');
await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement.blur());
await page.waitForFunction(() => { const b = globalThis.__herdrTerm.buffer.active; return b.getLine(b.viewportY)?.translateToString(true).startsWith('SIZE'); }, { timeout: 10_000 });
await pause(500);

// The "Mac window": a viewer of our own that resizes the terminal, as a dragged window does. It
// attaches after the phone, so it leads (the phone had its own grid, DESIGN.md「手机布局」); frames
// are counted once its size has settled.
const mac = await openCore({ session: SESSION });
const view = await mac.call('terminal.attach', { terminal: address, cols: 110, rows: 34 });
mac.on(view.channel, { onData: (b) => mac.send(view.channel, CREDIT, u32(b.length)) });
await page.waitForFunction(() => { const t = globalThis.__herdrTerm, b = t.buffer.active; return t.cols === 110 && b.getLine(b.viewportY)?.translateToString(true).startsWith('SIZE 110x34'); }, { timeout: 10_000 });
await pause(500);

// The frame checker: every render, the drawn screen.
await page.evaluate(() => {
  const t = globalThis.__herdrTerm;
  const screen = () => { const b = t.buffer.active; const out = []; for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? ''); return out; };
  globalThis.__frames = { n: 0, sizeBad: [], grown: [], reopenBad: [], mode: 'size', before: null };
  t.onRender(() => {
    const f = globalThis.__frames;
    f.n++;
    const s = screen();
    if (f.mode === 'size') {
      const m = /^SIZE (\d+)x(\d+)/.exec(s[0]);
      const ruler = s[1] ?? '';
      const [c, r] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
      // Impossible on a right grid: a drawing bigger than the grid, a ruler that wrapped or does not
      // match its own size line. A smaller drawing is what herdr-core's screen itself shows for a
      // moment after the grid grew, before the program redraws (the Mac shows it too): counted apart.
      // So is the old drawing moved up whole after the grid lost rows: the terminal keeps the cursor
      // (on the last row) in view and drops rows from the top, so the size line is gone for a moment.
      const k = Number(/^row (\d+) /.exec(s[0])?.[1]);
      const moved = !m && k > 0 && s.every((l, i) => l === `row ${k + i} `.repeat(3).trimEnd() || l === `row ${k + i} `.repeat(3) || (/^END/.test(l) && i === s.length - 1));
      if (moved) { f.grown.push(`top rows dropped (from row ${k}) on ${t.cols}x${t.rows}`); return; }
      const why = !m ? `no size line: ${JSON.stringify(s[0].slice(0, 30))}`
        : c > t.cols || r > t.rows ? `drawn for ${c}x${r} on ${t.cols}x${t.rows}`
        : ruler.length !== c || /^#/.test(s[2] ?? '') ? `ruler ${ruler.length} wide for ${c} on ${t.cols}` : null;
      if (why) f.sizeBad.push(why);
      else if (c !== t.cols || r !== t.rows) f.grown.push(`${c}x${r} on ${t.cols}x${t.rows}`);
    } else if (f.mode === 'reopen' && f.before && s.join('\n') !== f.before) {
      f.reopenBad.push(s.every((l) => !l.trim()) ? 'blank' : `differs: ${JSON.stringify(s.find((l, i) => l !== f.before.split('\n')[i])?.slice(0, 40))}`);
    }
  });
});

const sizes = [[96, 30], [130, 40], [110, 34], [84, 28], [120, 36], [100, 32], [140, 42], [90, 30], [110, 34], [125, 38], [105, 33], [110, 34]];
for (const [c, r] of sizes) { mac.send(view.channel, RESIZE, size(c, r)); await pause(350); }
await pause(1500);
const afterSize = await page.evaluate(() => { const f = globalThis.__frames; return { n: f.n, bad: f.sizeBad, grown: f.grown, grid: `${globalThis.__herdrTerm.cols}x${globalThis.__herdrTerm.rows}` }; });
check('Mac resizes 12 times: no frame shows bytes drawn for another size', afterSize.bad.length === 0,
  `${afterSize.bad.length} bad of ${afterSize.n} frames, grid now ${afterSize.grid}${afterSize.bad.length ? `; first: ${afterSize.bad.slice(0, 3).join(' | ')}` : ''}`);
console.log(`(${afterSize.grown.length} frames show the old drawing on a grid that changed size, as on the Mac, until the program redraws)`);
check('… and the phone ends at the Mac size', afterSize.grid === '110x34', afterSize.grid);

// Opened again on the same page, five times, as on a switch between relay and direct.
const normalBefore = await page.evaluate(() => globalThis.__herdrTerm.buffer.normal.length);
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => { const f = globalThis.__frames; const t = globalThis.__herdrTerm; const b = t.buffer.active;
    const s = []; for (let y = 0; y < t.rows; y++) s.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    f.before = s.join('\n'); f.mode = 'reopen'; });
  await page.evaluate(() => globalThis.__herdrLink.dispatchEvent(new CustomEvent('ready', { detail: {} })));
  await pause(1200);
}
const afterReopen = await page.evaluate(() => { const f = globalThis.__frames; return { n: f.n, bad: f.reopenBad }; });
check('opened again 5 times: no blank or half-drawn frame', afterReopen.bad.length === 0,
  `${afterReopen.bad.length} bad frames${afterReopen.bad.length ? `; ${[...new Set(afterReopen.bad)].slice(0, 3).join(' | ')}` : ''}`);
const normalAfter = await page.evaluate(() => globalThis.__herdrTerm.buffer.normal.length);
check('… and the history under a full-screen program stays', normalAfter === normalBefore, `${normalBefore} → ${normalAfter} lines`);

writeFileSync('/tmp/relay-size.stop', '');
await pause(500);

// Character widths: herdr-core's screen (Ghostty) says where the cursor is after each one (it answers
// the program's cursor query itself); the phone must draw the "|" after it in that same column.
writeFileSync('/tmp/relay-width.py', `import os, re, sys, termios, tty
S = ['⏺','✳','⎿','❯','●','✻','·','…','✓','⚠','⚠️','👍','✍️','🤖','中','│','╭','▌','⏵']
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)
lines = []
for s in S:
    os.write(1, b'\\r\\x1b[2K' + s.encode() + b'\\x1b[6n')
    b = b''
    while not b.endswith(b'R'): b += os.read(fd, 1)
    lines.append('%s|=%d' % (s, int(re.search(rb';(\\d+)R', b).group(1)) - 1))
termios.tcsetattr(fd, termios.TCSADRAIN, old)
sys.stdout.write('\\r\\x1b[2K' + '\\n'.join(lines) + '\\nWIDTHS_DONE\\n'); sys.stdout.flush()
`);
await page.focus('.term-keys');
await page.keyboard.type('clear; python3 /tmp/relay-width.py');
await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement.blur());
await page.waitForFunction(() => { const b = globalThis.__herdrTerm.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y)?.translateToString(true) === 'WIDTHS_DONE') return true; return false; }, { timeout: 10_000 });
const widths = await page.evaluate(() => {
  const b = globalThis.__herdrTerm.buffer.active, out = [];
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y), text = line?.translateToString(true) ?? '';
    const m = /^(.+)\|=(\d+)$/.exec(text);
    if (!m) continue;
    let col = -1;
    for (let x = 0; x < line.length; x++) if (line.getCell(x)?.getChars() === '|') { col = x; break; }
    out.push({ s: m[1], ghostty: Number(m[2]), phone: col });
  }
  return out;
});
const off = widths.filter((w) => w.ghostty !== w.phone);
// Opened again on the main screen, with history: no blank frame, and the history neither lost nor doubled.
await page.focus('.term-keys');
await page.keyboard.type('for i in $(seq 1 150); do echo hist-$i; done');
await page.keyboard.press('Enter');
await page.evaluate(() => document.activeElement.blur());
await page.waitForFunction(() => { const b = globalThis.__herdrTerm.buffer.active; for (let y = b.length - 1; y >= 0; y--) if (b.getLine(y)?.translateToString(true) === 'hist-150') return true; return false; }, { timeout: 10_000 });
await pause(500);
const histOf = () => page.evaluate(() => { const b = globalThis.__herdrTerm.buffer.normal; let n = 0; for (let y = 0; y < b.length; y++) if (/^hist-\d+$/.test(b.getLine(y)?.translateToString(true) ?? '')) n++; return n; });
const hist0 = await histOf();
await page.evaluate(() => { const f = globalThis.__frames; f.reopenBad = []; });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => { const f = globalThis.__frames; const t = globalThis.__herdrTerm; const b = t.buffer.active;
    const s = []; for (let y = 0; y < t.rows; y++) s.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    f.before = s.join('\n'); f.mode = 'reopen'; });
  await page.evaluate(() => globalThis.__herdrLink.dispatchEvent(new CustomEvent('ready', { detail: {} })));
  await pause(1200);
}
const mainBad = await page.evaluate(() => globalThis.__frames.reopenBad);
const hist1 = await histOf();
check('main screen opened again 3 times: no blank or half-drawn frame', mainBad.length === 0, `${mainBad.length} bad${mainBad.length ? `; ${[...new Set(mainBad)].slice(0, 3).join(' | ')}` : ''}`);
check('… and its history is all there once', hist0 === 150 && hist1 === 150, `hist lines ${hist0} → ${hist1}`);
await page.evaluate(() => { globalThis.__frames.mode = 'off'; });

check(`character widths as herdr-core's Ghostty counts them (${widths.length} kinds)`, widths.length >= 19 && off.length === 0,
  off.map((w) => `${w.s} ghostty ${w.ghostty}, phone ${w.phone}`).join(', '));

mac.release(view.channel);
mac.close();
await browser.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
