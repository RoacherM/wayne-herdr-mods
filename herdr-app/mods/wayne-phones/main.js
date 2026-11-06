// wayne-phones (wayne-herdr-mods in Herdr.app): the phones paired with this Mac, and pairing a new one.
// Opened as a dialog (`mod.open wayne-phones`): the phone icon in the tab bar, or `wayne-herdr-mods pair` in a shell.
// Written by `wayne-herdr-mods install` from the repo's herdr-app/; edits here are replaced on the next install.
//
// Everything goes through the command (`wayne-herdr-mods ctl <method> <json>`), which talks
// to the running host: status, pair.start / pair.cancel / pair.decide, devices.remove, voice.set / voice.test /
// voice.off, and watch (answers when anything changes, or after 20 s), so the dialog follows phones coming and going.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { exec, home, appHome, theme, notify } from "herdr";
import * as fs from "fs/promises";

const BIN = () => `${home()}/.local/bin/wayne-herdr-mods`;
const QR_DIR = "data/wayne-phones"; // under ~/.config/herdr-app: where image() looks

async function ctl(method, params = {}) {
  const r = await exec(BIN(), ["ctl", method, JSON.stringify(params)]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `wayne-herdr-mods ctl ${method}: exit ${r.code}`);
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
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export default class Phones extends View {
  init(_props, cx) {
    this.v = null;         // the host's view (status)
    this.error = "";
    this.busy = "";        // an action in flight
    this.qr = null;        // { link, path } of the shown QR
    this.removing = null;  // a device id waiting for its second click
    this.known = null;     // device ids when pairing started: the new one gets a notification
    this.closed = false;
    this.keyInput = InputState.new({ placeholder: "粘贴火山引擎的 API Key" }); // the voice key; never shown back
    this.keyInput.set_masked(true);
    this.changingKey = false; // the key field is open while a key is already set
    this.heard = null;        // the last「试一次」: { text, ms }
    this.saved = false;       // a key was just saved: a phone sees it on its next connection
    cx.spawn(async (cx) => {
      try { await this.show(await ctl("status")); } catch (e) { this.error = e.message; }
      cx.notify();
      while (!this.closed) {
        try { await this.show(await ctl("watch", { ms: 20000 })); this.error = ""; }
        catch (e) { // the host restarting: try again in a moment
          this.error = e.message; this.v = null;
          await new Promise((r) => cx.timer.after(3000, () => r()));
        }
        if (this.closed) return;
        cx.notify();
      }
    });
  }

  async close() {
    this.closed = true;
    // A QR still waiting for a phone goes with the dialog (as Ctrl-C does in `wayne-herdr-mods pair`).
    if (this.v?.pairing?.offer && !this.v?.pairing?.request) await exec(BIN(), ["ctl", "pair.cancel", "{}"]);
  }

  /** A new view from the host; the QR as a file image() can show (a new file per offer). */
  async show(v) {
    if (this.known && v.devices.length) {
      const added = v.devices.find((d) => !this.known.has(d.id));
      if (added) { this.known = null; notify({ title: "已配对", body: `「${added.name}」可以连接这台 Mac 了`, level: "success" }); }
    }
    if (!v.pairing.offer) this.known = null;
    const offer = v.pairing.offer;
    if (offer?.qrSvg && this.qr?.link !== offer.link) {
      const dir = `${appHome()}/${QR_DIR}`;
      await fs.mkdir(dir, { recursive: true });
      for (const f of await fs.readdir(dir).catch(() => [])) if (f.endsWith(".svg")) await fs.unlink(`${dir}/${f}`).catch(() => {});
      const name = `qr-${offer.expiresAt}.svg`;
      await fs.writeFile(`${dir}/${name}`, offer.qrSvg);
      this.qr = { link: offer.link, path: `${QR_DIR}/${name}` };
    }
    if (!offer) this.qr = null;
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

  button(id, label, primary, onClick) {
    const t = theme();
    return h_flex().id(id).h(30).px(14).items_center().justify_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(onClick).child(this.busy === id ? "…" : label);
  }

  render() {
    const t = theme();
    const v = this.v;
    const root = v_flex().id("wayne-phones").size_full().min_h(0).p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("手机"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")));
    if (!v) {
      return root.child(div().text_color(this.error ? t.blocked : t.muted).child(this.error
        ? `后台服务没有在运行（${this.error}）。在仓库里运行 node dist/wayne-herdr-mods.mjs install。`
        : "读取中…"));
    }
    const ok = (s) => s === "online";
    root.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
      .child(div().size(7).rounded_full().bg(ok(v.relay) && ok(v.core) ? t.done : t.blocked))
      .child(`中继 ${ok(v.relay) ? "已连接" : v.relay} · herdr-core ${ok(v.core) ? "运行中" : v.core} · ${v.terminals} 个终端`));
    if (this.error) root.child(div().text_size(12).text_color(t.blocked).child(this.error));

    const { offer, request } = v.pairing;
    if (request) return root.child(this.requestCard(request));
    if (offer) return root.child(this.offerCard(offer));
    return root.child(this.deviceList(v.devices))
      .child(h_flex().justify_end().child(this.button("pair", "配对新手机", true, this.act("pair", async () => {
        this.known = new Set(v.devices.map((d) => d.id));
        await this.show(await ctl("pair.start"));
      }))))
      .child(this.voiceCard(v.voice));
  }

  deviceList(devices) {
    const t = theme();
    if (!devices.length) return div().text_color(t.muted).child("还没有配对的手机。点「配对新手机」，用手机相机扫码。");
    return v_flex().gap(2).children(devices.map((d) => {
      const asking = this.removing === d.id;
      return h_flex().id(`dev-${d.id}`).h(44).px(10).gap(10).items_center().rounded(8).hover((s) => s.bg(t.hover))
        .child(div().size(8).rounded_full().flex_none().bg(d.online ? t.done : t.dim))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().child(d.name))
          .child(div().text_size(11.5).text_color(t.dim).child([d.online ? "在线" : `上次 ${ago(d.lastSeen)}`, d.push ? "推送已开" : null].filter(Boolean).join(" · "))))
        .child(div().id(`rm-${d.id}`).px(8).py(4).rounded(6).text_size(12).cursor_pointer()
          .text_color(asking ? t.blocked : t.muted).hover((s) => s.bg(t.raised))
          .on_click(asking
            ? this.act(`rm-${d.id}`, async () => { this.removing = null; await this.show(await ctl("devices.remove", { id: d.id })); })
            : (_e, cx) => { this.removing = d.id; cx.notify(); })
          .child(asking ? "确认移除" : "移除"));
    }));
  }

  // Voice input on the phone: the phone records, this Mac sends the audio to Volcengine's recognizer with
  // this key (kept in the keychain, never sent to a phone). The same as `wayne-herdr-mods voice key / test / off`.
  voiceCard(tail) {
    const t = theme();
    const card = v_flex().gap(8).pt(12).border_t_1().border_color(t.border)
      .child(h_flex().items_center().gap(6)
        .child(div().flex_1().font_semibold().child("语音输入"))
        .child(div().text_size(12).text_color(tail ? t.done : t.dim).child(tail ? `已开启 · Key ${tail}` : "未开启")));
    const save = this.act("voice-save", async () => {
      const key = this.keyInput.value().trim();
      if (!key) throw new Error("先粘贴 Key");
      await this.show(await ctl("voice.set", { key }));
      this.keyInput.set_value("");
      this.changingKey = false;
      this.heard = null;
      this.saved = true;
    });
    if (!tail || this.changingKey) {
      return card
        .child(div().text_size(12).text_color(t.muted).child("手机上按住说话，Mac 用火山引擎「豆包语音识别」转成文字。在火山引擎控制台创建 API Key，粘贴到这里；Key 存在这台 Mac 的钥匙串里，不会发给手机。"))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().child(Input.new(this.keyInput)))
          .child(this.changingKey ? this.button("voice-keep", "取消", false, (_e, cx) => { this.changingKey = false; this.keyInput.set_value(""); cx.notify(); }) : div())
          .child(this.button("voice-save", "保存", true, save)));
    }
    return card
      .child(this.heard ? div().text_size(12).text_color(t.muted).child(`识别：${this.heard.text || "（空）"} · ${this.heard.ms} ms`) : this.saved ? div().text_size(12).text_color(t.dim).child("已保存。手机重新打开网页后出现麦克风键。") : div())
      .child(h_flex().justify_end().gap(8)
        .child(this.button("voice-off", "关闭", false, this.act("voice-off", async () => { this.heard = null; this.saved = false; await this.show(await ctl("voice.off")); })))
        .child(this.button("voice-change", "换 Key", false, (_e, cx) => { this.changingKey = true; cx.notify(); }))
        .child(this.button("voice-test", "试一次", true, this.act("voice-test", async () => { this.heard = await ctl("voice.test"); }))));
  }

  offerCard(offer) {
    const t = theme();
    return v_flex().gap(12).items_center()
      .child(this.qr
        ? div().p(10).rounded(10).bg("#ffffff").child(image(this.qr.path).size(220))
        : div().size(240).flex().items_center().justify_center().text_color(t.muted).child("生成二维码…"))
      .child(div().text_color(t.muted).child(`用手机相机扫码。只能配对一台，${hhmm(offer.expiresAt)} 前有效。`))
      .child(h_flex().w_full().items_center()
        .child(div().flex_1().text_size(12).text_color(t.dim).child("等待手机…"))
        .child(this.button("cancel", "取消", false, this.act("cancel", async () => { this.known = null; await this.show(await ctl("pair.cancel")); }))));
  }

  requestCard(request) {
    const t = theme();
    const decide = (allow) => this.act(allow ? "allow" : "deny", async () => {
      await ctl("pair.decide", { allow });
      await this.show(await ctl("status"));
    });
    return v_flex().gap(12)
      .child(div().text_size(14).child(`「${request.name}」请求连接这台 Mac`))
      .child(div().text_color(t.muted).child("手机上显示的核对码应该是："))
      .child(div().text_size(30).font_semibold().child(`${request.sas.slice(0, 3)} ${request.sas.slice(3)}`))
      .child(div().text_size(12).text_color(t.dim).child("一样才允许。不一样说明有人冒充，点拒绝。"))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("deny", "拒绝", false, decide(false)))
        .child(this.button("allow", "允许", true, decide(true))));
  }
}
