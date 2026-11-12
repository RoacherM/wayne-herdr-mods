// Probe (hc 0.1.20, 2026-11-12): what herdr-core itself can tell an observability board.
//   node probe/board.mjs   — scratch HC_SESSION=probe-board core, never the user's.
// A. labels: do Chinese, long values and '=' survive, and does each change arrive as an event?
// B. parent: does a terminal started with `parent` carry it, and does its exit arrive as an event?
// C. OSC 7501: which wire form does the core accept, and how does a program report a second record?
import { Core, sleep } from './hc.mjs';

const core = await Core.open('probe-board');
const events = [];
const sub = await core.call('events.subscribe', {});
let pending = '';
core.on(sub.channel, { onData(buf) { pending += buf.toString('utf8'); let nl; while ((nl = pending.indexOf('\n')) >= 0) { try { const m = JSON.parse(pending.slice(0, nl)); if (m.method === 'event') events.push(m.params); } catch {} pending = pending.slice(nl + 1); } } });
const since = (n) => events.slice(n).map((e) => `${e.type}@${e.terminal}`).join(' ');

// A. labels
const root = await core.call('terminal.run', { argv: ['/bin/sh'], cwd: '/tmp' });
const long = '决'.repeat(400);
let mark = events.length;
await core.call('terminal.label', { terminal: root.address, labels: { 'wayne.note': '指标存 JSONL，不进 doc（a=b; "引号"）', 'wayne.long': long } });
await sleep(300);
let got = (await core.call('terminal.get', { terminal: root.address })).labels;
console.log('A. label kept as written:', got['wayne.note'] === '指标存 JSONL，不进 doc（a=b; "引号"）', '| 400 字 kept:', got['wayne.long'] === long, '| events:', since(mark));
mark = events.length;
await core.call('terminal.label', { terminal: root.address, labels: { 'wayne.note': '指标存 JSONL，不进 doc（a=b; "引号"）' } });
await sleep(300);
console.log('A. same value again → events:', since(mark) || '(none)');
console.log('A. label event data keys:', Object.keys(events.find((e) => e.type === 'labels')?.data ?? {}).join(','));

// B. parent
mark = events.length;
const kid = await core.call('terminal.run', { argv: ['/bin/sh', '-c', 'sleep 1; exit 3'], cwd: '/tmp', parent: root.address, name: 'kid', no_notify: true });
const kidNow = await core.call('terminal.get', { terminal: kid.address });
await sleep(2000);
const kidEnd = await core.call('terminal.get', { terminal: kid.address });
console.log('B. child parent:', kidNow.parent, '| name:', kidNow.name, '| after exit: state', kidEnd.state, 'exit_code', kidEnd.exit_code, '| events:', since(mark));

// C. OSC 7501 wire form. Each candidate is printed by a program of its own that then stays in front
// (a shell coming back to the front clears the status, so printing from the shell proves nothing).
// Result (hc 0.1.20): none of these is taken; only the query below is answered. The format has no
// public description, so the board does not send reports of its own (DESIGN.md「观测面板」).
const forms = {
  'k=v;': '\\033]7501;state=working;app=probe;msg=hello\\007',
  'k=v:': '\\033]7501;state=working:app=probe:msg=hello\\007',
  ':k=v:': '\\033]7501;:state=working:app=probe:msg=hello\\007',
  ';k=v:': '\\033]7501;;state=working:app=probe:msg=hello\\007',
  'word': '\\033]7501;working\\007',
  'word;msg': '\\033]7501;working;hello\\007',
  'json': '\\033]7501;{"state":"working","app":"probe","msg":"hello"}\\007',
  ';json': '\\033]7501;;{"state":"working","app":"probe","msg":"hello"}\\007',
  'id;json': '\\033]7501;sub1;{"state":"working","app":"probe","title":"child"}\\007',
  'id:k=v': '\\033]7501;sub1:state=working:app=probe:title=child\\007',
  'k=v ST': '\\033]7501;state=working;app=probe\\033\\\\',
};
for (const [name, seq] of Object.entries(forms)) {
  const r = await core.call('terminal.run', { argv: ['/bin/sh', '-c', `printf '${seq}'; sleep 2`], cwd: '/tmp', rm: true });
  await sleep(700);
  const t = await core.call('terminal.get', { terminal: r.address });
  console.log(`C. ${name.padEnd(9)} → reported ${t.reported} status ${JSON.stringify(t.status)} records ${JSON.stringify(t.records)}`);
}
await core.call('terminal.send', { terminal: root.address, text: "printf '\\033]7501;?\\007'", force: true }).catch(() => {});
await sleep(700);
const screen = await core.call('terminal.read', { terminal: root.address, lines: 0 }).catch(() => null);
console.log('C. query answer:', JSON.stringify((screen?.text ?? '').split('\n').filter(Boolean).slice(-1)));

await core.call('terminal.kill', { terminal: root.address }).catch(() => {});
await core.call('server.stop').catch(() => {});
core.close();
process.exit(0);
