/**
 * One terminal page's stream and grid, as an explicit state machine (DESIGN.md「终端会话状态机」).
 * Pure: no DOM, no timers, no I/O. The PWA (main.js) and the native app (ios/App.tsx) both feed it
 * events and carry out the effects it returns, so the two pages cannot drift apart.
 *
 *   phase    waiting → opening → live ─┬→ retrying → waiting      (stream closed: reopen in 800 ms)
 *                ↑        │           ├→ waiting                   (link lost or renewed)
 *                └────────┤           └→ exited | replaced         (no retry; reopened on the next link ready)
 *                         └→ failed → waiting (on the next link ready)
 *   any → disposed (the page went away)
 *
 * Events (`step(state, event)`):
 *   {type:'link', ready, renewed?}  the link is (not) ready; renewed: ready again on another connection
 *   {type:'view'}                   the page can draw (iOS: the WebView said ready)
 *   {type:'fit', fit}               the phone's grid ({cols, rows}); null: not measured yet
 *   {type:'away', on}               the phone left (background, locked, hidden) or came back
 *   {type:'opened', r, epoch}       term.open answered {s, cols, rows, sized}
 *   {type:'openFailed', message, epoch}
 *   {type:'stream', msg}            an `out` / `size` / `closed` event for this terminal
 *   {type:'input', m, p, after?}    term.input / term.press: sent now, or held until the stream is back
 *   {type:'retry'}                  the 800 ms after a closed stream are over
 *   {type:'dispose'}
 *
 * Effects (carried out in order):
 *   {type:'rpc', m:'term.open', p, epoch}   answer with 'opened' / 'openFailed' carrying `epoch`
 *   {type:'rpc', m:'term.close', p}         fire and forget
 *   {type:'notify', m, p, after?}           term.fit / term.input / term.press (after: pause, ms)
 *   {type:'view', msg}                      draw: {t:'open'|'out'|'size', …} (the iOS page's messages)
 *   {type:'notice', text}                   the line under the terminal ('' clears it)
 *   {type:'retry', ms}                      send {type:'retry'} after `ms`
 */

export const RETRY_MS = 800;
export const QUEUE_MAX = 256; // inputs held while the stream is down; more are not kept
export const NOTICE = {
  lost: '连接断开，正在重连…',
  held: '连接断开，正在重连…（刚输入的内容重连后发出）',
  pressLost: '连接断开，正在重连…（刚按的键没有发出）',
  pressEarly: '终端还在打开，刚按的键没有发出',
  exited: (code) => `程序已退出${code !== null && code !== undefined ? `（${code}）` : ''}`,
  dropped: (n) => `有 ${n} 次输入没发出去`,
  cannotOpen: (message) => `打不开：${message}`,
  replaced: '这个终端在别的页面打开了', // this phone opened more than MAX_STREAMS (host/phones.js): the oldest gave way
};

/**
 * Whether the phone still leads (its grid is the terminal's size) after a `size` event
 * (DESIGN.md「多个窗口怎么同步」). `fitSent` is the last grid the phone sent, as JSON: a size other
 * than it means a Mac window took the terminal back. Before the phone sent a grid, or while it is
 * away (`"null"`), a size says nothing about the phone, so `leads` stays as it was.
 */
export function leadsAfterSize(leads, fitSent, { cols, rows }) {
  if (!fitSent || fitSent === 'null') return leads;
  return fitSent === JSON.stringify({ cols, rows });
}

export function initial(address) {
  return {
    address,
    phase: 'waiting',
    linkReady: false,
    viewReady: false,
    epoch: 0, // counts link (re)connections: an answer from an older one is stale
    s: null,
    sized: false, // the Mac reports sizes in the stream (newer herdr-core), so the phone may set its own
    opened: false, // a stream was open before on this page (a reopen keeps the old screen until the repaint)
    leads: true,
    fit: null,
    away: false,
    fitSent: '', // JSON of the last grid sent ('' none yet, 'null' away)
    openFit: null, // the grid term.open went out with
    early: [], // stream events that came before term.open's answer
    queue: [], // inputs held while the stream is down
    dropped: 0,
  };
}

/** The grid the phone wants the terminal at now: null while away; undefined while not measured. */
const wanted = (st) => (st.away ? null : st.fit || undefined);

