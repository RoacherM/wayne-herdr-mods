/**
 * The coast after a flick (the finger lifts while it moves), for a full-screen program.
 *
 * The phone computes the flick's speed; the Mac sends the wheel steps (host/phones.js, `term.coast`),
 * so they reach the program evenly, one frame apart, whatever the network does on the way (a proxy
 * on the phone's side delivers the phone's own steps in clumps). Both sides use this one curve.
 *
 * The speed falls at the rate of iOS native scrolling (UIScrollView's normal rate, ×0.998 per ms);
 * one wheel step goes out for each row of travel, as Rex's phone app does.
 */
export const FRICTION_PER_MS = 0.998;
export const MIN_SPEED = 0.03;   // px per ms: below this, the coast stops
export const FRAME_MS = 1000 / 60;
export const MAX_STEPS = 400;

/** When each wheel step goes out: ms after the finger lifts, for a speed of `v` px/ms and rows `cell` px tall. */
export function coastSteps(v, cell) {
  const times = [];
  let speed = Math.abs(v), travel = 0, t = 0;
  if (!(cell > 0)) return times;
  while (speed > MIN_SPEED && times.length < MAX_STEPS) {
    t += FRAME_MS;
    travel += speed * FRAME_MS;
    speed *= FRICTION_PER_MS ** FRAME_MS;
    while (times.length < MAX_STEPS && (times.length + 1) * cell <= travel) times.push(Math.round(t));
  }
  return times;
}
