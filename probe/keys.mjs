// Probe: what bytes herdr-core's terminal.keys sends for key combos (ctrl+enter, alt+m, shift+enter…),
// with the program asking for the legacy encoding, for xterm's modifyOtherKeys, or for the kitty
// keyboard protocol. Runs on its own scratch core (HC_SESSION=relay-keys-probe); nothing else.
//   node probe/keys.mjs
import { Core, sleep } from './hc.mjs';

const SESSION = 'relay-keys-probe';
const KEYS = ['enter', 'ctrl+enter', 'shift+enter', 'alt+enter', 'alt+m', 'ctrl+j', 'shift+tab', 'ctrl+c', 'alt+up', 'ctrl+left', 'ctrl+shift+p', 'ctrl+o', 'ctrl+t', 'esc'];
// A raw-mode reader: asks for a keyboard mode, then prints the hex of what it reads, one line per read.
const reader = (enable) => `import os,sys,tty,termios
fd=0; tty.setraw(fd); sys.stdout.write(${JSON.stringify(enable)}+"READY\\r\\n"); sys.stdout.flush()
while True:
  b=os.read(fd,64)
  sys.stdout.write("<"+b.hex()+">\\r\\n"); sys.stdout.flush()`;
const MODES = { legacy: '', modifyOtherKeys2: '\x1b[>4;2m', kitty1: '\x1b[>1u', kitty_all: '\x1b[>31u' };

const core = await Core.open(SESSION);
const rows = {};
try {
  for (const [mode, enable] of Object.entries(MODES)) {
    const run = await core.call('terminal.run', { argv: ['/usr/bin/python3', '-c', reader(enable)], cwd: '/tmp', labels: { probe: 'keys' }, rm: true });
    const t = run.address;
    const read = async () => (await core.call('terminal.read', { terminal: t, lines: 200 })).text;
    for (let i = 0; i < 50 && !(await read()).includes('READY'); i++) await sleep(100);
    rows[mode] = {};
    for (const k of KEYS) {
      const before = ((await read()).match(/<[0-9a-f]*>/g) ?? []).length;
      let err = null;
      try { await core.call('terminal.keys', { terminal: t, keys: [k] }); } catch (e) { err = e.message; }
      let got = [];
      for (let i = 0; i < 20; i++) { got = ((await read()).match(/<[0-9a-f]*>/g) ?? []).slice(before); if (got.length || err) break; await sleep(50); }
      await sleep(60);
      got = ((await read()).match(/<[0-9a-f]*>/g) ?? []).slice(before);
      rows[mode][k] = err ? `ERR ${err}` : got.map((g) => g.slice(1, -1)).join(' ');
    }
    await core.call('terminal.kill', { terminal: t }).catch(() => {});
  }
} finally {
  await core.call('server.stop').catch(() => {}); // our own scratch core only
  core.close();
}
const show = (hex) => hex.startsWith('ERR') ? hex : Buffer.from(hex.replace(/ /g, ''), 'hex').toString('latin1').replace(/\x1b/g, 'ESC').replace(/[\x00-\x1f]/g, (c) => `^${String.fromCharCode(c.charCodeAt(0) + 64)}`);
console.log(['key', ...Object.keys(MODES)].join('\t'));
for (const k of KEYS) console.log([k, ...Object.keys(MODES).map((m) => show(rows[m][k] ?? ''))].join('\t'));
