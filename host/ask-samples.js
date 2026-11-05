/**
 * What a program's question looked like: each time a terminal starts to ask (status → blocked, or
 * a new question while blocked), its screen is kept on this Mac, under `<data dir>/asks/`:
 *
 *   <time>-<app>-<kind>.bin    the screen as herdr-core paints it (raw bytes, no history)
 *   <time>-<app>-<kind>.json   the status (app, kind, msg), the program, the size
 *
 * They never leave the Mac. When a question could not be answered from the phone, they show what
 * it looked like: `node dev/asks.mjs --show`. The newest KEEP are kept.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEEP = 200; // samples (a .bin and a .json each)
const SETTLE_MS = 300; // let the program finish drawing its question
const LISTEN_MS = 500; // a repaint takes one frame; this is plenty

export function createAskSamples({ dir, core, log = () => {}, keep = KEEP, settleMs = SETTLE_MS, listenMs = LISTEN_MS }) {
  const root = join(dir, 'asks');
  const seen = new Map(); // address → the question last kept

  function onStatus({ type, address, terminal }) {
    if (type === 'removed' || type === 'finished') { seen.delete(address); return; }
    if (type !== 'status' || !terminal) return;
    if (terminal.state !== 'blocked') { seen.delete(address); return; }
    const key = `${terminal.kind}\n${terminal.msg}`;
    if (seen.get(address) === key) return;
    seen.set(address, key);
    setTimeout(() => save(terminal).catch((error) => log(`wayne-herdr-mods: 没存下提问样本：${error.message}`)), settleMs);
  }

  async function save(t) {
    const c = core();
    if (!c || !t.cols || !t.rows) return;
    const reply = await c.call('terminal.attach', { terminal: t.address, cols: t.cols, rows: t.rows, history: 0, observe: true });
    const chunks = [];
    c.on(reply.channel, { onData: (b) => chunks.push(Buffer.from(b)) });
    await new Promise((r) => setTimeout(r, listenMs));
    c.release(reply.channel);
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return;
    const name = `${stamp(new Date())}-${slug(t.app || t.program || 'program')}-${slug(t.kind || 'ask')}`;
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, `${name}.bin`), bytes, { mode: 0o600 });
    const meta = { t: Date.now(), address: t.address, app: t.app, program: t.program, kind: t.kind, msg: t.msg, cols: t.cols, rows: t.rows };
    await writeFile(join(root, `${name}.json`), `${JSON.stringify(meta, null, 1)}\n`, { mode: 0o600 });
    await prune();
  }

  async function prune() {
    const names = (await readdir(root)).filter((n) => n.endsWith('.json')).sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      const base = n.slice(0, -'.json'.length);
      await rm(join(root, `${base}.json`), { force: true });
      await rm(join(root, `${base}.bin`), { force: true });
    }
  }

  return { onStatus, root };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x';
