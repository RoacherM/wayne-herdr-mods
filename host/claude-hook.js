/**
 * Cleanup for the retired `wayne-herdr-mods said` `UserPromptSubmit` hook in `~/.claude/settings.json`.
 *
 * `wayne-board` now parses local session transcripts directly (`host/transcripts.js`) and renders only
 * subagent communication topology, so `install` and `uninstall` strip the legacy hook while `said`
 * remains a silent no-op for already-running Claude Code sessions.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

const MARK = 'wayne-herdr-mods" said';
export const HOOK_COMMAND = `[ -n "$HC_TERMINAL_ID" ] && "$HOME/.local/bin/${MARK} || true`;

const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const ours = (hook) => String(hook?.command ?? '').includes(MARK);
const hasOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(ours);

/** Whether `settings` matches Claude Code's documented hooks object shape. */
export function editable(settings) {
  if (!isPlain(settings)) return false;
  if (settings.hooks === undefined) return true;
  return isPlain(settings.hooks) && (settings.hooks.UserPromptSubmit === undefined || Array.isArray(settings.hooks.UserPromptSubmit));
}

function stripOurEntry(entry) {
  return hasOurs(entry) ? { ...entry, hooks: entry.hooks.filter((h) => !ours(h)) } : entry;
}

function nonEmptyEntry(entry) {
  return !Array.isArray(entry?.hooks) || entry.hooks.length > 0;
}

/** Remove only our legacy hook command; clean up empty UserPromptSubmit / hooks containers. */
export function removeHook(settings) {
  if (!editable(settings)) return settings;
  const list = settings.hooks?.UserPromptSubmit;
  if (!list?.some(hasOurs)) return settings;
  const kept = list.map(stripOurEntry).filter(nonEmptyEntry);
  const { UserPromptSubmit: _, ...others } = settings.hooks;
  const hooks = kept.length ? { ...others, UserPromptSubmit: kept } : others;
  const { hooks: __, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

function readTargetJson(file, fs) {
  if (!fs.existsSync(file)) return null;
  const target = fs.realpathSync(file);
  const mode = fs.statSync(target).mode & 0o777;
  return { target, mode, current: JSON.parse(fs.readFileSync(target, 'utf8')) };
}

/** Atomically apply `edit` to `settings.json`, preserving symlinks and permissions. */
export function editSettingsFile(file, edit, fs = { existsSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync, statSync }) {
  let info;
  try { info = readTargetJson(file, fs); } catch { return 'skipped'; }
  if (!info) return 'same';
  if (!editable(info.current)) return 'skipped';
  const next = edit(info.current);
  if (next === info.current) return 'same';
  const tmp = `${info.target}.wayne-herdr-mods.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: info.mode, flag: 'wx' });
    fs.renameSync(tmp, info.target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
  return 'changed';
}

/** Silent no-op kept so already-running Claude Code sessions exit cleanly before reload. */
export async function said() {}
