// File tab preview for my-files: markdown (mermaid via mmd2txt), images, Quick Look, and syntax source.
// DESIGN.md「文件面板：每个窗格一份，文件开成 Herdr 标签」

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, set_theme } from "gpui-base";
import { exec, readTextFile, writeTextFile, theme, settings, appHome } from "herdr";
import { linkTarget } from "./state.js";

const MOD = "mods/my-files";
const CACHE = `${MOD}/.cache`;

const PREVIEW = {
  md: "md", markdown: "md", mdx: "md",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", tif: "image", tiff: "image", ico: "image", svg: "image",
  html: "look", htm: "look", xhtml: "look", pdf: "look", rtf: "look",
  doc: "look", docx: "look", xls: "look", xlsx: "look", ppt: "look", pptx: "look", key: "look", pages: "look", numbers: "look",
};
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

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

const extOf = (path) => (path?.includes(".") ? path.split(".").pop().toLowerCase() : "");
const kindOf = (path) => PREVIEW[extOf(path)] ?? null;

let appliedSelection = null;
let syncingSelection = false;

function selectionOverlayColor(bg, sel) {
  if (!bg || !sel || bg.length < 7 || sel.length < 7) return "#6087b359";
  const a = 0x59 / 255;
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  const unblend = (i) => Math.max(0, Math.min(255, Math.round((ch(sel, i) - (1 - a) * ch(bg, i)) / a))).toString(16).padStart(2, "0");
  return `#${unblend(1)}${unblend(3)}${unblend(5)}59`;
}

export function syncSelectionTheme(t, cx) {
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

function makeEditor(path, text) {
  const t = theme(), ext = extOf(path);
  const value = text.length > 400000 ? `${text.slice(0, 400000)}\n…` : text;
  return EditorState.new({
    language: LANG[ext] ?? (ext || "txt"), readonly: true, value,
    font_family: settings().font_family, font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
  });
}

export class FilePreview {
  constructor({ file, on, openTab }) {
    this.file = file;
    this.on = on ?? null;
    this.openTab = openTab;
    this.kind = kindOf(file);
    this.pref = "preview";
    this.mode = null;
    this.code = null;
    this.asset = null;
    this.text = null;
    this.mermaid = null;
    this.error = null;
    this.width = 368;
    this.seq = 0;
  }

  async fetchContent(seq) {
    if (this.mode === "source") await this.loadSource(seq);
    else if (this.kind === "md") await this.loadMarkdown(seq);
    else await this.loadAsset(seq);
  }

  load(cx) {
    this.code?.release();
    Object.assign(this, { code: null, asset: null, text: null, mermaid: null, error: null });
    this.mode = this.kind === "look" ? "preview" : !this.kind ? "source" : this.pref;
    const seq = ++this.seq;
    cx.spawn(async (cx) => {
      try { await this.fetchContent(seq); }
      catch (e) { if (this.seq === seq) this.error = e?.message || String(e); }
      finally { if (this.seq === seq) cx.notify(); }
    });
  }

  async loadSource(seq) {
    const text = await readTextFile(this.file, { on: this.on });
    if (this.seq !== seq) return;
    if (text === null) { this.error = "Cannot read"; return; }
    if (text.includes("\0")) { this.error = "Binary file"; return; }
    this.text = text;
    this.code = makeEditor(this.file, text);
  }

  async loadMarkdown(seq) {
    const text = await readTextFile(this.file, { on: this.on });
    if (this.seq !== seq) return;
    if (text === null) throw new Error("Cannot read");
    this.text = text;
    if (this.on || !/^\s*```mermaid\b/m.test(text)) return;
    const dir = `${appHome()}/${CACHE}`;
    const tmp = `${dir}/md-${Date.now()}.md`;
    await exec("sh", ["-c", 'mkdir -p "$1"', "md", dir]).catch(() => null);
    await writeTextFile(tmp, text, null);
    const rendered = await exec("mmd2txt", ["--md", tmp, "--max-width", "72"]).catch(() => null);
    await exec("rm", ["-f", tmp]).catch(() => null);
    if (rendered?.code === 0 && this.seq === seq) this.mermaid = rendered.stdout;
  }

  async loadAsset(seq) {
    const r = await exec("sh", ["-c", ASSET, "asset", `${appHome()}/${MOD}`, this.file, this.kind], { on: this.on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot preview");
    if (r.stdout.trim() === "cannot-preview") throw new Error("Cannot preview");
    const [rel, w, h] = r.stdout.trim().split("\t");
    if (this.seq !== seq) return;
    this.asset = { path: `${MOD}/${rel}`, w: Number(w) || 800, h: Number(h) || 600 };
  }

  openLink(url, cx) {
    const target = linkTarget(this.file, url);
    if (target === null) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) exec("open", [url]);
      return;
    }
    this.openTab(target, cx);
  }

  body(t) {
    if (this.error) return div().p(12).text_color(t.dim).child(this.error);
    if (this.mode === "source" || !this.kind) {
      return this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("Loading…");
    }
    if (this.kind === "md") {
      if (!this.text) return div().p(12).text_color(t.dim).child("Loading…");
      return v_flex().id("md-preview").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14)
        .child(TextView.markdown(`md-${this.file}`, this.mermaid ?? this.text).selectable(true).on_link_click((url, cx) => this.openLink(url, cx)));
    }
    if (!this.asset) return div().p(12).text_color(t.dim).child("Loading…");
    const w = Math.max(80, this.width - 28), h = Math.round((w * this.asset.h) / this.asset.w);
    return v_flex().id("asset-preview").flex_1().min_h(0).overflow_y_scrollbar().p(12)
      .child(image(this.asset.path).w(w).h(h).flex_none());
  }

  render(t, cx, seg) {
    syncSelectionTheme(t, cx);
    const switchable = Boolean(this.kind) && this.kind !== "look";
    return v_flex().id("my-files").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(h_flex().id("file-tools").h(36).flex_none().px(10).gap(6).items_center().justify_end()
        .when(switchable, (el) => el.child(h_flex().gap(2).p(2).flex_none().rounded(7).border_1().border_color(t.border)
          .child(seg(t, this.mode === "preview", "Preview", (_e, cx) => { this.pref = "preview"; this.load(cx); cx.notify(); }))
          .child(seg(t, this.mode === "source", "Source", (_e, cx) => { this.pref = "source"; this.load(cx); cx.notify(); }))))
        .child(div().id("files-open").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Open in default app")
          .on_click(() => exec("open", [this.file]))
          .child(svg(`${MOD}/open.svg`).size(13))))
      .child(this.body(t));
  }
}