function tryOpen(st, fx) {
  if (st.phase !== 'waiting' || !st.linkReady || !st.viewReady) return st;
  const fit = st.away ? null : st.fit;
  fx.push({ type: 'rpc', m: 'term.open', p: { address: st.address, fit, lead: st.leads || !st.opened }, epoch: st.epoch });
  return { ...st, phase: 'opening', early: [], openFit: fit };
}

/** Tell the Mac the phone's grid when it changed (null: the phone is away). */
function sendFit(st, fx) {
  const fit = wanted(st);
  if (st.phase !== 'live' || !st.sized || !st.linkReady || fit === undefined) return st;
  const key = JSON.stringify(fit);
  if (key === st.fitSent) return st;
  fx.push({ type: 'notify', m: 'term.fit', p: { s: st.s, fit } });
  return { ...st, fitSent: key };
}

function dropQueue(st, fx, text) {
  const n = st.queue.length + st.dropped;
  fx.push({ type: 'notice', text: n ? `${text}；${NOTICE.dropped(n)}` : text });
  return { ...st, queue: [], dropped: 0 };
}

const STREAM = {
  out(st, msg, fx) { fx.push({ type: 'view', msg: { t: 'out', d: msg.d, fresh: Boolean(msg.fresh), w: msg.w } }); return st; },
  size(st, msg, fx) {
    fx.push({ type: 'view', msg: { t: 'size', cols: msg.cols, rows: msg.rows } });
    return { ...st, leads: leadsAfterSize(st.leads, st.fitSent, msg) };
  },
  closed: onClosed,
};

function onStream(st, msg, fx) {
  if (st.phase === 'opening') return { ...st, early: [...st.early, msg] };
  if (st.phase !== 'live' || msg.s !== st.s || !Object.hasOwn(STREAM, msg.ev)) return st;
  return STREAM[msg.ev](st, msg, fx);
}

function onClosed(st, msg, fx) {
  const gone = { ...st, s: null };
  if (msg.reason === 'replaced') return dropQueue({ ...gone, phase: 'replaced' }, fx, NOTICE.replaced);
  if (msg.reason === 'exited') return dropQueue({ ...gone, phase: 'exited' }, fx, NOTICE.exited(msg.exitCode));
  fx.push({ type: 'notice', text: st.queue.length ? NOTICE.held : NOTICE.lost }, { type: 'retry', ms: RETRY_MS });
  return { ...gone, phase: 'retrying' };
}

/** Too late: the page went away, or the link changed meanwhile. That stream is nobody's. */
function onStaleOpened(st, { r, epoch }, fx) {
  fx.push({ type: 'rpc', m: 'term.close', p: { s: r.s } });
  // Our own open, but the link went down meanwhile: wait for it. (An older connection's answer:
  // the open on the current one is already out, see onLinkReady.)
  return st.phase === 'opening' && epoch === st.epoch ? tryOpen({ ...st, phase: 'waiting' }, fx) : st;
}

function onOpened(st, ev, fx) {
  if (st.phase !== 'opening' || ev.epoch !== st.epoch || !st.linkReady) return onStaleOpened(st, ev, fx);
  const { r } = ev;
  const sized = r.sized === true;
  let next = { ...st, phase: 'live', s: r.s, sized, fitSent: JSON.stringify(st.openFit), early: [] };
  fx.push({ type: 'view', msg: { t: 'open', sized, reopened: st.opened, cols: r.cols, rows: r.rows } }, { type: 'notice', text: '' });
  next.opened = true;
  for (const msg of st.early) next = onStream(next, msg, fx);
  if (next.phase !== 'live') return next;
  // The grid may have changed (or the phone left) while term.open was out: that goes first, so the
  // held input reaches the program at the right size (no redraw for the old grid in between).
  next = sendFit(next, fx);
  for (const q of next.queue) fx.push({ type: 'notify', m: q.m, p: { ...q.p, s: next.s }, after: q.after });
  if (next.dropped) fx.push({ type: 'notice', text: NOTICE.dropped(next.dropped) });
  return { ...next, queue: [], dropped: 0 };
}

function onOpenFailed(st, { message, epoch }, fx) {
  if (st.phase !== 'opening') return st;
  const waiting = { ...st, phase: 'waiting' };
  // The link went away or came back on another connection meanwhile: not the terminal's fault.
  if (epoch !== st.epoch) return st; // an older connection's: the open on this one is already out
  if (!st.linkReady) {
    fx.push({ type: 'notice', text: st.queue.length ? NOTICE.held : NOTICE.lost });
    return tryOpen(waiting, fx);
  }
  return dropQueue({ ...st, phase: 'failed' }, fx, NOTICE.cannotOpen(message));
}

