// Does a full-screen program redraw once for a batch of wheel steps, or once per step?
// (DESIGN.md「滑动延迟」). Opens a copied Claude Code session in a scratch core and sends 20 wheel
// steps three ways, counting the bytes the program writes back.
//   node probe/wheel-batch.mjs <session-id> <cwd>
import { openCore } from '../host/hc.js';
const [id, cwd] = process.argv.slice(2);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const mac = await openCore({ session: 'relay-wheel-probe' });
const run = await mac.call('terminal.run', { argv: ['/opt/homebrew/bin/claude', '--resume', id], cwd, rm: true });
const v = await mac.call('terminal.attach', { terminal: run.address, cols: 60, rows: 40 });
let bytes = 0, chunks = 0, text = '', last = Date.now(), first = null;
mac.on(v.channel, { onData: (b) => { bytes += b.length; chunks++; text += b.toString(); last = Date.now(); first ??= Date.now(); mac.credit(v.channel, b.length); } });
const quiet = async (ms = 600, max = 20000) => { const t0 = Date.now(); while (Date.now() - last < ms && Date.now() - t0 < max) await pause(50); };
const send = (s) => mac.send(v.channel, 0, Buffer.from(s));
await pause(4000); await quiet(1500);
const screen = () => text.replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, ' ').replace(/\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\s+/g, ' ').slice(-300);
console.log('start:', bytes, 'bytes; alt screen', text.includes('\x1b[?1049h'), '; mouse', /\x1b\[\?100[0236]h/.test(text), '\n  …', screen());
if (/trust/i.test(screen())) { send('\x1b[B'); await pause(300); send('\r'); await pause(4000); await quiet(1500); console.log('after trust:', screen()); }
const UP = '\x1b[<64;30;20M', DOWN = '\x1b[<65;30;20M';
async function trial(name, fn) {
  await quiet();
  bytes = 0; chunks = 0; first = null;
  const t0 = Date.now();
  await fn();
  const sentAt = Date.now();
  last = Math.max(last, sentAt); // wait for an answer, not only for silence
  await quiet(800);
  console.log(`${name.padEnd(26)} ${String(bytes).padStart(7)} bytes ${String(chunks).padStart(4)} chunks; first after ${first ? first - t0 : '-'} ms; quiet ${last - sentAt} ms after the last step`);
}
console.log('modes seen:', [...new Set(text.match(/\x1b\[\?[0-9;]+[hl]/g))].map((m) => m.slice(2)).join(' '));
await trial('warm up: 30 × 1, 30 ms (up)', async () => { for (let i = 0; i < 30; i++) { send(UP); await pause(30); } });
for (const [dir, D] of [['up', UP], ['down', DOWN], ['up', UP]]) {
  await trial(`1 step (${dir})`, async () => { send(D); });
  await trial(`20 × 1 step, 8 ms (${dir})`, async () => { for (let i = 0; i < 20; i++) { send(D); await pause(8); } });
  await trial(`20 steps, one write (${dir})`, async () => { send(D.repeat(20)); });
  await trial(`5 steps, one write (${dir})`, async () => { send(D.repeat(5)); });
}
await mac.call('server.stop').catch(() => {}); mac.close?.(); process.exit(0);
