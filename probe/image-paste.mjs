// Needs: python3, and the agents to test on PATH (claude, codex, agy), signed in. No Herdr, no relay.
// How agents take an image path pasted into their input line (DESIGN.md「发图片（已实现）」): each agent
// runs in its own PTY (100x30) in a temp folder with a small PNG; we paste the path per mode, type
// "XY", and print the input line as @xterm/headless draws it. Nothing is submitted.
//   node probe/image-paste.mjs [claude|codex|agy ...]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import xh from '@xterm/headless';

/** A valid 64x64 PNG (a solid square), so the agents see a real image. */
function png64() {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 64 }, () => Buffer.from([0, ...Array(64).fill([200, 60, 60]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// How to get past each agent's start dialogs (versions of 2026-11-07).
const AGENTS = {
  claude: { start: [6, ['\x1b[B', 0.5], ['\r', 5]], line: /^❯/ },            // trust prompt defaults to "No, exit"
  codex: { start: [6, ['\x1b', 3], ['\x1b', 3]], line: /^›/ },                 // update notice, hooks review: skip both
  agy: { start: [6, ['\r', 5]], line: /^> |attached/ },                         // trust prompt defaults to "Yes"
};
// Each mode: writes as [bytes, pause seconds]. P is the bracketed paste of the image path.
const MODES = {
  'path only': (P) => [[P, 0]],
  'path, 400 ms, space (old)': (P) => [[P, 0.4], [' ', 0]],
  'path+space in one write': (P) => [[`${P} `, 0]],
  'two images, 400 ms apart': (P) => [[P, 0.4], [P, 0]],
};

const PTY = String.raw`
import os, pty, sys, time, select, json, signal, struct, fcntl, termios
agent, cwd, out, plan = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.environ['TERM'] = 'xterm-256color'; os.execvp(agent, [agent])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
buf = bytearray()
def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        if select.select([fd], [], [], 0.05)[0]:
            try: buf.extend(os.read(fd, 65536))
            except OSError: return
for data, pause in plan:
    if data: os.write(fd, data.encode())
    pump(pause)
open(out, 'wb').write(bytes(buf))
os.kill(pid, signal.SIGKILL)
`;

async function screen(raw) {
  const term = new xh.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  await new Promise((r) => term.write(raw, r));
  const b = term.buffer.active;
  return Array.from({ length: term.rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? '');
}

const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(AGENTS);
const dir = mkdtempSync(join(tmpdir(), 'image-paste-'));
const png = join(dir, 'shot.png');
writeFileSync(png, png64());
const P = `\x1b[200~${png}\x1b[201~`;
for (const name of which) {
  const agent = AGENTS[name];
  let version = '?';
  try { version = execFileSync(name, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]; } catch {}
  console.log(`\n${name} ${version}`);
  for (const [mode, writes] of Object.entries(MODES)) {
    const [wait, ...steps] = agent.start;
    const plan = [['', wait], ...steps, ...writes(P), ['', 2], ['XY', 2]];
    const out = join(dir, `${name}.raw`);
    execFileSync('python3', ['-I', '-c', PTY, name, dir, out, JSON.stringify(plan)], { stdio: 'inherit', timeout: 60_000 });
    const lines = (await screen(readFileSync(out))).filter((l) => agent.line.test(l.trim())).map((l) => l.trimEnd());
    console.log(`  ${mode.padEnd(28)} ${JSON.stringify(lines)}`);
  }
}
