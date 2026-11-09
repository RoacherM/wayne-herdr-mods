// Probe (hc 0.1.19, 2026-11-09): after a client CLOSE on a stream channel, does herdr-core
// echo a CLOSE, and does it reuse the channel id for the next attach?
//   node probe/release.mjs   — scratch HC_SESSION=probe-release core, never the user's.
import { Core, DATA, CLOSE, sleep } from './hc.mjs';

const core = await Core.open('probe-release');
const run = await core.call('terminal.run', { argv: ['/bin/sh', '-c', 'sleep 60'], cwd: '/tmp', rm: true });
const a1 = await core.call('terminal.attach', { terminal: run.address, cols: 80, rows: 24, observe: true });
console.log('attach 1 → channel', a1.channel);

const seen = [];
const orig = core.frame.bind(core);
core.frame = (ch, kind, payload) => { seen.push({ ch, kind }); return orig(ch, kind, payload); };

core.send(a1.channel, CLOSE); // client detaches
await sleep(500);
const echo = seen.filter((f) => f.ch === a1.channel);
console.log('frames on released channel after client CLOSE:', JSON.stringify(echo));

const a2 = await core.call('terminal.attach', { terminal: run.address, cols: 80, rows: 24, observe: true });
console.log('attach 2 → channel', a2.channel, a2.channel === a1.channel ? '(REUSED)' : '(new id)');

await core.call('terminal.kill', { terminal: run.address }).catch(() => {});
await core.call('server.stop').catch(() => {});
core.close();
process.exit(0);
