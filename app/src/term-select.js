/**
 * Terminal link detection (OSC 8 hyperlinks + wrapped http/https URLs) and buffer-coordinate
 * selection math for touch devices (DESIGN.md「终端页怎么显示」).
 *
 * Pure over xterm.js's buffer API so it runs identically in the iOS WebView and headless unit tests.
 */

const URL_RE = /https?:\/\/[^\s<>"{}|\\^`]+/g;
const TRAILING_PUNCT = /[.,;:!?'"，。；：！？、]+$/;
const CLOSE_TO_OPEN = { ')': '(', ']': '[', '}': '{' };
const WORD_CHAR = /[^\s'"`()[\]{}<>,;:!?，。；：！？（）【】《》]/;
const MAX_URL_LEN = 4096;

/** Trim trailing prose punctuation while keeping balanced brackets inside URLs (e.g. Wikipedia). */
export function trimUrlPunctuation(raw) {
  let s = raw;
  for (;;) {
    const stripped = s.replace(TRAILING_PUNCT, '');
    if (stripped !== s) { s = stripped; continue; }
    const last = s.at(-1);
    const open = CLOSE_TO_OPEN[last];
    if (!open) break;
    const opens = s.split(open).length - 1;
    const closes = s.split(last).length - 1;
    if (closes > opens) { s = s.slice(0, -1); continue; }
    break;
  }
  return s;
}

/** Validate and normalize an http(s) URL; returns null for any other scheme or malformed string. */
export function safeHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LEN || /\s/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

/** Normalize a cell's inclusive start column and exclusive end column (handling width-2 chars). */
export function cellBounds(buffer, cols, row, col) {
  const c = Math.max(0, Math.min(cols - 1, col));
  const line = buffer.getLine(row);
  if (!line) return { row, col: c, endCol: Math.min(cols, c + 1) };
  let start = c;
  let cell = line.getCell(start);
  if (cell && cell.getWidth() === 0 && start > 0) {
    start -= 1;
    cell = line.getCell(start);
  }
  const width = Math.max(1, cell?.getWidth() || 1);
  return { row, col: start, endCol: Math.min(cols, start + width) };
}

/** Find the [startRow, endRow] span of soft-wrapped buffer rows containing `absRow`. */
function wrappedRowRange(buffer, absRow) {
  let startRow = absRow;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow--;
  let endRow = absRow;
  while (endRow + 1 < buffer.length && buffer.getLine(endRow + 1)?.isWrapped) endRow++;
  return [startRow, endRow];
}

/**
 * Join a soft-wrapped logical paragraph into text + per-code-unit buffer cell coordinates,
 * and find the text index corresponding to `(col, absRow)` (-1 if past line end).
 */
function wrappedParagraph(buffer, cols, col, absRow) {
  const [startRow, endRow] = wrappedRowRange(buffer, absRow);
  let text = '';
  const cells = [];
  let hitIndex = -1;

  for (let r = startRow; r <= endRow; r++) {
    const line = buffer.getLine(r);
    if (!line) continue;
    let lastNonEmpty = -1;
    for (let c = cols - 1; c >= 0; c--) {
      const ch = line.getCell(c)?.getChars();
      if (ch && ch !== ' ') { lastNonEmpty = c; break; }
    }
    // Wrapped rows keep explicit trailing spaces unless empty padding (width-2 char wrap).
    const limit = r < endRow ? cols : lastNonEmpty + 1;
    for (let c = 0; c < limit; c++) {
      const cell = line.getCell(c);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars();
      if (!chars) {
        if (r < endRow) continue; // skip unwritten right-edge wrap padding
        break;
      }
      const width = Math.max(1, cell.getWidth());
      const endCol = Math.min(cols, c + width);
      if (r === absRow && col >= c && col < endCol) hitIndex = text.length;
      const pos = { row: r, col: c, endCol };
      for (let i = 0; i < chars.length; i++) cells.push(pos);
      text += chars;
    }
  }
  return { startRow, endRow, text, cells, hitIndex };
}

function oscLinkAt(xterm, buffer, cols, col, absRow) {
  const bounds = cellBounds(buffer, cols, absRow, col);
  const cell = buffer.getLine(bounds.row)?.getCell(bounds.col);
  const urlId = cell?.extended?.urlId;
  if (!urlId) return null;
  const uri = xterm._core?._oscLinkService?.getLinkData?.(urlId)?.uri;
  const url = safeHttpUrl(uri);
  if (!url) return null;

  const [startRow, endRow] = wrappedRowRange(buffer, absRow);
  let start = { row: bounds.row, col: bounds.col };
  let end = { row: bounds.row, col: bounds.endCol };

  // Expand left across wrapped rows while cells share urlId.
  outerL: for (let r = bounds.row; r >= startRow; r--) {
    const line = buffer.getLine(r);
    const from = r === bounds.row ? bounds.col - 1 : cols - 1;
    for (let c = from; c >= 0; c--) {
      const x = line?.getCell(c);
      if (x && x.getWidth() === 0) continue;
      if (x?.extended?.urlId !== urlId) break outerL;
      start = { row: r, col: c };
    }
  }
  // Expand right across wrapped rows while cells share urlId.
  outerR: for (let r = bounds.row; r <= endRow; r++) {
    const line = buffer.getLine(r);
    const from = r === bounds.row ? bounds.endCol : 0;
    for (let c = from; c < cols; c++) {
      const x = line?.getCell(c);
      if (x && x.getWidth() === 0) continue;
      if (x?.extended?.urlId !== urlId) break outerR;
      end = { row: r, col: Math.min(cols, c + Math.max(1, x.getWidth())) };
    }
  }
  return { url, kind: 'osc8', start, end };
}

/**
 * Find a clickable http(s) link at 0-based `(col, absRow)`: checks OSC 8 hyperlink first,
 * then plain/wrapped URLs in the logical paragraph.
 */
export function linkAt(xterm, col, absRow) {
  const buffer = xterm?.buffer?.active;
  const cols = xterm?.cols ?? 0;
  if (!buffer || cols <= 0 || absRow < 0 || absRow >= buffer.length || col < 0 || col >= cols) return null;

  const osc = oscLinkAt(xterm, buffer, cols, col, absRow);
  if (osc) return osc;

  const { text, cells, hitIndex } = wrappedParagraph(buffer, cols, col, absRow);
  if (hitIndex < 0) return null;

  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const cleaned = trimUrlPunctuation(m[0]);
    const from = m.index;
    const to = from + cleaned.length;
    if (hitIndex < from || hitIndex >= to) continue;
    const url = safeHttpUrl(cleaned);
    if (!url) continue;
    const first = cells[from];
    const last = cells[to - 1];
    return {
      url,
      kind: 'url',
      start: { row: first.row, col: first.col },
      end: { row: last.row, col: last.endCol },
    };
  }
  return null;
}

/**
 * Compute initial long-press selection range at `(col, absRow)`: selects a whole link if on one,
 * else the word/token under the finger. Returns null on blank lines.
 */
export function wordRangeAt(xterm, col, absRow) {
  const buffer = xterm?.buffer?.active;
  const cols = xterm?.cols ?? 0;
  if (!buffer || cols <= 0 || absRow < 0 || absRow >= buffer.length || col < 0 || col >= cols) return null;

  const link = linkAt(xterm, col, absRow);
  if (link) return { start: link.start, end: link.end, url: link.url };

  const { text, cells, hitIndex } = wrappedParagraph(buffer, cols, col, absRow);
  if (!text.trim()) return null;

  let idx = hitIndex;
  if (idx < 0) {
    // Tapped past end of text on this row: anchor to last non-whitespace char on the same row.
    for (let i = cells.length - 1; i >= 0; i--) {
      if (cells[i].row === absRow && !/\s/.test(text[i])) { idx = i; break; }
    }
    if (idx < 0) return null;
  }

  let left = idx;
  let right = idx + 1;
  if (WORD_CHAR.test(text[idx])) {
    while (left > 0 && WORD_CHAR.test(text[left - 1])) left--;
    while (right < text.length && WORD_CHAR.test(text[right])) right++;
  }
  const first = cells[left];
  const last = cells[right - 1];
  return {
    start: { row: first.row, col: first.col },
    end: { row: last.row, col: last.endCol },
    url: null,
  };
}

/** Compare two buffer points `{ row, col }`. */
export const comparePos = (a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col);

/**
 * Order two inclusive endpoints `a` and `b` into `{ start, end, length }` where `start` is
 * inclusive (`0..cols-1`), `end` is exclusive (`1..cols`), and `length` is for `xterm.select()`.
 */
export function selectionFromCells(buffer, cols, a, b) {
  const first = comparePos(a, b) <= 0 ? a : b;
  const second = comparePos(a, b) <= 0 ? b : a;
  const s = cellBounds(buffer, cols, first.row, first.col);
  const e = cellBounds(buffer, cols, second.row, second.col);
  const start = { row: s.row, col: s.col };
  const end = { row: e.row, col: e.endCol };
  const length = (end.row - start.row) * cols + (end.col - start.col);
  return { start, end, length };
}

/** Length parameter for `xterm.select(start.col, start.row, length)` from inclusive start & exclusive end. */
export function rangeLength(cols, start, end) {
  return Math.max(0, (end.row - start.row) * cols + (end.col - start.col));
}
