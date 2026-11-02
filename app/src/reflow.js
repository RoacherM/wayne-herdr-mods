/**
 * The phone's own layout of a terminal that runs at the Mac's size.
 *
 * The terminal keeps the Mac's columns and rows: the phone never resizes it, so the Mac windows
 * never change. xterm (not shown) is the exact copy of that screen; this module lays its lines
 * out again for the phone's width, as text the browser wraps:
 *
 *   - a row the terminal wrapped joins the row before it (one logical line);
 *   - a row a program wrapped itself at the Mac's width (Claude Code does) joins the next one
 *     when it runs to the right edge and both are plain text (see `joins`);
 *   - a rule (────) is cut at the phone's edge instead of wrapping into several lines;
 *   - a table (│ ┌ ┼ …) keeps its shape and scrolls sideways as one block;
 *   - colours, bold, dim, italic, underline, inverse and the cursor stay.
 *
 * The alternate screen (full-screen programs) is laid out the same way for coding agents: Claude
 * Code and Codex draw text, rules and an input box there. Other full-screen programs (vim, htop)
 * only make sense at the Mac's size: the page shows xterm itself for them (`reflows` false).
 */
const BOX = /[─-╿]/g;
const HAS_BOX = /[─-╿]/;
const TABLE = /[│┃┆┇┊┋║┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝╠╣╦╩╬╞╡╪]/;
const MARKER = /^\s*([│┃╭╰├└●•◦○■□▪▸▶❯›>$%#⎿*\-+]|\d+[.)]\s)/; // a line that starts something new
const CJK = /[⺀-鿿豈-﫿＀-￯]/;
const EDGE = 12; // cells from the right edge where a program's own wrap is likely

const ANSI = ['#2e2e2e', '#ff6b6b', '#5fd068', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d4d4d4',
  '#7f7f7f', '#ff8787', '#87e08f', '#f0d58c', '#82c1ff', '#d99cf0', '#7fd4e0', '#ffffff'];
export const PALETTE = (() => {
  const p = [...ANSI];
  const v = [0, 95, 135, 175, 215, 255];
  const hex = (n) => n.toString(16).padStart(2, '0');
  for (let i = 0; i < 216; i++) p.push(`#${hex(v[Math.floor(i / 36)])}${hex(v[Math.floor(i / 6) % 6])}${hex(v[i % 6])}`);
  for (let i = 0; i < 24; i++) { const g = hex(8 + i * 10); p.push(`#${g}${g}${g}`); }
  return p;
})();

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const rgb = (n) => `#${n.toString(16).padStart(6, '0')}`;

function colors(cell, theme) {
  let fg = cell.isFgRGB() ? rgb(cell.getFgColor()) : cell.isFgPalette() ? PALETTE[cell.getFgColor()] : null;
  let bg = cell.isBgRGB() ? rgb(cell.getBgColor()) : cell.isBgPalette() ? PALETTE[cell.getBgColor()] : null;
  if (cell.isInverse()) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
  return [fg, bg];
}

/**
 * One buffer row as styled runs, trimmed on the right (but not before the cursor).
 * @returns {{ text: string, html: string, cells: number }}
 */
export function rowOf(line, cols, cell, theme, cursorX = -1) {
  let last = -1;
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    const ch = cell.getChars();
    if (ch && ch !== ' ') last = x; // trailing blanks go, coloured or not: they would wrap on a phone
  }
  const end = Math.max(last, cursorX) + 1;
  let text = '', html = '', run = '', key = null, open = '';
  const flush = () => { if (run) html += open ? `${open}${esc(run)}</span>` : esc(run); run = ''; };
  for (let x = 0; x < end; x++) {
    if (x < cols) line.getCell(x, cell);
    if (x < cols && cell.getWidth() === 0) continue; // the right half of a wide character
    const ch = x < cols ? cell.getChars() || ' ' : ' ';
    text += ch;
    if (x === cursorX) { flush(); key = null; html += `<span class="cur">${esc(ch)}</span>`; continue; }
    const [fg, bg] = x < cols ? colors(cell, theme) : [null, null];
    const bold = x < cols && cell.isBold(), dim = x < cols && cell.isDim(), it = x < cols && cell.isItalic(), ul = x < cols && cell.isUnderline();
    const k = `${fg}|${bg}|${bold}${dim}${it}${ul}`;
    if (k !== key) {
      flush();
      key = k;
      const css = [fg && `color:${fg}`, bg && `background:${bg}`, bold && 'font-weight:700', dim && 'opacity:.6', it && 'font-style:italic', ul && 'text-decoration:underline'].filter(Boolean).join(';');
      open = css ? `<span style="${css}">` : '';
    }
    run += ch;
  }
  flush();
  return { text, html, cells: end };
}

/** A program wrapped `a` at the Mac's edge and `b` goes on with it. */
export function joins(a, b, cols) {
  if (a.cells < cols - EDGE || !b.text.trim() || MARKER.test(b.text)) return false;
  return !HAS_BOX.test(a.text) && !HAS_BOX.test(b.text);
}

function kindOf(text) {
  const solid = text.replace(/\s/g, '');
  if (!solid) return 'text';
  if (TABLE.test(text)) return 'tbl';
  const box = (solid.match(BOX) ?? []).length;
  return box / solid.length >= 0.6 ? 'rule' : 'text';
}

/**
 * Logical lines of a buffer, from row `from` to the end.
 * @returns {{ kind: 'text' | 'rule' | 'tbl', html: string }[]}
 */
export function layout(buffer, cols, theme, { from = 0, cursor = null, rowCache = null, cell = buffer.getNullCell() } = {}) {
  const out = [];
  let cur = null;
  for (let y = from; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const cx = cursor && cursor.y === y ? cursor.x : -1;
    let row = rowCache?.get(y, line, cx);
    if (!row) { row = rowOf(line, cols, cell, theme, cx); rowCache?.set(y, line, cx, row); }
    if (cur && (line.isWrapped || joins(cur.lastRow, row, cols))) {
      // A program's own wrap: the words go on after a space (none between CJK characters).
      const sep = line.isWrapped ? '' : (CJK.test(cur.text.at(-1) ?? '') || CJK.test(row.text.trimStart()[0] ?? '') ? '' : ' ');
      const lead = line.isWrapped ? 0 : row.text.length - row.text.trimStart().length;
      cur.text += sep + row.text.slice(lead);
      cur.html += sep + (lead ? stripLead(row.html, lead) : row.html);
      cur.lastRow = row;
      continue;
    }
    if (cur) out.push(cur);
    cur = { text: row.text, html: row.html, lastRow: row };
  }
  if (cur) out.push(cur);
  return out.map((l) => ({ kind: kindOf(l.text), html: l.html }));
}

/** Drop `n` leading spaces from a row's html: tags stay, spaces in the text go. */
function stripLead(html, n) {
  let i = 0, res = '';
  while (i < html.length && n > 0) {
    if (html[i] === '<') { const j = html.indexOf('>', i) + 1; res += html.slice(i, j); i = j; } else if (html[i] === ' ') { n--; i++; } else break;
  }
  return res + html.slice(i);
}

/**
 * Rows above the live screen do not change: their layout is kept. The live screen is laid out
 * every time (programs redraw it).
 */
export class RowCache {
  constructor() { this.rows = new Map(); this.liveFrom = 0; }
  get(y, line, cx) {
    if (y >= this.liveFrom || cx >= 0) return null;
    const hit = this.rows.get(y);
    return hit && hit.key === line.translateToString(false) ? hit.row : null;
  }
  set(y, line, cx, row) { if (y < this.liveFrom && cx < 0) this.rows.set(y, { key: line.translateToString(false), row }); }
  clear() { this.rows.clear(); }
}

/** Blocks for the page: one per line, consecutive table lines in one block that scrolls sideways. */
export function blocks(lines) {
  const out = [];
  for (const l of lines) {
    const body = l.html || '​';
    if (l.kind === 'tbl' && out.at(-1)?.kind === 'tbl') out.at(-1).html += `\n${body}`;
    else out.push({ kind: l.kind, html: body });
  }
  return out.map((b) => (b.kind === 'tbl' ? `<div class="tbl"><div>${b.html}</div></div>` : `<div class="${b.kind}">${b.html}</div>`));
}

/**
 * The view: renders xterm's normal buffer into `el` (a scrolling element), at most once a frame,
 * touching only the blocks that changed. It stays at the bottom unless the user scrolled up.
 */
export class ReflowView {
  constructor(el, xterm, theme) {
    Object.assign(this, { el, xterm, theme, shown: [], frame: 0, cache: new RowCache() });
    this.atBottom = true;
    el.addEventListener('scroll', () => { this.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32; }, { passive: true });
    xterm.onResize(() => { this.cache.clear(); this.schedule(); });
  }
  schedule() { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); }); }
  bottom() { this.atBottom = true; this.el.scrollTop = this.el.scrollHeight; }
  render() {
    const buffer = this.xterm.buffer.active;
    if (buffer !== this.lastBuffer) { this.cache.clear(); this.lastBuffer = buffer; }
    this.cache.liveFrom = buffer.baseY;
    if (buffer.length < this.lastLength) this.cache.clear(); // cleared or trimmed
    this.lastLength = buffer.length;
    const hidden = this.xterm._core?.coreService?.isCursorHidden; // the program draws its own
    const cursor = hidden ? null : { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY };
    const next = blocks(layout(buffer, this.xterm.cols, this.theme, { cursor, rowCache: this.cache }));
    const stick = this.atBottom;
    const kids = this.el.children;
    for (let i = 0; i < next.length; i++) {
      if (this.shown[i] === next[i]) continue;
      const t = document.createElement('template');
      t.innerHTML = next[i];
      if (i < kids.length) kids[i].replaceWith(t.content.firstChild); else this.el.append(t.content.firstChild);
    }
    while (kids.length > next.length) kids[kids.length - 1].remove();
    this.shown = next;
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }
  dispose() { cancelAnimationFrame(this.frame); }
}
