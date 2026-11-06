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
import { readFileSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CREDIT, openCore, u32 } from './hc.js';

const THROTTLE_MS = 250;
const APP_HOME = process.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app');

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

  const loadIcon = createIconLoader(APP_HOME);
  // Herdr.app's own answer per terminal (DESIGN.md「图标跟着 Herdr.app」): re-read when shared.json changes.
  const sharedFile = join(APP_HOME, 'shared.json');
  let herdr = { mtime: -1, value: readHerdrPrograms(null), seen: '{}' };
  const herdrNow = () => {
    try {
      const { mtimeMs } = statSync(sharedFile);
      if (mtimeMs !== herdr.mtime) herdr = { ...herdr, mtime: mtimeMs, value: readHerdrPrograms(JSON.parse(readFileSync(sharedFile, 'utf8'))) };
    } catch { /* missing, or caught mid-write: keep the last answer */ }
    return herdr.value;
  };
  watchFile(sharedFile, { interval: 2000 }, () => {
    const seen = JSON.stringify(herdrNow().byAddress);
    if (seen !== herdr.seen) { herdr.seen = seen; changed(); }
  });
  connect();

  return {
    core: () => core,
    state: () => state,
    get: (address) => terminals.get(address),
    /** Live terminals as herdr-core reports them (argv included: for the host only). */
    raw: () => [...terminals.values()].filter((t) => t.state === 'live'),
    list: () => { const h = herdrNow(); return [...terminals.values()].filter((t) => t.state === 'live').map((t) => project(t, h)); },
    icons() {
      const out = {}, h = herdrNow();
      for (const t of terminals.values()) {
        if (t.state !== 'live') continue;
        const p = project(t, h);
        if (p.icon && !(p.icon in out)) {
          const entry = loadIcon(p.icon, Boolean(p.app), h);
          if (entry) out[p.icon] = entry;
        }
      }
      return out;
    },
    layout: () => layout,
    /** Retry right away (after a wake-up, or when a phone asks). */
    kick() { if (!core && !stopped) { attempt = 0; clearTimeout(retryTimer); connect(); } },
    dispose() { stopped = true; clearTimeout(retryTimer); clearTimeout(changeTimer); unwatchFile(sharedFile); core?.close(); },
  };
}

const INTERPRETERS = /^(node|nodejs|python[0-9.]*|bun|deno|ruby|perl|php)$/;
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'nu', 'pwsh', 'powershell', 'cmd', 'elvish', 'xonsh', 'tcsh', 'csh', 'ksh', 'ion']);
const ALIASES = {
  'claude-code': 'claude', agy: 'antigravity', 'cursor-agent': 'cursor', 'github-copilot': 'copilot',
  'grok-build': 'grok', 'kiro-cli': 'kiro', qodercli: 'qoder', vi: 'vim', view: 'vim', helix: 'hx',
  more: 'less', man: 'less', bat: 'less', gitui: 'lazygit', tig: 'lazygit', btop: 'htop', top: 'htop',
  btm: 'htop', glances: 'htop', mosh: 'ssh', et: 'ssh', zellij: 'tmux', screen: 'tmux', grep: 'rg',
  fzf: 'rg', fd: 'rg', find: 'rg', wget: 'curl', http: 'curl', httpie: 'curl', xh: 'curl',
  just: 'make', ninja: 'make', bunx: 'bun', python3: 'python', ipython: 'python', pip: 'python',
  pip3: 'python', uvx: 'uv', irb: 'ruby', bundle: 'ruby', gem: 'ruby', rails: 'ruby', rustc: 'cargo',
  rustup: 'cargo', javac: 'java', jshell: 'java', gradlew: 'gradle', mvnw: 'mvn', artisan: 'php',
  elixir: 'iex', mix: 'iex', ghc: 'ghci', stack: 'ghci', cabal: 'ghci', utop: 'ocaml', dune: 'ocaml',
  opam: 'ocaml', kotlinc: 'kotlin', sbt: 'scala', luajit: 'lua', rscript: 'r', tsx: 'tsc',
  'ts-node': 'tsc', npx: 'npm', nuxi: 'nuxt', postgres: 'psql', mariadb: 'mysql', sqlite: 'sqlite3',
  'redis-server': 'redis-cli', mongo: 'mongosh', 'docker-compose': 'docker', lazydocker: 'docker',
  k9s: 'kubectl', minikube: 'kubectl', kind: 'kubectl', tofu: 'terraform', 'ansible-playbook': 'ansible',
  flyctl: 'fly', 'nix-shell': 'nix', 'nixos-rebuild': 'nix', 'apt-get': 'apt', dpkg: 'apt',
  'rpm-ostree': 'dnf', yay: 'pacman', paru: 'pacman',
};
const NO_TINT = new Set(['claude', 'antigravity', 'epi', 'codex', 'pig', 'amp', 'kimi', 'kiro', 'crush']);

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

