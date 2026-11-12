/**
 * The person's words, as a label on the agent's terminal (DESIGN.md「观测面板」).
 *
 * herdr-core does not see what the person typed. Claude Code runs a `UserPromptSubmit` hook on every
 * prompt; ours (`wayne-herdr-mods said`) copies the prompt's start into the label `wayne.said` of the
 * terminal it runs in, where the board picks it up like any other fact of herdr-core.
 * What the hook prints is added to the agent's context: one line asking it to note its own decisions.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { HC_BIN } from './hc.js';
import { NOTE, SAID } from './board.js';

const MARK = 'wayne-herdr-mods" said';
/** Outside Herdr there is no terminal to label: the shell test keeps node from starting at all. */
export const HOOK_COMMAND = `[ -n "$HC_TERMINAL_ID" ] && "$HOME/.local/bin/${MARK} || true`;
export const REMINDER = `做了重要取舍时记一行（会显示在观测面板上）：hc label $HC_TERMINAL_ID ${NOTE}="决定和原因"`;
const MAX_CHARS = 300;

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const ours = (hook) => String(hook?.command ?? '').includes(MARK);
const hasOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(ours);

/**
 * Whether these settings have the shape Claude Code documents, as far as we touch it: an object,
 * `hooks` an object when present, `hooks.UserPromptSubmit` a list when present. Anything else is
 * somebody's own arrangement: we leave the file alone.
 */
export function editable(settings) {
  if (!isPlain(settings)) return false;
  if (settings.hooks === undefined) return true;
  return isPlain(settings.hooks) && (settings.hooks.UserPromptSubmit === undefined || Array.isArray(settings.hooks.UserPromptSubmit));
}

/** Claude Code's settings with our hook in `hooks.UserPromptSubmit`; everything else as it was. */
export function mergeHook(settings) {
  if (!editable(settings)) return settings;
  const list = settings.hooks?.UserPromptSubmit ?? [];
  if (list.some(hasOurs)) return settings;
  return { ...settings, hooks: { ...settings.hooks, UserPromptSubmit: [...list, { hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }] } };
}

/**
 * The same settings without our command. Only our command goes: an entry that also holds someone
 * else's command keeps it. An entry, a list and a `hooks` we emptied go too.
 */
export function removeHook(settings) {
  if (!editable(settings)) return settings;
  const list = settings.hooks?.UserPromptSubmit;
  if (!list?.some(hasOurs)) return settings;
  const kept = list.map((e) => (hasOurs(e) ? { ...e, hooks: e.hooks.filter((h) => !ours(h)) } : e)).filter((e) => !Array.isArray(e?.hooks) || e.hooks.length);
  const { UserPromptSubmit: _, ...others } = settings.hooks;
  const hooks = kept.length ? { ...others, UserPromptSubmit: kept } : others;
  const { hooks: __, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

/**
 * Apply `edit` (mergeHook / removeHook) to a settings file. Returns 'changed', 'same', or 'skipped'
 * (not JSON, or not a shape we edit: the file is left exactly as it was). The new text is written
 * whole to a file beside it and then renamed over it, so a failed write leaves the old settings.
 * A settings.json that is a link (a dotfiles setup) stays a link: the file it points to is the one
 * replaced. The new file has the old one's permissions; a new one is for its owner only.
 */
export function editSettingsFile(file, edit, fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, statSync }) {
  let current = {}, target = file, mode = 0o600;
  try {
    if (fs.existsSync(file)) {
      target = fs.realpathSync(file);
      mode = fs.statSync(target).mode & 0o777;
      current = JSON.parse(fs.readFileSync(target, 'utf8'));
    }
  } catch { return 'skipped'; }
  if (!editable(current)) return 'skipped';
  const next = edit(current);
  if (next === current) return 'same';
  const tmp = `${target}.wayne-herdr-mods.tmp`;
  try {
    fs.rmSync(tmp, { force: true }); // one left by an interrupted run would keep its own permissions
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode, flag: 'wx' });
    fs.renameSync(tmp, target);
  }
  catch (error) { try { fs.rmSync(tmp, { force: true }); } catch {} throw error; }
  return 'changed';
}

/** The label value for a prompt: when it was said, then its start on one line. Null: nothing to record. */
export function saidLabel(input, now) {
  let prompt;
  try { prompt = JSON.parse(input).prompt; } catch { return null; }
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return `${now}|${text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text}`;
}

/** The hook itself. Never fails: a prompt must go through whatever happens here. */
export async function said({ stdin = process.stdin, env = process.env, now = Date.now(), run = execFile } = {}) {
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) return;
  let input = '';
  try { for await (const chunk of stdin) input += chunk; } catch { return; }
  const value = saidLabel(input, now);
  if (value) await new Promise((resolve) => run(HC_BIN, ['label', terminal, `${SAID}=${value}`], { timeout: 3000 }, () => resolve()));
  process.stdout.write(`${REMINDER}\n`);
}
