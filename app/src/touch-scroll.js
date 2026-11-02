/**
 * Finger scrolling for xterm.js 6 on a phone.
 *
 * xterm 6 draws its own scrollbar and only listens to the mouse wheel, so a finger drag does
 * nothing. Here a vertical drag on the terminal turns into lines:
 *   - the outer viewport scrolls first, when the terminal is taller than the space it has;
 *   - then the normal buffer scrolls through its history (xterm.scrollLines);
 *   - a full-screen program (alternate buffer: vim, less, htop, Claude Code) has no history, so it
 *     gets wheel events and xterm passes them on the way a Mac wheel would (mouse reports or
 *     arrows). Each wheel step moves the program's view by as many lines as it likes (Claude Code:
 *     several), so steps go out as the finger covers that many lines, measured on the screen
 *     itself (see `steps`): the text moves as far as the finger, not several times as far.
 * A sideways drag is left to the browser (the outer viewport scrolls wide terminals).
 * After the finger lifts, the scroll coasts and slows down, as native scrolling does.
 *
 * Options: `outer: false` leaves the outer viewport alone (a terminal that fits the phone has
 * nothing to scroll there). `onTap` hears a tap: no drag, and not the touch that stopped a coast.
 */
const AXIS_PX = 8;          // movement before we decide vertical or sideways
const FRICTION = 0.94;      // per frame (60 fps) while coasting
const MIN_SPEED = 0.03;     // px per ms: below this, coasting stops
const SETTLE_MS = 40;       // no output for this long after a step: the program has redrawn
const STEP_WAIT_MS = 600;   // no redraw at all (the top of its history): stop waiting
const QUIET_MS = 450;       // no finger and no scrolling redraw for this long: text moved ahead springs back
const SPRING_MS = 220;
const rate = (v) => Math.max(1, Math.min(30, v));
// program → { s: lines one wheel step moves its view, t / b: rows above / below the rows it scrolls }
const LEARNED = 'herdr-relay.wheel';
function learnedOf(name) {
  try { const v = JSON.parse(localStorage.getItem(LEARNED) || '{}')[name || '?']; return typeof v === 'number' ? { s: v } : v ?? {}; } catch { return {}; }
}
const learned = (name) => learnedOf(name).s ?? null;
function learn(name, more) {
  try {
    const all = JSON.parse(localStorage.getItem(LEARNED) || '{}');
    const v = { ...learnedOf(name), ...more };
    if (v.s) v.s = Math.round(v.s * 100) / 100;
    all[name || '?'] = v;
    localStorage.setItem(LEARNED, JSON.stringify(all));
  } catch {}
}

