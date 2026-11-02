/**
 * A full-screen coding agent's history, kept on the phone.
 *
 * Claude Code, Codex and epi run on the alternate screen: they keep their history themselves and
 * scroll it when they get wheel steps. Through the relay each step takes a round trip (~250 ms),
 * so scrolling the program itself shows the text late and in jumps of several lines.
 *
 * Here the phone shows its own copy instead, and scrolls it at once:
 *   - opening it copies the rows the program scrolls (its `region`: not its header or input box);
 *   - the copy moves with the finger and coasts, all on the phone;
 *   - ahead of the reader, it pages the program up (wheel steps, a page at a time, each page
 *     overlapping the last) and adds the rows that came in on top (`shiftOf` finds them);
 *   - back at the bottom (or typing, or ↓), the program goes back to its latest, and once it has
 *     redrawn, the live screen shows again;
 *   - the copy is kept: opening again lines the screen up with its last rows (adding what came
 *     since), so the next scroll needs nothing from the Mac; paging on, the program first jumps
 *     to the top of the copy (`at`: where its view is in the copy) and goes on from there.
 * The Mac's view of that terminal pages up with it meanwhile (it is the same terminal).
 */
import { rowOf } from './reflow.js';
import { screenRows, shiftOf } from './touch-scroll.js';

