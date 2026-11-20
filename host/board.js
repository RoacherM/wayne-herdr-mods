/**
 * The observability board's topology memory (DESIGN.md「观测面板」).
 *
 * Fuses two local sources for each agent terminal on this Mac:
 *   1. `herdr-core` runtime state (`status`, in-process `records`, `hc run` child `parent` tree) —
 *      live running / `blocked` / failed states and child sub-terminals;
 *   2. Local agent transcripts (`host/transcripts.js`: Claude Code, Antigravity, Codex, Pi/Epi) —
 *      the causal communication graph (`spawn`, `message`, `return`).
 *
 * Writes `~/.config/wayne-herdr-mods/board.json` (`v: 2`) atomically when the topology changes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeStats, normalizeSubState, stripBoilerplateReply } from '../shared/board.js';
import { programOf, SHELLS } from './terminals.js';
import { createSessionReader, oneLine } from './transcripts.js';

const KEEP_ENDED_MS = 12 * 3600_000;
const MAX_EVENTS = 120;
const MAX_AGENTS = 60;
const VALID_KINDS = new Set(['spawn', 'message', 'return']);
const FG_AGENT_MAP = {
  agy: 'antigravity', antigravity: 'antigravity',
  claude: 'claude', 'claude-code': 'claude-code',
  codex: 'codex', epi: 'epi', pi: 'pi',
  droid: 'droid', devin: 'devin',
  dim: 'dim', dimcode: 'dim',
  amp: 'amp', grok: 'grok', 'grok-build': 'grok',
  cursor: 'cursor', 'cursor-agent': 'cursor',
  opencode: 'opencode', copilot: 'copilot', 'github-copilot': 'copilot',
  gemini: 'gemini', kimi: 'kimi', kiro: 'kiro', 'kiro-cli': 'kiro',
  qwen: 'qwen', goose: 'goose', aider: 'aider', crush: 'crush', qoder: 'qoder', qodercli: 'qoder',
};

export const emptyBoard = () => ({ v: 2, lanes: [] });

function agentAppOf(t) {
  const prog = programOf(t.foreground)?.toLowerCase() || null;
  if (prog && SHELLS.has(prog)) return null;
  if (t.status?.app) return t.status.app;
  return prog ? (FG_AGENT_MAP[prog] || null) : null;
}

function isSubTerminal(t) {
  if (t.status || t.template || agentAppOf(t)) return true;
  return Boolean(t.records && Object.keys(t.records).length);
}

function recordName(id, r) {
  return r.title || r.msg || r.app || id;
}

function toRecordItem(id, r, parentAgent, fallbackVia, now) {
  const state = normalizeSubState(r.state, { failed: r.state === 'error' });
  return {
    id, terminal: null, parentAgent,
    name: recordName(id, r),
    via: r.app || fallbackVia,
    model: null, state, msg: r.msg || null, start: now, end: null,
  };
}

function termStartMs(t, now) {
  return Number(t.created_ms) || Number(t.since) || now;
}

function toSubTermItem(k, parentAgent, now) {
  const ended = k.state !== 'live';
  const failed = (ended && Boolean(k.exit_code)) || k.status?.state === 'error';
  const status = k.status || {};
  return {
    id: `hc:${k.address}`,
    terminal: k.address,
    parentAgent,
    name: k.name || status.title || k.template || status.app || k.address,
    via: status.app || k.template || 'hc',
    model: null,
    state: normalizeSubState(status.state, { ended, failed }),
    msg: status.msg || null,
    start: termStartMs(k, now),
    end: ended ? (Number(k.finished_ms) || now) : null,
  };
}

function collectRuntimeSubs(rootAddr, byParent, now) {
  const out = [];
  const walk = (parentAddr, parentAgentId) => {
    for (const k of byParent.get(parentAddr) || []) {
      if (!isSubTerminal(k)) continue;
      const sub = toSubTermItem(k, parentAgentId, now);
      out.push(sub);
      for (const [rid, r] of Object.entries(k.records || {})) {
        out.push(toRecordItem(`rec:${k.address}:${rid}`, r, sub.id, 'in-proc', now));
      }
      walk(k.address, sub.id);
    }
  };
  walk(rootAddr, null);
  return out;
}

function makeReturnEvent(id, from, to, at, status, detail) {
  const clean = stripBoilerplateReply(detail);
  return {
    kind: 'return', id, at, from, to: to || 'main', status,
    summary: oneLine(clean, 88),
    detail: clean || null,
  };
}

function matchesRuntimeAgent(a, rt) {
  return a.id === rt.id
    || Boolean(rt.terminal && a.terminal === rt.terminal)
    || Boolean(a.agentId && rt.id === `rec:${a.agentId}`);
}

function updateMatchedRuntime(lane, match, rt) {
  lane.rtMap[rt.id] = match;
  if (rt.terminal) match.terminal = rt.terminal;
  if (rt.msg !== undefined) match.msg = rt.msg || null;
  if (rt.end && !match.end) {
    match.end = rt.end;
    match.state = rt.state;
    lane.rtEvents.push(makeReturnEvent(`rt-ret-${rt.id}`, match.id, match.parentAgent, rt.end, rt.state, rt.msg));
    return;
  }
  if (!match.end) match.state = rt.state;
}

function findMatchingAgent(lane, rt) {
  return lane.agents.find((a) => matchesRuntimeAgent(a, rt)) || lane.rtMap[rt.id];
}

function syncRuntimeAgent(lane, rt) {
  const match = findMatchingAgent(lane, rt);
  if (match) { updateMatchedRuntime(lane, match, rt); return; }
  const added = {
    id: rt.id, name: rt.name, via: rt.via, model: rt.model,
    terminal: rt.terminal, parentAgent: rt.parentAgent,
    state: rt.state, start: rt.start, end: rt.end,
    prompt: rt.msg, reply: null,
  };
  lane.rtMap[rt.id] = added;
  lane.rtAgents.push(added);
  lane.rtEvents.push({
    kind: 'spawn', id: `rt-sp-${rt.id}`, at: rt.start,
    from: rt.parentAgent || 'main', to: added.id,
    title: added.name, detail: rt.msg, via: added.via, model: null,
  });
  if (rt.end) {
    lane.rtEvents.push(makeReturnEvent(`rt-ret-${rt.id}`, added.id, added.parentAgent, rt.end, rt.state, rt.msg));
  }
}

function isRuntimeId(id) {
  return id.startsWith('rec:') || id.startsWith('hc:');
}

function closeGoneRuntime(lane, seenIds, now) {
  for (const [id, agent] of Object.entries(lane.rtMap)) {
    if (seenIds.has(id) || agent.end || !isRuntimeId(id)) continue;
    agent.end = now;
    agent.state = agent.state === 'failed' ? 'failed' : 'done';
    lane.rtEvents.push(makeReturnEvent(`rt-ret-${id}-${now}`, agent.id, agent.parentAgent, now, agent.state, null));
  }
}

function capAgents(allAgents) {
  if (allAgents.length <= MAX_AGENTS) return allAgents;
  const open = allAgents.filter((a) => !a.end);
  const closed = allAgents.filter((a) => a.end).slice(-Math.max(0, MAX_AGENTS - open.length));
  return [...open, ...closed].slice(-MAX_AGENTS);
}

function overlayRuntimeStates(txAgents, rtMap) {
  const rtList = Object.values(rtMap);
  for (const a of txAgents) {
    if (!a.terminal) continue;
    const rt = rtList.find((r) => !r.end && r.terminal === a.terminal);
    if (!rt) continue;
    a.state = rt.state;
    a.msg = rt.msg || null;
  }
}

function pickLaneActivity(state, msg, txActivity) {
  return (state === 'working' ? (txActivity || msg) : (msg || txActivity)) || null;
}

function cleanAgentCopy(a) {
  const reply = a.reply ? (stripBoilerplateReply(a.reply) || null) : null;
  return { ...a, reply };
}

function filterRtEvents(rtEvents, txAgents, txEvents) {
  const txReturned = new Set(txEvents.filter((e) => e.kind === 'return').map((e) => e.from));
  return rtEvents.filter((e) => {
    if (e.kind === 'spawn') return !txAgents.some((t) => matchesRuntimeAgent(t, { id: e.to, terminal: e.to.startsWith('hc:') ? e.to.slice(3) : null }));
    if (e.kind === 'return') return !txReturned.has(e.from);
    return true;
  });
}

function assembleLane(lane, tx) {
  const txAgents = (tx?.agents || []).map(cleanAgentCopy);
  const txEvents = tx?.events || [];
  const keptRt = lane.rtAgents.filter((rt) => !txAgents.some((t) => matchesRuntimeAgent(t, rt)));
  overlayRuntimeStates(txAgents, lane.rtMap);
  const allAgents = [...txAgents, ...keptRt];
  allAgents.forEach((a, idx) => { a.colorIdx = idx % 8; });

  const events = [...txEvents, ...filterRtEvents(lane.rtEvents, txAgents, txEvents)]
    .filter((e) => VALID_KINDS.has(e.kind))
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_EVENTS);
  lane.sessionId = tx?.sessionId || lane.sessionId || null;
  lane.model = tx?.model || lane.model || null;
  lane.activity = pickLaneActivity(lane.state, lane.msg, tx?.activity);
  lane.agents = capAgents(allAgents);
  lane.events = events;
  lane.stats = computeStats(allAgents, events);
}

function stripInternal(board) {
  return {
    v: 2,
    lanes: board.lanes.map(({ rtMap: _m, rtAgents: _a, rtEvents: _e, ...pub }) => pub),
  };
}

function hydrateLane(raw) {
  const agents = raw.agents || [];
  const events = (raw.events || []).filter((e) => VALID_KINDS.has(e.kind));
  const rtAgents = agents.filter((a) => isRuntimeId(a.id));
  return {
    ...raw,
    agents,
    events,
    stats: computeStats(agents, events),
    rtMap: Object.fromEntries(rtAgents.map((a) => [a.id, a])),
    rtAgents,
    rtEvents: events.filter((e) => String(e.id).startsWith('rt-')),
  };
}

function closeLane(lane, now) {
  if (lane.ended) return;
  lane.ended = now;
  lane.state = lane.state === 'error' ? 'error' : 'idle';
  for (const a of lane.agents) {
    if (!a.end) { a.end = now; a.state = a.state === 'failed' ? 'failed' : 'done'; }
  }
  lane.stats = computeStats(lane.agents, lane.events);
}

function findOrCreateLane(board, addr, app, state, since, now) {
  const existing = board.lanes.find((l) => l.t === addr && !l.ended);
  if (existing) return existing;
  const fresh = hydrateLane({
    t: addr, app, since: Number(since) || now, ended: null,
    state, msg: null, activity: null, cwd: null, where: null,
  });
  board.lanes.push(fresh);
  return fresh;
}

function syncLaneMeta(lane, t) {
  const fg = t.foreground || {};
  const labels = t.labels || {};
  const status = t.status || {};
  const created = Number(t.created_ms);
  if (created > 0 && created < lane.since) lane.since = created;
  lane.cwd = fg.cwd || t.cwd || lane.cwd;
  lane.where = labels.where || lane.where;
  lane.msg = status.msg || null;
  return status.state || null;
}

function readLaneTx(sessionReader, addr, t, app, cwd, since, now) {
  if (!sessionReader) return null;
  const pid = t.pid || (t.foreground ? t.foreground.pid : 0);
  return sessionReader.read({ address: addr, pid, app, cwd, since }, now);
}

function updateRootLane(board, addr, t, app, byParent, now, sessionReader) {
  const rawState = t.status ? t.status.state : null;
  const lane = findOrCreateLane(board, addr, app, rawState || 'idle', t.created_ms ?? t.since, now);
  const st = syncLaneMeta(lane, t);
  const tx = readLaneTx(sessionReader, addr, t, app, lane.cwd, lane.since, now);
  lane.state = st || (tx && tx.state) || 'idle';
  lane.agents = tx && tx.agents ? tx.agents.map((a) => ({ ...a })) : [...lane.rtAgents];

  const rootRecords = Object.entries(t.records || {}).map(([rid, r]) => toRecordItem(`rec:${rid}`, r, null, app, now));
  const rtList = [...rootRecords, ...collectRuntimeSubs(addr, byParent, now)];
  for (const rt of rtList) syncRuntimeAgent(lane, rt);
  closeGoneRuntime(lane, new Set(rtList.map((r) => r.id)), now);
  assembleLane(lane, tx);
}

function groupByParent(local) {
  const byParent = new Map();
  for (const t of local) {
    if (!t.parent) continue;
    const arr = byParent.get(t.parent) || [];
    arr.push(t);
    byParent.set(t.parent, arr);
  }
  return byParent;
}

function isLocalTerm(t) {
  return typeof t?.address === 'string' && !t.address.includes('/');
}

function collectRootTerms(local) {
  const roots = new Map();
  for (const t of local) {
    if (t.state !== 'live' || t.parent) continue;
    const app = agentAppOf(t);
    if (app) roots.set(t.address, { t, app });
  }
  return roots;
}

function laneSinceOf(existing, t, now) {
  const created = Number(t.created_ms);
  if (!existing) return created || Number(t.since) || now;
  return created > 0 && created < existing.since ? created : existing.since;
}

function buildRootSpec(board, addr, t, app, now) {
  const existing = board.lanes.find((l) => l.t === addr && !l.ended);
  const fg = t.foreground || {};
  return {
    address: addr,
    pid: t.pid || fg.pid || 0,
    app,
    cwd: fg.cwd || t.cwd || existing?.cwd || null,
    since: laneSinceOf(existing, t, now),
  };
}

function rootSpecsFrom(board, roots, now) {
  const specs = [];
  for (const [addr, { t, app }] of roots) specs.push(buildRootSpec(board, addr, t, app, now));
  return specs;
}

/** Update `board` in place from `terminals` + optional `sessionReader`; returns true if changed. */
export function observe(board, terminals, now = Date.now(), sessionReader = null) {
  const before = JSON.stringify(stripInternal(board));
  const local = terminals.filter(isLocalTerm);
  const byParent = groupByParent(local);
  const roots = collectRootTerms(local);

  for (const lane of board.lanes) {
    const cur = roots.get(lane.t);
    if (!cur || cur.app !== lane.app) closeLane(lane, now);
  }
  if (typeof sessionReader?.prepare === 'function' && roots.size) {
    sessionReader.prepare(rootSpecsFrom(board, roots, now), now);
  }
  for (const [addr, { t, app }] of roots) updateRootLane(board, addr, t, app, byParent, now, sessionReader);

  board.lanes = board.lanes.filter((l) => !l.ended || now - l.ended <= KEEP_ENDED_MS);
  board.v = 2;
  return JSON.stringify(stripInternal(board)) !== before;
}

