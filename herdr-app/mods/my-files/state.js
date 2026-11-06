// The parts of my-files that need no app: node tests them (test/my-files-state.test.mjs).
// DESIGN.md「Herdr.app 里的界面」

const dirOf = (file) => file.split(/[\\/]/).slice(0, -1).join("/");

/** The full-window view of a tab keeps its open files in shared(viewerKey(tab)):
 *  { root, on, from: the pane that opened it, files: [absolute path], active: absolute path | null }. */
export const viewerKey = (tab) => `my-files/viewer/${tab}`;

/** The full-window view's pane in `tab`, or null. */
export const viewerPane = (panes, tab) => (tab && panes.find((p) => p.mod === "my-files" && p.tab === tab)) || null;

/** Which window the focus is in: a pane, or a terminal block of the layout (no pane). */
export const windowOf = (focus) => focus?.pane ?? (focus?.terminal ? `terminal:${focus.terminal}` : null);

/**
 * Where the panel looks: a pane's own file wins, then the focused window's folder. The window
 * (`pane`) is part of it, so each window keeps its own folders open and file shown, even when
 * several share a folder. While the full-window view has the focus (a mod pane: no folder), the
 * panel stays the one of the window that opened it.
 */
export function locate({ file, space, focus, panes, viewer }) {
  if (file) return { pane: null, cwd: dirOf(file), on: null, file };
  const pane = focus?.pane ? panes.find((p) => p.pane === focus.pane) : null;
  if (pane?.mod === "my-files" && viewer?.root) return { pane: viewer.from ?? null, cwd: viewer.root, on: viewer.on ?? null, file: null };
  const on = focus?.pane === null ? (focus.terminal?.includes("/") ? focus.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { pane: windowOf(focus), cwd: pane?.cwd || focus?.cwd || space?.folder, on, file: null };
}

/** Opens `file` in the view: a tab of its own (once), shown. */
export function openIn(viewer, file) {
  const files = viewer.files.includes(file) ? viewer.files : [...viewer.files, file];
  return { ...viewer, files, active: file };
}

/** Closes `file`'s tab; if it was shown, its neighbour is (the one after, else before). */
export function closeIn(viewer, file) {
  const i = viewer.files.indexOf(file);
  if (i < 0) return viewer;
  const files = viewer.files.filter((f) => f !== file);
  const active = viewer.active === file ? files[Math.min(i, files.length - 1)] ?? null : viewer.active;
  return { ...viewer, files, active };
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
