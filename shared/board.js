/**
 * Canonical subagent observation state machine, Metro topology geometry, and renderer-agnostic
 * view-model (`DESIGN.md`「观测面板」).
 *
 * Pure JS with zero Node, DOM, GPUI, or NSH dependencies: shared identically by `host/` (state &
 * RPC), `herdr-app/mods/wayne-board/` (Mac sidebar), and `ios/` (`BoardSheet` & `TermScreen`).
 */

export const SUB_STATES = Object.freeze(['working', 'waiting', 'blocked', 'done', 'failed', 'stopped']);

export const SIZE = Object.freeze({
  pad: 8,
  railLeft: 15,
  railStep: 14,
  compactRailStep: 12,
  compactThreshold: 4,
  maxRails: 6,
  rowH: 30,
  subRowH: 42,
  detailLineH: 16,
  detailPad: 18,
  dotY: 15,
});

const COMM_KINDS = new Set(['spawn', 'message', 'return']);
const END_BY_RAW = { failed: 'failed', stopped: 'stopped', done: 'done' };
const LIVE_BY_RAW = { blocked: 'blocked', error: 'blocked', waiting: 'waiting' };
const TONE_BY_STATE = { blocked: 'warn', waiting: 'muted', failed: 'bad', error: 'bad', stopped: 'muted' };
const STAT_FIELD = {
  working: 'running',
  waiting: 'waiting',
  blocked: 'blocked',
  failed: 'failed',
  stopped: 'stopped',
  done: 'done',
};
const LIVE_RANK = { blocked: 3, working: 2, waiting: 1 };
const DONE_TAG_RE = /^(?:@[A-Za-z0-9_.-]+\s+)?\[done\]\s*/i;
const CODEX_ENV_RE = /^Message Type:\s*(?:FINAL_ANSWER|MESSAGE)\s*(?:Task name:[^\n]*\n)?(?:Sender:[^\n]*\n)?(?:Payload:\s*)?/i;
const AGENT_FINISHED_RE = /^Agent\s+"[^"]+"\s+(?:finished|completed)\.?$/i;

export const railX = (rail, step = SIZE.railStep) => SIZE.railLeft + rail * step;

export function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function span(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  const rem = m % 60;
  return `${Math.floor(m / 60)}h${rem ? `${rem}m` : ''}`;
}

function folderBasename(cwd) {
  return cwd ? cwd.replace(/\/+$/, '').split('/').pop() : '';
}

export function laneTitle(lane) {
  if (!lane) return '';
  return lane.where || folderBasename(lane.cwd) || lane.t || '';
}

export function stripBoilerplateReply(raw) {
  const cleaned = String(raw ?? '').trim().replace(CODEX_ENV_RE, '').replace(DONE_TAG_RE, '').trim();
  return AGENT_FINISHED_RE.test(cleaned) ? '' : cleaned;
}

export function normalizeSubState(raw, { ended = false, failed = false, stopped = false } = {}) {
  if (failed) return 'failed';
  if (stopped) return 'stopped';
  if (END_BY_RAW[raw]) return END_BY_RAW[raw];
  if (ended) return 'done';
  return LIVE_BY_RAW[raw] || 'working';
}

export function computeStats(agents = [], events = []) {
  const stats = { totalSubs: agents.length, running: 0, waiting: 0, blocked: 0, done: 0, failed: 0, stopped: 0, messages: 0 };
  for (const a of agents) stats[STAT_FIELD[a.state] || 'done']++;
  for (const e of events) if (e.kind === 'message') stats.messages++;
  return stats;
}

export function boardBadgeOf(stats) {
  const blocked = stats?.blocked ?? 0;
  if (blocked > 0) return { kind: 'blocked', count: blocked, tone: 'warn' };
  const running = stats?.running ?? 0;
  if (running > 0) return { kind: 'running', count: running, tone: 'accent' };
  return { kind: 'none', count: 0, tone: 'neutral' };
}

function ownsAddress(lane, address) {
  if (lane.t === address) return true;
  return (lane.agents || []).some((a) => a.terminal === address);
}

/** Find the lane for `address` (or the parent lane if `address` is a child subagent terminal). */
export function laneOf(board, address) {
  const lanes = board?.lanes;
  if (!lanes?.length || !address) return null;
  let endedHit = null;
  for (let i = lanes.length - 1; i >= 0; i--) {
    const l = lanes[i];
    if (!ownsAddress(l, address)) continue;
    if (!l.ended) return l;
    endedHit = endedHit || l;
  }
  return endedHit;
}

