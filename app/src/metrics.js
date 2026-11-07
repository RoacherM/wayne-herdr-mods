import { wheelSteps } from '../../shared/wheel.js';

/**
 * What the phone measures, for DESIGN.md「体验记录」: times and kinds only. Never what is on the
 * screen, never what was typed. Batches go to the Mac (`metrics.put`) every 15 s while the page
 * shows, and when it hides; each batch's round trip is itself a sample of the link's delay.
 *
 * Every event: { t (epoch ms), ev, via ('direct' | 'relay' | '') , … }
 *   echo    { net, paint }          a key typed into a quiet terminal → its output arrives / is drawn
 *   open    { ms, again }           a terminal opened (again: reopened after a reconnect) → drawn
 *   resume  { away, ready, paint }  back on the page after `away` ms → link ready → drawn (null: nothing came)
 *   rtt     { ms, n, ice?, pair? }  one metrics.put round trip carrying n events; on the direct path
 *                                   also WebRTC's own round trip (ice, no queues of ours) and the kind
 *                                   of path (pair: host = same network, srflx = through NAT, relay = TURN)
 *   link    { status }              the link's status changed
 *   scroll  { mode, ms, n, p95, long, steps, coast, lag, lagMax, answered, kb }
 *           one touch on the terminal and its coast. mode 'history' (moves here) or 'program' (a
 *           full-screen program: wheel steps to the Mac). n/p95/long: the gaps between frames.
 *           steps: wheel steps sent, coast: steps the Mac sends for the flick. lag: for each step,
 *           from sending it to the first drawn screen the program made after it (the Mac stamps
 *           every output with the steps it had, `w`); the median, the most, and how many were
 *           answered. kb: output drawn meanwhile (DESIGN.md「滑动延迟」)
 *   op      { op, key? }            what the person did: a key bar key, paste, voice, image, open, back
 *   kbd     { why, f, act, vh, vt, sc, ih, dh, sy, up, st, sb }  what the terminal page sees change
 *           around the keyboard (keyboard-fit.js): focus, the visual viewport, the window, the scroll,
 *           the page's own top and bottom. Numbers only, never text
 */
const KEEP = 400;          // events held while the Mac cannot be reached
const QUIET_MS = 300;      // an echo counts only after this long without output (else it is not ours)
const ECHO_GIVE_UP = 2000; // no output this long after a key: that key printed nothing
const OPEN_GIVE_UP = 15_000; // an open with nothing drawn this long: not counted (a later drawing is not its)
const FLUSH_MS = 15_000;
const LONG_FRAME = 50;     // a frame gap the eye sees as a stutter

const now = () => performance.now();
const ms = (x) => Math.round(x);

