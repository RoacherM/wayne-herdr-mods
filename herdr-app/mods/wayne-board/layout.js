// Where every row and line of the board goes (DESIGN.md「观测面板」). Pure: one lane in, rows and lines out.
//
// The board is a side panel and shows one agent: the one in the window the person is in.
// It is drawn like a git graph (a metro map): rails are columns, every row has one stop on a rail.
//   - Rail 0 is the agent's own line. The terminal is its top stop; below it the decisions, latest first.
//   - Sub-agents started after a decision are a branch: it leaves the line just above that decision
//     and runs up rail 1, one stop per sub-agent. A sub-agent's own sub-agents branch off it to rail 2.
// So time runs upward, as in `git log --graph`: what is nearest the top is the latest.
// Rows have no width: the text of a row starts right of its stop and reaches the panel's right edge.

export const SIZE = { pad: 14, rail: 18, dotY: 15, headH: 54, decH: 60, shutH: 42, agentH: 42, pileH: 34, groupGap: 6, maxRail: 3, bend: 8 };

const RANK = { blocked: 0, error: 0, failed: 1, working: 2 };
const rank = (state) => RANK[state] ?? 3;
export const isOpen = (sub) => !sub.ended && rank(sub.state) <= 2;
const anyOpen = (subs) => subs.some((s) => isOpen(s) || anyOpen(s.subs));
const flat = (subs) => subs.flatMap((s) => [s, ...flat(s.subs)]);
/** Ended sub-agents the host stopped keeping (host/board.js `compact`): still counted, by how they ended. */
function dropped(holder) {
  const n = { done: holder.dropped?.done ?? 0, failed: holder.dropped?.failed ?? 0 };
  for (const s of holder.subs) { const m = dropped(s); n.done += m.done; n.failed += m.failed; }
  return n;
}
/** What a stretch of branch carries: someone waiting for the person, someone at work, or nothing any more. */
function lit(subs) {
  const live = flat(subs).filter((s) => !s.ended);
  if (live.some((s) => s.state === 'blocked' || s.state === 'error')) return 'blocked';
  return live.some((s) => s.state === 'working') ? 'working' : 'done';
}

/** The lane of a terminal: the agent there now, else the last one that was there. Null: none recorded. */
export function laneOf(board, terminal) {
  const mine = (board?.lanes ?? []).filter((l) => l.t === terminal).sort((a, b) => b.since - a.since);
  return mine.find((l) => !l.ended) ?? mine[0] ?? null;
}

/** How many sub-agents are in each state, for a folded pile and for the header. */
export function tally(subs) {
  const out = { blocked: 0, working: 0, failed: 0, done: 0 };
  for (const s of subs) {
    if (!s.ended && (s.state === 'blocked' || s.state === 'error')) out.blocked++;
    else if (!s.ended && s.state === 'working') out.working++;
    else if (s.state === 'failed') out.failed++;
    else out.done++;
  }
  return out;
}

/**
 * Rows: `{kind: head|dec|agent|pile, key, rail, y, h, …}`; the stop of a row is at `y + SIZE.dotY` on its rail.
 * Lines: `{kind: 'line', rail, y, h, status}` runs down a rail; `{kind: 'fork', rail, y, status}` is the
 * bend at height `y` that takes a branch from `rail` to `rail + 1`.
 * `flipped`: step keys (`<terminal>/<since>/<index>`) the person toggled. A step is open when it is the
 * lane's last or still has a sub-agent at work; a toggle turns that around.
 */
export function layout(lane, flipped = new Set()) {
  const rows = [], wires = [];
  if (!lane) return { rows, wires, height: SIZE.pad };
  const head = { kind: 'head', key: `${lane.t}/${lane.since}`, rail: 0, y: SIZE.pad, h: SIZE.headH, lane };
  rows.push(head);
  let y = head.y + head.h;
  const stop = (row) => row.y + SIZE.dotY;

  // The branch of a holder (a decision, or a sub-agent with its own). `kids`: its rows, top to bottom,
  // already placed above the holder; `carry[k]`: what the branch still carries when it reaches kids[k].
  const join = (holder, kids, carry) => {
    if (!kids.length) return;
    const rail = kids[0].rail, all = carry.at(-1);
    if (rail === holder.rail) { // no rail left to branch to: the same line goes on
      wires.push({ kind: 'line', rail, y: stop(kids[0]), h: stop(holder) - stop(kids[0]), status: all });
      return;
    }
    kids.forEach((kid, k) => {
      const to = k < kids.length - 1 ? stop(kids[k + 1]) : holder.y - SIZE.bend;
      wires.push({ kind: 'line', rail, y: stop(kid), h: to - stop(kid), status: carry[k] });
    });
    wires.push({ kind: 'fork', rail: holder.rail, y: holder.y, status: all });
    // Rail 0 is drawn whole; a deeper holder needs the piece from the bend down to its own stop.
    if (holder.rail > 0) wires.push({ kind: 'line', rail: holder.rail, y: holder.y, h: SIZE.dotY, status: all });
  };

  // Places the sub-agents of a holder above the place the holder will get: the ones needing the person on top.
  const place = (subs, rail, key) => {
    const kids = [], carry = [], seen = [];
    for (const sub of [...subs].sort((a, b) => rank(a.ended ? 'x' : a.state) - rank(b.ended ? 'x' : b.state) || a.since - b.since)) {
      const under = place(sub.subs, Math.min(rail + 1, SIZE.maxRail), `${key}/${sub.id}`);
      const row = { kind: 'agent', key: `${key}/${sub.id}`, rail, y, h: SIZE.agentH, sub, lane };
      rows.push(row); y += row.h;
      join(row, under.kids, under.carry);
      seen.push(sub); kids.push(row); carry.push(lit(seen));
    }
    return { kids, carry };
  };

  let first = true;
  for (let i = lane.steps.length - 1; i >= 0; i--) {
    const step = lane.steps[i], key = `${head.key}/${i}`;
    const open = (i === lane.steps.length - 1 || anyOpen(step.subs)) !== flipped.has(key);
    if (!first) y += SIZE.groupGap;
    first = false;
    let branch = { kids: [], carry: [] };
    if (open) branch = place(step.subs, 1, key);
    else if (step.subs.length) {
      const all = flat(step.subs), gone = dropped(step), n = tally(all);
      const pile = { kind: 'pile', key: `${key}/pile`, rail: 1, y, h: SIZE.pileH, step, count: all.length + gone.done + gone.failed, tally: { ...n, done: n.done + gone.done, failed: n.failed + gone.failed }, lane };
      rows.push(pile); y += pile.h;
      branch = { kids: [pile], carry: ['done'] };
    }
    const dec = { kind: 'dec', key, rail: 0, y, h: open ? SIZE.decH : SIZE.shutH, step, open, lane };
    rows.push(dec); y += dec.h;
    join(dec, branch.kids, branch.carry);
  }
  // The agent's own line: from the terminal down to its first decision.
  const last = rows.filter((r) => r.kind === 'dec').at(-1);
  if (last) wires.unshift({ kind: 'line', rail: 0, y: stop(head), h: stop(last) - stop(head), status: 'spine' });
  return { rows, wires, height: y + SIZE.pad };
}