function visualUnits(line) {
  let units = 0;
  for (let i = 0; i < line.length; i++) units += line.charCodeAt(i) > 0x2e7f ? 1.85 : 1;
  return units;
}

function detailHeight(text) {
  if (!text) return 0;
  let wrapped = 0;
  for (const line of String(text).split('\n')) wrapped += Math.max(1, Math.ceil(visualUnits(line) / 34));
  const lines = Math.min(24, Math.max(2, wrapped));
  return SIZE.detailPad + lines * SIZE.detailLineH;
}

function measureRow(previewText, expandedDetail) {
  const base = previewText ? SIZE.subRowH : SIZE.rowH;
  return base + detailHeight(expandedDetail);
}

function claimRail(usedRails) {
  const taken = new Set(usedRails.values());
  for (let r = 1; r <= SIZE.maxRails; r++) {
    if (!taken.has(r)) return r;
  }
  return SIZE.maxRails;
}

function toneForState(state) {
  return TONE_BY_STATE[state] || 'rail';
}

function thruEntry(rail, sub, part = 'full') {
  const st = sub ? sub.state : 'working';
  return {
    rail,
    colorIdx: sub ? sub.colorIdx : 0,
    state: st,
    tone: toneForState(st),
    dashed: st === 'working',
    part,
  };
}

function snapThru(usedRails, agentMap, skipId = null) {
  const list = [];
  for (const [aid, rail] of usedRails.entries()) {
    if (aid !== skipId) list.push(thruEntry(rail, agentMap.get(aid)));
  }
  return list;
}

function railOfRef(ref, usedRails) {
  return !ref || ref === 'main' ? 0 : (usedRails.get(ref) || 0);
}

function isOpenSub(a) {
  return !a.end && Boolean(LIVE_RANK[a.state]);
}

function hasFollowupEvent(events, fromIdx, agentId) {
  for (let i = fromIdx + 1; i < events.length; i++) {
    if (events[i].kind !== 'spawn' || events[i].from === agentId) return true;
  }
  return false;
}

function findContinuedOpenIds(openSubs, events) {
  const spawnIdx = new Map();
  events.forEach((e, idx) => { if (e.kind === 'spawn') spawnIdx.set(e.to, idx); });
  const continued = new Set();
  for (const sub of openSubs) {
    const idx = spawnIdx.get(sub.id);
    if (idx === undefined || hasFollowupEvent(events, idx, sub.id)) continued.add(sub.id);
  }
  return continued;
}

function stepSpawn(ev, state) {
  const sub = state.agentMap.get(ev.to);
  const fromRail = railOfRef(ev.from, state.usedRails);
  const subRail = state.usedRails.get(ev.to) || claimRail(state.usedRails);
  const thru = snapThru(state.usedRails, state.agentMap, ev.to);
  const continued = state.continuedOpenIds.has(ev.to);
  if (state.willMerge.has(ev.to) || continued) {
    state.usedRails.set(ev.to, subRail);
    thru.push(thruEntry(subRail, sub, 'bottom'));
  }
  state.maxRail = Math.max(state.maxRail, subRail);
  const colorIdx = sub ? sub.colorIdx : 0;
  const st = sub ? sub.state : 'working';
  const isTip = Boolean(sub && isOpenSub(sub) && !continued);
  const curves = [{ kind: 'fork', from: fromRail, to: subRail, colorIdx, state: st, tone: toneForState(st), dashed: st === 'working' }];
  return { rail: subRail, colorIdx, thru, curves, bridge: null, isTip };
}

function stepReturn(ev, state) {
  const sub = state.agentMap.get(ev.from);
  const subRail = state.usedRails.get(ev.from) || 1;
  const toRail = railOfRef(ev.to, state.usedRails);
  state.usedRails.delete(ev.from);
  const colorIdx = sub ? sub.colorIdx : 0;
  const status = ev.status || 'done';
  const curves = [{ kind: 'merge', from: subRail, to: toRail, colorIdx, state: status, tone: toneForState(status), dashed: false }];
  return { rail: toRail, colorIdx, thru: snapThru(state.usedRails, state.agentMap), curves, bridge: null, isTip: false };
}

function stepMessage(ev, state) {
  const fromRail = railOfRef(ev.from, state.usedRails);
  const toRail = railOfRef(ev.to, state.usedRails);
  const peerKey = ev.from === 'main' ? ev.to : ev.from;
  const sub = state.agentMap.get(peerKey);
  const colorIdx = sub ? sub.colorIdx : 0;
  const dir = toRail >= fromRail ? 1 : -1;
  return {
    rail: toRail,
    colorIdx,
    thru: snapThru(state.usedRails, state.agentMap),
    curves: [],
    bridge: { from: fromRail, to: toRail, dir, colorIdx },
    isTip: false,
  };
}

