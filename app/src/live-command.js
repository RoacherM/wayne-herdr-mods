/**
 * Slash commands typed live into the terminal.
 *
 * Coding agents (Claude Code, Codex) open their own command menu as soon as "/" is typed and filter
 * it as you type. The message box only sends on submit, so that menu never shows. While the box
 * starts with "/", every change is mirrored into the terminal as keystrokes instead: the menu shows
 * and filters on the terminal above, ↑↓ / Tab from the key bar pick, and send presses Enter.
 */

/** Keystrokes that turn what we typed (`from`) into `to`: backspaces to the common prefix, then the rest. */
export function keystrokes(from, to) {
  const a = Array.from(from), b = Array.from(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return '\x7f'.repeat(a.length - i) + b.slice(i).join('');
}

/** What the terminal should hold for this box value: the value itself in command mode, else nothing. */
export const commandText = (value) => (value.startsWith('/') && !value.includes('\n') ? value : '');
