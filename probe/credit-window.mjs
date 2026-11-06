// Probe: how much does herdr-core send a viewer that never credits, and what does it send once it does?
// Answer (DESIGN.md「滑动延迟」): a 256 KB window per viewer; behind, it replays old output in order.
//   node probe/credit-window.mjs   (own scratch core HC_SESSION=relay-credit-probe, stopped at the end)
import { openCore } from '../host/hc.js';
const mac = await openCore({ session: 'relay-credit-probe' });
const run = await mac.call('terminal.run', { argv: ['/bin/sh', '-c', 'sleep 0.5; i=0; while [ $i -lt 4000 ]; do printf "\\033[H\\033[2Jframe %d %0200d\\n" $i 0; i=$((i+1)); done; sleep 30'], cwd: '/tmp', rm: true });
const v = await mac.call('terminal.attach', { terminal: run.address, cols: 100, rows: 30, observe: true, resize_notifications: true });
let got = 0, chunks = 0, last = Date.now();
mac.on(v.channel, { onData: (b) => { got += b.length; chunks++; last = Date.now(); } });
await new Promise((r) => setTimeout(r, 3000));
console.log('no credit: received', got, 'bytes in', chunks, 'chunks; idle since', Date.now() - last, 'ms');
// now credit what we got, see if a repaint arrives (falling behind → fresh screen)
let after = '';
mac.on(v.channel, { onData: (b) => { after += b.toString(); } });
mac.credit(v.channel, got);
await new Promise((r) => setTimeout(r, 1500));
console.log('after credit:', after.length, 'bytes; first 120:', JSON.stringify(after.slice(0, 120)));
await mac.call('server.stop').catch(() => {}); mac.close?.(); process.exit(0);
