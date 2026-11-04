/**
 * Wheel steps in what the phone sends a terminal: mouse wheel reports, SGR (`ESC [ < 64;x;y M`,
 * 65 = down) or the old X10 form (`ESC [ M` then ` or a and two bytes). The phone and the Mac
 * count them the same way, so an output can say which steps the program had when it was made
 * (DESIGN.md「滑动延迟」).
 */
const ONE = /\x1b\[<6[45];\d{1,4};\d{1,4}M|\x1b\[M[`a][\x20-\xff]{2}/g;
const ALL = /^(?:\x1b\[<6[45];\d{1,4};\d{1,4}M|\x1b\[M[`a][\x20-\xff]{2})+$/;

/** How many wheel steps `text` is (0 unless it is nothing but wheel steps). */
export function wheelSteps(text) {
  return typeof text === 'string' && ALL.test(text) ? text.match(ONE).length : 0;
}
