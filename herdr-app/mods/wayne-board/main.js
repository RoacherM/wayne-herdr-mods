// wayne-board (wayne-herdr-mods in Herdr.app): the agent of the window you are in, its decisions and its
// sub-agents, as one picture drawn like a git graph. A side panel beside the terminals (the layout's `board` slot); the board
// icon in the tab bar (mods/my-tabs) opens and closes it. DESIGN.md「观测面板」.
// Written by `wayne-herdr-mods install` from the repo's herdr-app/; edits here are replaced on the next install.
//
// The picture is not worked out here. wayne-herdr-mods (the host) watches herdr-core and keeps
// ~/.config/wayne-herdr-mods/board.json; this mod reads that file once a second and draws it.
// Where each row and line goes is layout.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, theme, run, readTextFile, focused } from "herdr";
import { layout, laneOf, tally, SIZE } from "./layout.js";

const FILE = () => `${home()}/.config/wayne-herdr-mods/board.json`;
const FAILED = "#e5675f"; // the theme has no color for "failed"

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function span(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1 分";
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}
const flat = (subs) => subs.flatMap((s) => [s, ...flat(s.subs)]);
const LINE = 1.5;
const railX = (rail) => SIZE.pad + 6 + rail * SIZE.rail; // the middle of a rail

export default class Board extends View {
  init(_props, cx) {
    this.board = null;      // board.json as the host last wrote it
    this.raw = "";
    this.missing = false;   // no file: the host never ran
    this.flipped = new Set(); // decisions the person opened or folded
    this.closed = false;
    this.terminal = null;   // the terminal last in focus: a click on this panel or a file tab does not empty it
    cx.spawn(async (cx) => {
      let drawn = -1;
      while (!this.closed) {
        const changed = (await this.load()) | this.follow();
        const tick = Math.floor(Date.now() / 30000); // the "12 分" on a running block moves on its own
        if (changed || tick !== drawn) { drawn = tick; cx.notify(); }
        await new Promise((r) => cx.timer.after(1000, () => r()));
      }
    });
  }

  async close() { this.closed = true; }

  /** Take the focused pane's terminal; true when it is another one than before. */
  follow() {
    const now = focused()?.terminal ?? null;
    if (!now || now === this.terminal) return false;
    this.terminal = now;
    return true;
  }

  async load() {
    let text = null;
    try { text = await readTextFile(FILE()); } catch { return false; }
    const missing = text === null;
    if (missing === this.missing && (text ?? "") === this.raw) return false;
    this.missing = missing; this.raw = text ?? "";
    try { this.board = text ? JSON.parse(text) : null; } catch { /* caught mid-write: keep the last one */ }
    return true;
  }

  // One color per state, the same on a stop, on the word beside it and in the counts:
  // waiting for the person, at work, failed, ended well. A line that carries nothing any more is grey.
  color(t, status) {
    return status === "blocked" || status === "error" ? t.blocked : status === "working" ? t.working : status === "failed" ? FAILED : status === "done" ? t.done : t.dim;
  }

  /** "1 等你 · 2 在跑 · 1 失败 · 3 完成", each count in its state's color, as a row of pieces after `lead`. */
  counts(t, n, lead = [], tail = []) {
    const parts = [...lead.map((x) => [x, t.dim]), ...[["blocked", "等你"], ["working", "在跑"], ["failed", "失败"], ["done", "完成"]].filter(([k]) => n[k]).map(([k, w]) => [`${n[k]} ${w}`, this.color(t, k)]), ...tail.map((x) => [x, t.dim])];
    const piece = (text, color) => div().flex_none().text_color(color).child(text);
    return h_flex().min_w(0).overflow_hidden().text_size(11.5).gap(5).children(parts.flatMap(([text, color], i) => (i ? [piece("·", t.dim), piece(text, color)] : [piece(text, color)])));
  }

  // A row: its words start right of its stop and reach the panel's right edge. The first line is 16 high
  // and starts 7 down, so its middle is the stop's height (SIZE.dotY).
  row(t, r) {
    return v_flex().id(r.key).absolute().left(railX(r.rail) + 12).right(8).top(r.y).h(r.h).pt(7).px(6).rounded(7).overflow_hidden();
  }
  first() { return h_flex().h(16).flex_none().gap(7).items_center(); }
  small(t) { return div().truncate().text_size(11.5).text_color(t.dim); }

