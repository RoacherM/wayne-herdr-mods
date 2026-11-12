/**
 * The observability board's memory (DESIGN.md「观测面板」).
 *
 * herdr-core says what is true now: which agents run, their sub-agents, their labels. It does not
 * keep what was. This module watches each change and keeps the history the board draws: for every
 * agent terminal a lane of decisions, and under each decision the sub-agents started after it.
 *
 * Everything comes from herdr-core's own facts, nothing is parsed out of an agent's files:
 *   - a sub-agent inside the agent's process: one entry in the terminal's `records` (OSC 7501);
 *   - a sub-agent in its own terminal (`hc run`): a terminal whose `parent` is the agent's address;
 *   - a decision: the terminal's label `wayne.said` (the person's words) or `wayne.note` (the agent's).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SAID = 'wayne.said', NOTE = 'wayne.note';
const KEEP_ENDED_MS = 12 * 3600_000, MAX_LANES = 30, MAX_STEPS = 40, MAX_SUBS = 60;

export const emptyBoard = () => ({ v: 1, lanes: [], labels: {} });

/** `1794454931956|the words` → { at, text }; a bare value has no time of its own. */
function stamped(value, now) {
  const m = /^(\d{13})\|([\s\S]*)$/.exec(value);
  return m ? { at: Number(m[1]), text: m[2] } : { at: now, text: value };
}

/** The part of a 7501 record the board shows. A terminal that has not reported yet counts as working. */
const facts = (r) => ({ app: r?.app ?? null, state: r?.state ?? 'working', msg: r?.msg ?? null, progress: r?.progress ?? null });

/** A child that never reported and has no template is a plain command (`hc run npm test`): not a sub-agent. */
const isSubAgent = (k, parent) => k.parent === parent && k.state === 'live' && Boolean(k.status?.state || k.template);

/** What a terminal runs under it right now: its records, and the agent terminals it started. */
function subsNow(t, all) {
  const inside = Object.entries(t.records ?? {}).map(([id, r]) => ({ id, kind: 'in', title: r.title || r.msg || id, ...facts(r) }));
  const started = all.filter((k) => isSubAgent(k, t.address))
    .map((k) => ({ id: k.address, kind: 'term', title: k.name || k.template || k.address, ...facts(k.status), app: k.status?.app ?? k.template ?? null, terminal: k }));
  return [...inside, ...started];
}

function end(sub, all, now) {
  if (sub.ended) return;
  sub.ended = now;
  const t = sub.kind === 'term' ? all.find((k) => k.address === sub.id) : null;
  sub.state = t ? (t.exit_code ? 'failed' : 'done') : sub.state === 'error' ? 'failed' : 'done';
  for (const s of sub.subs) end(s, all, now);
}

/** Bring one holder's sub-agents in line with what runs now. New ones go into `into`. */
function sync(known, into, current, all, now) {
  const live = new Map(current.map((c) => [c.id, c]));
  const under = (sub, c) => { if (c.terminal) sync(sub.subs, sub.subs, subsNow(c.terminal, all), all, now); };
  for (const sub of known.filter((x) => !x.ended)) {
    const c = live.get(sub.id);
    if (!c) { end(sub, all, now); continue; }
    live.delete(sub.id);
    Object.assign(sub, { title: c.title, app: c.app, state: c.state, msg: c.msg, progress: c.progress });
    under(sub, c);
  }
  for (const c of live.values()) {
    const sub = { id: c.id, kind: c.kind, title: c.title, app: c.app, state: c.state, msg: c.msg, progress: c.progress, since: now, ended: null, subs: [] };
    into.push(sub);
    under(sub, c);
  }
}

const hasOpen = (subs) => subs.some((s) => !s.ended || hasOpen(s.subs));

/** How a sub-agent and everything under it ended, as counts: what stays of it once it is dropped. */
function outcome(sub) {
  const n = { done: sub.dropped?.done ?? 0, failed: sub.dropped?.failed ?? 0 };
  n[sub.state === 'failed' ? 'failed' : 'done']++;
  for (const s of sub.subs) { const m = outcome(s); n.done += m.done; n.failed += m.failed; }
  return n;
}

/**
 * Keep the board small while an agent runs for days. Per holder (a decision, or a sub-agent with
 * its own) at most MAX_SUBS: the oldest ended ones go and stay only as counts (`dropped`: how many
 * ended well and how many failed, their own sub-agents included). Per lane at most MAX_STEPS
 * decisions: the oldest go, but never the latest one (the next sub-agent hangs there) and never
 * one with a sub-agent still at work; when every one is like that, the lane stays over the limit.
 */
