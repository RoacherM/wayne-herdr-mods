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
 *   - a rule (────, a box's top and bottom edge) stretches to the phone's width; its caption stays;
 *   - a tree line on the left (epi's `   │ `, `   ├─$ cmd`) and a box's sides are a *gutter*:
 *     kept apart from the text, so the text beside them wraps and joins as usual;
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
const JUNCTION = /[┬┴┼╤╧╪╥╨╫┳┻╋]/; // inside a table's edge; a box's edge has none
const GUTTER = /^( *)([│┃║├┣╟╠└┗╚╰╭┌])([─━═]*)( ?)/; // a tree line or a box side, then text
const TAIL = / *[│┃║] *$/; // a box's right side
const DOWN = /[│┃║├┣╟╠╭┌]/; // the line goes on below this glyph
const SIDE = /[│┃║]/; // a plain side: the text beside it may go on from the row above

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
 * One buffer row as styled runs, trimmed on the right (but not before the cursor). A row with a
 * gutter (see GUTTER) comes in parts: `gut`, the text (`text`, `html`) and a box's right side `tail`.
 * @returns {{ text: string, html: string, cells: number, edge: number,
 *   gut?: { html: string, indent: number, glyph: string, v: boolean, color: string | null },
 *   tail?: { html: string } | null }}
 */
export function rowOf(line, cols, cell, theme, cursorX = -1) {
  let last = -1;
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    const ch = cell.getChars();
    if (ch && ch !== ' ') last = x; // trailing blanks go, coloured or not: they would wrap on a phone
  }
  const end = Math.max(last, cursorX) + 1;
  const xs = []; // the cell of each character
  let all = '';
  for (let x = 0; x < end; x++) {
    if (x < cols) { line.getCell(x, cell); if (cell.getWidth() === 0) continue; } // a wide character's right half
    const ch = x < cols ? cell.getChars() || ' ' : ' ';
    for (let i = 0; i < ch.length; i++) xs.push(x);
    all += ch;
  }
  const html = (from, to) => runs(line, cols, cell, theme, cursorX, xs, all, from, to);
  const row = { text: all, html: html(0, all.length), cells: end, edge: cols };
  const g = GUTTER.exec(all);
  if (!g || isRule(all)) return row;
  const from = g[0].length;
  const side = SIDE.test(g[2]) && TAIL.exec(all.slice(from)); // │ text │: a box's right side
  const to = side ? from + side.index : all.length;
  if (TABLE.test(all.slice(from, to))) return row; // lines inside too: a table
  const filled = from + all.slice(from, to).trimEnd().length;
  return {
    text: all.slice(from, to), html: html(from, to),
    cells: filled > from ? xs[filled - 1] + 1 : 0,
    edge: side ? xs[from + side.index + side[0].indexOf(side[0].trim())] : cols,
    gut: { html: html(0, from), indent: g[1].length, glyph: g[2], v: DOWN.test(g[2]), color: glyphColor(line, cell, theme, xs[g[1].length]) },
    tail: side ? { html: html(to, all.length).replace(/^ +/, '') } : null,
    raw: row, // the whole row, for a row the terminal wrapped after it
  };
}

function glyphColor(line, cell, theme, x) {
  line.getCell(x, cell);
  return colors(cell, theme)[0];
}

/** Styled html of characters [from, to) of a row (see rowOf). */
function runs(line, cols, cell, theme, cursorX, xs, all, from, to) {
  let html = '', run = '', key = null, open = '';
  const flush = () => { if (run) html += open ? `${open}${esc(run)}</span>` : esc(run); run = ''; };
  for (let i = from; i < to; i++) {
    const x = xs[i], ch = all[i];
    if (x === cursorX) { flush(); key = null; html += `<span class="cur">${esc(ch)}</span>`; continue; }
    if (x < cols) line.getCell(x, cell);
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
  return html;
}

/**
 * A program wrapped `a` at its edge (the Mac's, or its box's right side) and `b` goes on with it.
 * Beside a gutter, `b` must sit beside the same plain line: a branch (├─) starts something new.
 */
export function joins(a, b, cols) {
  if (a.cells < (a.edge ?? cols) - EDGE || !b.text.trim() || MARKER.test(b.text)) return false;
  if (a.gut || b.gut) {
    if (!a.gut || !b.gut || a.gut.indent !== b.gut.indent || !SIDE.test(b.gut.glyph) || !a.tail !== !b.tail) return false;
  }
  return !HAS_BOX.test(a.text) && !HAS_BOX.test(b.text);
}

/** A line drawn across: mostly box characters, with a run of them, and no table junction. */
function isRule(text) {
  const solid = text.replace(/\s/g, '');
  if (!solid || !/[─━═]{3}/.test(solid) || JUNCTION.test(solid)) return false;
  return (solid.match(BOX) ?? []).length / solid.length >= 0.6;
}

function kindOf(line) {
  if (line.gut) return 'text';
  if (isRule(line.text)) return 'rule';
  return TABLE.test(line.text) ? 'tbl' : 'text';
}

/**
 * Logical lines of a buffer, from row `from` to the end.
 * @returns {{ kind: 'text' | 'rule' | 'tbl', html: string, gut?: object, tail?: object }[]}
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
    if (cur && line.isWrapped) { // the terminal wrapped it: the row goes on as it is
      const r = row.raw ?? row;
      cur.text += r.text;
      cur.html += r.html;
      cur.lastRow = r;
      continue;
    }
    if (cur && joins(cur.lastRow, row, cols)) {
      // A program's own wrap: the words go on after a space (none between CJK characters).
      const sep = CJK.test(cur.text.at(-1) ?? '') || CJK.test(row.text.trimStart()[0] ?? '') ? '' : ' ';
      const lead = row.text.length - row.text.trimStart().length;
      cur.text += sep + row.text.slice(lead);
      cur.html += sep + (lead ? stripLead(row.html, lead) : row.html);
      cur.lastRow = row;
      continue;
    }
    if (cur) out.push(cur);
    cur = { text: row.text, html: row.html, lastRow: row, gut: row.gut, tail: row.tail };
  }
  if (cur) out.push(cur);
  return out.map((l) => ({ kind: kindOf(l), html: l.html, ...(l.gut ? { gut: l.gut, tail: l.tail } : {}) }));
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

const LINE = /([─━═])\1{2,}/g;
/** A rule's runs of ─ become lines that stretch to the phone's width; corners and captions stay. */
const stretch = (html) => html.replace(LINE, (_, c) => `<i class="ln${c === '━' ? ' h' : c === '═' ? ' d' : ''}"></i>`);

function gutter(g, extra = '') {
  const style = [`--i:${g.indent ?? 0}`, g.color && `color:${g.color}`].filter(Boolean).join(';');
  return `<span class="g${extra}${g.v ? ' v' : ''}" style="${style}">`;
}

/**
 * Blocks for the page: one per line, consecutive table lines in one block that scrolls sideways
 * (a table row alone wraps as text). A line beside a gutter: the gutter, the text, a box's side.
 */
export function blocks(lines) {
  const out = [];
  for (const l of lines) {
    const body = l.html || '​';
    if (l.kind === 'tbl' && out.at(-1)?.kind === 'tbl') { out.at(-1).html += `\n${body}`; out.at(-1).rows++; } else out.push({ ...l, html: body, rows: 1 });
  }
  return out.map((b) => {
    if (b.gut) {
      const tail = b.tail ? `${gutter({ v: true, color: b.gut.color }, ' t')}${b.tail.html}</span>` : '';
      return `<div class="gut">${gutter(b.gut)}${b.gut.html}</span><span class="c">${b.html === '​' ? '' : b.html}</span>${tail}</div>`;
    }
    if (b.kind === 'rule') return `<div class="rule">${stretch(b.html)}</div>`;
    if (b.kind === 'tbl' && b.rows > 1) return `<div class="tbl"><div>${b.html}</div></div>`;
    return `<div class="${b.kind === 'tbl' ? 'text' : b.kind}">${b.html}</div>`;
  });
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
