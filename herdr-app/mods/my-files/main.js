// Files, with previews: markdown (mermaid drawn as box art), images, and a Quick Look
// thumbnail for anything else the system can render (PDF, HTML, Office). Anything else
// keeps the source view with syntax highlighting. A Changed filter hides untouched files.
//
// Two ways to use it:
//   - the Files panel (the shipped layout's `files` slot): the tree only, following the focused
//     pane; each window (pane) keeps its own folders open. A click on a file opens it as a Herdr
//     tab of its own (tab.new {mod}), or goes to the tab that already has it: shared(FILE_TABS).
//     DESIGN.md「文件面板：每个窗格一份，文件开成 Herdr 标签」
//   - a file (props {file: "/abs/path.md", on?: machine}): the preview, in that tab or any pane:
//     herdr-app do pane.split '{"direction":"right","mod":"my-files","props":{"file":"/abs/path.md"}}'
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, set_theme } from "gpui-base";
import { spaces, panes, focused, props, exec, run, shared, setShared, readTextFile, writeTextFile, watchFolder, nextCommand, theme, settings, window, appHome, openOverlay, closeOverlay, notify } from "herdr";
import { locate, FILE_TABS, withFileTab, fileTabOf, newTabId, linkTarget } from "./state.js";

const MOD = "mods/my-files";
const CACHE = `${MOD}/.cache`;
const PHONE_FOLDERS = "my-files/folders";
const PHONE_SYNC_FILE = "data/my-files/phone-sync.json";
const PER_FOLDER = 500, TOTAL = 5000;
let appliedSelection = null, syncingSelection = false;

function selectionOverlayColor(bg, sel) {
  if (!bg || !sel || bg.length < 7 || sel.length < 7) return "#6087b359";
  const a = 0x59 / 255;
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  const unblend = (i) => {
    const v = Math.round((ch(sel, i) - (1 - a) * ch(bg, i)) / a);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  };
  return `#${unblend(1)}${unblend(3)}${unblend(5)}59`;
}

function syncSelectionTheme(t, cx) {
  const key = `${t.background}:${t.selection}:${cx.theme()?.colors?.selection}`;
  if (syncingSelection || key === appliedSelection) return;
  syncingSelection = true;
  const selection = selectionOverlayColor(t.background, t.selection);
  cx.spawn(async (cx) => {
    try {
      set_theme({ colors: { selection } });
      appliedSelection = `${t.background}:${t.selection}:${cx.theme()?.colors?.selection}`;
    } finally {
      syncingSelection = false;
    }
  });
}

// md: rendered as text. image: shown as-is. look: whatever the system can render.
const PREVIEW = {
  md: "md", markdown: "md", mdx: "md",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", tif: "image", tiff: "image", ico: "image", svg: "image",
  html: "look", htm: "look", xhtml: "look", pdf: "look", rtf: "look",
  doc: "look", docx: "look", xls: "look", xlsx: "look", ppt: "look", pptx: "look", key: "look", pages: "look", numbers: "look",
};
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

const extOf = (path) => (path?.includes(".") ? path.split(".").pop().toLowerCase() : "");
const kindOf = (path) => PREVIEW[extOf(path)] ?? null;
const baseName = (path) => path?.split(/[\\/]/).pop() ?? "";
const childPath = (prefix, name) => (prefix ? `${prefix}/${name}` : name);
const OPENERS = { macos: "open", windows: "explorer", linux: "xdg-open" };

function checkText(text, absPath) {
  if (text === null) return `Cannot read ${absPath}`;
  if (text.includes("\0")) return "Binary file · no text preview";
  return null;
}

function makeEditor(path, text) {
  const t = theme(), ext = extOf(path);
  const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
  return EditorState.new({
    language: LANG[ext] ?? (ext || "txt"), readonly: true, value,
    font_family: settings().font_family, font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
  });
}

