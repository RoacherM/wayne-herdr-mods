// The questions kept on this Mac (host/ask-samples.js), as text: what each program's question
// looked like, to see why a phone could not answer it.
//
//   node dev/asks.mjs            one line per sample: when, which program, its status
//   node dev/asks.mjs --show     and the bottom of each screen
//   node dev/asks.mjs <dir>      samples from elsewhere (default: <data dir>/asks)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import xh from '@xterm/headless';
import { defaultDataDir } from '../host/state.js';

const show = process.argv.includes('--show');
const dir = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(defaultDataDir(), 'asks');
let names = [];
try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { /* none yet */ }
if (!names.length) { console.log(`${dir} 里还没有样本：终端下次问你时会存一份。`); process.exit(0); }

for (const n of names) {
  const meta = JSON.parse(readFileSync(join(dir, n), 'utf8'));
  console.log(`${n.replace(/\.json$/, '')}  ${meta.kind ?? '-'}  ${(meta.msg ?? '').slice(0, 60)}`);
  if (!show) continue;
  const term = new xh.Terminal({ cols: meta.cols, rows: meta.rows, allowProposedApi: true });
  await new Promise((r) => term.write(readFileSync(join(dir, n.replace(/\.json$/, '.bin'))), r));
  const b = term.buffer.active, rows = [];
  for (let y = 0; y < meta.rows; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
  console.log(rows.filter((r) => r.trim()).slice(-20).map((r) => `    | ${r}`).join('\n'));
  term.dispose();
}
console.log(`\n${names.length} 份样本。`);
