// A program that asks as Claude Code does, for dev/term-smoke.mjs: two questions under tabs, a
// Submit step, then a permission prompt. ↑/↓ move the ❯, ⏎ picks, Esc cancels. It says what it
// asks with OSC 7501 (blocked, question / permission), and prints what was picked.
const out = (s) => process.stdout.write(s);
const status = (s, msg = '') => out(`\x1b]7501;state=${s}${msg ? `:msg=${Buffer.from(msg).toString('base64')}` : ''}:app=claude\x1b\\`);
const RULE = '─'.repeat(50);

const steps = [
  { tab: 0, q: '这次改动做到哪一步？', opts: [['全部', '手机和 Mac 一起改。'], ['只要手机', '先不动 Mac。'], ['Type something.', '']] },
  { tab: 1, q: '新功能叫什么名字？', opts: [['ask', ''], ['prompt (Recommended)', '和 Claude Code 的叫法一样。']] },
  { tab: 2, q: 'Review your answers', opts: [['Submit answers', ''], ['Cancel', '']] },
];
const permission = { q: 'Do you want to proceed?', opts: [['Yes', ''], ["Yes, and don't ask again for npm test commands", ''], ['No, and tell Claude what to do differently (esc)', '']] };
let at = 0, sel = 0, picked = [], mode = 'questions';

function draw() {
  const s = mode === 'questions' ? steps[at] : permission;
  let txt = '\x1b[?25l\x1b[2J\x1b[H⏺ 先问两个问题。\r\n';
  if (mode === 'questions') {
    const names = ['范围', '名字'];
    txt += `${RULE}\r\n←  ${names.map((n, k) => `${picked[k] ? '☒' : '☐'} ${n}`).join('  ')}  ✔ Submit  →\r\n\r\n`;
    txt += `│ ${s.q}\r\n\r\n`;
  } else txt += ` Bash command\r\n\r\n   npm test\r\n\r\n ${s.q}\r\n`;
  s.opts.forEach(([label, desc], k) => {
    txt += `${k === sel ? '\x1b[36m❯' : ' '} ${k + 1}. ${label}\x1b[0m\r\n`;
    if (desc) txt += `     \x1b[2m${desc}\x1b[0m\r\n`;
  });
  txt += `\r\n${mode === 'questions' ? 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel' : 'Esc to cancel'}\r\n`;
  out(txt);
  status('blocked', s.q);
}

function pick() {
  const s = mode === 'questions' ? steps[at] : permission;
  const label = s.opts[sel][0];
  if (mode === 'permission') { done(`授权：${label}`); return; }
  if (at < 2) { picked[at] = label; at++; sel = 0; draw(); return; }
  if (label === 'Cancel') { done('取消了'); return; }
  out(`\x1b[2J\x1b[H答案：${picked.join(' / ')}\r\n`);
  status('working');
  setTimeout(() => { mode = 'permission'; sel = 0; draw(); }, 600);
}
function done(text) { out(`\x1b[2J\x1b[H${text}\r\n\x1b[?25h`); status('done'); mode = 'over'; }

process.stdin.setRawMode?.(true);
process.stdin.on('data', (b) => {
  let s = b.toString();
  while (s && mode !== 'over') {
    const n = (mode === 'questions' ? steps[at] : permission).opts.length;
    if (s.startsWith('\x1b[A') || s.startsWith('\x1bOA')) { sel = Math.max(0, sel - 1); s = s.slice(3); draw(); }
    else if (s.startsWith('\x1b[B') || s.startsWith('\x1bOB')) { sel = Math.min(n - 1, sel + 1); s = s.slice(3); draw(); }
    else if (s[0] === '\r' || s[0] === '\n') { s = s.slice(1); pick(); }
    else if (s[0] === '\x1b') { s = s.slice(1); done('取消了'); }
    else s = s.slice(1);
  }
});
draw();
setInterval(() => {}, 1 << 30);
