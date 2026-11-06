/**
 * The shortcuts of each coding agent that a phone needs, and key combos by name. herdr-core's
 * terminal.keys turns a name (ctrl+enter, alt+m) into the bytes the program asked for: legacy,
 * modifyOtherKeys or the kitty keyboard protocol (probe/keys.mjs). DESIGN.md「每个 agent 的快捷键」
 *
 * Each entry: [label, key names, what it does]. Taken from the programs themselves (2026-11-06):
 * Claude Code 2.1.316 its default keybinding table; agy (Antigravity CLI) its release notes and
 * hints; droid 1.5.0 its hints. None of them had a user keybindings file on this Mac.
 */
export const AGENT_KEYS = {
  claude: [
    ['^⏎', ['ctrl+enter'], '立即发送'], ['^O', ['ctrl+o'], '展开记录'], ['^T', ['ctrl+t'], '待办'], ['^B', ['ctrl+b'], '转到后台'],
    ['⌥P', ['alt+p'], '选模型'], ['⌥T', ['alt+t'], '思考开关'], ['^G', ['ctrl+g'], '外部编辑器'], ['^S', ['ctrl+s'], '暂存输入'],
  ],
  antigravity: [
    ['⌥M', ['alt+m'], '立即发送 / 排队，和设置相反'], ['^O', ['ctrl+o'], '展开'], ['^G', ['ctrl+g'], '全屏看命令'], ['^R', ['ctrl+r'], '产物审阅'],
    ['⌥S', ['alt+s'], 'swarm 看板'], ['⇧⏎', ['shift+enter'], '换行'],
  ],
  droid: [
    ['^N', ['ctrl+n'], '换模型'], ['^L', ['ctrl+l'], '自主级别'], ['^O', ['ctrl+o'], '详情'], ['^T', ['ctrl+t'], 'Mission Control'],
    ['^R', ['ctrl+r'], '改队列'], ['^X', ['ctrl+x'], '清空队列'], ['⇧⏎', ['shift+enter'], '换行'],
  ],
};
const ALIASES = { 'claude-code': 'claude', agy: 'antigravity', factory: 'droid' };

/** The terminal's agent shortcuts: by the icon key Herdr.app gives it, else by the program's name. */
export function agentKeys(t) {
  for (const k of [t?.icon, t?.app, t?.program]) {
    const key = ALIASES[k] ?? k;
    if (key && AGENT_KEYS[key]) return AGENT_KEYS[key];
  }
  return [];
}

export const MODS = ['ctrl', 'alt', 'shift'];
/** A key name with the held modifiers, in herdr-core's order: ctrl+alt+shift+enter. */
export const combo = (mods, key) => [...MODS.filter((m) => mods.has(m)), key].join('+');

/** What a typed character is called as a key, or null (a Chinese character has no key). */
export function keyOfChar(ch) {
  if (ch === ' ') return 'space';
  if (/^[a-z0-9]$/i.test(ch)) return ch.toLowerCase();
  if (/^[-=[\]\;',./`]$/.test(ch)) return ch;
  return null;
}
