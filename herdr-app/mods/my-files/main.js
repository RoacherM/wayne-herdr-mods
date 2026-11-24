// Per-pane file tree panel; clicking a file opens it as a Herdr tab (FilePreview in ./preview.js).
// DESIGN.md「文件面板：每个窗格一份，文件开成 Herdr 标签」

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, props, exec, run, shared, setShared, watchFolder, theme, openOverlay, closeOverlay, checking } from "herdr";
import { locate, FILE_TABS, withFileTab, fileTabOf, newTabId } from "./state.js";
import { FilePreview } from "./preview.js";

const MOD = "mods/my-files";
const PER_FOLDER = 500, TOTAL = 5000;
const DIR_SCRIPT = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';

const baseName = (path) => path?.split("/").pop() ?? "";
const openedTab = (tab) => (tab ? shared(FILE_TABS)?.[tab] : null) ?? null;
const allTabs = () => new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
const shownTabs = () => (spaces().find((s) => s.active)?.tabs ?? []).map((t) => t.id);

function location() {
  const focus = focused();
  return locate({ file: props()?.file, fileOn: props()?.on, space: spaces().find((s) => s.active), focus, panes: panes(), opened: openedTab(focus?.tab) });
}

async function listDir(path, on) {
  const r = await exec("sh", ["-c", DIR_SCRIPT, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

async function readGitMarks(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  if (top?.code !== 0) return {};
  const st = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
  if (st?.code !== 0) return {};
  const root = top.stdout.trim(), marks = {};
  for (const entry of st.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
    const xy = entry.slice(0, 2);
    marks[`${root}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
  }
  return marks;
}

function openFileTab(absPath, place, cx) {
  const had = fileTabOf(shared(FILE_TABS), absPath, new Set(shownTabs()));
  if (had) { run("tab.select", { id: had }); return; }
  const before = new Set(shownTabs());
  run("tab.new", { name: baseName(absPath), mod: "my-files", props: { file: absPath, ...(place.on ? { on: place.on } : {}) } });
  let tries = 0;
  const remember = (cx) => {
    const id = newTabId(before, shownTabs());
    if (!id) { if (++tries < 20) cx.timer.after(50, remember); return; }
    setShared(FILE_TABS, withFileTab(shared(FILE_TABS), id, { file: absPath, ...place }, allTabs()));
    run("tab.move", { id, index: shownTabs().length });
  };
  remember(cx);
}

function seg(t, active, label, action) {
  return div().id(`seg-${label}`).px(8).h(20).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
    .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted)
    .on_click(action).child(label);
}

function menuView(menu, t) {
  const close = () => closeOverlay(props().overlay);
  const item = (id, icon, label, action) => h_flex().id(id).h(30).px(8).gap(8).rounded(6).items_center().cursor_pointer()
    .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(action)
    .child(svg(`${MOD}/${icon}.svg`).size(13).flex_none().text_color(t.muted))
    .child(div().flex_1().child(label));
  return v_flex().id("my-files-menu").w_full().p(5).bg(t.popover).text_size(12.5)
    .child(item("menu-copy-path", "path", "Copy path", (_e, cx) => { cx.write_to_clipboard(menu.absPath); close(); }))
    .child(item("menu-open", "open", "Open in default app", () => { close(); exec("open", [menu.absPath]); }));
}

export default class MyFiles extends View {
  init(_props, cx) {
    const p = props();
    if (p?.menu) return;
    if (p?.file) {
      this.viewer = new FilePreview({
        file: p.file,
        on: p.on,
        openTab: (target, cx) => this.openRelativeLink(p, target, cx),
      });
      if (!checking()) this.viewer.load(cx);
      return;
    }
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.onlyChanged = false;
    this.hovered = null;
    this.copied = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  openRelativeLink(p, target, cx) {
    const o = openedTab(focused()?.tab);
    const dir = p.file.slice(0, p.file.lastIndexOf("/"));
    const abs = target.startsWith("/") ? target : `${dir}/${target}`;
    openFileTab(abs, { root: o?.root ?? dir, on: p.on ?? null, from: o?.from ?? null }, cx);
  }

  current(context) { return this.context === context && JSON.stringify(location()) === context.key; }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  async loadFolder(path, context) {
    const entries = await listDir(path ? `${context.cwd}/${path}` : context.cwd, context.on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    const kept = entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    this.entries.set(path, kept);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  switchContext(loc, next) {
    if (this.context) this.saved.set(this.context.key, { folders: this.folders });
    const saved = this.saved.get(next);
    this.context = { key: next, cwd: loc.cwd, on: loc.on };
    this.root = loc.cwd;
    this.on = loc.on;
    this.entries = new Map();
    this.folders = new Set(saved?.folders);
    this.pending = new Set();
    this.marks = {};
    this.watched = null;
    this.error = null;
    this.limited = false;
    this.loading = false;
  }

  refresh(cx) {
    const loc = location(), next = JSON.stringify(loc);
    if (next !== this.context?.key) this.switchContext(loc, next);
    if (!loc.cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const marks = await readGitMarks(loc.cwd, loc.on);
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(loc.cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const f of this.folders) if (f === path || f.startsWith(`${path}/`)) { this.folders.delete(f); this.entries.delete(f); }
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

  copyBtn(pid, absPath, t) {
    const copied = this.copied === pid;
    return div().id(pid).size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(copied ? t.ansi2 : t.dim).hover((s) => s.bg(t.hover).text_color(copied ? t.ansi2 : t.foreground))
      .tooltip(copied ? "Copied" : "Copy path")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.write_to_clipboard(absPath);
        this.copied = pid;
        cx.notify();
        cx.timer.after(1200, (cx) => { if (this.copied === pid) { this.copied = null; cx.notify(); } });
      })
      .child(svg(`${MOD}/${copied ? "check" : "path"}.svg`).size(13));
  }

  row(entry, path, depth, t, shown) {
    const absPath = `${this.root}/${path}`;
    const open = this.folders.has(path), mark = this.marks[absPath];
    const here = !entry.dir && shown === absPath;
    const pid = `tree-path:${path}`;
    const markColor = mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked;
    return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .when(here, (el) => el.bg(t.selected)).hover((s) => s.bg(here ? t.selected : t.hover))
      .on_hover((on, cx) => {
        if (on) this.hovered = path;
        else if (this.hovered === path) this.hovered = null;
        cx.notify();
      })
      .on_click((_e, cx) => {
        if (entry.dir) this.toggle(path, cx);
        else openFileTab(absPath, { root: this.root, on: this.on, from: location().pane }, cx);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "my-files", kind: "popup", width: 196, height: 72, props: { menu: { absPath } } });
      })
      .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(entry.name))
      .when(this.hovered === path || this.copied === pid, (el) => el.child(this.copyBtn(pid, absPath, t)))
      .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(markColor).child(mark)));
  }

  isVisible(entry, path) {
    if (!this.onlyChanged) return true;
    const prefix = `${this.root}/${path}`;
    return entry.dir
      ? Object.keys(this.marks).some((p) => p.startsWith(`${prefix}/`))
      : Boolean(this.marks[prefix]);
  }

  rows(prefix, depth, out, t, shown = openedTab(focused()?.tab)?.file ?? null) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!this.isVisible(entry, path)) continue;
      out.push(this.row(entry, path, depth, t, shown));
      if (entry.dir && this.folders.has(path)) this.rows(path, depth + 1, out, t, shown);
    }
    return out;
  }

  render(cx) {
    const t = theme(), menu = props()?.menu;
    if (menu) return menuView(menu, t);
    if (this.viewer) return this.viewer.render(t, cx, seg);
    if (!checking() && JSON.stringify(location()) !== this.context?.key) this.refresh(cx);
    const empty = this.error || (this.loading ? "Loading…" : !this.root ? "No folder" : this.onlyChanged ? "No changes" : "No files");
    return v_flex().id("my-files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().id("my-files-head").h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().truncate().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(baseName(this.root))))
      .child(h_flex().h(30).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(seg(t, !this.onlyChanged, "All", (_e, cx) => { this.onlyChanged = false; cx.notify(); }))
        .child(seg(t, this.onlyChanged, "Changed", (_e, cx) => { this.onlyChanged = true; cx.notify(); })))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(empty)))
        .when(this.limited, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("Truncated (5,000 max)"))));
  }
}
