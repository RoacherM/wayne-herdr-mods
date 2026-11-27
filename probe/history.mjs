// Can the phone get older history by attaching again with a larger `history`? (DESIGN.md「往回翻历史」)
// On a scratch herdr-core (HC_SESSION=relay-history), never Herdr.app's own:
//   1. a terminal prints 3000 numbered, colored lines;
//   2. view A attaches with history 150 (the first paint now); a typer leads at 57x40;
//   3. view B attaches with history 600, 2000, 5000 while A stays attached: lines, bytes, and the
//      grid each paint is drawn at; and whether A sees anything when B comes and goes.
//   node probe/history.mjs
import { openCore } from '../host/hc.js';

const SESSION = 'relay-history';
{ const old = await openCore({ session: SESSION }); await old.call('server.stop').catch(() => {}); old.close(); await new Promise((r) => setTimeout(r, 500)); }
const core = await openCore({ session: SESSION });
const script = `for i in $(seq 1 3000); do printf '\\033[3%dmline %04d\\033[0m some text to make it a little longer\\n' $((i % 7 + 1)) $i; done; sleep 100000`;
const { address } = await core.call('terminal.run', { argv: ['/bin/sh', '-c', script], cwd: '/tmp', rm: true });
await new Promise((r) => setTimeout(r, 1500));

/** Attach, collect bytes until quiet for 300 ms, give credit as we go. */
async function view(history, { observe = true, cols = 120, rows = 40, keep = false } = {}) {
  const reply = await core.call('terminal.attach', { terminal: address, cols, rows, history, observe, resize_notifications: true });
  const chunks = [];
  let resizes = [];
  let quiet;
  const done = new Promise((resolve) => {
    const bump = () => { clearTimeout(quiet); quiet = setTimeout(resolve, 300); };
    core.on(reply.channel, {
      onData: (b) => { chunks.push(Buffer.from(b)); core.credit(reply.channel, b.length); bump(); },
      onResize: (c, r) => { resizes.push(`${c}x${r}`); bump(); },
      onClose: () => resolve(),
    });
    bump();
  });
  await done;
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString('utf8');
  const nums = [...text.matchAll(/line (\d{4})/g)].map((m) => Number(m[1]));
  const out = { history, bytes: bytes.length, kb: Math.round(bytes.length / 1024), first: nums[0] ?? null, last: nums.at(-1) ?? null, lines: nums.length, grid: `${reply.terminal?.cols}x${reply.terminal?.rows}`, resizes };
  if (!keep) core.release(reply.channel);
  return { ...out, channel: reply.channel, chunks };
}

// The phone's typer leads at its own grid, as a phone does.
const typer = await core.call('terminal.attach', { terminal: address, cols: 57, rows: 40, history: 0 });
core.on(typer.channel, { onData: (b) => core.credit(typer.channel, b.length), onResize: () => {}, onClose: () => {} });
await new Promise((r) => setTimeout(r, 500));

const a = await view(150, { keep: true });
console.log('A', JSON.stringify({ ...a, chunks: undefined }));
let aAfter = 0;
core.on(a.channel, { onData: (b) => { aAfter += b.length; core.credit(a.channel, b.length); }, onResize: () => {}, onClose: () => {} });
for (const h of [600, 2000, 5000]) {
  const t0 = Date.now();
  const b = await view(h);
  console.log('B', JSON.stringify({ ...b, chunks: undefined, ms: Date.now() - t0 - 300 }));
}
await new Promise((r) => setTimeout(r, 500));
console.log('A saw while B came and went:', aAfter, 'bytes');
const t = await core.call('terminal.get', { terminal: address }).catch(() => null);
console.log('grid now', t?.cols, t?.rows);
await core.call('server.stop').catch(() => {});
core.close();
process.exit(0);