const QUIET_MS = 60;        // no output for this long: the program has redrawn
const REDRAW_WAIT_MS = 1200;
const AHEAD_SCREENS = 2;    // keep this much history loaded above what is shown
const MAX_ROWS = 20000;
const WINDOW_SCREENS = 2;   // rows drawn above and below what is shown
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class History {
  /**
   * @param {object} o
   * @param {import('@xterm/xterm').Terminal} o.xterm
   * @param {object} o.theme
   * @param {() => number} o.cellHeight
   * @param {(n: number) => void} o.wheel  n wheel steps up (negative: down) to the program
   * @param {() => void} o.latest  the program back to its latest
   */
  constructor({ xterm, theme, cellHeight, wheel, latest }) {
    Object.assign(this, { xterm, theme, cellHeight, wheel, latest });
    this.active = false;
    this.lines = [];       // html of each row, oldest first
    this.texts = [];       // the same rows as text, to line screens up with
    this.at = 0;           // the row of the copy at the top of the program's view
    this.pos = 0;          // px from the top of `lines` to the top of what is shown
    this.drawn = [0, 0];   // rows in the DOM
    this.loading = false;
    this.top = false;      // the program has nothing older
    this.waiters = [];
    this.quiet = 0;
    this.parsed = xterm.onWriteParsed(() => {
      clearTimeout(this.quiet);
      this.quiet = setTimeout(() => { for (const w of this.waiters.splice(0)) w(); }, QUIET_MS);
    });
  }

  /** Open on the program's screen as it is; `region` = { top, bottom } rows, `perStep` lines per wheel step. */
  open(region, perStep) {
    const x = this.xterm;
    this.region = region;
    this.perStep = perStep;
    const rows = region.bottom - region.top + 1;
    const html = this.regionHtml(region.top, region.bottom + 1), text = this.regionText(region.top, region.bottom + 1);
    const same = this.kept === `${x.cols}x${x.rows}:${region.top}-${region.bottom}`;
    const k = same ? (equal(this.texts.slice(-rows), text) ? 0 : shiftOf(this.texts.slice(-rows), text, false)) : -1;
    if (same && (k === 0 || (k > 0 && k < rows)) && this.texts.length >= rows) {
      // The copy goes on: the rows that came since (k), and the last screen as it is now.
      this.lines.splice(this.lines.length - rows + k, rows - k, ...html);
      this.texts.splice(this.texts.length - rows + k, rows - k, ...text);
    } else {
      this.lines = html;
      this.texts = text;
      this.top = false;
    }
    this.kept = `${x.cols}x${x.rows}:${region.top}-${region.bottom}`;
    this.rows = rows;
    this.at = this.lines.length - rows; // the program is at its latest
    this.active = true;
    const h = this.cellHeight();
    this.pos = this.lines.length * h - this.rows * h;
    const style = getComputedStyle(x.element.querySelector('.xterm-rows'));
    this.el = document.createElement('div');
    this.el.className = 'term-history';
    Object.assign(this.el.style, { top: `${region.top * h}px`, height: `${this.rows * h}px`, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: `${h}px`, color: style.color });
    this.inner = document.createElement('div');
    this.el.append(this.inner);
    x.element.append(this.el);
    this.drawn = [0, 0];
    this.paint();
    this.more();
  }

  /** The finger moved `px` (positive: down, to older lines). False when it went past the bottom: closed. */
  scrollBy(px) {
    const h = this.cellHeight(), max = Math.max(0, this.lines.length * h - this.rows * h);
    const next = this.pos - px;
    // Past the bottom by more than a row (over any number of moves): back to the live screen.
    this.over = next > max ? (this.over ?? 0) + (next - Math.max(this.pos, max)) : 0;
    if (this.over > h) { this.over = 0; this.close(); return false; }
    this.pos = Math.max(0, Math.min(max, next));
    this.paint();
    this.more();
    return true;
  }

  /** Back to the live screen: the program to its latest (`tell`), then away once it has redrawn. */
  async close(tell = true) {
    if (!this.active) return;
    this.active = false;
    const el = this.el;
    this.el = null;
    if (tell) this.latest();
    await this.redrawn();
    el?.remove();
  }

  dispose() { this.parsed.dispose(); clearTimeout(this.quiet); this.el?.remove(); this.active = false; }

  // ---- inside

  regionText(from, to) {
    const b = this.xterm.buffer.active, out = [];
    for (let y = from; y < to; y++) out.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    return out;
  }

  /** Where the program's view is in the copy: the row whose screen lines up with `text`, or -1. */
  locate(text) {
    const filled = text.filter((t) => t.trim().length > 2).length;
    let best = -1, bestHits = 0;
    for (let j = 0; j + text.length <= this.texts.length; j++) {
      let hits = 0;
      for (let i = 0; i < text.length; i++) if (text[i].trim().length > 2 && text[i] === this.texts[j + i]) hits++;
      if (hits > bestHits) { best = j; bestHits = hits; }
    }
    return bestHits >= 2 && bestHits >= filled * 0.5 ? best : -1;
  }

  regionHtml(from, to) {
    const b = this.xterm.buffer.active, cell = b.getNullCell(), out = [];
    for (let y = from; y < to; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line) { out.push(''); continue; }
      const r = rowOf(line, this.xterm.cols, cell, this.theme);
      out.push((r.raw ?? r).html);
    }
    return out;
  }

  /** The next time the program has written and gone quiet (or `ms` passed). */
  redrawn(ms = REDRAW_WAIT_MS) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(); }, Math.max(0, ms));
      this.waiters.push(done);
    });
  }

  /** Page the program up while the reader is near the top of what we have. */
  async more() {
    const h = this.cellHeight();
    while (this.active && !this.loading && !this.top && this.lines.length < MAX_ROWS && this.pos < AHEAD_SCREENS * this.rows * h) {
      this.loading = true;
      if (this.at > 0) { await this.jump(); this.loading = false; continue; }
      const before = screenRows(this.xterm);
      const n = Math.max(1, Math.floor(this.rows / 2 / this.perStep)); // half a screen: the rest lines it up
      this.wheel(n);
      // Through the relay a page can come as several redraws: wait for all of it (or the top).
      const expect = n * this.perStep, end = performance.now() + REDRAW_WAIT_MS;
      let k = 0;
      while (this.active && performance.now() < end) {
        await this.redrawn(end - performance.now());
        k = shiftOf(before, screenRows(this.xterm), true);
        if (k >= expect) break;
      }
      this.loading = false;
      if (!this.active) return;
      k = Math.min(this.rows, k);
      if (!k) { this.top = true; break; } // nothing older (or it did not line up: stop there)
      this.lines.unshift(...this.regionHtml(this.region.top, this.region.top + k));
      this.texts.unshift(...this.regionText(this.region.top, this.region.top + k));
      this.pos += k * h;
      this.drawn = [this.drawn[0] + k, this.drawn[1] + k];
      this.paint();
    }
  }

  /** The program shows rows the copy has: send it to the copy's top in one go, then see where it is. */
  async jump() {
    const want = Math.max(0, this.at - Math.ceil(this.at / this.perStep) * this.perStep);
    this.wheel(Math.ceil(this.at / this.perStep));
    const end = performance.now() + REDRAW_WAIT_MS * 2;
    let j = -1;
    while (this.active && performance.now() < end) {
      await this.redrawn(end - performance.now());
      j = this.locate(this.regionText(this.region.top, this.region.bottom + 1));
      if (j >= 0 && j <= want) break;
    }
    if (!this.active) return;
    if (j < 0) { this.top = true; return; } // it shows something the copy does not have: stop loading
    if (j === this.at) { this.top = true; return; } // it did not move: nothing older
    this.at = j;
  }

  /** Draw the rows around what is shown; move them to `pos`. */
  paint() {
    if (!this.el) return;
    const h = this.cellHeight();
    const first = Math.floor(this.pos / h), last = first + this.rows;
    const [a, b] = this.drawn;
    if (first < a || last > b || b === 0) {
      const from = Math.max(0, first - WINDOW_SCREENS * this.rows), to = Math.min(this.lines.length, last + WINDOW_SCREENS * this.rows);
      this.inner.innerHTML = this.lines.slice(from, to).map((l) => `<div>${l || ' '}</div>`).join('');
      this.drawn = [from, to];
    }
    this.inner.style.transform = `translateY(${this.drawn[0] * h - this.pos}px)`;
    this.el.dataset.lines = this.lines.length; // rows kept (for tests)
  }
}