const STEP_EVENT = { spawn: stepSpawn, return: stepReturn, message: stepMessage };
const MAIN_SOLID_TONE = { blocked: 'warn', error: 'bad' };

function mainStation(lane, stats) {
  if (lane.ended) return { shape: 'ring', colorIdx: -1, tone: 'muted' };
  if (lane.state === 'working') return { shape: 'spin', colorIdx: -1, tone: 'working' };
  const solid = MAIN_SOLID_TONE[lane.state];
  if (solid) return { shape: 'solid', colorIdx: -1, tone: solid };
  if (stats.running > 0 || stats.blocked > 0) return { shape: 'ring', colorIdx: -1, tone: 'working' };
  return lane.state === 'done'
    ? { shape: 'solid', colorIdx: -1, tone: 'ok' }
    : { shape: 'ring', colorIdx: -1, tone: 'muted' };
}

function tipStation(agent, colorIdx) {
  if (agent?.state === 'blocked') return { shape: 'solid', colorIdx, tone: 'warn' };
  if (agent?.state === 'waiting') return { shape: 'ring', colorIdx, tone: 'rail' };
  return { shape: 'spin', colorIdx, tone: 'rail' };
}

function returnStation(status, colorIdx) {
  if (status === 'failed') return { shape: 'solid', colorIdx, tone: 'bad' };
  if (status === 'stopped') return { shape: 'ring', colorIdx, tone: 'muted' };
  return { shape: 'solid', colorIdx, tone: 'rail' };
}

function resolveStation(base, lane, stats) {
  if (base.kind === 'main') return mainStation(lane, stats);
  if (base.isTip) return tipStation(base.agent, base.colorIdx);
  if (base.kind === 'return') return returnStation(base.event?.status || 'done', base.colorIdx);
  return { shape: 'ring', colorIdx: base.colorIdx, tone: 'rail' };
}

function agentSpan(agent, endMs) {
  return agent?.start && endMs ? span(endMs - agent.start) : '';
}

function peerName(id, agentMap) {
  if (!id || id === 'main') return 'main';
  return agentMap.get(id)?.name || id;
}

function firstTag(...candidates) {
  return candidates.find(Boolean) || null;
}

function joinMeta(...parts) {
  return parts.filter(Boolean).join(' · ');
}

function metaToneOfState(state) {
  const tone = TONE_BY_STATE[state];
  return tone === 'warn' || tone === 'bad' ? tone : 'muted';
}

function mainHeadline(lane, now) {
  return {
    kind: 'standard',
    icon: null,
    iconTone: 'muted',
    title: firstTag(lane.model, lane.app, lane.t) || '',
    titleTone: lane.ended ? 'muted' : 'fg',
    right: lane.since ? span((lane.ended || now) - lane.since) : '',
    rightTone: metaToneOfState(lane.state),
    bold: true,
  };
}

function openAgentStyle(agent) {
  const waiting = agent?.state === 'waiting';
  return {
    titleTone: waiting ? 'muted' : 'fg',
    iconTone: waiting ? 'muted' : 'rail',
    rightTone: agent?.state === 'blocked' ? 'warn' : 'muted',
    bold: !waiting,
  };
}

function spawnHeadline(ev, agent, isTip, now) {
  const tag = firstTag(ev.model, agent?.model, ev.via, agent?.via);
  const style = isTip ? openAgentStyle(agent) : { titleTone: 'fg', iconTone: 'rail', rightTone: 'muted', bold: true };
  return {
    kind: 'standard',
    icon: 'fork',
    iconTone: style.iconTone,
    title: firstTag(ev.title, agent?.name) || 'subagent',
    titleTone: style.titleTone,
    right: joinMeta(tag, agent?.terminal, isTip ? agentSpan(agent, now) : ''),
    rightTone: style.rightTone,
    bold: style.bold,
  };
}

const RETURN_ICON = { failed: 'fail', stopped: 'stop' };

function returnHeadline(ev, agent) {
  const status = ev.status || 'done';
  return {
    kind: 'standard',
    icon: RETURN_ICON[status] || 'merge',
    iconTone: toneForState(status),
    title: firstTag(agent?.name, ev.from) || 'subagent',
    titleTone: status === 'failed' ? 'bad' : 'muted',
    right: agentSpan(agent, agent?.end || ev.at),
    rightTone: 'muted',
    bold: false,
  };
}