export function touchScroll(viewport, xterm, { outer = true, onTap = null, key = null } = {}) {
  let start = null;         // { x, y, axis, stopped }
  let lastY = 0, lastT = 0, speed = 0, carry = 0, coast = 0;

  const cellHeight = () => xterm._core?._renderService?.dimensions?.css?.cell?.height || xterm.options.fontSize * 1.2;

  /** Move the content by `px` (positive = finger moved down = show older lines). */
  function move(px) {
    // 1. The outer viewport, if it can move that way.
    if (outer) {
      const before = viewport.scrollTop;
      viewport.scrollTop = before - px;
      px -= before - viewport.scrollTop;
      if (!px) return;
    }
    // 2. Whole lines in the terminal; keep the fraction for the next move. A full-screen
    // program's text follows the finger at once (see `ahead`).
    if (xterm.buffer.active.type !== 'normal') lead(px);
    carry += px;
    const lines = Math.trunc(carry / cellHeight());
    if (!lines) return;
    carry -= lines * cellHeight();
    if (xterm.buffer.active.type === 'normal') xterm.scrollLines(-lines);
    else { steps.want += lines; steps.pump(); }
  }

  /**
   * Wheel steps for a full-screen program, sent as the finger moves (no waiting: the relay's round
   * trip is ~250 ms). One step moves the program's view by `perStep` lines: learned once per
   * program from a first step sent alone (its redraw shows how far it moved, see `shiftOf`), kept
   * in localStorage, and refined after each drag.
   */
  const steps = {
    perStep: null, want: 0, probe: null, settle: 0, giveUp: 0, drag: null,
    begin() { this.perStep ??= learned(key?.()); this.drag = { rows: screenRows(xterm), n: 0 }; },
    pump() {
      if (this.probe) return; // learning: wait for that step's redraw
      const per = this.perStep ?? 1;
      const n = Math.trunc(this.want / per);
      if (!n) return;
      this.want -= n * per;
      if (this.perStep === null) { this.probe = { rows: screenRows(xterm), n }; this.giveUp = setTimeout(() => this.land(), STEP_WAIT_MS); }
      if (this.drag) this.drag.n += n;
      wheel(xterm, n);
    },
    output() { if (this.probe) { clearTimeout(this.settle); this.settle = setTimeout(() => this.land(), SETTLE_MS); } },
    land() {
      clearTimeout(this.settle); clearTimeout(this.giveUp);
      const p = this.probe;
      if (!p) return;
      this.probe = null;
      const now = screenRows(xterm);
      const moved = shiftOf(p.rows, now, p.n > 0);
      if (moved > 0) { this.perStep = rate(moved / Math.abs(p.n)); learn(key?.(), { s: this.perStep, ...regionLearned(regionOf(p.rows, now, moved, p.n > 0)) }); this.pump(); } else this.want = 0; // the end of its history
    },
    /** The drag (and its coast) is over: once the redraws are in, how far did it all move? */
    end() {
      const d = this.drag;
      this.drag = null;
      if (!d?.n || this.perStep === null) return;
      setTimeout(() => {
        const moved = shiftOf(d.rows, screenRows(xterm), d.n > 0);
        if (moved > 0) { this.perStep = rate(0.5 * this.perStep + 0.5 * (moved / Math.abs(d.n))); learn(key?.(), { s: this.perStep }); }
      }, 700);
    },
    stop() { clearTimeout(this.settle); clearTimeout(this.giveUp); this.probe = null; this.want = 0; },
  };
  const parsed = xterm.onWriteParsed(() => steps.output());

  /**
   * The text moves with the finger at once, ahead of the program's redraw: its scrolling rows are
   * moved by `ahead.px` (clipped to where they scroll). Each redraw that shows the view moved by
   * k rows takes k rows off `ahead`, so the text stays where the finger put it. What the program
   * never draws (the top of its history) springs back once it is quiet.
   */
  const ahead = { px: 0, last: null, region: null, quiet: 0, spring: 0 };
  function lead(px) {
    cancelAnimationFrame(ahead.spring);
    const max = viewport.clientHeight * 0.8;
    ahead.px = Math.max(-max, Math.min(max, ahead.px + px));
    paint();
    springLater();
  }
  function springLater() {
    clearTimeout(ahead.quiet);
    ahead.quiet = setTimeout(() => {
      if (!ahead.px) return;
      if (start || coast) return springLater();
      const from = ahead.px, t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / SPRING_MS);
        ahead.px = from * (1 - t) ** 3;
        if (t >= 1) ahead.px = 0;
        paint();
        if (ahead.px) ahead.spring = requestAnimationFrame(step);
      };
      ahead.spring = requestAnimationFrame(step);
    }, QUIET_MS);
  }
  const rendered = xterm.onRender(() => {
    if (xterm.buffer.active.type !== 'alternate') { ahead.last = null; if (ahead.px) { ahead.px = 0; paint(); } return; }
    const rows = screenRows(xterm);
    if (ahead.last && ahead.px) {
      const up = ahead.px > 0, k = shiftOf(ahead.last, rows, up);
      if (k) {
        ahead.region = regionOf(ahead.last, rows, k, up) ?? ahead.region;
        if (ahead.region && steps.perStep) learn(key?.(), regionLearned(ahead.region));
        const left = ahead.px - (up ? 1 : -1) * k * cellHeight();
        ahead.px = (left > 0) === up ? left : 0; // the program went further than the finger: it is right
        paint();
        springLater();
      }
    }
    ahead.last = rows;
  });
  function paint() {
    const els = xterm.element?.querySelectorAll('.xterm-rows > div');
    if (!els) return;
    const h = cellHeight(), d = Math.round(ahead.px);
    const r = ahead.region ?? { top: 0, bottom: els.length - 1 };
    for (let i = 0; i < els.length; i++) {
      const st = els[i].style;
      if (!d || i < r.top || i > r.bottom) { if (st.transform) { st.transform = ''; st.clipPath = ''; } continue; }
      const y = i * h + d, ct = Math.max(0, r.top * h - y), cb = Math.max(0, y + h - (r.bottom + 1) * h);
      st.transform = `translateY(${d}px)`;
      st.clipPath = ct || cb ? `inset(${Math.min(h, ct)}px 0 ${Math.min(h, cb)}px 0)` : '';
    }
  }

  /** Rows above and below the region, the way `learn` keeps them. */
  function regionLearned(r) { return r ? { t: r.top, b: xterm.rows - 1 - r.bottom } : {}; }

  function stopCoast() { cancelAnimationFrame(coast); coast = 0; }
  function stop() { stopCoast(); steps.stop(); parsed.dispose(); rendered.dispose(); clearTimeout(ahead.quiet); cancelAnimationFrame(ahead.spring); }

  viewport.addEventListener('touchstart', (e) => {
    const stopped = coast !== 0; // this touch only stops the coasting: it is not a tap
    stopCoast();
    if (e.touches.length !== 1) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, axis: null, stopped };
    if (xterm.buffer.active.type !== 'normal') steps.begin();
    lastY = t.clientY; lastT = e.timeStamp; speed = 0; carry = 0;
  }, { passive: true });

  viewport.addEventListener('touchmove', (e) => {
    if (!start || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!start.axis) {
      const dx = Math.abs(t.clientX - start.x), dy = Math.abs(t.clientY - start.y);
      if (Math.max(dx, dy) < AXIS_PX) return;
      start.axis = dy > dx ? 'y' : 'x';
      lastY = t.clientY; lastT = e.timeStamp;
    }
    if (start.axis !== 'y') return;
    e.preventDefault();
    const dy = t.clientY - lastY, dt = Math.max(1, e.timeStamp - lastT);
    speed = 0.8 * (dy / dt) + 0.2 * speed;
    lastY = t.clientY; lastT = e.timeStamp;
    move(dy);
  }, { passive: false });

  viewport.addEventListener('touchend', (e) => {
    if (start && !start.axis && !start.stopped && e.touches.length === 0) onTap?.();
    if (!start || start.axis !== 'y') { start = null; return; }
    start = null;
    if (e.timeStamp - lastT > 80 || Math.abs(speed) < MIN_SPEED * 4) { steps.end(); return; } // finger rested before lifting
    let prev = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - prev); prev = now;
      move(speed * dt);
      speed *= FRICTION ** (dt / 16.7);
      coast = Math.abs(speed) > MIN_SPEED ? requestAnimationFrame(step) : 0;
      if (!coast) steps.end();
    };
    coast = requestAnimationFrame(step);
  });
  viewport.addEventListener('touchcancel', () => { start = null; steps.end(); });

  return stop;
}

