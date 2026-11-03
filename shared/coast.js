/**
 * The coast after a flick (the finger lifts while it moves), for a full-screen program.
 *
 * The phone computes the flick's speed; the Mac sends the wheel steps (host/phones.js, `term.coast`),
 * so they reach the program evenly, one frame apart, whatever the network does on the way (a proxy
 * on the phone's side delivers the phone's own steps in clumps). Both sides use this one curve.
 *
 * One wheel step goes out for each row of travel, as Rex's phone app does (and as the finger does
 * while it is down: the program follows at once). But a program scrolls about 3 lines for each step,
 * so the content moves 3 times as far as the finger. At iOS's own rate (×0.998 per ms, time constant
 * τ = 500 ms) a flick at 2.5 px/ms sent 85 steps = 255 lines (5 screens) over 1.4 s: "it slows down
 * too slowly" (user, 2026-11-03). The coast distance is v·τ, so the wheel coast uses τ/3: the same
 * content distance as an iOS list (29 steps = 87 lines, 0.45 s), and with a ~250 ms round trip it is
 * mostly over by the time its first redraw is on the phone, so there is little to catch.
 */
export const FRICTION_PER_MS = 0.998;           // pixels on the phone (history, outer viewport): iOS normal
export const LINES_PER_STEP = 3;                // what most programs scroll for one wheel step
export const WHEEL_FRICTION_PER_MS = FRICTION_PER_MS ** LINES_PER_STEP; // ≈ 0.994, τ ≈ 166 ms
export const MIN_SPEED = 0.03;   // px per ms: below this, the coast stops
// The slow end of a coast: one step every few hundred ms, each one a jump of a few lines (a
// program scrolls 3 lines a step). It felt like a stutter that went on too long (user, 2026-11-03).
// The coast stops when the next step would be more than this far after the last one.
export const MAX_GAP_MS = 100;
export const FRAME_MS = 1000 / 60;
export const MAX_STEPS = 400;

/** Does a coast at `v` px/ms still send wheel steps, with rows `cell` px tall? */
export const stepsGoOn = (v, cell) => Math.abs(v) > Math.max(MIN_SPEED, cell / MAX_GAP_MS);

/** When each wheel step goes out: ms after the finger lifts, for a speed of `v` px/ms and rows `cell` px tall. */
export function coastSteps(v, cell) {
  const times = [];
  let speed = Math.abs(v), travel = 0, t = 0;
  if (!(cell > 0)) return times;
  while (speed > Math.max(MIN_SPEED, cell / MAX_GAP_MS) && times.length < MAX_STEPS) {
    t += FRAME_MS;
    travel += speed * FRAME_MS;
    speed *= WHEEL_FRICTION_PER_MS ** FRAME_MS;
    while (times.length < MAX_STEPS && (times.length + 1) * cell <= travel) times.push(Math.round(t));
  }
  return times;
}