function liveHeadline(agent, now) {
  const style = openAgentStyle(agent);
  const tag = firstTag(agent?.model, agent?.via);
  return {
    kind: 'standard',
    icon: null,
    iconTone: 'rail',
    title: agent?.name || 'subagent',
    titleTone: style.titleTone,
    right: joinMeta(tag, agent?.terminal, agentSpan(agent, now)),
    rightTone: style.rightTone,
    bold: style.bold,
  };
}

function resolveHeadline(base, state) {
  const { kind, isTip, event: ev, agent, colorIdx } = base;
  if (kind === 'main') return mainHeadline(state.lane, state.now);
  if (kind === 'spawn') return spawnHeadline(ev, agent, isTip, state.now);
  if (kind === 'return') return returnHeadline(ev, agent);
  if (kind === 'live') return liveHeadline(agent, state.now);
  return { kind: 'message', from: peerName(ev.from, state.agentMap), to: peerName(ev.to, state.agentMap), colorIdx, right: hhmm(ev.at) };
}

function liveStepOfAgent(agent) {
  if (agent.state === 'blocked') return firstTag(agent.msg, agent.activity) || '';
  return firstTag(agent.activity, agent.msg) || '';
}

function combineStepAndPrompt(liveStep, prompt) {
  if (liveStep && prompt && liveStep !== prompt) return `${liveStep}\n\n${prompt}`;
  return liveStep || prompt;
}

function tipBody(agent) {
  if (!agent) return { preview: '', detail: '', tone: 'muted' };
  const liveStep = liveStepOfAgent(agent);
  const prompt = agent.prompt || '';
  const detail = combineStepAndPrompt(liveStep, prompt);
  const preview = agent.state === 'waiting' ? liveStep : (liveStep || prompt);
  return { preview, detail, tone: metaToneOfState(agent.state) };
}

function mainBody(lane) {
  const text = firstTag(lane.activity, lane.msg) || '';
  return { preview: text, detail: text, tone: metaToneOfState(lane.state) };
}

function returnBody(ev, agent) {
  const summary = stripBoilerplateReply(ev?.summary);
  const detail = stripBoilerplateReply(firstTag(ev?.detail, agent?.reply)) || summary;
  return { preview: summary || detail, detail, tone: ev?.status === 'failed' ? 'bad' : 'muted' };
}

function messageBody(ev) {
  const summary = stripBoilerplateReply(firstTag(ev?.summary, ev?.detail));
  const detail = stripBoilerplateReply(firstTag(ev?.detail, ev?.summary));
  return { preview: summary, detail, tone: 'muted' };
}

function rawBodyContent(base, lane) {
  if (base.kind === 'main') return mainBody(lane);
  if (base.kind === 'live' || base.isTip) return tipBody(base.agent);
  if (base.kind === 'return') return returnBody(base.event, base.agent);
  if (base.kind === 'message') return messageBody(base.event);
  const text = firstTag(base.event?.detail, base.agent?.prompt) || '';
  return { preview: text, detail: text, tone: 'muted' };
}

function packTextAndHeight(id, body, openIds) {
  const flatPreview = String(body.preview || '').replace(/\s+/g, ' ').trim();
  const cleanDetail = String(body.detail || '').trim();
  const expandable = Boolean(cleanDetail);
  const expanded = expandable && openIds.has(id);
  const h = measureRow(flatPreview, expanded ? cleanDetail : null);
  const subline = !expanded && flatPreview ? { text: flatPreview, tone: body.tone } : null;
  return { h, expandable, expanded, subline, detail: cleanDetail || null };
}

function decorateRow(base, state, openIds) {
  const body = rawBodyContent(base, state.lane);
  const textBox = packTextAndHeight(base.id, body, openIds);
  const row = {
    ...base,
    y: state.y,
    ...textBox,
    station: resolveStation(base, state.lane, state.stats),
    headline: resolveHeadline(base, state),
  };
  state.y += row.h;
  return row;
}

function buildMainRow(lane, hasChildren, state, openIds) {
  return decorateRow({
    id: 'main', kind: 'main', isTip: false, event: null, agent: null,
    rail: 0, colorIdx: -1, thru: [], curves: [], bridge: null,
    trunkTop: false, trunkBottom: hasChildren,
  }, state, openIds);
}

function eventAgentOf(ev, agentMap) {
  const primary = ev.kind === 'return' ? ev.from : ev.to;
  return agentMap.get(primary) || agentMap.get(ev.from) || null;
}

