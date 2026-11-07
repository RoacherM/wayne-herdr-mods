/**
 * The phones' experience records (DESIGN.md「体验记录」), on the Mac: one JSON line per event in
 * `<data dir>/metrics/YYYY-MM-DD.jsonl`, kept 30 days. A phone sends only times and kinds; this
 * checks every field against a fixed list, so nothing else can be written here.
 *
 * summarize() turns the lines into what the report page shows: per measure and path (direct or
 * relay), the median (p50) and the slow tail (p95), per day and overall.
 */
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const KEEP_DAYS = 30;
const MAX_EVENTS = 500;

// ev → its fields: 'n' a finite number (or null where allowed), 's' a short string, 'b' a boolean.
const FIELDS = {
  echo: { net: 'n', paint: 'n' },
  open: { ms: 'n', again: 'b' },
  resume: { away: 'n', ready: 'n?', paint: 'n?' },
  rtt: { ms: 'n', n: 'n', ice: 'n?', pair: 's?' }, // ice, pair: on the direct path only (WebRTC's own view)
  link: { status: 's' },
  frames: { ms: 'n', n: 'n', p95: 'n', long: 'n' }, // before 2026-11-04 evening: now part of scroll
  scroll: { mode: 's', ms: 'n', n: 'n', p95: 'n', long: 'n', steps: 'n', coast: 'n', lag: 'n?', lagMax: 'n?', answered: 'n', kb: 'n' },
  macscroll: { steps: 'n', coast: 'n', prog: 'n?', progMax: 'n?', kb: 'n', behind: 'n', ms: 'n' },
  reprint: { kb: 'n', fresh: 'b', ms: 'n' }, // the Mac: a program printed its whole history again (phones.js reprint())
  op: { op: 's', key: 's?' },
  kbd: { why: 's', f: 'b', act: 's', vh: 'n', vt: 'n', sc: 'n', ih: 'n', dh: 'n', sy: 'n', up: 'b', st: 'n', sb: 'n' }, // the keyboard page sees a change (keyboard-fit.js), to check it on a real phone
  voice: { kb: 'n', ms: 'n', muted: 'b', err: 's?' }, // one recording: size, length, mic muted at start, what failed (null: words came)
};
const CTX = { src: 's', ver: 's', os: 's', browser: 's', standalone: 'b', w: 'n', h: 'n' };

/** The measures the report shows, in order: [key, label, what it is, unit (default ms)]. */
export const MEASURES = [
  ['echo.paint', '打字到看见', '在安静的终端里按一个键，到它的回显画到屏幕上'],
  ['echo.net', '打字到回显到达', '按键到回显的数据到达手机（不含画）'],
  ['open.ms', '打开终端', '点开一个终端到第一屏画出来'],
  ['resume.paint', '回到页面', '切回页面到终端重新画出来'],
  ['resume.ready', '回到页面后重连', '切回页面到连接恢复'],
  ['rtt.ms', '往返', '手机发一批记录到 Mac 再收到回复（含连接里的排队）'],
  ['rtt.ice', '网络往返', '直连时 WebRTC 自己量的网络往返，不含我们的排队'],
  ['scroll.lag', '滑动到画面跟上', '全屏程序里手指动一行，到程序回应这一步的画面画出来（一次滑动的中位数）'],
  ['scroll.lagMax', '滑动时最大的落后', '一次滑动里画面落后手指最多的那一下'],
  ['macscroll.prog', '程序回应滚轮', 'Mac 上：滚轮写给程序，到程序第一段输出（不含网络）'],
  ['reprint.kb', '程序重印', 'Mac 上：程序清掉历史、把整段对话重印一遍的大小（超过 64 KB 不发，换成新首屏）', 'KB'],
  ['reprint.ms', '重印到新画面', 'Mac 上：程序开始重印，到发给手机的是新画面（原样发出或新首屏）'],
  ['macscroll.behind', '在路上的数据', 'Mac 上：一次滑动里发出去但手机还没画完的最多字节数', 'KB'],
  ['scroll.p95', '滑动的慢帧', '一次滑动里最慢 5% 的帧间隔'],
];

/** The value when it is of this kind, else undefined. */
function ok(value, kind) {
  switch (kind[0]) {
    case 'n': return Number.isFinite(value) && Math.abs(value) < 1e9 ? Math.round(value) : undefined;
    case 's': return typeof value === 'string' && value.length <= 40 ? value : undefined;
    case 'b': return typeof value === 'boolean' ? value : undefined;
    default: return undefined;
  }
}

/** One event from a phone, or null when a field is off the list. Unknown fields are dropped. */
export function clean(e, ctx = {}) {
  const fields = FIELDS[e?.ev];
  if (!fields || !Number.isFinite(e.t)) return null;
  const out = { t: Math.round(e.t), ev: e.ev, via: e.via === 'direct' || e.via === 'relay' ? e.via : '' };
  for (const [k, kind] of Object.entries(CTX)) { const v = ok(ctx[k], kind); if (v !== undefined) out[k] = v; } // context: keep what passes
  for (const [k, kind] of Object.entries(fields)) {
    if (e[k] === undefined || e[k] === null) {
      if (!kind.endsWith('?')) return null;
      if (e[k] === null) out[k] = null;
      continue;
    }
    const v = ok(e[k], kind);
    if (v === undefined) return null;
    out[k] = v;
  }
  return out;
}

