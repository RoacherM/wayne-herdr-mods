// The parts of my-files that need no app: node tests them (test/my-files-state.test.mjs).
// DESIGN.md「Herdr.app 里的界面」

const dirOf = (file) => file.split(/[\\/]/).slice(0, -1).join("/");

/** The files opened as Herdr tabs, in one shared value: { [tab]: { file: absolute path, root, on,
 *  from: the window that opened it } }. DESIGN.md「文件面板：每个窗格一份，文件开成 Herdr 标签」 */
export const FILE_TABS = "my-files/tabs";

/** `all` with `tab` set to `entry` (or removed when null), and without the tabs that no longer exist. */
export function withFileTab(all, tab, entry, liveTabs) {
  const out = {};
  for (const [id, v] of Object.entries(all ?? {})) if (liveTabs.has(id) && id !== tab) out[id] = v;
  if (entry) out[tab] = entry;
  return out;
}

/** The live tab that already shows `file`, or null. */
export function fileTabOf(all, file, liveTabs) {
  for (const [id, v] of Object.entries(all ?? {})) if (v?.file === file && liveTabs.has(id)) return id;
  return null;
}

/** The tab `tab.new` just made: the one in `after` that was not in `before`. */
export const newTabId = (before, after) => after.find((id) => !before.has(id)) ?? null;

/** Which window the focus is in: a pane, or a terminal block of the layout (no pane). */
export const windowOf = (focus) => focus?.pane ?? (focus?.terminal ? `terminal:${focus.terminal}` : null);

/**
 * Where the panel looks: a pane's own file wins, then the focused window's folder. The window
 * (`pane`) is part of it, so each window keeps its own folders open, even when several share a
 * folder. While a file tab has the focus (a mod pane: no folder), the panel stays the one of the
 * window that opened it (`opened`: that tab's FILE_TABS entry).
 */
export function locate({ file, fileOn, space, focus, panes, opened }) {
  if (file) return { pane: null, cwd: dirOf(file), on: fileOn ?? null, file };
  const pane = focus?.pane ? panes.find((p) => p.pane === focus.pane) : null;
  if (pane?.mod === "my-files" && opened?.root) return { pane: opened.from ?? null, cwd: opened.root, on: opened.on ?? null, file: null };
  const on = focus?.pane === null ? (focus.terminal?.includes("/") ? focus.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { pane: windowOf(focus), cwd: pane?.cwd || focus?.cwd || space?.folder, on, file: null };
}

/** A link inside `from`: the file beside it it names (absolute if `from` is), or null for a URL. */
export function linkTarget(from, url) {
  const target = url.replace(/^\.\//, "").replace(/[#?].*$/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || !target) return null;
  const dir = from?.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const parts = (target.startsWith("/") ? target : dir ? `${dir}/${target}` : target).split("/"), rest = [];
  for (const part of parts) {
    if (part === "..") rest.pop();
    else if (part !== "." && part !== "") rest.push(part);
  }
  if (!rest.length) return null;
  return (from?.startsWith("/") || target.startsWith("/") ? "/" : "") + rest.join("/");
}
