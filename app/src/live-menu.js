/**
 * A menu on the agent's screen (conversation view, live part): which lines are its options and
 * which one is selected now. Agents mark the selected option with a pointer ("❯ 2. No"); the other
 * options line up with its text. Lines indented deeper are an option's description.
 *
 * Tapping an option moves the pointer there with ↑ / ↓; tapping the selected one presses ⏎.
 */
const POINTER = /^([\s│┃]*)([❯›▶▸➜→])\s+(?=\S)/;
const lead = (l) => /^[\s│┃]*/.exec(l)[0].length;

/** → { sel, options } (line numbers), or null when there is no menu. */
export function menuOf(lines) {
  let sel = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (POINTER.test(lines[i])) { sel = i; break; }
  if (sel < 0) return null;
  const at = POINTER.exec(lines[sel])[0].length; // where the option's text starts
  const options = [sel];
  for (const step of [-1, 1]) {
    for (let i = sel + step; i >= 0 && i < lines.length; i += step) {
      const l = lines[i];
      if (!l.trim() || /^[\s│┃]*$/.test(l)) break;
      const n = lead(l);
      if (n > at) continue;          // a description under an option
      if (n !== at) break;           // the menu ends
      if (step < 0) options.unshift(i); else options.push(i);
    }
  }
  return options.length > 1 ? { sel, options } : null;
}

/** The keys that pick option line `to` when `sel` is selected. */
export function keysTo(menu, to) {
  const from = menu.options.indexOf(menu.sel), target = menu.options.indexOf(to);
  if (target < 0) return '';
  if (target === from) return '\r';
  return (target > from ? '\x1b[B' : '\x1b[A').repeat(Math.abs(target - from));
}