function compact(holder) {
  for (const s of holder.subs) compact(s);
  for (let over = holder.subs.length - MAX_SUBS; over > 0; over--) {
    const i = holder.subs.findIndex((s) => s.ended && !hasOpen(s.subs));
    if (i < 0) return;
    const [gone] = holder.subs.splice(i, 1), n = outcome(gone);
    holder.dropped = { done: (holder.dropped?.done ?? 0) + n.done, failed: (holder.dropped?.failed ?? 0) + n.failed };
  }
}

function trim(lane) {
  for (const step of lane.steps) compact(step);
  for (let over = lane.steps.length - MAX_STEPS; over > 0; over--) {
    const i = lane.steps.findIndex((s, at) => at < lane.steps.length - 1 && !hasOpen(s.subs));
    if (i < 0) return;
    lane.steps.splice(i, 1);
  }
}

/** A label is a decision once: the board remembers the last value it took from each terminal. */
function takeLabels(board, lane, t, now) {
  const seen = board.labels[t.address] ??= {};
  for (const [key, by] of [[SAID, 'you'], [NOTE, 'agent']]) {
    const value = t.labels?.[key];
    if (!value || value === seen[key]) continue;
    seen[key] = value;
    lane.steps.push({ by, ...stamped(value, now), subs: [] });
  }
}

/** The lane of an agent terminal, brought up to now. */
function follow(board, t, all, now) {
  let lane = board.lanes.find((l) => l.t === t.address && !l.ended);
  if (!lane) board.lanes.push(lane = { t: t.address, since: now, ended: null, steps: [] });
  Object.assign(lane, { ...facts(t.status), cwd: t.foreground?.cwd ?? t.cwd ?? null, where: t.labels?.where ?? null });
  takeLabels(board, lane, t, now);
  const current = subsNow(t, all);
  // A sub-agent hangs under the latest decision; with none yet, under a plain "started" step.
  if (!lane.steps.length && current.length) lane.steps.push({ by: 'start', at: lane.since, text: '', subs: [] });
  sync(lane.steps.flatMap((s) => s.subs), lane.steps.at(-1)?.subs ?? [], current, all, now);
  trim(lane);
}

/** An agent that is gone (back at the shell, or its terminal ended) ends its lane and everything under it. */
function close(lane, all, now) {
  Object.assign(lane, { ended: now, state: 'idle', msg: null });
  for (const s of lane.steps.flatMap((x) => x.subs)) end(s, all, now);
}

/**
 * One step of the board: `terminals` is every terminal herdr-core knows (finished ones included).
 * Changes `board` in place and returns whether anything changed.
 */
export function observe(board, terminals, now) {
  const before = JSON.stringify(board);
  const all = terminals.filter((t) => typeof t?.address === 'string' && !t.address.includes('/'));
  const roots = all.filter((t) => t.state === 'live' && t.status?.state && !t.parent);
  for (const t of roots) follow(board, t, all, now);
  const running = new Set(roots.map((t) => t.address));
  for (const lane of board.lanes) if (!lane.ended && !running.has(lane.t)) close(lane, all, now);
  board.lanes = board.lanes.filter((l) => !l.ended || now - l.ended < KEEP_ENDED_MS).slice(-MAX_LANES);
  const known = new Set(all.map((t) => t.address));
  for (const address of Object.keys(board.labels)) if (!known.has(address)) delete board.labels[address];
  return JSON.stringify(board) !== before;
}

/** The board on disk: `<dir>/board.json`, rewritten (whole, atomically) shortly after each change. */
export function createBoard({ dir, log = () => {}, now = Date.now, delayMs = 300 }) {
  const file = join(dir, 'board.json');
  let board = emptyBoard(), timer;
  try { const saved = JSON.parse(readFileSync(file, 'utf8')); if (saved?.v === 1 && Array.isArray(saved.lanes)) board = { ...emptyBoard(), ...saved }; } catch { /* first run, or a broken file: start empty */ }
  const write = () => {
    timer = undefined;
    try { mkdirSync(dir, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify({ ...board, at: now() })); renameSync(`${file}.tmp`, file); }
    catch (error) { log(`wayne-herdr-mods: 写观测面板失败：${error.message}`); }
  };
  return {
    file,
    board: () => board,
    update(terminals) { if (observe(board, terminals, now()) && !timer) timer = setTimeout(write, delayMs); },
    dispose() { if (timer) { clearTimeout(timer); write(); } },
  };
}
