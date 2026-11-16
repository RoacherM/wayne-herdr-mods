// wayne-board: Thin GPUI renderer over canonical `shared/board.js` (DESIGN.md「观测面板」).

import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, theme, readTextFile, focused, terminals } from "herdr";
import { layoutMetro, laneOf, SIZE } from "../../../shared/board.js";

const MOD = "mods/wayne-board";
const FILE = () => `${home()}/.config/wayne-herdr-mods/board.json`;
const FAILED = "#e5675f";
const ICON_PATH = {
  fork: `${MOD}/fork.svg`,
  merge: `${MOD}/merge.svg`,
  fail: `${MOD}/fail.svg`,
  arrow: `${MOD}/arrow.svg`,
  stop: "mods/my-pane/close.svg",
};
const TONE_KEY = { working: "working", accent: "accent", warn: "blocked", ok: "ansi2", fg: "foreground" };

const paletteOf = (t) => [t.ansi4, t.ansi5, t.ansi2, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi13];
const pickRail = (pal, idx, fallback) => (idx >= 0 ? pal[idx % pal.length] : fallback);
const rowIcon = (name, color) => svg(ICON_PATH[name] || `${MOD}/${name}.svg`).size(12).flex_none().text_color(color);

function toneColor(t, pal, tone, colorIdx, mutedFallback = t.muted) {
  if (tone === "rail") return pickRail(pal, colorIdx, t.accent);
  if (tone === "bad") return FAILED;
  const key = TONE_KEY[tone];
  return key ? t[key] : mutedFallback;
}

function makePathBuckets() {
  const buckets = new Map();
  const get = (color, dashed = false) => {
    const key = `${color}|${dashed ? 1 : 0}`;
    if (!buckets.has(key)) {
      const p = dashed ? PathBuilder.stroke(1.75).dash_array([3.5, 3]) : PathBuilder.stroke(1.75);
      buckets.set(key, { p, color });
    }
    return buckets.get(key).p;
  };
  return { buckets, get };
}

function addTrunkAndThru(r, t, pal, get) {
  if (r.trunkTop) get(t.border).move_to(SIZE.railLeft, 0).line_to(SIZE.railLeft, r.dotY);
  if (r.trunkBottom) get(t.border).move_to(SIZE.railLeft, r.dotY).line_to(SIZE.railLeft, r.h);
  for (const seg of r.thru) {
    const y0 = seg.part === "bottom" ? r.dotY : 0;
    const y1 = seg.part === "top" ? r.dotY : r.h;
    get(toneColor(t, pal, seg.tone, seg.colorIdx), seg.dashed).move_to(seg.x, y0).line_to(seg.x, y1);
  }
}

function addCurvesAndBridge(r, t, pal, get) {
  for (const c of r.curves) {
    const col = toneColor(t, pal, c.tone, c.colorIdx, t.accent);
    get(col, c.dashed).move_to(c.x0, 0).cubic_bezier_to(c.x1, r.dotY, c.x0, r.dotY * 0.72, c.x1, r.dotY * 0.28);
  }
  const b = r.bridge;
  if (!b || b.x0 === b.x1) return null;
  const col = pickRail(pal, b.colorIdx, t.accent);
  get(col).move_to(b.x0, r.dotY).line_to(b.tip - b.dir * 4.5, r.dotY);
  const poly = PathBuilder.fill()
    .add_polygon([[b.tip, r.dotY], [b.tip - b.dir * 5.5, r.dotY - 3.5], [b.tip - b.dir * 5.5, r.dotY + 3.5]], true)
    .build();
  return { path: poly, color: col };
}

function buildRowPaths(r, t, pal) {
  const { buckets, get } = makePathBuckets();
  addTrunkAndThru(r, t, pal, get);
  const arrow = addCurvesAndBridge(r, t, pal, get);
  const painted = [...buckets.values()].map(({ p, color }) => ({ path: p.build(), color }));
  if (arrow) painted.push(arrow);
  return painted;
}

function stationMark(t, pal, station) {
  const col = toneColor(t, pal, station.tone, station.colorIdx);
  if (station.shape === "spin") return svg("mods/workspace-chrome/spinner.svg").size(11).text_color(col).spin(900);
  if (station.shape === "solid") return div().size(7.5).rounded(4).bg(col);
  return div().size(7.5).rounded(4).border(1.8).border_color(col).bg(t.background);
}

function gutterCell(t, pal, r, gutterW) {
  const paths = buildRowPaths(r, t, pal);
  const b = r.bridge;
  const hasBridge = Boolean(b && b.x0 !== b.x1);
  const halo = r.station.shape === "spin" ? 13 : 10;
  return div().relative().flex_none().w(gutterW).h(r.h).overflow_hidden()
    .children(paths.map(({ path, color }) => globalThis.window.paint_path(path, color).absolute().left(0).top(0).size_full()))
    .when(hasBridge, (el) => el.child(div().absolute().left(b.x0 - 2.5).top(r.dotY - 2.5).size(5).rounded(2.5).bg(pickRail(pal, b.colorIdx, t.accent))))
    .child(div().absolute().left(r.x - halo / 2).top(r.dotY - halo / 2).size(halo).rounded(halo / 2).bg(t.background).flex().items_center().justify_center().child(stationMark(t, pal, r.station)));
}

