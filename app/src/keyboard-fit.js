export const POLL_MS = 200;
export const STALE_PX = 20;   // the viewport this far from the window's scroll: its values are old
export const SETTLE_MS = 600; // right after focus the viewport may still be where it was: not stale yet

/**
 * With the keyboard up, the terminal page follows the visible viewport: on iOS the keyboard covers
 * the page instead of resizing it. Otherwise CSS holds it (inset 0): the toolbars of iOS browsers
 * grow and shrink as you touch the page, and following them made the layout jump.
 * "Keyboard up" needs our field focused: iOS does not always report the last viewport change when
 * the keyboard goes away, and a stale height left the page at half the screen. On blur the page
 * goes back to full height at once.
 * The keyboard's own hide key leaves the field focused: no blur, and often no viewport event either
 * (an idle terminal draws nothing, so nothing sends it). So while the field is focused, the viewport
 * is also read every POLL_MS.
 * On iOS 27 (Chrome, 2026-11-07) the viewport is not even right when read: after the hide key it
 * keeps its keyboard-up height and offset until the field loses its focus. What does change is the
 * window: iOS scrolls it back to 0, while with the keyboard up the viewport's offset always equals
 * the window's scroll. So a focused field whose viewport is STALE_PX off the scroll, on two reads
 * POLL_MS apart (once could be a bounce or the phone turning), lets go of the focus, as the keyboard button does; the blur brings the right values, and a tap brings the
 * keyboard back. DESIGN.md「键盘弹出和收起」
 * note(snapshot): told each time what the page sees changes (the metrics' `kbd` event, to check this on
 * a real phone): focus, the viewport, the window, the scroll, and whether the page took the keyboard.
 * @returns {() => void} stop
 */
export function followKeyboard({ screen, field, win = globalThis, vv = win.visualViewport, note = null }) {
  if (!vv) return () => {};
  let poll = null, stopped = false, seen = '', focusedAt = 0, staleSince = 0;
  const set = (k, v) => { if (screen.style[k] !== v) screen.style[k] = v; }; // a read every POLL_MS must not restyle
  const follow = (why) => {
    if (stopped) return;
    const focused = win.document.activeElement === field;
    const keyboard = focused && win.innerHeight - vv.height > 120;
    const zoomed = Math.abs((vv.scale ?? 1) - 1) > 0.01; // a pinch also moves the viewport off the scroll
    const off = keyboard && !zoomed && Math.abs(vv.offsetTop - win.scrollY) > STALE_PX && Date.now() - focusedAt > SETTLE_MS;
    if (!off) staleSince = 0;
    else if (!staleSince) staleSince = Date.now(); // once could be a bounce or a turn: read again
    else if (Date.now() - staleSince >= POLL_MS) {
      staleSince = 0;
      log(`${why}.stale`, focused, keyboard);
      field.blur(); // its blur handler sets the page right
      return;
    }
    set('height', keyboard ? `${vv.height}px` : '');
    set('transform', keyboard && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '');
    if (!keyboard && (win.scrollX || win.scrollY)) win.scrollTo(0, 0); // iOS scrolled the page for the field
    if (focused && !poll) poll = win.setInterval(() => follow('poll'), POLL_MS);
    if (!focused && poll) { win.clearInterval(poll); poll = null; }
    log(why, focused, keyboard);
  };
  function log(why, focused, keyboard) {
    if (note) {
      const a = win.document.activeElement;
      const r = screen.getBoundingClientRect?.();
      const snap = { f: focused, act: a ? `${a.tagName}.${a.className}`.slice(0, 40) : '', vh: vv.height, vt: vv.offsetTop, sc: Math.round((vv.scale ?? 1) * 100),
        ih: win.innerHeight, dh: win.document.documentElement?.clientHeight ?? 0, sy: win.scrollY, up: keyboard, st: r?.top ?? 0, sb: r?.bottom ?? 0 };
      const key = JSON.stringify(snap);
      if (key !== seen) { seen = key; note({ why, ...snap }); }
    }
  }
  const onVv = (e) => follow(`vv.${e.type}`);
  const onScroll = () => follow('scroll');
  const later = (e) => { follow(e.type); win.setTimeout(() => follow('later'), 600); }; // and once the keyboard has slid away
  vv.addEventListener('resize', onVv);
  vv.addEventListener('scroll', onVv);
  win.addEventListener('resize', later);
  win.addEventListener('orientationchange', later);
  win.addEventListener('scroll', onScroll);
  const onFocus = () => { focusedAt = Date.now(); follow('focus'); };
  field.addEventListener('focus', onFocus);
  field.addEventListener('blur', later);
  follow('start');
  return () => {
    stopped = true;
    win.clearInterval(poll); poll = null;
    vv.removeEventListener('resize', onVv);
    vv.removeEventListener('scroll', onVv);
    win.removeEventListener('resize', later);
    win.removeEventListener('orientationchange', later);
    win.removeEventListener('scroll', onScroll);
    field.removeEventListener('focus', onFocus);
    field.removeEventListener('blur', later);
  };
}
