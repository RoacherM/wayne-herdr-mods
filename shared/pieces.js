/**
 * Long messages on a WebRTC data channel go in pieces (host/rtc-link.js, app/src/direct.js):
 * every frame stays under 16 KB, the size every browser takes.
 *
 *   "\u0001" + piece   a piece; more follows
 *   anything else      the last piece (or a whole message)
 *
 * Messages are E2E-sealed text or the handshake's JSON, so none starts with "\u0001".
 */
export const PIECE = 16 * 1024;

export function pieces(text) {
  if (text.length <= PIECE) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += PIECE) out.push((i + PIECE < text.length ? '\u0001' : '') + text.slice(i, i + PIECE));
  return out;
}

/** Put pieces together again: `push(frame)` → the whole message, or null while more is due. */
export function joiner(max = 8 << 20) {
  let buf = '';
  return (frame) => {
    if (frame[0] === '\u0001') {
      buf += frame.slice(1);
      if (buf.length > max) { buf = ''; throw new Error('message too long'); }
      return null;
    }
    const whole = buf + frame;
    buf = '';
    return whole;
  };
}
