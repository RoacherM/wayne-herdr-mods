export const POLL_MS = 200;

/**
 * With the keyboard up, the terminal page follows the visible viewport: on iOS the keyboard covers
 * the page instead of resizing it. Otherwise CSS holds it (inset 0): the toolbars of iOS browsers
 * grow and shrink as you touch the page, and following them made the layout jump.
 * "Keyboard up" needs our field focused: iOS does not always report the last viewport change when
 * the keyboard goes away, and a stale height left the page at half the screen. On blur the page
 * goes back to full height at once.
 * The keyboard's own hide key leaves the field focused: no blur, and often no viewport event either
 * (an idle terminal draws nothing, so nothing sends it). So while the field is focused, the viewport
 * is also read every POLL_MS. DESIGN.md「终端页布局」
 * @returns {() => void} stop
 */
export function followKeyboard({ screen, field, win = globalThis, vv = win.visualViewport }) {
  if (!vv) return () => {};
  let poll = null, stopped = false;
  const set = (k, v) => { if (screen.style[k] !== v) screen.style[k] = v; }; // a read every POLL_MS must not restyle
  const follow = () => {
    if (stopped) return;
    const focused = win.document.activeElement === field;
    const keyboard = focused && win.innerHeight - vv.height > 120;
    set('height', keyboard ? `${vv.height}px` : '');
    set('transform', keyboard && vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '');
    if (!keyboard && (win.scrollX || win.scrollY)) win.scrollTo(0, 0); // iOS scrolled the page for the field
    if (focused && !poll) poll = win.setInterval(follow, POLL_MS);
    if (!focused && poll) { win.clearInterval(poll); poll = null; }
  };
  const later = () => { follow(); win.setTimeout(follow, 600); }; // and once the keyboard has slid away
  vv.addEventListener('resize', follow);
  vv.addEventListener('scroll', follow);
  win.addEventListener('resize', later);
  win.addEventListener('orientationchange', later);
  field.addEventListener('focus', follow);
  field.addEventListener('blur', later);
  follow();
  return () => {
    stopped = true;
    win.clearInterval(poll); poll = null;
    vv.removeEventListener('resize', follow);
    vv.removeEventListener('scroll', follow);
    win.removeEventListener('resize', later);
    win.removeEventListener('orientationchange', later);
    field.removeEventListener('focus', follow);
    field.removeEventListener('blur', later);
  };
}
