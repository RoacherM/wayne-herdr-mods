/**
 * herdr-core's repaints, drawn in one frame on the phone.
 *
 * Every repaint (first paint, after a resize, after falling behind) starts the same way
 * (herdr-core crates/ghostty-vt paint(), viewers.rs paint_state()):
 *
 *   CAN  ESC[!p  ESC[?2026l  …modes off…  ESC[?1049l ESC[?1047l ESC[?47l  ESC[H ESC[2J
 *   then the history (main screen only), or ESC[?1049h (the alternate screen); then the screen.
 *
 * `atomic()` turns its "sync off" into "sync on" (after the soft reset, which turns sync off) and
 * ends sync after it, so xterm draws nothing in between. With `clearHistory` (the terminal opened
 * again: the repaint brings the history again) the history is cleared just before ESC[H ESC[2J:
 * by then the repaint has switched to the main screen, and ESC[3J clears the screen in use. A
 * repaint of the alternate screen brings no history, so the history stays.
 */
const enc = (s) => new TextEncoder().encode(s);
export const PAINT = enc('\x18\x1b[!p\x1b[?2026l');
const PAINT_SYNC = enc('\x18\x1b[!p\x1b[?2026h');
const CLEARED = enc('\x1b[H\x1b[2J');
const ALT_ON = enc('\x1b[?1049h');
const CLEAR_HISTORY = enc('\x1b[3J');
export const SYNC_ON = enc('\x1b[?2026h');
export const SYNC_OFF = enc('\x1b[?2026l');

export function indexOf(hay, needle, from = 0, to = hay.length) {
  const end = Math.min(to, hay.length) - needle.length;
  outer: for (let i = hay.indexOf(needle[0], from); i >= 0 && i <= end; i = hay.indexOf(needle[0], i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * `bytes` split where a repaint starts: [before, repaint drawn in one frame]. No repaint in it:
 * [bytes, null]. The repaint part runs to the end of `bytes` (the host sends a repaint whole).
 */
export function atomic(bytes, { clearHistory = false } = {}) {
  const at = indexOf(bytes, PAINT);
  if (at < 0) return [bytes, null];
  const body = bytes.subarray(at + PAINT.length);
  const parts = [PAINT_SYNC];
  const c = clearHistory ? indexOf(body, CLEARED, 0, 1024) : -1;
  const alt = c >= 0 && indexOf(body, ALT_ON, c + CLEARED.length, c + CLEARED.length + ALT_ON.length) === c + CLEARED.length;
  if (c >= 0 && !alt) parts.push(body.subarray(0, c), CLEAR_HISTORY, body.subarray(c));
  else parts.push(body);
  parts.push(SYNC_OFF);
  return [bytes.subarray(0, at), concat(parts)];
}
