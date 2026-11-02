/**
 * Finger scrolling for xterm.js 6 on a phone.
 *
 * xterm 6 draws its own scrollbar and only listens to the mouse wheel, so a finger drag does
 * nothing. Here a vertical drag on the terminal turns into lines:
 *   - the outer viewport scrolls first, when the terminal is taller than the space it has;
 *   - then the normal buffer scrolls through its history (xterm.scrollLines);
 *   - a full-screen program (alternate buffer: vim, less, htop) has no history, so it gets
 *     wheel events and xterm passes them on the way a Mac wheel would (mouse reports or arrows).
 * A sideways drag is left to the browser (the outer viewport scrolls wide terminals).
 * After the finger lifts, the scroll coasts and slows down, as native scrolling does.
 *
 * Options: `outer: false` leaves the outer viewport alone (a terminal that fits the phone has
 * nothing to scroll there). `onTap` hears a tap: no drag, and not the touch that stopped a coast.
 */
const AXIS_PX = 8;          // movement before we decide vertical or sideways
const FRICTION = 0.94;      // per frame (60 fps) while coasting
const MIN_SPEED = 0.03;     // px per ms: below this, coasting stops

export function touchScroll(viewport, xterm, { outer = true, onTap = null } = {}) {
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
    // 2. Whole lines in the terminal; keep the fraction for the next move.
    carry += px;
    const lines = Math.trunc(carry / cellHeight());
    if (!lines) return;
    carry -= lines * cellHeight();
    if (xterm.buffer.active.type === 'normal') {
      xterm.scrollLines(-lines);
    } else {
      const target = xterm.element?.querySelector('.xterm-screen') ?? xterm.element;
      const box = target?.getBoundingClientRect();
      target?.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -lines, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true,
        clientX: box ? box.left + box.width / 2 : 0, clientY: box ? box.top + box.height / 2 : 0,
      }));
    }
  }

  function stopCoast() { cancelAnimationFrame(coast); coast = 0; }

  viewport.addEventListener('touchstart', (e) => {
    const stopped = coast !== 0; // this touch only stops the coasting: it is not a tap
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
    let prev = performance.now();
    const step = (now) => {
      const dt = Math.min(50, now - prev); prev = now;
      move(speed * dt);
      speed *= FRICTION ** (dt / 16.7);
      coast = Math.abs(speed) > MIN_SPEED ? requestAnimationFrame(step) : 0;
    };
    coast = requestAnimationFrame(step);
  });
  viewport.addEventListener('touchcancel', () => { start = null; });

  return stopCoast;
}