const NO_HERDR = Object.freeze({ byAddress: {}, byKey: {}, byRun: {} });
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/**
 * What Herdr.app says about programs, from its shared.json (parsed; null when unreadable):
 * - byAddress: its answer per terminal of this Mac, { t6: { key, icon, tint } } (our my-tabs writes it);
 * - byKey: icon file and tint per key, from those answers and its agent table (its new-menu caches it);
 * - byRun: the command an agent runs → its key (`agy` → `antigravity`).
 */
export function readHerdrPrograms(shared) {
  const byAddress = {}, byKey = {}, byRun = {};
  for (const [address, p] of Object.entries(record(record(shared)?.['wayne-herdr-mods.programs']) ?? {})) {
    if (typeof p?.key === 'string') byAddress[address] = { key: p.key, icon: typeof p.icon === 'string' ? p.icon : null, tint: Boolean(p.tint) };
  }
  const table = record(shared)?.['new-menu.agents']?.[''];
  for (const a of Array.isArray(table) ? table : []) {
    if (typeof a?.key !== 'string') continue;
    byKey[a.key] = { icon: typeof a.icon === 'string' ? a.icon : null, tint: Boolean(a.tint) };
    const cmd = Array.isArray(a.run) && typeof a.run[0] === 'string' ? a.run[0].split('/').pop().toLowerCase() : null;
    if (cmd && cmd !== a.key) byRun[cmd] = a.key;
  }
  for (const p of Object.values(byAddress)) byKey[p.key] ??= { icon: p.icon, tint: p.tint };
  return { byAddress, byKey, byRun };
}

/** Program icon key as Herdr.app's sidebar resolves it: agent report first, else foreground program. */
export function iconOf(app, program, herdr = NO_HERDR) {
  const raw = String(app || program || '').toLowerCase();
  if (!raw) return 'shell';
  if (SHELLS.has(raw)) return 'shell';
  return ALIASES[raw] ?? herdr.byRun[raw] ?? raw;
}

function effectiveState(t) {
  const raw = t.status?.state || null;
  const seen = t.labels?.['herdr.seen'];
  if (raw === 'done' && seen !== undefined && Number(seen) >= (t.turn || 0)) return 'idle';
  return raw;
}

function readCustomPrograms(appDir) {
  try {
    return JSON.parse(readFileSync(join(appDir, 'programs.json'), 'utf8'))?.programs ?? {};
  } catch {
    return {};
  }
}

function readIconSvg(appDir, rel) {
  if (!rel || rel.includes('..')) return null;
  try {
    return readFileSync(join(appDir, rel), 'utf8').trim();
  } catch {
    return null;
  }
}

function findCustomProgram(progs, key) {
  return progs[key] ?? Object.values(progs).find((p) => p.match?.includes(key));
}

/** key → { svg, tint }: the file and tint Herdr.app uses for it, else programs.json, else icons/<key>.svg. */
function createIconLoader(appDir) {
  const files = new Map();
  let custom = null;
  const read = (rel) => { if (!files.has(rel)) files.set(rel, readIconSvg(appDir, rel)); return files.get(rel); };
  return (key, isAgent, herdr = NO_HERDR) => {
    custom ??= readCustomPrograms(appDir);
    const known = herdr.byKey[key], hit = findCustomProgram(custom, key);
    const fallback = isAgent ? 'icons/agent.svg' : 'icons/program.svg';
    const svg = read(known?.icon ?? hit?.icon ?? `icons/${key}.svg`) ?? read(fallback);
    if (!svg) return null;
    return { svg, tint: known?.tint ?? hit?.tint ?? !NO_TINT.has(key) };
  };
}

/** What a phone sees of one terminal. Never argv or env: only display facts. */
export function project(t, herdr = NO_HERDR) {
  const status = t.status ?? null;
  const program = programOf(t.foreground);
  // An agent's last report outlives it: with a shell back in front, the agent has exited.
  const app = SHELLS.has(program) ? null : status?.app || null;
  const said = SHELLS.has(program) ? null : herdr.byAddress[t.address]?.key;
  return {
    address: t.address,
    name: t.name ?? null,
    title: t.title ?? null,
    where: t.labels?.where ?? null,
    space: t.labels?.['herdr.space'] ?? null,
    tab: t.labels?.['herdr.tab'] ?? null,
    cwd: t.foreground?.cwd ?? t.cwd ?? null,
    program,
    app,
    icon: said || iconOf(app, program, herdr),
    state: effectiveState(t), // idle | working | done | blocked | error | null (never reported)
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
