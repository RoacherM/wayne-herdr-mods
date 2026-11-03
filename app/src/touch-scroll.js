/**
 * Finger scrolling for xterm.js 6 on a phone.
 *
 * xterm 6 draws its own scrollbar and only listens to the mouse wheel, so a finger drag does
 * nothing. Here a vertical drag on the terminal turns into lines:
 *   - the outer viewport scrolls first, when the terminal is taller than the space it has;
 *   - then the normal buffer scrolls through its history (xterm.scrollLines);
 *   - a full-screen program (alternate buffer: vim, less, htop, Claude Code) has no history, so it
 *     gets one wheel step for each row the finger moves, sent at once, and xterm passes them on the
 *     way a Mac wheel would (mouse reports or arrows). Nothing on the phone moves ahead of the
 *     program's own redraw. This is what Rex's phone app does (measured 2026-11-03: about one step
 *     per row of finger travel, one step per frame while coasting, for about 2 s after a flick).
 * A sideways drag is left to the browser (the outer viewport scrolls wide terminals).
 * After the finger lifts, the scroll coasts and slows down at the rate of iOS native scrolling
 * (shared/coast.js). A full-screen program's coast runs on the Mac when it can (`remoteCoast`): the
 * phone sends the speed once and the Mac sends the steps, evenly, one frame apart.
 *
 * Options: `outer: false` leaves the outer viewport alone (a terminal that fits the phone has
 * nothing to scroll there). `onTap` hears a tap: no drag, and not the touch that stopped a coast.
 * `remoteCoast(v, cell)` starts a coast on the Mac (v: px/ms, positive = older) and says whether it
 * did; `remoteCoast(0)` stops it.
 */
import { FRICTION_PER_MS, MIN_SPEED, coastSteps, stepsGoOn } from '../../shared/coast.js';

const AXIS_PX = 8; // movement before we decide vertical or sideways

export function touchScroll(viewport, xterm, { outer = true, onTap = null, remoteCoast = null } = {}) {
  let start = null;         // { x, y, axis, stopped }
  let lastY = 0, lastT = 0, speed = 0, carry = 0, coast = 0;
  let remoteUntil = 0;      // a coast on the Mac runs until then (performance.now())

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
    // 2. Whole rows; keep the fraction for the next move.
    carry += px;
    const lines = Math.trunc(carry / cellHeight());
    if (!lines) return;
    carry -= lines * cellHeight();
    if (xterm.buffer.active.type === 'normal') xterm.scrollLines(-lines);
    else wheel(xterm, lines);
  }

  function stopCoast() {
    cancelAnimationFrame(coast); coast = 0;
    if (remoteUntil > performance.now()) remoteCoast?.(0);
    remoteUntil = 0;
  }

  viewport.addEventListener('touchstart', (e) => {
    const stopped = coast !== 0 || remoteUntil > performance.now(); // this touch only stops the coasting: it is not a tap
    stopCoast();
    if (e.touches.length !== 1) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, axis: null, stopped };
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
    if (e.timeStamp - lastT > 80 || Math.abs(speed) < MIN_SPEED * 4) return; // finger rested before lifting
    // The outer viewport coasts here; a full-screen program's wheel steps are the Mac's to send, from
    // where the outer viewport stops (a Mac layout taller than the phone has one to scroll first).
    const outerCanMove = () => outer && (speed > 0 ? viewport.scrollTop > 0 : viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1);
    const toMac = () => {
      if (xterm.buffer.active.type === 'normal' || outerCanMove() || !stepsGoOn(speed, cellHeight())) return false;
      if (!remoteCoast?.(speed, cellHeight())) return false;
      remoteUntil = performance.now() + (coastSteps(speed, cellHeight()).at(-1) ?? 0);
      return true;
    };
    if (toMac()) return;
    let prev = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - prev); prev = now;
      move(speed * dt);
      speed *= FRICTION_PER_MS ** dt;
      const goOn = xterm.buffer.active.type === 'normal' || outerCanMove() ? Math.abs(speed) > MIN_SPEED : stepsGoOn(speed, cellHeight());
      coast = goOn && !toMac() ? requestAnimationFrame(step) : 0;
    };
    coast = requestAnimationFrame(step);
  });
  viewport.addEventListener('touchcancel', () => { start = null; });

  return stopCoast;
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
