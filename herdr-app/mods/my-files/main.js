// Files, with previews: markdown (mermaid drawn as box art), images, and a Quick Look
// thumbnail for anything else the system can render (PDF, HTML, Office). Anything else
// keeps the source view with syntax highlighting. A Changed filter hides untouched files.
//
// Two ways to use it:
//   - the Files panel (the shipped layout's `files` slot), following the focused pane
//   - a pane of its own:
//     herdr-app do pane.split '{"direction":"right","mod":"my-files","props":{"file":"/abs/path.md"}}'
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, props, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, appHome } from "herdr";

const MOD = "mods/my-files";
const CACHE = `${MOD}/.cache`;
const PER_FOLDER = 500, TOTAL = 5000;

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
const OPENERS = { macos: "open", windows: "explorer", linux: "xdg-open" };

// Where the panel looks: a pane's own file wins, then the focused pane's folder.
function location() {
  const file = props()?.file;
  if (file) return { cwd: file.split(/[\\/]/).slice(0, -1).join("/"), on: null, file };
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, file: null };
}
const key = () => JSON.stringify(location());

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
    this.pref = "preview";
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
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
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false; this.loading = false;
      this.show(file ?? null, cx);
      if (!file && saved?.file) this.show(saved.file, cx);
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
    cx.notify();
  }

  /** Opens `path` in the panel: its preview when it has one, its source otherwise. */
  show(path, cx) {
    this.code?.release(); this.code = null;
    this.asset = null; this.text = null; this.mermaid = null; this.fileError = null;
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
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.abs(path), { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = `Cannot read ${this.abs(path)}`; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = extOf(path);
        this.code = EditorState.new({ language: LANG[ext] ?? (ext || "txt"), readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { if (this.current(context)) cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      if (this.onlyChanged && (entry.dir ? !this.subtreeChanged(path) : !mark)) continue;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`${MOD}/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`${MOD}/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
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
    const dir = this.file?.includes("/") ? this.file.slice(0, this.file.lastIndexOf("/")) : "";
    const target = url.replace(/^\.\//, "").replace(/[#?].*$/, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || !target) return void exec(OPENERS[window()?.platform] ?? "open", [url]);
    const parts = (dir ? `${dir}/${target}` : target).split("/"), rest = [];
    for (const part of parts) {
      if (part === "..") rest.pop();
      else if (part !== "." && part !== "") rest.push(part);
    }
    if (!rest.length) return;
    this.show(rest.join("/"), cx);
    cx.notify();
  }

  seg(t, on, label, action) {
    return div().id(`seg-${label}`).px(8).h(20).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .on_click(action).child(label);
  }

  header(t) {
    const name = baseName(this.file) || this.root?.split(/[\\/]/).pop() || "";
    const switchable = Boolean(this.kind) && this.kind !== "look";
    return h_flex().id("my-files-head").h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.file) && !props()?.file, (el) => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted)
        .on_click((_e, cx) => { this.show(null); this.refresh(cx); cx.notify(); }).child("←")))
      .child(div().font_semibold().child(this.file ? name : "Files"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? name))
      .when(switchable, (el) => el.child(h_flex().gap(2).p(2).flex_none().rounded(7).border_1().border_color(t.border)
        .child(this.seg(t, this.preview === "preview", "Preview", (_e, cx) => { this.pref = "preview"; this.show(this.file, cx); cx.notify(); }))
        .child(this.seg(t, this.preview === "source", "Source", (_e, cx) => { this.pref = "source"; this.show(this.file, cx); cx.notify(); }))))
      .when(Boolean(this.file), (el) => el.child(div().id("files-open").size(22).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => exec(OPENERS[window()?.platform] ?? "open", [this.abs(this.file)]))
        .child(svg(`${MOD}/open.svg`).size(13))));
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

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), panel = !props()?.file;
    return v_flex().id("my-files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(this.header(t))
      .when(panel && !this.file, (el) => el.child(h_flex().h(30).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.seg(t, !this.onlyChanged, "All", (_e, cx) => { this.onlyChanged = false; cx.notify(); }))
        .child(this.seg(t, this.onlyChanged, "Changed", (_e, cx) => { this.onlyChanged = true; cx.notify(); }))))
      .when(!this.file, (el) => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, (inner) => inner.child(div().p(8).text_size(12).text_color(t.dim)
          .child(this.error || (this.loading ? "Loading files…" : this.root ? (this.onlyChanged ? "Nothing changed here" : "No files") : "No folder"))))
        .when(this.limited, (inner) => inner.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), (el) => el.child(this.body(t)));
  }
}
