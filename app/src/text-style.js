/**
 * Symbols that iOS draws as color emoji, drawn as text again.
 *
 * These have text style by default (Unicode: Emoji, not Emoji_Presentation), and Ghostty draws
 * them as one-cell text. iOS has no text font with them, so WebKit falls back to Apple Color Emoji:
 * Claude Code's ⏺ becomes a blue button (seen on an iPhone and in the iOS Simulator, 2026-11-04;
 * headless Chrome on a Mac has text fonts for them and shows nothing wrong). VS15 (U+FE0E) after
 * the symbol asks for text style; iOS then draws a plain symbol, and xterm still counts one cell.
 *
 * Works on UTF-8 bytes. A symbol already followed by VS15 or VS16 (an explicit emoji) is left as
 * it is. A symbol split across two writes is missed (the host sends whole bursts; rare).
 */
// UTF-8 of each symbol is E2 <b1> <b2>.
const SYMBOLS = new Set([
  0x2328, // ⌨
  0x23cf, // ⏏
  0x23ed, 0x23ee, 0x23ef, // ⏭ ⏮ ⏯
  0x23f1, 0x23f2, // ⏱ ⏲
  0x23f8, 0x23f9, 0x23fa, // ⏸ ⏹ ⏺
]);
const isSymbol = (b0, b1, b2) => b0 === 0xe2 && SYMBOLS.has(0x2000 | ((b1 & 0x0f) << 6) | (b2 & 0x3f)) && (b1 & 0xf0) === 0x80;
const VS15 = [0xef, 0xb8, 0x8e];
const isSelector = (bytes, i) => bytes[i] === 0xef && bytes[i + 1] === 0xb8 && (bytes[i + 2] === 0x8e || bytes[i + 2] === 0x8f);

export function textStyle(bytes) {
  let out = null, from = 0, o = 0;
  for (let i = bytes.indexOf(0xe2); i >= 0 && i + 2 < bytes.length; i = bytes.indexOf(0xe2, i + 1)) {
    if (!isSymbol(bytes[i], bytes[i + 1], bytes[i + 2]) || isSelector(bytes, i + 3)) continue;
    out ??= new Uint8Array(bytes.length + 3 * 64);
    if (o + (i + 3 - from) + 3 > out.length) { const bigger = new Uint8Array(out.length * 2 + i - from + 3); bigger.set(out.subarray(0, o)); out = bigger; }
    out.set(bytes.subarray(from, i + 3), o); o += i + 3 - from;
    out.set(VS15, o); o += 3;
    from = i + 3;
  }
  if (!out) return bytes;
  const rest = bytes.length - from;
  if (o + rest > out.length) { const bigger = new Uint8Array(o + rest); bigger.set(out.subarray(0, o)); out = bigger; }
  out.set(bytes.subarray(from), o);
  return out.subarray(0, o + rest);
}
