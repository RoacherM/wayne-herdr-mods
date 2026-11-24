// Tab bar (cloned from tabs 0.1.12): publishes terminal program icons for the phone, remembers each
// tab's last-focused agent, resets icon on shell return, and mounts phones + files panel buttons.
// DESIGN.md「Herdr.app 里的界面」「图标跟着 Herdr.app」

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, terminals, run, openOverlay, theme, window, layout, settings, shared, setShared, checking } from "herdr";

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh", "elvish", "xonsh", "tcsh", "csh", "ksh"]);
const SHELL = { key: "shell", icon: "icons/shell.svg", tint: true, shell: true, agent: false };
const PROGRAMS = "wayne-herdr-mods.programs";

function publishPrograms() {
  const out = {};
  for (const t of terminals()) {
    const p = t?.program;
    if (typeof t?.address === "string" && !t.address.includes("/") && p?.key) {
      out[t.address] = { key: p.key, icon: p.icon ?? null, tint: Boolean(p.tint) };
    }
  }
  if (JSON.stringify(out) !== JSON.stringify(shared(PROGRAMS) ?? {})) setShared(PROGRAMS, out);
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function loadSavedPanels() {
  const raw = localStorage.getItem("panels");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function trafficLightsPadding(root, sidebar) {
  const w = window();
  if (w?.platform !== "macos" || w.titlebar !== "none" || w.fullscreen || !root?.traffic_lights) return 10;
  const sideW = sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0);
  return Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - sideW);
}

function tabStatusDot(status, t) {
  if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
  if (status === "blocked" || status === "done") return div().size(6).rounded(3).bg(t[status]);
  return null;
}

const stop = (_e, cx) => cx.stop_propagation();

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = loadSavedPanels() ?? {};
    this.used = {};
    if (checking()) return;
    publishPrograms();
    cx.timer.every(2000, () => publishPrograms());
  }

  lead(tab, front) {
    const mine = panes().filter((p) => p.tab === tab).map((p) => {
      const fg = front[p.terminal];
      return p.program?.agent && SHELLS.has(fg) ? { ...p, program: { ...SHELL, name: fg } } : p;
    });
    const now = mine.find((p) => p.focused);
    if (now?.program?.agent) this.used[tab] = now.pane;
    return mine.find((p) => p.pane === this.used[tab] && p.program?.agent) ?? mine.find((p) => p.program?.agent) ?? now ?? mine[0];
  }

  syncPanel(space, panel) {
    if (!space || !panel) return;
    const open = !panel.hidden;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!first || space.id in this.panels) {
        const stored = this.panels[space.id];
        const want = stored === true || stored === "files";
        if (want !== open) {
          this.pending = { want, until: Date.now() + 1000 };
          run(want ? "layout.show" : "layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== open && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === open) return;
    this.panels[space.id] = open;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  tabItem(c, i, space, shown, front, t) {
    const program = this.lead(c.id, front)?.program;
    const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
    const dot = tabStatusDot(c.status, t);
    const glyph = program?.icon
      ? (program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14))
      : null;
    return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
      .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
      .on_mouse_up("left", () => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === c.id) + 1 });
        else run("tab.select", { id: c.id });
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
      .when(Boolean(glyph), (el) => el.child(glyph))
      .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
      .when(Boolean(dot), (el) => el.child(dot))
      .when(c.active, (el) => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
        .child(svg("mods/pane/close.svg").size(12))));
  }

  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const front = Object.fromEntries(terminals().map((x) => [x.address, x.foreground?.name]));
    const root = layout(), sidebar = findNode(root, "sidebar"), panel = findNode(root, "panel");
    this.syncPanel(space, panel);
    const panelOpen = Boolean(panel && !panel.hidden);
    const iconBtn = (id, glyph, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(glyph);
    return h_flex().size_full().min_w(0).px(10).pl(trafficLightsPadding(root, sidebar)).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .children(shown.map((c, i) => this.tabItem(c, i, space, shown, front, t))))
      .child(iconBtn("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(iconBtn("phones", svg("mods/wayne-phones/phone.svg").size(15), () => run("mod.open", { name: "wayne-phones" })))
      .child(div().id("panel-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .bg(panelOpen ? t.selected : t.chrome).text_color(panelOpen ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => run(panelOpen ? "layout.hide" : "layout.show", { id: "panel" }))
        .child(svg("mods/my-tabs/panel-right.svg").size(15)));
  }
}