  // A stop: a disc in the panel's color that cuts the line, with the mark of the row on it.
  stop(t, r, mark) {
    return div().absolute().left(railX(r.rail) - 8).top(r.y + SIZE.dotY - 8).size(16).rounded(8).bg(t.background).flex().items_center().justify_center().child(mark);
  }
  disc(size, color) { return div().size(size).rounded(size / 2).bg(color); }
  ring(t, size, color) { return div().size(size).rounded(size / 2).border(1.5).border_color(color).bg(t.background); }
  spinner(t) { return svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900); }

  head(t, r, now) {
    const l = r.lane, live = !l.ended, n = tally(flat(l.steps.flatMap((s) => s.subs)).filter((s) => !s.ended));
    const state = n.blocked || l.state === "blocked" ? "blocked" : live && (n.working || l.state === "working") ? "working" : "idle";
    return [
      this.row(t, r)
        .child(this.first().child(div().flex_1().min_w(0).truncate().text_size(13).text_color(live ? t.foreground : t.muted).child(l.where ?? l.cwd?.split("/").pop() ?? l.t)).child(div().flex_none().text_size(11.5).text_color(t.dim).child(l.t)))
        .child(this.counts(t, live ? n : {}, [l.app ?? "agent"], [live ? `已 ${span(now - l.since)}` : `已结束 ${hhmm(l.ended)}`]).mt(2)),
      this.stop(t, r, state === "working" ? this.spinner(t) : state === "blocked" ? this.disc(10, t.blocked) : this.ring(t, 10, live ? t.foreground : t.dim)),
    ];
  }

  decision(t, r) {
    const s = r.step, mine = s.by === "you";
    const who = mine ? "你" : s.by === "agent" ? "agent" : "开始";
    return [
      this.row(t, r).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.flip(r.key, cx))
        .child(this.first().text_size(11.5).child(div().text_color(mine ? t.accent : t.dim).child(who)).child(div().text_color(t.dim).child(hhmm(s.at))))
        .child(r.open
          ? div().h(36).overflow_hidden().text_color(t.foreground).child(s.text || "开始工作")
          : div().truncate().text_color(t.muted).child(s.text || "开始工作")),
      // What the person said is a full stop in the accent color; what the agent decided is a ring.
      this.stop(t, r, mine ? this.disc(9, t.accent) : s.by === "agent" ? this.ring(t, 9, t.muted) : this.disc(5, t.dim)),
    ];
  }

  agent(t, r, now) {
    const s = r.sub, status = s.state;
    const say = s.ended ? `${s.state === "failed" ? "失败" : "完成"} ${span(s.ended - s.since)}` : status === "blocked" || status === "error" ? "等你" : status === "working" ? span(now - s.since) : "空闲";
    const under = [s.app, s.kind === "term" ? s.id : null, !s.ended && s.msg ? s.msg : null].filter(Boolean).join(" · ");
    const live = !s.ended && (status === "working" || status === "blocked" || status === "error");
    const mark = s.ended ? this.disc(status === "failed" ? 8 : 7, this.color(t, status === "failed" ? "failed" : "done")) : status === "working" ? this.spinner(t) : live ? this.disc(8, t.blocked) : this.ring(t, 8, t.dim);
    return [
      this.row(t, r)
        .when(s.kind === "term" && !s.ended, (el) => el.hover((st) => st.bg(t.hover)).on_click(() => run("terminal.peek", { terminal: s.id })))
        .child(this.first().child(div().flex_1().min_w(0).truncate().text_color(s.ended ? t.muted : t.foreground).child(s.title)).child(div().flex_none().text_size(11.5).text_color(live || s.ended ? this.color(t, s.ended && status !== "failed" ? "done" : status) : t.dim).child(say)))
        .child(this.small(t).child(under || (s.kind === "term" ? "终端里的 agent" : "进程内的子 agent"))),
      this.stop(t, r, mark),
    ];
  }

  pile(t, r) {
    return [
      this.row(t, r).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.flip(r.key.replace(/\/pile$/, ""), cx))
        .child(this.first().child(this.counts(t, r.tally, [`${r.count} 个子 agent`]))),
      this.stop(t, r, this.ring(t, 7, t.dim)),
    ];
  }

  flip(key, cx) {
    if (this.flipped.has(key)) this.flipped.delete(key); else this.flipped.add(key);
    cx.notify();
  }

  // A line down a rail, or the bend that takes a branch one rail to the right. At work: dashed.
  wire(t, w) {
    const color = w.status === "spine" ? t.muted : w.status === "done" ? t.dim : this.color(t, w.status);
    const el = w.kind === "line"
      ? div().absolute().left(railX(w.rail) - LINE / 2).top(w.y).w(0).h(w.h).border_l(LINE)
      : div().absolute().left(railX(w.rail) + LINE / 2).top(w.y - SIZE.bend).w(SIZE.rail).h(SIZE.bend).border_b(LINE).border_r(LINE).rounded_br(SIZE.bend);
    return el.border_color(color).when(w.status === "working", (e) => e.border_dashed());
  }

  render() {
    const t = theme(), now = Date.now();
    this.follow();
    const page = v_flex().size_full().bg(t.background).text_color(t.foreground).text_size(12.5);
    const lane = laneOf(this.board, this.terminal);
    if (!lane) {
      const [say, why] = this.missing ? ["还没有数据", "wayne-herdr-mods 没在运行，或者还没写过 board.json。运行 wayne-herdr-mods status 看一下。"]
        : this.terminal ? ["这个窗口里没有 agent", "agent 报告状态后，它的决定和子 agent 会出现在这里。"]
        : ["点一个终端窗口", "这里显示那个窗口里的 agent。"];
      return page.items_center().justify_center().gap(6).px(20)
        .child(div().text_color(t.muted).child(say))
        .child(div().text_size(11.5).text_color(t.dim).child(why));
    }
    const { rows, wires, height } = layout(lane, this.flipped);
    // Finished lines first, so the ones at work are drawn over them where they meet.
    const live = (w) => Number(w.status === "working" || w.status === "blocked");
    const lines = [...wires].sort((a, b) => live(a) - live(b));
    const draw = (r) => (r.kind === "head" ? this.head(t, r, now) : r.kind === "dec" ? this.decision(t, r) : r.kind === "agent" ? this.agent(t, r, now) : this.pile(t, r));
    return page
      .child(div().id("board-scroll").size_full().overflow_y_scrollbar()
        .child(div().relative().flex_none().w_full().h(height)
          .children(lines.map((w) => this.wire(t, w)))
          .children(rows.flatMap(draw))));
  }
}
