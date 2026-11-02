/**
 * The phone keyboard → the program's own input line. There is one input box: the program's.
 *
 * The phone's text field is only a keyboard. It holds the *burst*: what was typed since the last
 * commit. Every change of the burst goes into the terminal at once as keystrokes (backspaces back
 * to the common prefix, then the new text), so Claude Code, Codex or the shell show it, menus and
 * all. A commit (send, a key from the key bar, an inserted image) hands what went in to the
 * program: the burst starts empty again, and a backspace on an empty burst goes straight through.
 *
 *   - while an input method composes (pinyin), nothing goes in; the chosen characters do;
 *   - while the program asks a question (blocked), nothing goes in: a letter could answer it.
 *     The text waits (`pending`) and goes in once the question is answered;
 *   - a reconnect changes nothing: the program kept its line, so `typed` stays as it was;
 *   - a line break goes in as a pasted LF: Claude Code and Codex insert a new line, a shell too
 *     (a typed LF would be Enter).
 */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const PASTE_LF = `${PASTE_START}\n${PASTE_END}`;

/** Text as one bracketed paste; an end marker inside could not end it early. */
export const pasteText = (text) => PASTE_START + String(text).replaceAll(PASTE_END, '') + PASTE_END;

/** Keystrokes that turn `from` into `to`: backspaces to the common prefix, then the rest. */
export function keystrokes(from, to) {
  const a = Array.from(from), b = Array.from(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return '\x7f'.repeat(a.length - i) + b.slice(i).join('').replaceAll('\n', PASTE_LF);
}

export class LiveLine {
  /** @param {(data: string) => void} write  bytes for the terminal (term.input) */
  constructor(write) {
    this.write = write;
    this.value = '';   // the field: the burst
    this.typed = '';   // what of the burst the terminal has
    this.composing = false;
    this.held = false;
  }

  /** Text that has not gone in yet (held, or still composing). */
  get pending() { return this.value.startsWith(this.typed) ? this.value.slice(this.typed.length) : this.value; }

  set(value) { this.value = value; this.flush(); }
  compose(on) { this.composing = on; this.flush(); }
  hold(on) { this.held = on; this.flush(); }

  flush() {
    if (this.composing || this.held || this.value === this.typed) return;
    this.write(keystrokes(this.typed, this.value));
    this.typed = this.value;
  }

  /** The program owns what went in; keep only what has not. */
  commit() {
    this.value = this.pending;
    this.typed = '';
    this.flush();
  }

  /** Enter. Refused while text waits: Enter would answer the program's question. */
  submit() {
    this.flush();
    if (this.value !== this.typed) return false;
    this.write('\r');
    this.value = this.typed = '';
    return true;
  }

  /** Backspace pressed. True when it went to the program (the burst was empty). */
  backspace() {
    if (this.value) return false;
    this.write('\x7f');
    return true;
  }
}