function buildEventRow(ev, state, openIds) {
  const geom = STEP_EVENT[ev.kind](ev, state);
  return decorateRow({
    id: ev.id, kind: ev.kind, isTip: geom.isTip, event: ev, agent: eventAgentOf(ev, state.agentMap),
    rail: geom.rail, colorIdx: geom.colorIdx,
    thru: geom.thru, curves: geom.curves, bridge: geom.bridge,
    trunkTop: true, trunkBottom: true,
  }, state, openIds);
}

function buildLiveRow(sub, isLast, state, openIds) {
  const subRail = state.usedRails.get(sub.id) || claimRail(state.usedRails);
  state.maxRail = Math.max(state.maxRail, subRail);
  state.usedRails.delete(sub.id);
  const thru = snapThru(state.usedRails, state.agentMap);
  const spawned = state.spawnedIds.has(sub.id);
  const st = sub.state;
  const curves = spawned ? [] : [{ kind: 'fork', from: 0, to: subRail, colorIdx: sub.colorIdx, state: st, tone: toneForState(st), dashed: st === 'working' }];
  if (spawned) thru.push(thruEntry(subRail, sub, 'top'));
  return decorateRow({
    id: `live-${sub.id}`, kind: 'live', isTip: true, event: null, agent: sub,
    rail: subRail, colorIdx: sub.colorIdx,
    thru, curves, bridge: null, trunkTop: true, trunkBottom: !isLast,
  }, state, openIds);
}

function attachPixelCoords(rows, step) {
  for (const r of rows) {
    r.dotY = SIZE.dotY;
    r.x = railX(r.rail, step);
    for (const seg of r.thru) seg.x = railX(seg.rail, step);
    for (const c of r.curves) { c.x0 = railX(c.from, step); c.x1 = railX(c.to, step); }
    if (r.bridge) {
      r.bridge.x0 = railX(r.bridge.from, step);
      r.bridge.x1 = railX(r.bridge.to, step);
      r.bridge.tip = r.bridge.x1 - r.bridge.dir * 5.5;
    }
  }
}

function createLayoutState(lane, now) {
  const agents = lane.agents ?? [];
  const events = (lane.events ?? []).filter((e) => COMM_KINDS.has(e.kind));
  const stats = lane.stats ?? computeStats(agents, events);
  const openSubs = agents.filter(isOpenSub);
  const continuedOpenIds = findContinuedOpenIds(openSubs, events);
  const liveSubs = openSubs
    .filter((a) => continuedOpenIds.has(a.id))
    .sort((a, b) => (LIVE_RANK[b.state] - LIVE_RANK[a.state]));
  return {
    lane,
    events,
    liveSubs,
    stats,
    now,
    agentMap: new Map(agents.map((a) => [a.id, a])),
    willMerge: new Set(events.filter((e) => e.kind === 'return').map((e) => e.from)),
    spawnedIds: new Set(events.filter((e) => e.kind === 'spawn').map((e) => e.to)),
    continuedOpenIds,
    usedRails: new Map(),
    rows: [],
    maxRail: 0,
    y: SIZE.pad,
  };
}

function buildHeader(lane, stats) {
  return {
    title: laneTitle(lane),
    address: lane.t || '',
    muted: Boolean(lane.ended),
    running: stats.running ?? 0,
    blocked: stats.blocked ?? 0,
    badge: boardBadgeOf(stats),
  };
}

/**
 * Lay out one agent session's communication topology (main root on rail 0 + subagents on rails 1..6)
 * together with its fully normalized renderer-agnostic view-model.
 */
export function layoutMetro(lane, { openIds = new Set(), now = Date.now() } = {}) {
  if (!lane) return { header: null, rows: [], maxRail: 0, railStep: SIZE.railStep, gutterW: 30, height: SIZE.pad };
  const state = createLayoutState(lane, now);
  state.rows.push(buildMainRow(lane, Boolean(state.events.length || state.liveSubs.length), state, openIds));
  for (const ev of state.events) state.rows.push(buildEventRow(ev, state, openIds));
  state.liveSubs.forEach((sub, i) => state.rows.push(buildLiveRow(sub, i === state.liveSubs.length - 1, state, openIds)));
  if (!state.liveSubs.length) state.rows.at(-1).trunkBottom = false;

  const step = state.maxRail > SIZE.compactThreshold ? SIZE.compactRailStep : SIZE.railStep;
  attachPixelCoords(state.rows, step);
  const gutterW = SIZE.railLeft + state.maxRail * step + 14;
  return {
    header: buildHeader(lane, state.stats),
    rows: state.rows,
    maxRail: state.maxRail,
    railStep: step,
    gutterW,
    height: state.y + SIZE.pad,
  };
}
