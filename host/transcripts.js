/**
 * A coding agent's conversation, read from the transcript it writes on the Mac, for the phone's
 * conversation view (scrolled natively on the phone: no wheel steps, no redraws to wait for).
 *
 *   Claude Code  ~/.claude/sessions/<pid>.json names the session → ~/.claude/projects/<dir>/<id>.jsonl
 *   epi / pi     the newest .jsonl in <sessions>/--<cwd with / as ->--/
 *
 * The phone only names a terminal; the file is found here from its foreground process, inside
 * these folders only. What goes out: user text, replies, tool names with a short summary, tool
 * output cut short. Not: thinking, system-injected text, sidechains (sub-agents), argv.
 *
 * A transcript only has what is finished: a reply is written when its block ends, a tool's output
 * when the tool ends, thinking never shows. So while the agent works, the phone also gets the
 * bottom of its screen (`live`, see livePart): the reply being written, the spinner, the question.
 *
 * An item's `seq` is the byte offset of the line it came from (plus its place in the line), so a
 * page of older items is "lines before this offset", read backwards from there: a 40 MB
 * transcript costs only the tail it shows.
 */
import { execFile } from 'node:child_process';
import { open as openFile, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PAGE_ITEMS = 60;
const CHUNK = 256 * 1024;
const MAX_TEXT = 20_000;
const MAX_OUT = 2_000;
const MAX_SUM = 300;
const POLL_MS = 300;
const LOCATE_MS = 2_000;
const MAX_OPEN = 4; // per phone
const PEEK_MS = 700;  // how often the agent's screen is read for the live part
const LIVE_LINES = 14;

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ------------------------------------------------------------------ where --------

/**
 * The transcript of the agent in the foreground, or null. `fg` = herdr-core's foreground facts;
 * `others` = the foregrounds of other terminals running the same program in the same folder.
 */
export async function locate(fg, program, home = homedir(), others = []) {
  if (!fg?.pid) return null;
  if (program === 'claude') {
    let session;
    try { session = JSON.parse(await readFile(join(home, '.claude', 'sessions', `${Number(fg.pid)}.json`), 'utf8')); } catch { return null; }
    const id = String(session.sessionId ?? '');
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) return null;
    const projects = join(home, '.claude', 'projects');
    const cwd = String(session.cwd ?? fg.cwd ?? '');
    const guess = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
    if (await isFile(guess)) return { kind: 'claude', file: guess };
    for (const dir of await readdir(projects).catch(() => [])) {
      const file = join(projects, dir, `${id}.jsonl`);
      if (await isFile(file)) return { kind: 'claude', file };
    }
    return null;
  }
  const roots = { epi: join(home, '.epi', 'pi', 'sessions'), pi: join(home, '.pi', 'agent', 'sessions') };
  if (!roots[program] || !fg.cwd) return null;
  const dir = join(roots[program], `--${String(fg.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
  const files = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!name.endsWith('.jsonl')) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s?.isFile()) files.push({ file: join(dir, name), mtimeMs: s.mtimeMs, created: createdOf(name) ?? s.birthtimeMs });
  }
  if (!files.length) return null;
  // Several of them in one folder: each one's session is the newest file it made since it started,
  // the latest started first (pi names a file after the time it made it).
  const procs = [fg, ...others.filter((o) => o?.pid && o.pid !== fg.pid)];
  const starts = await Promise.all(procs.map((p) => startOf(p.pid)));
  const order = procs.map((p, i) => ({ pid: p.pid, start: starts[i] ?? 0 })).sort((a, b) => b.start - a.start);
  const claimed = new Set();
  const newest = (list) => list.reduce((a, b) => (!a || b.mtimeMs > a.mtimeMs ? b : a), null);
  for (const p of order) {
    const free = files.filter((f) => !claimed.has(f.file));
    const pick = newest(free.filter((f) => f.created >= p.start - 2000)) ?? newest(free);
    if (!pick) break;
    if (p.pid === fg.pid) return { kind: 'pi', file: pick.file };
    claimed.add(pick.file);
  }
  return { kind: 'pi', file: newest(files).file };
}

/** pi names a session file after the time it made it: 2026-11-02T14-46-59-739Z_<id>.jsonl */
function createdOf(name) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

const starts = new Map(); // pid → ms the process started (it does not change)
async function startOf(pid) {
  if (starts.has(pid)) return starts.get(pid);
  const out = await new Promise((resolve) => execFile('/bin/ps', ['-o', 'lstart=', '-p', String(Number(pid))], (e, stdout) => resolve(e ? '' : stdout)));
  const ms = Date.parse(out.trim().replace(/\s+/g, ' ')) || null;
  if (ms) starts.set(pid, ms);
  if (starts.size > 500) starts.delete(starts.keys().next().value);
  return ms;
}

const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

// ------------------------------------------------------------------ what --------

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '');

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt
    ?? Object.values(input).find((v) => typeof v === 'string');
  return typeof pick === 'string' ? cut(pick.split('\n')[0], MAX_SUM) : '';
}

/** Text a person typed, without what Claude Code injects around it; null when there is none. */
function claudeUserText(text) {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return [command[1].trim(), args].filter(Boolean).join(' ');
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text);
  if (bash) return `! ${bash[1].trim()}`;
  const plain = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!plain || /^<[a-z-]+>/.test(plain) || plain.startsWith('Caveat:') || plain.startsWith('[Request interrupted')) return null;
  return plain;
}

/** One Claude Code transcript line → items. */
export function claudeItems(d) {
  if (!d || d.isSidechain || d.isMeta) return [];
  const time = d.timestamp ?? null;
  if (d.isCompactSummary) return [{ k: 'note', text: '更早的对话已压缩' }];
  const m = d.message;
  if (!m) return [];
  if (d.type === 'user') {
    if (typeof m.content === 'string') {
      const text = claudeUserText(m.content);
      return text ? [{ k: 'user', text: cut(text, MAX_TEXT), time }] : [];
    }
    const out = [];
    const texts = [];
    let images = 0;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_result') out.push({ k: 'result', id: String(b.tool_use_id ?? ''), out: cut(textOf(b.content), MAX_OUT), error: Boolean(b.is_error) });
      else if (b?.type === 'image') images++;
      else if (b?.type === 'text') { const t = claudeUserText(b.text ?? ''); if (t) texts.push(t); }
    }
    if (texts.length || images) out.unshift({ k: 'user', text: cut(texts.join('\n'), MAX_TEXT), images, time });
    return out;
  }
  if (d.type === 'assistant') {
    const out = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text' && b.text?.trim()) out.push({ k: 'assistant', text: cut(b.text, MAX_TEXT), time });
      else if (b?.type === 'tool_use') out.push({ k: 'tool', id: String(b.id ?? ''), name: String(b.name ?? 'tool'), sum: toolSummary(b.name, b.input) });
    }
    return out;
  }
  return [];
}

/** One pi / epi session line → items. */
export function piItems(d) {
  if (d?.type === 'compaction') return [{ k: 'note', text: '更早的对话已压缩' }];
  if (d?.type !== 'message' || !d.message) return [];
  const m = d.message;
  const time = d.timestamp ?? null;
  if (m.role === 'user') {
    const text = textOf(m.content).trim();
    const images = Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'image').length : 0;
    return text || images ? [{ k: 'user', text: cut(text, MAX_TEXT), images, time }] : [];
  }
  if (m.role === 'assistant') {
    const out = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'text' && b.text?.trim()) out.push({ k: 'assistant', text: cut(b.text, MAX_TEXT), time });
      else if (b?.type === 'toolCall') out.push({ k: 'tool', id: String(b.id ?? ''), name: String(b.name ?? 'tool'), sum: toolSummary(b.name, b.arguments) });
    }
    return out;
  }
  if (m.role === 'toolResult') return [{ k: 'result', id: String(m.toolCallId ?? ''), out: cut(textOf(m.content), MAX_OUT), error: Boolean(m.isError) }];
  return [];
}

const PARSERS = { claude: claudeItems, pi: piItems };

/** Items of one line at `offset`; lines that are never messages are not parsed (Claude Code's are large). */
function lineItems(kind, line, offset) {
  if (!line || (kind === 'claude' && line.startsWith('{"type"'))) return [];
  let d;
  try { d = JSON.parse(line); } catch { return []; }
  return PARSERS[kind](d).map((item, i) => ({ ...item, seq: offset + i / 100 }));
}

// ------------------------------------------------------------------ reading -----

/** Up to `want` items from the whole lines that end at or before byte `before`, read backwards. */
export async function readBack(kind, file, before, want = PAGE_ITEMS) {
  const fh = await openFile(file, 'r');
  try {
    const items = [];
    let pos = before;
    let carry = Buffer.alloc(0); // bytes from `pos` up to the lines already read; ends with a newline
    let first = before;          // offset of the oldest line read
    while (pos > 0 && items.length < want) {
      const from = Math.max(0, pos - CHUNK);
      const chunk = Buffer.alloc(pos - from);
      await fh.read(chunk, 0, chunk.length, from);
      const buf = Buffer.concat([chunk, carry]);
      pos = from;
      // Before the first newline is the end of a line that starts further back (unless at 0).
      const start = from === 0 ? 0 : buf.indexOf(10) + 1;
      if (start === 0 && from > 0) { carry = buf; continue; }
      carry = buf.subarray(0, start);
      const body = buf.subarray(start);
      if (!body.length) continue;
      const lines = body.toString('utf8').replace(/\n$/, '').split('\n');
      let offset = from + start;
      const offsets = lines.map((l) => { const at = offset; offset += Buffer.byteLength(l) + 1; return at; });
      for (let i = lines.length - 1; i >= 0 && items.length < want; i--) {
        items.unshift(...lineItems(kind, lines[i], offsets[i]));
        first = offsets[i];
      }
    }
    // Fewer than `want`: every line down to the start was read, nothing older is left.
    return { items, first, hasMore: items.length >= want && first > 0 };
  } finally { await fh.close(); }
}

/** Where the last whole line ends (a line still being written is left for the next read). */
export async function lineEnd(file) {
  const s = await stat(file);
  if (!s.size) return 0;
  const fh = await openFile(file, 'r');
  try {
    for (let pos = s.size; pos > 0;) {
      const from = Math.max(0, pos - CHUNK);
      const buf = Buffer.alloc(pos - from);
      await fh.read(buf, 0, buf.length, from);
      const nl = buf.lastIndexOf(10);
      if (nl >= 0) return from + nl + 1;
      pos = from;
    }
    return 0;
  } finally { await fh.close(); }
}

/** Items in the whole lines between byte `from` and the end; `end` = where the next read starts. */
export async function readForward(kind, file, from) {
  const s = await stat(file);
  if (s.size <= from) return { items: [], end: s.size < from ? -1 : from };
  const fh = await openFile(file, 'r');
  try {
    const buf = Buffer.alloc(s.size - from);
    await fh.read(buf, 0, buf.length, from);
    const last = buf.lastIndexOf(10);
    if (last < 0) return { items: [], end: from };
    const lines = buf.subarray(0, last).toString('utf8').split('\n');
    const items = [];
    let offset = from;
    for (const line of lines) { items.push(...lineItems(kind, line, offset)); offset += Buffer.byteLength(line) + 1; }
    return { items, end: from + last + 1 };
  } finally { await fh.close(); }
}

// ------------------------------------------------------------------ live --------

const BOX = /^[\s─━═╭╮╰╯┌┐└┘│┃]+$/;
const RULE = /[─━═]{8}/;

/**
 * What the agent is doing now, from its screen: the last lines above its input box (Claude Code:
 * a rule, "❯", a rule; epi / pi: a rounded box around "❯"). No box (a question, a menu): the
 * bottom of the screen.
 */
export function livePart(screen, n = LIVE_LINES) {
  const lines = String(screen ?? '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let end = lines.length;
  // The input box: a rule, a "❯" line right under it, and a closing rule soon after. A menu in a
  // box ("❯ 1. Yes") is not the input box: it is what the phone needs to see.
  const rule = (l) => BOX.test(l) && RULE.test(l);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!rule(lines[i])) continue;
    const under = lines.slice(i + 1, i + 3);
    if (!under.some((l) => /^[\s│┃]*[❯>›]/.test(l))) continue;
    const close = lines.slice(i + 2, i + 10).findIndex(rule);
    const inside = lines.slice(i + 1, close < 0 ? i + 3 : i + 2 + close);
    if (close >= 0 && !inside.some((l) => /^[\s│┃]*[❯>›]\s*\d+[.)]/.test(l))) { end = i; break; }
  }
  const body = lines.slice(0, end);
  while (body.length && !body.at(-1).trim()) body.pop();
  const part = body.slice(-n);
  while (part.length && !part[0].trim()) part.shift();
  // The common indent goes: the phone is narrow.
  const indent = Math.min(...part.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length));
  return part.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

/**
 * Open conversations of one phone. `find(address)` → { fg, program } of a terminal, or null.
 * `emit(c, payload)` sends a `conv` event (new items, or `reset` with a fresh page).
 */
export function createConversations({ find, emit, home, peek }) {
  home ??= homedir();
  const open = new Map(); // c → { address, kind, file, end, timer, located }
  let next = 1;

  async function where(address) {
    const t = find(address);
    return t ? locate(t.fg, t.program, home, t.others) : null;
  }

  async function first(conv) {
    const end = await lineEnd(conv.file);
    const page = await readBack(conv.kind, conv.file, end);
    conv.end = end;
    conv.oldest = page.first;
    return { kind: conv.kind, items: page.items, first: page.first, hasMore: page.hasMore };
  }

  async function tick(c) {
    const conv = open.get(c);
    if (!conv || conv.busy) return;
    conv.busy = true;
    try {
      if (Date.now() - conv.located > LOCATE_MS) {
        conv.located = Date.now();
        const now = await where(conv.address);
        if (now && now.file !== conv.file) { // /clear, /resume, a new session: start over
          Object.assign(conv, now);
          emit(c, { reset: true, ...(await first(conv)) });
          return;
        }
      }
      const r = await readForward(conv.kind, conv.file, conv.end);
      if (r.end < 0) { emit(c, { reset: true, ...(await first(conv)) }); return; } // the file got shorter
      conv.end = r.end;
      if (r.items.length) emit(c, { items: r.items });
      if (peek && Date.now() - conv.peeked >= PEEK_MS) {
        conv.peeked = Date.now();
        const live = livePart(await peek(conv.address).catch(() => ''));
        if (live !== conv.live) { conv.live = live; emit(c, { items: [], live }); }
      }
    } catch {} finally {
      if (open.has(c)) { conv.busy = false; conv.timer = setTimeout(() => tick(c), POLL_MS); }
    }
  }

  return {
    async open(address) {
      if (open.size >= MAX_OPEN) throw new Error('打开的对话太多');
      const found = await where(address);
      if (!found) throw new Error('找不到这个 agent 的会话记录');
      const c = next++;
      const conv = { address, ...found, end: 0, located: Date.now(), busy: false, timer: 0, peeked: 0, live: '' };
      const page = await first(conv);
      open.set(c, conv);
      conv.timer = setTimeout(() => tick(c), POLL_MS);
      return { c, ...page };
    },
    async older(c, before) {
      const conv = open.get(Number(c));
      if (!conv) throw new Error('对话已关闭');
      const at = Math.min(Math.max(0, Math.floor(Number(before) || 0)), conv.end);
      const page = await readBack(conv.kind, conv.file, at);
      return { items: page.items, first: page.first, hasMore: page.hasMore };
    },
    close(c) { const conv = open.get(Number(c)); if (conv) { clearTimeout(conv.timer); open.delete(Number(c)); } },
    closeAll() { for (const c of [...open.keys()]) this.close(c); },
  };
}
