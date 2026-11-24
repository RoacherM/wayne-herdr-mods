// Pane header (cloned from pane 0.1.13): hides zoom when lone; file tabs show filename + folder.
// DESIGN.md「文件面板：每个窗格一份，文件开成 Herdr 标签」

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, shared } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint
    ? svg(p.icon).size(size).flex_none().text_color(color)
    : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(`${h}/`) ? `~${cwd.slice(h.length)}` : cwd;
}

function paneMeta(p, t) {
  const file = p.mod === "my-files" ? shared("my-files/tabs")?.[p.tab]?.file : null;
  if (file) {
    return {
      name: file.split("/").pop(),
      cwd: file.slice(0, file.lastIndexOf("/")),
      pic: svg("mods/files/file.svg").size(14).flex_none().text_color(t.dim),
    };
  }
  const name = p.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
  return { name, cwd: p.cwd, pic: icon(p.program, 14, t.dim) };
}

export default class Pane extends View {
  init() { this.hovered = false; }

  button(t, id, glyph, command, args) {
    return div()
      .id(id).p(3).rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/pane/${glyph}.svg`).size(14));
  }

  render() {
    const t = theme();
    const all = panes();
    const p = all.find((q) => q.pane === props()?.pane);
    if (!p) return div();
    const { name, cwd, pic } = paneMeta(p, t);
    const alone = !p.zoomed && all.filter((q) => q.tab === p.tab).length < 2;
    const { status: st, pane } = p;
    return h_flex()
      .id(`pane-head-${pane}`).size_full().px(10).gap(8).items_center()
      .bg(t.background).border_b(1).border_color(t.border).text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(cwd)))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked" || st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t[st])))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .when(!alone, (el) => el.child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane })))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
