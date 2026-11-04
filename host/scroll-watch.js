/**
 * What the Mac sees of one phone scrolling a full-screen program (DESIGN.md「滑动延迟」), per stream:
 *   - wheel steps written to the program (from the phone, and from a coast run here);
 *   - the program's answer: from a step written to the first output after it (`prog`);
 *   - the bytes on their way to the phone: sent minus what the phone says it has drawn (`behind`).
 * One record per gesture (a pause of GAP_MS without steps ends it), to the metrics store as
 * `macscroll`. `w` is the number of the phone's own steps written so far: each output carries it,
 * so the phone can tell which of its steps a screen answers.
 */
const GAP_MS = 1000;

const pct = (v, q) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };

export function scrollWatch({ record, now = () => performance.now() }) {
  let w = 0;                // phone steps written
  let sent = 0, acked = 0;  // bytes to the phone, and drawn there
  let g = null;             // the gesture: { t0, last, steps, coast, prog: [], wait, bytes, behind, timer }

  const behind = () => Math.max(0, sent - acked);

  function begin() {
    if (!g) g = { t0: now(), steps: 0, coast: 0, prog: [], wait: null, bytes: 0, behind: behind() };
    clearTimeout(g.timer);
    g.timer = setTimeout(end, GAP_MS);
    return g;
  }
  function end() {
    if (!g) return;
    const x = g; g = null;
    clearTimeout(x.timer);
    record({ ev: 'macscroll', steps: x.steps, coast: x.coast, prog: pct(x.prog, 0.5), progMax: x.prog.length ? Math.max(...x.prog) : null, kb: Math.round(x.bytes / 1024), behind: Math.round(x.behind / 1024), ms: Math.round(now() - x.t0 - GAP_MS) });
  }

  return {
    get w() { return w; },
    /** `n` wheel steps were written to the program; `coast`: by the coast here, not the phone. */
    steps(n, coast = false) {
      if (!n) return;
      if (!coast) w += n;
      const x = begin();
      if (coast) x.coast += n; else x.steps += n;
      x.wait ??= now();
    },
    /** The program wrote `n` bytes. */
    output(n) {
      if (!g) return;
      g.bytes += n;
      if (g.wait !== null) { g.prog.push(Math.round(now() - g.wait)); g.wait = null; }
    },
    sent(n) { sent += n; if (g) g.behind = Math.max(g.behind, behind()); },
    acked(n) { acked += n; },
    behind,
    /** How long the program has had a step without answering it (Infinity: nothing waits). */
    waiting() { return g && g.wait !== null ? now() - g.wait : Infinity; },
    stop() { end(); },
  };
}
