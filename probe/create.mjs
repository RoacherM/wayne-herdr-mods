// Probe: can the host create a new tab in Herdr.app, and what does it do to the person's screen?
//   node probe/create.mjs [space-id]
// Makes TWO short-lived tabs in one space (default: the one named herdr-relay), each running a
// shell that prints a line and exits after 30 s. Herdr closes a pane whose program exits, and the
// tab with it. Anything left over is closed at the end. Records focus before and after each step.
//
//   A  herdr-app do tab.new --space S --name … --argv […]      (the app's own command)
//   B  hc terminal.run with labels herdr.space=S               (core only; the app adopts it)
// Each also runs from a child with a LaunchAgent-like environment (env -i, minimal PATH) to see
// whether the background service can do the same.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { openCore } from '../host/hc.js';

const APP = `${homedir()}/.local/bin/herdr-app`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

function app(args, { bare = false } = {}) {
  // bare: the environment launchd gives a LaunchAgent (no HC_TERMINAL_ID, no TERM, minimal PATH).
  const env = bare ? { HOME: homedir(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', USER: process.env.USER } : process.env;
  return new Promise((resolve) => execFile(APP, args, { env, timeout: 15_000 }, (error, stdout, stderr) => {
    let json = null;
    try { json = JSON.parse(stdout); } catch {}
    resolve({ code: error ? (error.code ?? 1) : 0, json, stdout: stdout.trim(), stderr: stderr.trim() });
  }));
}
const status = async () => (await app(['status'])).json;
const ls = async () => (await app(['ls'])).json;
const focusOf = (s) => (s ? { space: s.space, tab: s.tab, pane: s.focused_pane, agent: s.agent } : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tabsOf = (tree, space) => tree.spaces.find((s) => s.id === space)?.tabs ?? [];

const tree0 = await ls();
const space = process.argv[2] ?? tree0.spaces.find((s) => s.name === 'herdr-relay')?.id;
if (!space) throw new Error('no space named herdr-relay; pass a space id');
const before = tabsOf(tree0, space).map((t) => t.id);
console.log(`space ${space}, tabs before: ${before.length}`);
const script = (tag) => `echo "herdr-relay probe ${tag}: this tab closes itself in 30 s"; sleep 30`;

// ---------------------------------------------------------------- A: herdr-app do tab.new
const f0 = focusOf(await status());
const a = await app(['do', 'tab.new', '--space', space, '--name', 'relay-probe A', '--argv', JSON.stringify(['/bin/sh', '-c', script('A')])], { bare: true });
await sleep(1500);
const f1 = focusOf(await status());
const tabA = tabsOf(await ls(), space).find((t) => !before.includes(t.id));
note('A: herdr-app do tab.new works from a LaunchAgent-like env', a.code === 0 && Boolean(tabA), `exit ${a.code} ${a.stdout || a.stderr}`.slice(0, 200));
note('A: focus unchanged after tab.new', same(f0, f1), same(f0, f1) ? '' : `before ${JSON.stringify(f0)} after ${JSON.stringify(f1)}`);
const termA = tabA?.terminals?.[0]?.terminal;
note('A: tab has the name we gave', tabA?.name === 'relay-probe A', `name=${JSON.stringify(tabA?.name)} terminal=${termA}`);

// ---------------------------------------------------------------- B: hc terminal.run + labels
const core = await openCore();
const f2 = focusOf(await status());
const tabsBeforeB = tabsOf(await ls(), space).map((t) => t.id);
let runB;
try {
  runB = await core.call('terminal.run', { argv: ['/bin/sh', '-c', script('B')], cwd: homedir(), labels: { 'herdr.space': space }, keep: false, no_parent: true });
} catch (error) { runB = { error: error.message }; }
await sleep(2500);
const f3 = focusOf(await status());
const treeB = await ls();
const tabB = tabsOf(treeB, space).find((t) => !tabsBeforeB.includes(t.id));
note('B: terminal.run with herdr.space label shows up as a new tab', Boolean(tabB), `terminal=${runB.address ?? runB.error} tab=${tabB?.id ?? '—'} name=${JSON.stringify(tabB?.name)}`);
note('B: focus unchanged', same(f2, f3), same(f2, f3) ? '' : `before ${JSON.stringify(f2)} after ${JSON.stringify(f3)}`);
const recB = runB.address ? await core.call('terminal.get', { terminal: runB.address }) : null;
note('B: Herdr added herdr.tab to the record', Boolean(recB?.labels?.['herdr.tab']), JSON.stringify(recB?.labels ?? {}));

// ---------------------------------------------------------------- the programs exit by themselves
console.log('waiting 33 s for both programs to exit…');
await sleep(33_000);
const after = tabsOf(await ls(), space);
const left = after.filter((t) => !before.includes(t.id));
note('exited programs close their tabs', left.length === 0, left.length ? `left: ${left.map((t) => `${t.id}(${t.name})`).join(', ')}` : '');
for (const t of left) await app(['do', 'tab.close', '--id', t.id, '--confirmed', 'true']);
if (left.length) { await sleep(800); note('leftovers closed by the probe', tabsOf(await ls(), space).every((t) => before.includes(t.id))); }
const fEnd = focusOf(await status());
note('focus at the end equals focus at the start', same(f0, fEnd), same(f0, fEnd) ? '' : `start ${JSON.stringify(f0)} end ${JSON.stringify(fEnd)}`);
core.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} pass`);
