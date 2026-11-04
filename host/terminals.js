/**
 * The host's own view of herdr-core: one framed connection that stays subscribed to events.
 *
 * - Keeps a live map of terminals (snapshot + every event, applied as schema/README.md says).
 * - Keeps Herdr.app's layout (the `herdr-app` doc: spaces → tabs → split tree), read-only.
 * - Reconnects with backoff when herdr-core goes away; never starts a core itself.
 * - Reports status changes so the host can push "needs you" / "done" notifications.
 *
 * Phone streams (attach) ride on the same connection: `core()` hands it out.
 */
import { CREDIT, openCore, u32 } from './hc.js';

const THROTTLE_MS = 250;

export function createTerminals({ coreOptions = {}, log = () => {}, onChange = () => {}, onStatus = () => {}, onCore = () => {} }) {
  const terminals = new Map(); // address → record
  let layout = [];
  let core = null;
  let state = 'connecting';
  let stopped = false;
  let attempt = 0;
  let retryTimer;
  let changeTimer;

  const changed = () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = undefined; onChange(); }, THROTTLE_MS);
  };

  async function readLayout() {
    if (!core) return;
    try {
      const doc = await core.call('doc.get', { name: 'herdr-app' });
      layout = projectLayout(doc.value);
      changed();
    } catch (error) {
      log(`wayne-herdr-mods: 读取 Herdr 布局失败：${error.message}`);
    }
  }

  function apply(params) {
    const { type, terminal: address, data = {} } = params;
    if (type === 'doc') { if (data.name === 'herdr-app') readLayout(); return; }
    if (!address) return;
    const t = terminals.get(address);
    const before = t ? { state: t.status?.state ?? null, turn: t.turn } : null;
    switch (type) {
      case 'created':
      case 'restarted':
        terminals.set(address, data);
        break;
      case 'removed':
        terminals.delete(address);
        break;
      case 'lost':
        if (t) { Object.assign(t, data); delete t.pid; t.foreground = null; }
        break;
      case 'finished':
        if (t) { Object.assign(t, data, { state: 'finished' }); t.foreground = null; }
        break;
      case 'status':
        if (t) { t.status = data.status ?? null; t.records = data.records; t.reported = data.reported; t.status_ms = Date.now(); }
        break;
      case 'turn':
        if (t) t.turn = data.turn;
        break;
      case 'labels':
        if (data.record) terminals.set(address, data.record);
        else if (t) t.labels = data.labels;
        break;
      case 'keep': case 'title': case 'size':
        if (t) Object.assign(t, data);
        break;
      case 'foreground':
        if (t) t.foreground = data;
        break;
      default:
        return;
    }
    changed();
    const now = terminals.get(address);
    onStatus({ type, address, terminal: now ? project(now) : null, before, data });
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === 'event') apply(msg.params ?? {});
    else if (msg.method === 'missed') { replace(msg.params?.terminals ?? []); readLayout(); }
  }

  function replace(list) {
    terminals.clear();
    for (const t of list) terminals.set(t.address, t);
    changed();
  }

  async function connect() {
    if (stopped) return;
    try {
      const c = await openCore(coreOptions);
      if (stopped) { c.close(); return; }
      core = c;
      c.onEnd(() => {
        if (core !== c) return;
        core = null;
        setState('offline');
        onCore(null);
        schedule();
      });
      const sub = await c.call('events.subscribe', {});
      replace(sub.terminals ?? []);
      let pending = '';
      c.on(sub.channel, {
        onData(buf) {
          c.send(sub.channel, CREDIT, u32(buf.length));
          pending += buf.toString('utf8');
          let nl;
          while ((nl = pending.indexOf('\n')) >= 0) { onLine(pending.slice(0, nl)); pending = pending.slice(nl + 1); }
        },
        onClose() { if (core === c) c.close(); },
      });
      await readLayout();
      attempt = 0;
      setState('online');
      onCore(c);
    } catch (error) {
      if (state !== 'offline') log(`wayne-herdr-mods: 连不上 herdr-core：${error.message}`);
      setState('offline');
      schedule();
    }
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    if (next === 'offline') { terminals.clear(); layout = []; }
    changed();
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(retryTimer);
    const delay = Math.min(30_000, 1000 * 2 ** attempt);
    attempt = Math.min(attempt + 1, 5);
    retryTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    core: () => core,
    state: () => state,
    get: (address) => terminals.get(address),
    /** Live terminals as herdr-core reports them (argv included: for the host only). */
    raw: () => [...terminals.values()].filter((t) => t.state === 'live'),
    list: () => [...terminals.values()].filter((t) => t.state === 'live').map(project),
    layout: () => layout,
    /** Retry right away (after a wake-up, or when a phone asks). */
    kick() { if (!core && !stopped) { attempt = 0; clearTimeout(retryTimer); connect(); } },
    dispose() { stopped = true; clearTimeout(retryTimer); clearTimeout(changeTimer); core?.close(); },
  };
}

const INTERPRETERS = /^(node|nodejs|python[0-9.]*|bun|deno|ruby|perl|php)$/;

/**
 * The program's name as a person would say it: a script run by an interpreter (`node …/bin/epi`)
 * is named after the script. Only the name goes to the phone, never argv.
 */
export function programOf(fg) {
  if (!fg?.name) return null;
  if (!INTERPRETERS.test(fg.name)) return fg.name;
  const script = (fg.argv ?? []).slice(1).find((a) => !a.startsWith('-'));
  if (!script || !/[/.]/.test(script)) return fg.name; // `bun run dev`: no script file
  return script.split('/').pop().replace(/\.(m?js|cjs|ts|py|rb|pl|php)$/, '') || fg.name;
}

/** What a phone sees of one terminal. Never argv or env: only display facts. */
export function project(t) {
  const status = t.status ?? null;
  return {
    address: t.address,
    name: t.name ?? null,
    title: t.title ?? null,
    where: t.labels?.where ?? null,
    space: t.labels?.['herdr.space'] ?? null,
    tab: t.labels?.['herdr.tab'] ?? null,
    cwd: t.foreground?.cwd ?? t.cwd ?? null,
    program: programOf(t.foreground),
    app: status?.app || null,
    state: status?.state ?? null, // idle | working | done | blocked | error | null (never reported)
    kind: status?.kind ?? null, // permission | question | auth (blocked only)
    msg: status?.msg || null,
    progress: status?.progress ?? null,
    statusMs: t.status_ms ?? null,
    turn: t.turn ?? 0,
    cols: t.cols,
    rows: t.rows,
  };
}

/** Herdr.app's doc → [{ id, name, folder, tabs: [{ id, name, terminals: [address…] }] }]. */
export function projectLayout(value) {
  const spaces = value?.spaces ?? [];
  const walk = (node, out) => {
    if (!node) return out;
    if (node.content?.terminal) out.push(node.content.terminal);
    for (const child of node.children ?? []) walk(child, out);
    return out;
  };
  return spaces.map((space) => ({
    id: space.id ?? null,
    name: space.name || null,
    folder: space.folder ?? null,
    tabs: (space.tabs ?? []).map((tab) => ({ id: tab.id ?? null, name: tab.name || null, terminals: walk(tab.root, []) })),
  }));
}