/** `n` wheel steps to xterm (positive: up, to older lines); it passes them on to the program. */
export function wheel(xterm, n) {
  const target = xterm.element?.querySelector('.xterm-screen') ?? xterm.element;
  const box = target?.getBoundingClientRect();
  // One event per step: xterm reports one wheel step per event to a program, whatever its delta.
  for (let i = 0; i < Math.abs(n); i++) {
    target?.dispatchEvent(new WheelEvent('wheel', {
      deltaY: n > 0 ? -1 : 1, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true,
      clientX: box ? box.left + box.width / 2 : 0, clientY: box ? box.top + box.height / 2 : 0,
    }));
  }
}

/** The rows on screen, as text. */
export function screenRows(xterm) {
  const b = xterm.buffer.active, rows = [];
  for (let y = 0; y < xterm.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
  return rows;
}

/** The rows that scroll (a program's header and input box stay): the rows that moved by `k`, and the k that came in. */
export function regionOf(before, after, k, up) {
  let top = -1, bottom = -1;
  for (let i = 0; i + k < before.length; i++) {
    const [a, b, at] = up ? [before[i], after[i + k], i + k] : [before[i + k], after[i], i];
    if (a.trim().length > 2 && a === b) { if (top < 0) top = at; bottom = at; }
  }
  if (top < 0) return null;
  return up ? { top: Math.max(0, top - k), bottom } : { top, bottom: Math.min(before.length - 1, bottom + k) };
}

/**
 * How many rows the text moved from `before` to `after`: down (`up` true: the view went to older
 * lines) or up. The shift that lines up the most rows with text in them wins; a program's own
 * header and input box stay in place and are not counted (shift 0 is never tried); at least half
 * the rows that could line up at that shift must. 0: no shift.
 */
export function shiftOf(before, after, up) {
  let best = 0, bestHits = 0;
  for (let k = 1; k < before.length; k++) {
    let hits = 0, could = 0;
    for (let i = 0; i + k < before.length; i++) {
      const [a, b] = up ? [before[i], after[i + k]] : [before[i + k], after[i]];
      if (a.trim().length <= 2) continue;
      could++;
      if (a === b) hits++;
    }
    if (hits >= 2 && hits >= could * 0.5 && hits > bestHits) { best = k; bestHits = hits; }
  }
  return best;
}