// Where the panel looks (state.js locate): per window (pane), a pane's own file first, then the focused window's folder.
function location() {
  const focus = focused();
  return locate({ file: props()?.file, fileOn: props()?.on, space: spaces().find((s) => s.active), focus, panes: panes(), opened: opened(focus?.tab) });
}
const key = () => JSON.stringify(location());
const opened = (tab) => (tab ? shared(FILE_TABS)?.[tab] : null) ?? null;
const allTabs = () => new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
const shownTabs = () => (spaces().find((s) => s.active)?.tabs ?? []).map((t) => t.id);

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Puts a copy of the file where image() can reach it — the app resolves paths against its own
// folder, never the project's — and reports its pixel size so the preview keeps its aspect.
// The name carries the file's mtime, so an edited file is a new one, never a stale picture.
const ASSET = `set -e
mod="$1"; src="$2"; kind="$3"; c="$mod/.cache"
mkdir -p "$c"
find "$c" -mindepth 1 -maxdepth 1 -mtime +2 -exec rm -rf {} + 2>/dev/null || true
id="$(md5 -q -s "$src")-$(stat -f %m "$src")"
if [ "$kind" = image ]; then
  ext="$(printf %s "\${src##*.}" | tr 'A-Z' 'a-z')"
  out="$c/img-$id.$ext"
  [ -e "$out" ] || cp "$src" "$out"
else
  out="$c/ql-$id.png"
  if [ ! -e "$out" ]; then
    tmp="$c/ql-$id"; rm -rf "$tmp"; mkdir -p "$tmp"
    qlmanage -t -s 2000 -o "$tmp" "$src" >/dev/null 2>&1 || true
    page="$(find "$tmp" -maxdepth 1 -name '*.png' | head -1)"
    [ -n "$page" ] || { echo "cannot-preview"; exit 0; }
    mv "$page" "$out"; rm -rf "$tmp"
  fi
fi
printf '%s\\t' "\${out#"$mod"/}"
sips -g pixelWidth -g pixelHeight "$out" 2>/dev/null | awk '/pixelWidth/{w=$2}/pixelHeight/{h=$2}END{print w"\\t"h}'`;

