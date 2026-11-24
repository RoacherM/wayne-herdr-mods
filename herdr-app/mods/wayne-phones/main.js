// wayne-phones: paired iPhones, QR/SAS pairing, and voice API key dialog (`mod.open wayne-phones`).
// Talks to the running host through `wayne-herdr-mods ctl <method> <json>`. DESIGN.md「电脑上的确认」

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { exec, home, appHome, theme, notify, checking } from "herdr";
import * as fs from "fs/promises";

const BIN = () => `${home()}/.local/bin/wayne-herdr-mods`;
const QR_DIR = "data/wayne-phones";

async function ctl(method, params = {}) {
  const r = await exec(BIN(), ["ctl", method, JSON.stringify(params)]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `ctl ${method}: exit ${r.code}`);
  return JSON.parse(r.stdout);
}

function ago(ms) {
  if (!ms) return "从未连接";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function statusSummary(v) {
  const relayOk = v.relay === "online", coreOk = v.core === "online";
  if (relayOk && coreOk) return { ok: true, text: `在线 · ${v.terminals} 个终端` };
  const parts = [relayOk ? null : `中继 ${v.relay}`, coreOk ? null : `core ${v.core}`, `${v.terminals} 个终端`].filter(Boolean);
  return { ok: false, text: parts.join(" · ") };
}

export default class Phones extends View {
  init(_props, cx) {
    this.v = null;
    this.error = "";
    this.busy = "";
    this.qr = null;
    this.removing = null;
    this.known = null;
    this.closed = false;
    this.keyInput = InputState.new({ placeholder: "火山引擎 API Key" });
    this.keyInput.set_masked(true);
    this.changingKey = false;
    this.heard = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      try { await this.show(await ctl("status")); } catch (e) { this.error = e.message; }
      cx.notify();
      while (!this.closed) {
        try {
          await this.show(await ctl("watch", { ms: 20000 }));
          this.error = "";
        } catch (e) {
          this.error = e.message;
          this.v = null;
          await new Promise((r) => cx.timer.after(3000, () => r()));
        }
        if (this.closed) return;
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
    if (this.v?.pairing?.offer && !this.v?.pairing?.request) await ctl("pair.cancel").catch(() => {});
  }

  async syncQr(offer) {
    if (!offer) { this.known = null; this.qr = null; return; }
    if (!offer.qrSvg || this.qr?.link === offer.link) return;
    const dir = `${appHome()}/${QR_DIR}`;
    await fs.mkdir(dir, { recursive: true });
    const old = await fs.readdir(dir).catch(() => null);
    if (old) for (const f of old) if (f.endsWith(".svg")) await fs.unlink(`${dir}/${f}`).catch(() => {});
    const name = `qr-${offer.expiresAt}.svg`;
    await fs.writeFile(`${dir}/${name}`, offer.qrSvg);
    this.qr = { link: offer.link, path: `${QR_DIR}/${name}` };
  }

  async show(v) {
    const added = this.known ? v.devices.find((d) => !this.known.has(d.id)) : null;
    if (added) {
      this.known = null;
      notify({ title: "已配对", body: added.name, level: "success" });
    }
    await this.syncQr(v.pairing.offer);
    this.v = v;
  }

  act(label, fn) {
    return (_e, cx) => {
      if (this.busy) return;
      this.busy = label;
      cx.notify();
      cx.spawn(async (cx) => {
        try { await fn(); this.error = ""; } catch (e) { this.error = e.message; }
        this.busy = "";
        cx.notify();
      });
    };
  }

  btn(id, label, kind, onClick) {
    const t = theme();
    const solid = kind === "primary";
    return h_flex().id(id).h(30).px(14).items_center().justify_center().rounded(8).border_1()
      .border_color(solid ? t.solid : t.input).bg(solid ? t.solid : t.raised)
      .text_color(solid ? t.solid_foreground : t.foreground).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(onClick).child(this.busy === id ? "…" : label);
  }

  render() {
    const t = theme();
    const v = this.v;
    const root = v_flex().id("wayne-phones").size_full().min_h(0).p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child("手机"));
    if (!v) return root.child(div().text_color(this.error ? t.blocked : t.muted).child(this.error || "读取中…"));

    const st = statusSummary(v);
    root.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
      .child(div().size(7).rounded_full().bg(st.ok ? t.done : t.blocked))
      .child(st.text));
    if (this.error) root.child(div().text_size(12).text_color(t.blocked).child(this.error));

    const { offer, request } = v.pairing;
    if (request) return root.child(this.requestCard(request));
    if (offer) return root.child(this.offerCard(offer));
    return root
      .child(this.deviceList(v.devices))
      .child(h_flex().justify_end().child(this.btn("pair", "配对新手机", "primary", this.act("pair", async () => {
        this.known = new Set(v.devices.map((d) => d.id));
        await this.show(await ctl("pair.start"));
      }))))
      .child(this.voiceCard(v.voice));
  }

  deviceList(devices) {
    const t = theme();
    if (!devices.length) return div().text_color(t.dim).child("无已配对手机");
    return v_flex().gap(2).children(devices.map((d) => {
      const asking = this.removing === d.id;
      return h_flex().id(`dev-${d.id}`).h(42).px(10).gap(10).items_center().rounded(8).hover((s) => s.bg(t.hover))
        .child(div().size(8).rounded_full().flex_none().bg(d.online ? t.done : t.dim))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().child(d.name))
          .child(div().text_size(11.5).text_color(t.dim).child(d.online ? "在线" : ago(d.lastSeen))))
        .child(div().id(`rm-${d.id}`).px(8).py(4).rounded(6).text_size(12).cursor_pointer()
          .text_color(asking ? t.blocked : t.muted).hover((s) => s.bg(t.raised))
          .on_click(asking
            ? this.act(`rm-${d.id}`, async () => { this.removing = null; await this.show(await ctl("devices.remove", { id: d.id })); })
            : (_e, cx) => { this.removing = d.id; cx.notify(); })
          .child(asking ? "确认移除" : "移除"));
    }));
  }

  voiceCard(tail) {
    const t = theme();
    const card = v_flex().gap(8).pt(12).border_t_1().border_color(t.border)
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().font_semibold().child("语音"))
        .child(div().text_size(12).text_color(tail ? t.done : t.dim).child(tail ?? "未开启")));
    if (!tail || this.changingKey) {
      const save = this.act("voice-save", async () => {
        const key = this.keyInput.value().trim();
        if (!key) throw new Error("请输入 Key");
        await this.show(await ctl("voice.set", { key }));
        this.keyInput.set_value("");
        this.changingKey = false;
        this.heard = null;
      });
      return card.child(h_flex().gap(8).items_center()
        .child(div().flex_1().child(Input.new(this.keyInput)))
        .when(this.changingKey, (el) => el.child(this.btn("voice-keep", "取消", "secondary", (_e, cx) => {
          this.changingKey = false;
          this.keyInput.set_value("");
          cx.notify();
        })))
        .child(this.btn("voice-save", "保存", "primary", save)));
    }
    return card
      .when(Boolean(this.heard), (el) => el.child(div().text_size(12).text_color(t.muted).child(`${this.heard.text || "（空）"} · ${this.heard.ms} ms`)))
      .child(h_flex().justify_end().gap(8)
        .child(this.btn("voice-off", "关闭", "secondary", this.act("voice-off", async () => { this.heard = null; await this.show(await ctl("voice.off")); })))
        .child(this.btn("voice-change", "换 Key", "secondary", (_e, cx) => { this.changingKey = true; cx.notify(); }))
        .child(this.btn("voice-test", "试一次", "primary", this.act("voice-test", async () => { this.heard = await ctl("voice.test"); }))));
  }

  offerCard(offer) {
    const t = theme();
    return v_flex().gap(12).items_center()
      .child(this.qr
        ? div().p(10).rounded(10).bg("#ffffff").child(image(this.qr.path).size(220))
        : div().size(240).flex().items_center().justify_center().text_color(t.muted).child("生成中…"))
      .child(h_flex().w_full().items_center()
        .child(div().flex_1().text_size(12).text_color(t.dim).child(`${hhmm(offer.expiresAt)} 前有效`))
        .child(this.btn("cancel", "取消", "secondary", this.act("cancel", async () => { this.known = null; await this.show(await ctl("pair.cancel")); }))));
  }

  requestCard(request) {
    const decide = (allow) => this.act(allow ? "allow" : "deny", async () => {
      await ctl("pair.decide", { allow });
      await this.show(await ctl("status"));
    });
    return v_flex().gap(12)
      .child(div().text_size(14).child(request.name))
      .child(div().text_size(30).font_semibold().child(`${request.sas.slice(0, 3)} ${request.sas.slice(3)}`))
      .child(h_flex().justify_end().gap(8)
        .child(this.btn("deny", "拒绝", "secondary", decide(false)))
        .child(this.btn("allow", "允许", "primary", decide(true))));
  }
}