function messageHeadlineView(t, pal, h) {
  return h_flex().h(16).items_center().gap(4).min_w(0)
    .child(div().truncate().text_size(11.8).text_color(t.foreground).child(h.from))
    .child(rowIcon("arrow", pickRail(pal, h.colorIdx, t.accent)))
    .child(div().flex_1().min_w(0).truncate().text_size(11.8).text_color(t.foreground).child(h.to))
    .child(div().flex_none().text_size(10.5).text_color(t.dim).child(h.right));
}

function rowHeadline(t, pal, r) {
  const h = r.headline;
  if (h.kind === "message") return messageHeadlineView(t, pal, h);
  const titleCol = toneColor(t, pal, h.titleTone, r.colorIdx);
  const rightCol = toneColor(t, pal, h.rightTone, r.colorIdx, t.dim);
  return h_flex().h(16).items_center().gap(5).min_w(0)
    .when(Boolean(h.icon), (el) => el.child(rowIcon(h.icon, toneColor(t, pal, h.iconTone, r.colorIdx))))
    .child(div().flex_1().min_w(0).truncate().text_size(12).when(h.bold, (e) => e.font_semibold()).text_color(titleCol).child(h.title))
    .when(Boolean(h.right), (el) => el.child(div().flex_none().text_size(10.5).text_color(rightCol).child(h.right)));
}

function progGlyph(prog, t) {
  if (!prog?.icon) return null;
  return prog.tint ? svg(prog.icon).size(14).flex_none().text_color(t.muted) : image(prog.icon).size(14).flex_none();
}

export default class Board extends View {
  init(_props, cx) {
    this.board = null;
    this.raw = "";
    this.openIds = new Set();
    this.closed = false;
    this.terminal = null;
    cx.spawn(async (cx) => {
      while (!this.closed) {
        const changed = (await this.load()) | this.follow();
        const lane = laneOf(this.board, this.terminal);
        if (changed || (lane && !lane.ended)) cx.notify();
        await new Promise((r) => cx.timer.after(1000, () => r()));
      }
    });
  }

  async close() { this.closed = true; }

  follow() {
    const now = focused()?.terminal ?? null;
    if (!now || now === this.terminal) return false;
    this.terminal = now;
    this.openIds.clear();
    return true;
  }

  async load() {
    let text = null;
    try { text = await readTextFile(FILE()); } catch { return false; }
    const nextRaw = text || "";
    if (nextRaw === this.raw) return false;
    this.raw = nextRaw;
    if (!text) { this.board = null; return true; }
    try { this.board = JSON.parse(text); } catch { /* ignore partial read */ }
    return true;
  }

  toggleRow(id, cx) {
    if (this.openIds.has(id)) this.openIds.delete(id);
    else this.openIds.add(id);
    cx.notify();
  }

  headerView(t, hdr) {
    const prog = terminals().find((x) => x.address === hdr.address)?.program;
    const glyph = progGlyph(prog, t);
    const badge = hdr.badge;
    return h_flex().h(38).flex_none().px(12).gap(7).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(glyph), (el) => el.child(glyph))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).text_color(hdr.muted ? t.muted : t.foreground).child(hdr.title))
      .when(badge.kind === "blocked", (el) => el.child(h_flex().flex_none().items_center().gap(3).child(div().size(6).rounded(3).bg(t.blocked)).child(div().text_size(11).text_color(t.blocked).child(String(badge.count)))))
      .when(badge.kind === "running", (el) => el.child(h_flex().flex_none().items_center().gap(3).child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working).spin(900)).child(div().text_size(11).text_color(t.working).child(String(badge.count)))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(hdr.address));
  }

  rowView(t, pal, r, gutterW) {
    return h_flex().id(`row-${r.id}`).w_full().h(r.h).flex_none().items_start()
      .when(r.expandable, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleRow(r.id, cx)))
      .child(gutterCell(t, pal, r, gutterW))
      .child(v_flex().flex_1().min_w(0).h_full().pr(10).pt(7).gap(2).overflow_hidden()
        .child(rowHeadline(t, pal, r))
        .when(Boolean(r.subline), (el) => el.child(div().truncate().text_size(11).text_color(toneColor(t, pal, r.subline.tone, r.colorIdx, t.dim)).child(r.subline.text)))
        .when(Boolean(r.expanded && r.detail), (el) => el.child(v_flex().mt(4).p(6).rounded(6).bg(t.raised).border_1().border_color(t.border).overflow_hidden().child(div().text_size(11.2).text_color(t.foreground).overflow_hidden().child(r.detail)))));
  }

  render() {
    const t = theme();
    this.follow();
    const lane = laneOf(this.board, this.terminal);
    const frame = v_flex().id("wayne-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground);
    if (!lane) return frame.child(v_flex().flex_1().items_center().justify_center().child(svg(`${MOD}/board.svg`).size(22).text_color(t.dim).opacity(0.32)));
    const pal = paletteOf(t);
    const { header, rows, gutterW } = layoutMetro(lane, { openIds: this.openIds, now: Date.now() });
    return frame
      .child(this.headerView(t, header))
      .child(v_flex().id("board-scroll").flex_1().min_h(0).w_full().py(4).overflow_y_scrollbar().children(rows.map((r) => this.rowView(t, pal, r, gutterW))));
  }
}