export function createMetrics({ src = 'phone', version = '' } = {}) {
  const queue = [];
  const all = [];          // everything this page saw (tests and the bench read it)
  let link = null;
  let lastOut = -Infinity;
  let echo = null;         // { t0 } a key waiting for its output
  let paint = null;        // { ev, t0, data } a screen waiting for its first drawing
  let resume = null;       // { t0, away, ready }
  let hiddenAt = null;
  let timer = null;

  function mark(ev, data = {}) {
    const e = { t: Date.now(), ev, via: link?.via ?? '', ...data };
    queue.push(e);
    if (queue.length > KEEP) queue.splice(0, queue.length - KEEP);
    all.push(e);
    if (all.length > 5000) all.splice(0, 1000);
    return e;
  }

  /** Something went to the terminal from the keyboard or the key bar. */
  function typed() {
    const t = now();
    if (!echo && t - lastOut > QUIET_MS) echo = { t0: t };
  }

  /**
   * Output arrived for the open terminal. Returns what to call once xterm has drawn it (or null):
   * the time to the next frame after that is what the person sees.
   */
  function output(bytes = 0, w = null) {
    const t = now();
    lastOut = t;
    const waiting = [];
    if (touch) touch.bytes += bytes;
    // The wheel steps this screen answers (the Mac said the program had `w` of them).
    if (Number.isFinite(w) && sent.length && sent[0][0] <= w) {
      const done = []; while (sent.length && sent[0][0] <= w) done.push(sent.shift()[1]);
      const g = touch;
      if (g) waiting.push((d) => { for (const t0 of done) g.lags.push(d - t0); });
    }
    if (echo) {
      const e = echo; echo = null;
      if (t - e.t0 <= ECHO_GIVE_UP) waiting.push((d) => mark('echo', { net: ms(t - e.t0), paint: ms(d - e.t0) }));
    }
    if (paint && t - paint.t0 > OPEN_GIVE_UP) paint = null;
    if (paint) { const p = paint; paint = null; waiting.push((d) => mark(p.ev, { ...p.data, ms: ms(d - p.t0) })); }
    if (resume?.ready !== undefined) { const r = resume; resume = null; waiting.push((d) => mark('resume', { away: r.away, ready: r.ready, paint: ms(d - r.t0) })); }
    if (!waiting.length) return null;
    return () => requestAnimationFrame(() => { const d = now(); for (const w of waiting) w(d); });
  }

  /** A terminal is being opened (again): its first drawing ends the wait. */
  function opening(again) { paint = { ev: 'open', t0: now(), data: { again } }; }

  function op(name, key) { mark('op', key ? { op: name, key } : { op: name }); }

  // ---- touch: one drag (and its coast): frame gaps, and for a full-screen program the lag of
  // each wheel step until a screen made after it is drawn
  let touch = null;
  let stream = null, count = 0;
  const sent = [];          // [step number, time sent] not yet answered
  function input(s, d) {
    const n = wheelSteps(d);
    if (!n) return;
    if (s !== stream) { stream = s; count = 0; sent.length = 0; } // a new stream counts from 0 (as the Mac does)
    for (let i = 0; i < n; i++) sent.push([++count, now()]);
    if (sent.length > 2000) sent.splice(0, sent.length - 2000);
    if (touch) touch.steps += n;
  }
  function coasting(n) { if (touch) touch.coast += n; }
  function touchStart(mode) {
    if (touch) { clearTimeout(touch.stop); return; }
    touch = { mode, t0: now(), last: now(), gaps: [], raf: 0, stop: 0, steps: 0, coast: 0, lags: [], bytes: 0 };
    const tick = () => { const t = now(); touch.gaps.push(t - touch.last); touch.last = t; touch.raf = requestAnimationFrame(tick); };
    touch.raf = requestAnimationFrame(tick);
  }
  function touchEnd() {
    if (!touch) return;
    clearTimeout(touch.stop);
    const g = touch;
    const t1 = now();
    // The coast after the finger lifts is part of it; so are the screens still on their way (up to 5 s).
    const finish = () => {
      if (touch !== g) return;
      if (sent.length && now() - t1 < 5000) { g.stop = setTimeout(finish, 200); return; }
      touch = null;
      cancelAnimationFrame(g.raf);
      const gaps = g.gaps.slice(1).sort((a, b) => a - b);
      if (gaps.length < 5 && !g.steps) return;
      const lags = g.lags.sort((a, b) => a - b);
      mark('scroll', {
        mode: g.mode, ms: ms(now() - g.t0), n: gaps.length, p95: gaps.length ? ms(gaps[Math.floor(gaps.length * 0.95)]) : 0,
        long: gaps.filter((x) => x > LONG_FRAME).length, steps: g.steps, coast: g.coast,
        lag: lags.length ? ms(lags[Math.floor((lags.length - 1) / 2)]) : null, lagMax: lags.length ? ms(lags.at(-1)) : null,
        answered: lags.length, kb: Math.round(g.bytes / 1024),
      });
    };
    g.stop = setTimeout(finish, 600);
  }

  // ---- the link and the page
  function watch(l) {
    link = l;
    let last = l.status;
    l.addEventListener('status', () => {
      if (l.status === last) return;
      last = l.status;
      mark('link', { status: l.status });
      if (!resume) return;
      if (l.status !== 'ready') resume.ready = undefined; // the link found it was dead: wait for it again
      else if (resume.ready === undefined) resume.ready = ms(now() - resume.t0);
    });
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') { hiddenAt = now(); flush(); stopTimer(); return; }
    if (hiddenAt !== null) {
      resume = { t0: now(), away: ms(now() - hiddenAt) };
      // Ready already? Asked after the link's own visibilitychange handler, which may find the
      // connection dead after a long sleep and start again (link.js wake()).
      const r0 = resume;
      setTimeout(() => { if (resume === r0 && r0.ready === undefined && link?.status === 'ready') r0.ready = 0; }, 0);
      // Nothing drawn within 5 s (an idle terminal, or the home screen): it is over without a paint.
      const r = resume;
      setTimeout(() => { if (resume === r) { resume = null; mark('resume', { away: r.away, ready: r.ready ?? null, paint: null }); } }, 5000);
    }
    hiddenAt = null;
    startTimer();
  }

  // ---- to the Mac
  let sending = false;
  async function flush() {
    if (sending || link?.status !== 'ready') return;
    sending = true;
    const events = queue.splice(0);
    const t0 = now();
    try {
      await link.rpc('metrics.put', { ctx: context(), events }, 10_000);
      const took = ms(now() - t0);
      mark('rtt', { ms: took, n: events.length, ...await iceStats() });
    } catch {
      queue.unshift(...events); // the Mac is away (or older and does not know metrics.put): try later
      if (queue.length > KEEP) queue.splice(0, queue.length - KEEP);
    } finally { sending = false; }
  }
  /** The direct path as WebRTC sees it: the round trip on the wire and the kind of path. No addresses. */
  async function iceStats() {
    const pc = link?.via === 'direct' ? link.direct?.pc : null;
    if (!pc) return {};
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((x) => { if (x.type === 'transport' && x.selectedCandidatePairId) pair = stats.get(x.selectedCandidatePairId) ?? pair; });
      if (!pair) stats.forEach((x) => { if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair ??= x; });
      if (!pair) return {};
      const kind = (id) => { const k = stats.get(id)?.candidateType; return ['host', 'srflx', 'prflx', 'relay'].includes(k) ? k : '?'; };
      const rt = pair.currentRoundTripTime;
      return { ice: Number.isFinite(rt) ? ms(rt * 1000) : null, pair: `${kind(pair.localCandidateId)}/${kind(pair.remoteCandidateId)}` };
    } catch { return {}; }
  }
  function context() {
    const ua = navigator.userAgent;
    const os = ua.match(/OS (\d+[_.]\d+)/)?.[1]?.replace('_', '.') ?? '';
    const browser = /CriOS/.test(ua) ? 'chrome' : /Safari/.test(ua) && !/Chrome/.test(ua) ? 'safari' : /Chrome/.test(ua) ? 'chrome' : '';
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    return { src: globalThis.__herdrSim ? `sim:${globalThis.__herdrSim}` : src, ver: version, os, browser, standalone, w: innerWidth, h: innerHeight };
  }
  function startTimer() { stopTimer(); timer = setInterval(flush, FLUSH_MS); }
  function stopTimer() { clearInterval(timer); timer = null; }

  document.addEventListener('visibilitychange', onVisibility);
  startTimer();

  return { mark, typed, output, opening, op, input, coasting, touchStart, touchEnd, watch, flush, all: () => all.slice() };
}