const day = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function createMetricsStore({ dir, now = Date.now }) {
  const root = join(dir, 'metrics');
  let pruned = '';

  /** A batch from one phone. Returns how many events were kept. */
  async function put(device, { ctx, events } = {}) {
    if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new Error(`一次最多 ${MAX_EVENTS} 条`);
    const files = new Map();
    for (const e of events) {
      const line = clean(e, ctx ?? {});
      if (!line) continue;
      const row = { ...line, dev: String(device?.id ?? '').slice(0, 8) };
      const f = `${day(row.t)}.jsonl`;
      files.set(f, (files.get(f) ?? '') + JSON.stringify(row) + '\n');
    }
    if (files.size) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      for (const [f, text] of files) await appendFile(join(root, f), text, { mode: 0o600 });
    }
    await prune();
    return { kept: [...files.values()].reduce((n, s) => n + s.split('\n').length - 1, 0) };
  }

  async function prune() {
    const today = day(now());
    if (pruned === today) return;
    pruned = today;
    const oldest = day(now() - KEEP_DAYS * 86_400_000);
    for (const f of await readdir(root).catch(() => [])) {
      if (/^\d{4}-\d\d-\d\d\.jsonl$/.test(f) && f.slice(0, 10) < oldest) await rm(join(root, f), { force: true });
    }
  }

  /** Every event of the last `days` days, oldest first. */
  async function read(days = 7) {
    const from = day(now() - (days - 1) * 86_400_000);
    const rows = [];
    for (const f of (await readdir(root).catch(() => [])).sort()) {
      if (!/^\d{4}-\d\d-\d\d\.jsonl$/.test(f) || f.slice(0, 10) < from) continue;
      for (const line of (await readFile(join(root, f), 'utf8')).split('\n')) {
        if (!line) continue;
        try { rows.push(JSON.parse(line)); } catch { /* a torn last line */ }
      }
    }
    return rows.sort((a, b) => a.t - b.t);
  }

  return { put, read, root };
}

// ------------------------------------------------------------------ summary --

/** The value at fraction q of the sorted numbers (nearest rank). */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function stats(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95) };
}

const valueOf = (row, key) => { const [ev, field] = key.split('.'); return row.ev === ev ? row[field] : undefined; };

/**
 * Rows → { groups: { [src]: group } }. A group: overall stats per measure and path, the same per
 * day, link changes per day, the key bar's use, and the latest rows (for the timeline).
 */
export function summarize(rows) {
  const bySrc = new Map();
  for (const r of rows) {
    const src = !r.src || r.src === 'mac' ? 'phone' : r.src; // the Mac's records are of the real phones
    if (!bySrc.has(src)) bySrc.set(src, []);
    bySrc.get(src).push(r);
  }
  const groups = {};
  for (const [src, list] of bySrc) {
    const days = [...new Set(list.map((r) => day(r.t)))].sort();
    const measures = {};
    for (const [key] of MEASURES) {
      const m = { all: {}, daily: {} };
      for (const via of ['direct', 'relay']) {
        const mine = list.filter((r) => r.via === via && valueOf(r, key) !== undefined);
        m.all[via] = stats(mine.map((r) => valueOf(r, key)));
        m.daily[via] = days.map((d) => ({ day: d, ...stats(mine.filter((r) => day(r.t) === d).map((r) => valueOf(r, key))) }));
      }
      measures[key] = m;
    }
    const drops = days.map((d) => ({ day: d, n: list.filter((r) => r.ev === 'link' && r.status !== 'ready' && day(r.t) === d).length }));
    const keys = {};
    for (const r of list) if (r.ev === 'op') { const k = r.key ? `${r.op}:${r.key}` : r.op; keys[k] = (keys[k] ?? 0) + 1; }
    const frames = list.filter((r) => r.ev === 'frames' || r.ev === 'scroll');
    const longShare = frames.length ? frames.reduce((s, r) => s + r.long, 0) / Math.max(1, frames.reduce((s, r) => s + r.n, 0)) : null;
    const last = list[list.length - 1];
    groups[src] = {
      src, n: list.length, days, from: list[0].t, to: last.t,
      ver: last.ver ?? '', device: [last.os && `iOS ${last.os}`, last.browser, last.standalone ? '主屏幕' : '', last.w && `${last.w}×${last.h}`].filter(Boolean).join(' · '),
      direct: list.filter((r) => r.via === 'direct').length / Math.max(1, list.filter((r) => r.via).length),
      measures, drops, keys, longShare,
      recent: list.slice(-300).reverse(),
    };
  }
  return { groups, measures: MEASURES };
}