function onLink(st, ev, fx) {
  if (st.phase === 'disposed') return st;
  return ev.ready ? onLinkReady(st, ev, fx) : onLinkLost(st, fx);
}

function onLinkLost(st, fx) {
  if (!st.linkReady) return st;
  const next = { ...st, linkReady: false };
  if (st.phase !== 'live' && st.phase !== 'retrying') return next;
  fx.push({ type: 'notice', text: st.queue.length ? NOTICE.held : NOTICE.lost });
  return { ...next, phase: 'waiting', s: null };
}

function onLinkReady(st, { renewed = false }, fx) {
  if (st.linkReady && !renewed) return st;
  let next = { ...st, linkReady: true, epoch: st.epoch + 1 };
  // Ready on another connection: the old stream stays behind there. Open the terminal again here.
  // After an exit or a takeover too: the terminal may be back (as the pages did before this module).
  // While opening: that open went out on the older connection. Do not wait for its answer (up to the
  // 30 s rpc timeout); open here now. The old answer is closed when it comes (onOpened, epoch).
  if (['live', 'retrying', 'failed', 'exited', 'replaced', 'opening'].includes(next.phase)) next = { ...next, phase: 'waiting', s: null };
  return tryOpen(next, fx);
}

function onInput(st, { m, p, after = 0 }, fx) {
  if (st.phase === 'live' && st.linkReady) { fx.push({ type: 'notify', m, p: { ...p, s: st.s }, after }); return st; }
  if (['exited', 'replaced', 'failed', 'disposed'].includes(st.phase)) return st; // nothing will take it
  // A control key answers the screen as it was: replayed after a reconnect it may answer another
  // prompt. Drop it and say so (F1, the user decided 2026-11-09). Text still queues.
  if (m === 'term.press') {
    fx.push({ type: 'notice', text: st.opened ? NOTICE.pressLost : NOTICE.pressEarly });
    return { ...st, dropped: st.dropped + 1 };
  }
  if (st.queue.length >= QUEUE_MAX) return { ...st, dropped: st.dropped + 1 };
  if (!st.queue.length && (st.phase === 'retrying' || (st.phase === 'waiting' && st.opened))) fx.push({ type: 'notice', text: NOTICE.held });
  return { ...st, queue: [...st.queue, { m, p, after }] };
}

const STEP = {
  link: onLink,
  view: (st, ev, fx) => (st.viewReady ? st : tryOpen({ ...st, viewReady: true }, fx)),
  fit: (st, ev, fx) => sendFit({ ...st, fit: ev.fit ?? st.fit }, fx),
  away: (st, ev, fx) => sendFit({ ...st, away: Boolean(ev.on) }, fx),
  opened: onOpened,
  openFailed: onOpenFailed,
  stream: (st, ev, fx) => onStream(st, ev.msg, fx),
  input: onInput,
  retry: (st, ev, fx) => (st.phase === 'retrying' ? tryOpen({ ...st, phase: 'waiting' }, fx) : st),
  dispose(st, ev, fx) {
    if (st.phase === 'disposed') return st;
    if (st.s !== null && st.linkReady) fx.push({ type: 'rpc', m: 'term.close', p: { s: st.s } });
    return { ...st, phase: 'disposed', s: null, queue: [], early: [] };
  },
};

/** The next state and the effects to carry out, for one event. Never mutates `st`. */
export function step(st, ev) {
  const fx = [];
  const next = Object.hasOwn(STEP, ev.type) ? STEP[ev.type](st, ev, fx) : st;
  return { state: next, effects: fx };
}

/** A session for one page: `send(event)` steps it and hands the effects to `run`. */
/**
 * Append `fn` to an ordered send queue (a promise chain). One failing step must not stop every
 * later one: without the catch, the chain stays rejected and all input after it is silently lost.
 */
export function enqueue(q, fn) {
  return q.then(fn).catch((e) => { console.warn(`term input: ${e?.message ?? e}`); });
}

export function termSession(address, run) {
  let state = initial(address);
  const session = {
    get state() { return state; },
    send(ev) {
      const r = step(state, ev);
      state = r.state;
      run(r.effects, session);
      return r.effects;
    },
  };
  return session;
}