function loadSavedBoard(file, log) {
  try {
    if (!existsSync(file)) return emptyBoard();
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.v === 2 && Array.isArray(parsed.lanes)) return { v: 2, lanes: parsed.lanes.map(hydrateLane) };
  } catch (error) {
    log(`wayne-herdr-mods: 观测面板历史损坏，从空开始：${error.message}`);
  }
  return emptyBoard();
}

function writeBoardAtomically(dir, file, state, at, log) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...stripInternal(state), at }, null, 0), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    log(`wayne-herdr-mods: 写入 board.json 失败：${error.message}`);
  }
}

function snapshotLaneMap(lanes) {
  const m = new Map();
  for (const l of lanes) m.set(l.t, JSON.stringify(l));
  return m;
}

function diffChangedLane(prevByT, lanes) {
  const nextByT = snapshotLaneMap(lanes);
  const changed = new Set();
  for (const [t, raw] of nextByT) if (prevByT.get(t) !== raw) changed.add(t);
  for (const t of prevByT.keys()) if (!nextByT.has(t)) changed.add(t);
  prevByT.clear();
  for (const [t, raw] of nextByT) prevByT.set(t, raw);
  return changed.size === 1 ? { t: [...changed][0] } : {};
}

/** Persistent board service writing `board.json` and polling active transcripts gently. */
export function createBoard({ dir, log = () => {}, now = Date.now, delayMs = 200, pollMs = 2000, sessionReader = createSessionReader(), onChange = () => {} }) {
  const file = join(dir, 'board.json');
  const state = loadSavedBoard(file, log);
  const prevByT = snapshotLaneMap(stripInternal(state).lanes);
  const useAsync = pollMs > 0 && typeof sessionReader?.prepareAsync === 'function' && typeof sessionReader?.readBound === 'function';
  const activeReader = useAsync ? { read: (term) => sessionReader.readBound(term) } : sessionReader;
  let writeTimer = null;
  let lastTerminals = [];
  let at = now();
  let refreshing = false;
  let pendingRefresh = false;
  let disposed = false;

  const flush = () => {
    writeTimer = null;
    const doc = stripInternal(state);
    const info = diffChangedLane(prevByT, doc.lanes);
    writeBoardAtomically(dir, file, state, at, log);
    onChange(doc, info);
  };

  function applyUpdate(terminals, t) {
    if (!observe(state, terminals, t, activeReader)) return;
    at = t;
    if (writeTimer) return;
    writeTimer = setTimeout(flush, delayMs);
    writeTimer.unref?.();
  }

  function kickRefresh(terminals, t) {
    if (!useAsync || disposed) return;
    const specs = rootSpecsFrom(state, collectRootTerms(terminals.filter(isLocalTerm)), t);
    if (!specs.length || (typeof sessionReader.needsPrepare === 'function' && !sessionReader.needsPrepare(specs, t))) return;
    if (refreshing) { pendingRefresh = true; return; }
    refreshing = true;
    Promise.resolve(sessionReader.prepareAsync(specs, t))
      .catch((error) => log(`wayne-herdr-mods: 异步扫描会话句柄失败：${error?.message ?? error}`))
      .finally(() => {
        refreshing = false;
        if (disposed) return;
        applyUpdate(lastTerminals, now());
        if (pendingRefresh) { pendingRefresh = false; kickRefresh(lastTerminals, now()); }
      });
  }

  function update(terminals) {
    lastTerminals = terminals;
    const t = now();
    applyUpdate(terminals, t);
    kickRefresh(terminals, t);
  }

  const pollTimer = pollMs > 0 ? setInterval(() => {
    if (lastTerminals.length && state.lanes.some((l) => !l.ended)) update(lastTerminals);
  }, pollMs) : null;
  pollTimer?.unref?.();

  return {
    board: () => stripInternal(state),
    update,
    dispose() {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (writeTimer) { clearTimeout(writeTimer); flush(); }
    },
  };
}
