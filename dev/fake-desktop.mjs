// A stand-in Mac for UI work: a scratch herdr-core (HC_SESSION=relay-ui) with a few terminals in
// different states, a herdr-app layout doc, and the host service on the local relay.
//   npm run relay:dev   # in another shell
//   node dev/fake-desktop.mjs          # prints a pairing link; auto-approves the pairing
// Ctrl-C stops the scratch core. Herdr.app's own core is never touched.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCore } from '../host/hc.js';
import { controlCall, startService } from '../host/service.js';

const RELAY = process.env.RELAY ?? 'http://127.0.0.1:8799';
// REAL_VOICE=1 uses the key in the keychain (real recognition); otherwise a fake key just shows the mic.
if (!process.env.REAL_VOICE) process.env.HERDR_RELAY_VOLC_KEY ??= 'fake-key-for-ui';
const SESSION = 'relay-ui';
const r = (s) => `printf '\\033]7501;${s}\\033\\\\'`;
const b64 = (s) => Buffer.from(s).toString('base64');

const mac = await openCore({ session: SESSION });
const term = async (script, where, cwd = '/tmp') => (await mac.call('terminal.run', { argv: ['/bin/sh', '-c', script], cwd, labels: { where }, rm: true })).address;
// A process named `claude` (a copied system shell is killed by macOS; a tiny compiled one is not),
// so the host finds a "Claude Code" transcript for it in the made-up home below.
const fakeBin = await mkdtemp(join(tmpdir(), 'herdr-relay-bin-'));
await writeFile(join(fakeBin, 'claude.c'), '#include <stdlib.h>\nint main(int c, char **v) { return c > 1 ? system(v[1]) : 0; }\n');
execFileSync('cc', ['-O1', '-o', join(fakeBin, 'claude'), join(fakeBin, 'claude.c')]);
const asClaude = async (script, where) => (await mac.call('terminal.run', { argv: [join(fakeBin, 'claude'), script], cwd: '/tmp', labels: { where }, rm: true })).address;
const shell = (await mac.call('terminal.run', { argv: ['/bin/zsh', '-f'], cwd: process.env.HOME, labels: { where: 'herdr-relay · shell' }, rm: true })).address;
const claude = await asClaude(`${r('state=working:app=claude')}; printf '\\033[1m● 正在修改 host/phones.js\\033[0m\\n'; sleep 1; printf '  ⎿ 已更新 3 处\\n\\n'; ${r(`state=blocked:kind=permission:app=claude:msg=${b64('要运行 npm test 吗？')}`)}; printf '\\033[33m要运行 npm test 吗？\\033[0m\\n ❯ 1. 是\\n   2. 是，以后都允许\\n   3. 否\\n'; stty -echo; while read -r l; do echo "你选了 $l"; ${r('state=working:app=claude')}; sleep 2; ${r('state=done:app=claude')}; done`, 'herdr-relay · claude');
const codex = await term(`${r('state=working:app=codex')}; for i in $(seq 1 30); do echo "step $i: building…"; sleep 0.2; done; ${r(`state=done:app=codex:msg=${b64('测试全部通过')}`)}; sleep 100000`, 'site / 1');
const logs = await term(`while true; do date '+%H:%M:%S  GET /v1/health 200'; sleep 2; done`, 'site / 2');

const leaf = (t) => ({ content: { terminal: t } });
const doc = await mac.call('doc.get', { name: 'herdr-app' });
await mac.call('doc.set', { name: 'herdr-app', version: doc.version, value: { spaces: [
  { id: 's1', name: 'herdr-relay', folder: '~/Projects/sides/herdr-relay', tabs: [{ id: 'a', name: 'main', root: { children: [leaf(claude), leaf(shell)] } }] },
  // No name: Herdr.app shows it after where its terminals are now ("site"), not the folder it was made in.
  { id: 's2', name: '', folder: '~/Projects/old-site', tabs: [{ id: 'b', name: 'build', root: leaf(codex) }, { id: 'c', name: 'logs', root: leaf(logs) }] },
] } });
// A Mac window viewing the claude terminal at a desktop size.
for (const t of [claude, shell, codex, logs]) await mac.call('terminal.attach', { terminal: t, cols: 110, rows: 34 });

// A made-up home with the claude terminal's transcript: 150 turns, so the conversation view pages.
const home = await mkdtemp(join(tmpdir(), 'herdr-relay-home-'));
let claudePid = null;
for (let i = 0; i < 50 && !claudePid; i++) { const t = await mac.call('terminal.get', { terminal: claude }); if (t.foreground?.name === 'claude') claudePid = t.foreground.pid; else await new Promise((r) => setTimeout(r, 100)); }
const sessionId = '0f0f0f0f-1111-2222-3333-444444444444';
await mkdir(join(home, '.claude', 'sessions'), { recursive: true });
await mkdir(join(home, '.claude', 'projects', '-tmp'), { recursive: true });
await writeFile(join(home, '.claude', 'sessions', `${claudePid}.json`), JSON.stringify({ pid: claudePid, sessionId, cwd: '/tmp' }));
const convFile = join(home, '.claude', 'projects', '-tmp', `${sessionId}.jsonl`);
const line = (type, content) => JSON.stringify({ parentUuid: null, isSidechain: false, type, message: { role: type, content }, timestamp: new Date().toISOString() });
const turns = [];
for (let i = 1; i <= 150; i++) {
  turns.push(line('user', `第 ${i} 个问题：host/phones.js 里的第 ${i} 处要怎么改？`));
  turns.push(line('assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: `先看一下第 ${i} 处。` }, { type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: `grep -n "case ${i}" host/phones.js` } }]));
  turns.push(line('user', [{ type: 'tool_result', tool_use_id: `tu${i}`, content: `${i}:  case ${i}: return x;` }]));
  turns.push(line('assistant', [{ type: 'text', text: `**第 ${i} 处**改好了：\n\n- 去掉了重复的分支\n- 加了 \`return\`\n\n\`\`\`js\ncase ${i}: return y;\n\`\`\`` }]));
}
await writeFile(convFile, `${turns.join('\n')}\n`);
console.log(`CONV ${convFile}`);
const dataDir = process.env.DATA_DIR ?? await mkdtemp(join(tmpdir(), 'herdr-relay-ui-'));
const svc = await startService({ relayUrl: RELAY, dataDir, coreOptions: { session: SESSION }, log: (m) => console.error(m), home });
for (;;) { const v = await controlCall(dataDir, 'status'); if (v.relay === 'online' && v.core === 'online') break; await new Promise((res) => setTimeout(res, 200)); }
const start = await controlCall(dataDir, 'pair.start');
console.log(`LINK ${start.pairing.offer.link}`);
(async () => { for (;;) { const v = await controlCall(dataDir, 'watch', { ms: 20_000 }); if (v.pairing.request) { await controlCall(dataDir, 'pair.decide', { allow: true }); console.log('PAIRED'); } } })();
const stop = async () => { await svc.stop(); await mac.call('server.stop').catch(() => {}); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