export default class MyFiles extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.pref = "preview"; this.hovered = null; this.copied = null;
    if (props()?.menu) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    if (!props()?.file) {
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "sync") await this.syncFromPhone(cx);
        }
      });
    }
  }

  saveSharedFolders() {
    if (!this.root) return;
    const prev = shared(PHONE_FOLDERS);
    const map = prev && typeof prev === "object" ? { ...prev } : {};
    map[this.root] = [...this.folders];
    setShared(PHONE_FOLDERS, map);
  }

  async applyPhoneFolders(list, cx) {
    this.folders = new Set(list.map(String));
    this.saveSharedFolders();
    const context = this.context;
    if (!context) return;
    for (const path of this.folders) {
      if (!this.entries.has(path) && !this.pending.has(path)) {
        await this.loadFolder(path, context).catch(() => {});
      }
    }
  }

  async syncFromPhone(cx) {
    try {
      const raw = await readTextFile(`${appHome()}/${PHONE_SYNC_FILE}`);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.onlyChanged !== undefined) this.onlyChanged = Boolean(data.onlyChanged);
      const list = Array.isArray(data.folders)
        ? (!data.root || data.root === this.root ? data.folders : null)
        : (this.root && Array.isArray(data.folders?.[this.root]) ? data.folders[this.root] : null);
      if (list) await this.applyPhoneFolders(list, cx);
      cx.notify();
    } catch {}
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) { return this.context === context && key() === context.key; }

  /** A pane's own file is absolute; one from the tree is relative to the panel's folder. */
  abs(path) { return path?.startsWith("/") ? path : `${this.root}/${path}`; }

  markCopied(id, cx) {
    this.copied = id;
    cx.notify();
    cx.timer.after(1200, (cx) => {
      if (this.copied === id) { this.copied = null; cx.notify(); }
    });
  }

  copyPath(path, id, cx) {
    cx.write_to_clipboard(this.abs(path));
    this.markCopied(id, cx);
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, file } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      const synced = cwd && Array.isArray(shared(PHONE_FOLDERS)?.[cwd]) ? shared(PHONE_FOLDERS)[cwd] : [];
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders ?? synced);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false; this.loading = false;
      this.show(file ?? null, cx);
    }
    if (!cwd || this.loading || this.file) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    this.saveSharedFolders();
    cx.notify();
  }

  /** Opens `path` in the panel: its preview when it has one, its source otherwise. */
  show(path, cx) {
    this.code?.release(); this.code = null;
    this.asset = null; this.text = null; this.mermaid = null; this.fileError = null; this.hovered = null;
    this.file = path ?? null;
    this.kind = path ? kindOf(path) : null;
    if (!path) { this.preview = null; return; }
    // Quick Look renders the file itself, so there is no source to switch to.
    if (this.kind === "look") this.preview = "preview";
    else if (!this.kind) this.preview = "source";
    else this.preview = this.pref;
    if (this.preview === "source") return this.loadSource(path, cx);
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        if (this.kind === "md") await this.loadMarkdown(path, context, root, on);
        else await this.loadAsset(path, this.kind, root, on, context);
      } catch (e) { if (this.current(context)) this.fileError = String(e); }
      finally { if (this.current(context)) cx.notify(); }
    });
  }

  async loadMarkdown(path, context, root, on) {
    const text = await readTextFile(this.abs(path), { on });
    if (text === null) throw new Error(`Cannot read ${this.abs(path)}`);
    if (this.file !== path || !this.current(context)) return;
    this.text = text;
    if (!/^\s*```mermaid\b/m.test(text)) return;
    // mmd2txt reads a file, not a pipe, so the markdown lands in the mod's own hidden cache
    // (hidden, so writing it does not reload the mod). A remote pane keeps the source.
    if (on) { this.mermaid = null; return; }
    const dir = `${appHome()}/${CACHE}`;
    const tmp = `${dir}/md-${Date.now()}.md`;
    await exec("sh", ["-c", 'mkdir -p "$1"', "md", dir]).catch(() => null);
    await writeTextFile(tmp, text, null);
    const rendered = await exec("mmd2txt", ["--md", tmp, "--max-width", "72"]).catch(() => null);
    await exec("rm", ["-f", tmp]).catch(() => null);
    if (rendered?.code === 0 && this.file === path && this.current(context)) this.mermaid = rendered.stdout;
  }

  async loadAsset(path, kind, root, on, context) {
    const r = await exec("sh", ["-c", ASSET, "asset", `${appHome()}/${MOD}`, this.abs(path), kind], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot preview this file");
    if (r.stdout.trim() === "cannot-preview") throw new Error("Nothing on this machine can render this file");
    const [rel, w, h] = r.stdout.trim().split("\t");
    if (this.file !== path || !this.current(context)) return;
    this.asset = { path: `${MOD}/${rel}`, w: Number(w) || 800, h: Number(h) || 600 };
  }

  loadSource(path, cx) {
    const context = this.context, on = this.on, absPath = this.abs(path);
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(absPath, { on });
        if (this.file !== path || !this.current(context)) return;
        this.fileError = checkText(text, absPath);
        if (!this.fileError) { this.text = text; this.code = makeEditor(path, text); }
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { if (this.current(context)) cx.notify(); }
    });
  }

  /**
   * Opens `absPath` as a Herdr tab of its own, or goes to the tab of this space that already has it.
   * `place` is where the panel was looking, kept so the panel stays put while the file tab has focus.
   */
  openTab(absPath, place, cx) {
    const had = fileTabOf(shared(FILE_TABS), absPath, new Set(shownTabs()));
    if (had) { run("tab.select", { id: had }); return; }
    const before = new Set(shownTabs());
    run("tab.new", { name: baseName(absPath), mod: "my-files", props: { file: absPath, ...(place.on ? { on: place.on } : {}) } });
    let tries = 0;
    const remember = (cx) => {
      const id = newTabId(before, shownTabs());
      if (!id) { if (++tries < 20) cx.timer.after(50, remember); return; }
      setShared(FILE_TABS, withFileTab(shared(FILE_TABS), id, { file: absPath, ...place }, allTabs()));
      run("tab.move", { id, index: shownTabs().length }); // tab.new puts it after the current tab: to the end
    };
    remember(cx);
  }

  iconBtn(id, icon, tip, t, action) {
    const ok = this.copied === id;
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(ok ? t.ansi2 : t.dim).hover((s) => s.bg(t.hover).text_color(ok ? t.ansi2 : t.foreground))
      .tooltip(ok ? "Copied" : tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); action(e, cx); })
      .child(svg(`${MOD}/${ok ? "check" : icon}.svg`).size(13));
  }

  markColor(mark, t) {
    if (mark === "A") return t.ansi2;
    return mark === "D" || mark === "U" ? t.ansi1 : t.blocked;
  }

  rowActions(path, t) {
    const pid = `tree-path:${path}`;
    return h_flex().gap(2).flex_none().items_center()
      .child(this.iconBtn(pid, "path", "Copy path", t, (_e, cx) => this.copyPath(path, pid, cx)));
  }

  hasRowActions(path) {
    return this.hovered === path || this.copied === `tree-path:${path}`;
  }

  openRowMenu(entry, path) {
    openOverlay({ mod: "my-files", kind: "popup", width: 196, height: 72, props: { menu: { absPath: this.abs(path) } } });
  }

  row(entry, path, depth, t, shown) {
    const open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
    const here = !entry.dir && shown === this.abs(path); // the file the focused tab shows
    return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .when(here, (el) => el.bg(t.selected)).hover((s) => s.bg(here ? t.selected : t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = path;
        else if (this.hovered === path) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => { if (entry.dir) this.toggle(path, cx); else this.openTab(this.abs(path), { root: this.root, on: this.on, from: location().pane }, cx); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openRowMenu(entry, path); })
      .child(entry.dir ? svg(`${MOD}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`${MOD}/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(entry.name))
      .when(this.hasRowActions(path), (el) => el.child(this.rowActions(path, t)))
      .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(this.markColor(mark, t)).child(mark)));
  }

  visibleEntry(entry, path) {
    if (!this.onlyChanged) return true;
    return entry.dir ? this.subtreeChanged(path) : Boolean(this.marks[`${this.root}/${path}`]);
  }

  rows(prefix, depth, out, t, shown = opened(focused()?.tab)?.file ?? null) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = childPath(prefix, entry.name);
      if (!this.visibleEntry(entry, path)) continue;
      out.push(this.row(entry, path, depth, t, shown));
      if (entry.dir && this.folders.has(path)) this.rows(path, depth + 1, out, t, shown);
    }
    return out;
  }

  /** A folder stays in the Changed list while anything under it changed. */
  subtreeChanged(prefix) {
    const start = `${this.root}/${prefix}/`;
    return Object.keys(this.marks).some((path) => path.startsWith(start));
  }

  /** A link inside the preview: a file beside this one opens here, anything else goes to the system. */
  openLink(url, cx) {
    const target = linkTarget(this.file, url);
    if (target === null) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) exec(OPENERS[window()?.platform] ?? "open", [url]);
      return;
    }
    const o = opened(focused()?.tab);
    this.openTab(this.abs(target), { root: o?.root ?? this.root, on: this.on, from: o?.from ?? null }, cx);
  }

  seg(t, on, label, action) {
    return div().id(`seg-${label}`).px(8).h(20).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .on_click(action).child(label);
  }

  modeSwitch(t) {
    return h_flex().gap(2).p(2).flex_none().rounded(7).border_1().border_color(t.border)
      .child(this.seg(t, this.preview === "preview", "Preview", (_e, cx) => { this.pref = "preview"; this.show(this.file, cx); cx.notify(); }))
      .child(this.seg(t, this.preview === "source", "Source", (_e, cx) => { this.pref = "source"; this.show(this.file, cx); cx.notify(); }));
  }

  /** The panel's header: no buttons. Copy path lives on the tree rows (hover, right-click). */
  header(t) {
    return h_flex().id("my-files-head").h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().truncate().child("Files"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(baseName(this.root)));
  }

  /** A file's own controls: one slim row at the right, no name (the pane's frame, my-pane, names it). */
  fileTools(t) {
    const switchable = Boolean(this.kind) && this.kind !== "look";
    return h_flex().id("file-tools").h(36).flex_none().px(10).gap(6).items_center().justify_end()
      .when(switchable, (el) => el.child(this.modeSwitch(t)))
      .child(this.iconBtn("files-open", "open", "Open in default app", t, () => exec(OPENERS[window()?.platform] ?? "open", [this.abs(this.file)])));
  }

  /** The preview body: markdown, an image, a Quick Look thumbnail, or the source. */
  body(t) {
    if (this.fileError) return div().p(12).text_color(t.dim).child(this.fileError);
    if (this.preview === "source" || !this.kind) return this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("Loading file…");
    if (this.kind === "md") {
      if (!this.text) return div().p(12).text_color(t.dim).child("Loading preview…");
      return v_flex().id("md-preview").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14)
        .child(TextView.markdown(`md-${this.file}`, this.mermaid ?? this.text).selectable(true).on_link_click((url, cx) => this.openLink(url, cx)));
    }
    if (!this.asset) return div().p(12).text_color(t.dim).child("Rendering preview…");
    const w = Math.max(80, (this.width ?? 368) - 28), h = Math.round(w * this.asset.h / this.asset.w);
    return v_flex().id("asset-preview").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(8)
      .child(image(this.asset.path).w(w).h(h).flex_none())
      .when(this.kind === "look", (el) => el.child(div().text_size(11).text_color(t.dim).child("Rendered by Quick Look · first page or frame")));
  }

  menuItem(id, icon, label, t, action) {
    return h_flex().id(id).h(30).px(8).gap(8).rounded(6).items_center().cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(action)
      .child(svg(`${MOD}/${icon}.svg`).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().child(label));
  }

  menuView(menu, t) {
    const close = () => closeOverlay(props().overlay);
    return v_flex().id("my-files-menu").w_full().p(5).bg(t.popover).text_size(12.5)
      .child(this.menuItem("menu-copy-path", "path", "Copy path", t, (_e, cx) => {
        cx.write_to_clipboard(menu.absPath);
        close();
      }))
      .child(this.menuItem("menu-open", "open", "Open in default app", t, () => {
        close();
        exec(OPENERS[window()?.platform] ?? "open", [menu.absPath]);
      }));
  }

  emptyText() {
    if (this.error) return this.error;
    if (this.loading) return "Loading files…";
    if (!this.root) return "No folder";
    return this.onlyChanged ? "Nothing changed here" : "No files";
  }

  treeView(t) {
    return v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
      .when(Boolean(this.error) || !this.entries.get("")?.length, (inner) => inner.child(div().p(8).text_size(12).text_color(t.dim).child(this.emptyText())))
      .when(this.limited, (inner) => inner.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
  }

  render(cx) {
    const t = theme(), menu = props()?.menu;
    syncSelectionTheme(t, cx);
    if (menu) return this.menuView(menu, t);
    if (key() !== this.context?.key) this.refresh(cx);
    const sized = (el) => el.text_color(t.foreground).text_size(13).on_size_change((size, cx) => { this.width = size.width; cx.notify(); });
    // A file sits in the pane's frame as it is: no frame of its own inside it.
    if (props()?.file) return sized(v_flex().id("my-files").size_full().min_h(0).bg(t.background))
      .when(Boolean(this.file), (el) => el.child(this.fileTools(t)).child(this.body(t)));
    return sized(v_flex().id("my-files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border))
      .child(this.header(t))
      .child(h_flex().h(30).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.seg(t, !this.onlyChanged, "All", (_e, cx) => { this.onlyChanged = false; cx.notify(); }))
        .child(this.seg(t, this.onlyChanged, "Changed", (_e, cx) => { this.onlyChanged = true; cx.notify(); })))
      .child(this.treeView(t));
  }
}
