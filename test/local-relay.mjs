// A relay of the test's own: `wrangler dev` on a free port, its Durable Object state and static
// folder in a temp dir. So `npm test` needs nothing started by hand, and never shares state with
// a relay you run yourself (`npm run relay:dev` on 8799).
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export async function startLocalRelay({ timeoutMs = 60_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wayne-relay-test-'));
  await mkdir(join(dir, 'public'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '-c', 'relay/wrangler.jsonc',
    '--ip', '127.0.0.1', '--port', String(port), '--persist-to', join(dir, 'state'), '--assets', join(dir, 'public'),
    '--show-interactive-dev-session=false', '--log-level', 'warn',
  ], { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  const exited = new Promise((r) => child.once('exit', r));
  const stop = async () => {
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await exited; }
    await rm(dir, { recursive: true, force: true });
  };
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) { await stop(); throw new Error(`wrangler dev exited: ${err.slice(-500)}`); }
    // Any HTTP answer (even 404 from the empty static folder) means the Worker is up.
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)) return { url, stop };
    if (Date.now() > end) { await stop(); throw new Error(`wrangler dev not up after ${timeoutMs} ms: ${err.slice(-500)}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
}
