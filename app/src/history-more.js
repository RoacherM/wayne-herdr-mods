/**
 * When a terminal page asks the Mac for older history, and what its top line says
 * (DESIGN.md「往回翻历史」). Pure: the page measures and keeps the timers, this decides.
 *
 * herdr-core gives the last N rows only, so each ask is "twice what I have" (host/phones.js more()).
 * The page asks:
 *   - once in the background, after the first paint has been quiet a moment (`idle`);
 *   - again whenever the reader comes within a screen of the top (`near`);
 * never while an ask is out, never once it has all there is (`earliest`).
 *
 * Events (`step(state, event)` → { state, ask }; `ask`: the rows to say it `have`s, or null):
 *   {type:'painted', promised, baseY, older}  a paint that brought `promised` rows of history is
 *                                             drawn and left `baseY` rows above the screen
 *   {type:'idle'}                             the first paint has been quiet a while
 *   {type:'near'}                             the reader is within a screen of the top
 *   {type:'timeout'}                          an ask got no paint in time (the Mac was busy)
 */
export const MORE_MAX = 5000; // host/phones.js HISTORY_MAX: beyond, nothing more comes
const SHORT = 2; // rows of slack: a paint "short" of what it promised by more is all there is

export function initial() {
  return { have: 0, promised: 0, earliest: false, pending: false, prefetched: false };
}

function painted(st, { promised, baseY, older }) {
  const p = Math.max(0, Number(promised) || 0);
  const b = Math.max(0, Number(baseY) || 0);
  // Short of what was promised: the terminal has no more. An older-history paint that brought no
  // new rows: the same. At the cap: the Mac gives no more either.
  const earliest = b < p - SHORT || (older && b <= st.have) || p >= MORE_MAX;
  // A paint that was not ours (a reprint: the program printed it all again) starts over: the
  // background ask may run again.
  return { ...st, have: b, promised: p, earliest, pending: false, prefetched: older ? st.prefetched : false };
}

function ask(st, extra = {}) {
  if (st.pending || st.earliest || !st.promised) return { state: st, ask: null };
  return { state: { ...st, ...extra, pending: true }, ask: st.promised };
}

export function step(st, ev) {
  switch (ev.type) {
    case 'painted': return { state: painted(st, ev), ask: null };
    case 'idle': return st.prefetched ? { state: st, ask: null } : ask(st, { prefetched: true });
    case 'near': return ask(st);
    case 'timeout': return { state: { ...st, pending: false }, ask: null };
    default: return { state: st, ask: null };
  }
}

/** The line at the top of the history, for a reader at the top: '' when there is nothing to say. */
export function topLabel(st) {
  if (st.earliest) return '已到最早';
  if (st.pending) return '加载更早…';
  return '';
}
