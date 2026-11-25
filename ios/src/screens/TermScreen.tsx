import { cleanup, Clipboard, computed, effect, host, Keyboard, lifecycle, Picker, safeArea, Scroll, signal, Text, View, WebView } from "nsh";
import type { InputRef, WebViewRef } from "nsh/types";
import { Button, Input, NavPage, Popover } from "nsh/base";
import {
  activeTermAddress, clearStreamListener, clientLog, info, linkEpoch, list, notify,
  paired, recordOp, rpc, sendFile, sendImage, setStreamListener, status,
  termDrawn, termOpening, termOutputArrived, termRpcOpened, termTyped, termWebReady,
  transcribeAudio,
} from "../conn";
import { TERM_HTML } from "../term-html";
import { imageInput, LiveLine, PASTE_LF, pasteText } from "../../../app/src/live-line.js";
import { agentKeys, combo, keyOfChar, MODS } from "../../../app/src/agent-keys.js";
import { safeHttpUrl } from "../../../app/src/term-select.js";
import { enqueue, termSession } from "../../../app/src/term-session.js";
import {
  base, GlassCapsule, GlassCircle, glassFallbackClass, glassStyle, Icon, spaceName, tapHaptic,
} from "../ui/controls";
import { FilesSheet } from "./FilesSheet";
import checkIcon from "../../assets/check.svg";
import chevronIcon from "../../assets/chevron.svg";
import downIcon from "../../assets/down.svg";
import folderOutlineIcon from "../../assets/folder-outline.svg";
import kbdIcon from "../../assets/kbd.svg";
import micIcon from "../../assets/mic.svg";
import pasteIcon from "../../assets/paste.svg";
import photoIcon from "../../assets/photo.svg";
import plusIcon from "../../assets/plus.svg";
import spinnerIcon from "../../assets/spinner.svg";
import xIcon from "../../assets/x.svg";

const KEYBAR_FRONT: [string, string][] = [
  ["Esc", "\x1b"], ["←", "left"], ["↑", "up"], ["↓", "down"], ["→", "right"], ["⏎", "\r"], ["⇧Tab", "\x1b[Z"], ["^C", "\x03"],
];
const KEYBAR_BACK: [string, string][] = [
  ["Tab", "\t"], ["粘贴", "paste"], ["换行", PASTE_LF],
  ["1", "1"], ["2", "2"], ["3", "3"], ["y", "y"], ["n", "n"], ["^D", "\x04"], ["^R", "\x12"], ["^L", "\x0c"],
];
const NAME_OF: Record<string, string> = {
  "\x1b": "esc", left: "left", up: "up", down: "down", right: "right", "\r": "enter", "\t": "tab",
  "1": "1", "2": "2", "3": "3", y: "y", n: "n",
};
const MOD_LABELS: Record<string, string> = { ctrl: "^", alt: "⌥", shift: "⇧" };
const ARROWS: Record<string, string> = { up: "A", down: "B", right: "C", left: "D" };
const REPEAT = new Set(["up", "down", "left", "right"]);
const MAX_VOICE_MS = 60_000;
const WAVE_BARS = 32;
const WAVE_POLL_MS = 80;
const PAGE_READY_FALLBACK_MS = 1500;
const WEB_PING_MS = 600;
const MAX_WEB_RECOVERS = 3;
const RECOVER_COOLDOWN_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emptyWave = () => Array.from({ length: WAVE_BARS }, () => 0);

function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}

export function TermScreen(props: {
  address: string;
  onBack: () => void;
  onOpenPreview: (rootId: string, path: string, title: string) => void;
}) {
  const address = props.address;
  const term = computed(() => list().terminals.find((t) => t.address === address));
  const appCursor = signal(false);
  const atLatest = signal(true);
  const notice = signal("");
  const burst = signal("");
  const focused = signal(false);
  const uploading = signal("");
  const voiceState = signal<"" | "starting" | "rec" | "busy">("");
  const voiceSec = signal(0);
  const waveBars = signal<number[]>(emptyWave());
  const attachOpen = signal(false);
  const mods = signal<string[]>([]);
  const litKey = signal("");
  const filesOpen = signal(false);
  const webReady = signal(false);
  const webEpoch = signal(0);

  let litTimer: any = 0;
  let noticeTimer: any = 0;
  let repeatDelay: any = 0;
  let repeatEvery: any = 0;
  let didRepeat = false;
  let voiceTickTimer: any = 0;
  let voiceMeterTimer: any = 0;
  let voiceLimitTimer: any = 0;
  let voiceGen = 0;
  let recStartedAt = 0;
  let disposed = false;
  let bootTimer: any = 0;
  let pingTimer: any = 0;
  let pingSeq = 0;
  let webDeadInBg = false;
  let recoverCount = 0;
  let lastRecoverAt = 0;

  let mountedAt = Date.now();
  termOpening(address, false);
  function armBootTimer(gen: number) {
    clearTimeout(bootTimer);
    bootTimer = setTimeout(() => {
      if (gen !== webEpoch() || pageReady) return;
      clientLog("warn", "term.ready_timeout", { address, ms: PAGE_READY_FALLBACK_MS, gen });
      webReady.set(true);
    }, PAGE_READY_FALLBACK_MS);
  }
  armBootTimer(0);

  let field!: InputRef;
  let web: WebViewRef | undefined;
  let pageReady = false;
  const toPage: string[] = [];
  const post = (v: object) => {
    const m = JSON.stringify(v);
    if (pageReady && web) web.postMessage(m);
    else toPage.push(m);
  };
  function clearPing() {
    clearTimeout(pingTimer);
    pingTimer = 0;
  }
  function recoverWebView(reason: string) {
    clearTimeout(bootTimer);
    clearPing();
    toPage.length = 0;
    pageReady = false;
    webReady.set(false);
    session.send({ type: "viewLost" });
    if (lifecycle() === "background") {
      webDeadInBg = true;
      clientLog("warn", "term.web_lost_bg", { address, reason });
      return;
    }
    const now = Date.now();
    if (recoverCount >= MAX_WEB_RECOVERS && now - lastRecoverAt < 30_000) {
      clientLog("error", "term.web_recover_limit", { address, reason, count: recoverCount });
      return;
    }
    if (now - lastRecoverAt < RECOVER_COOLDOWN_MS && reason !== "bg_resume") return;
    lastRecoverAt = now;
    recoverCount++;
    webDeadInBg = false;
    mountedAt = now;
    const next = webEpoch() + 1;
    clientLog("warn", "term.web_remount", { address, reason, gen: next, count: recoverCount });
    web = undefined;
    webEpoch.set(next);
    armBootTimer(next);
  }
  function probeWebView(why: string) {
    if (!pageReady || lifecycle() !== "active" || pingTimer) return;
    const id = ++pingSeq;
    const gen = webEpoch();
    post({ t: "ping", id });
    pingTimer = setTimeout(() => {
      pingTimer = 0;
      if (gen !== webEpoch() || !pageReady || lifecycle() !== "active") return;
      clientLog("warn", "term.web_unresponsive", { address, why, id, ms: WEB_PING_MS });
      recoverWebView(`ping_timeout:${why}`);
    }, WEB_PING_MS);
  }

  function flashNotice(msg: string, ms = 1800) {
    clearTimeout(noticeTimer);
    notice.set(msg);
    if (ms > 0) {
      noticeTimer = setTimeout(() => {
        if (notice() === msg) notice.set("");
      }, ms);
    }
  }

  let sendQ = Promise.resolve();
  function typed(e: { m: string; p: any; after?: number }) {
    sendQ = enqueue(sendQ, async () => {
      if (e.p.s !== session.state.s) {
        session.send({ type: "input", m: e.m, p: { ...e.p, s: undefined }, after: e.after });
        return;
      }
      notify(e.m, e.p);
      if (e.after) await sleep(e.after);
    });
  }

  const session = termSession(address, (effects, ses) => {
    for (const e of effects) {
      if (e.type === "rpc" && e.m === "term.open") {
        const epoch = e.epoch;
        if (ses.state.opened) termOpening(address, true);
        const openT0 = Date.now();
        rpc("term.open", e.p).then(
          (r: any) => { termRpcOpened(Date.now() - openT0); ses.send({ type: "opened", r, epoch }); },
          (err: any) => ses.send({ type: "openFailed", message: err?.message ?? String(err), epoch }),
        );
      } else if (e.type === "rpc") {
        rpc(e.m, e.p).catch(() => {});
      } else if (e.type === "notify" && e.m === "term.fit") {
        clientLog("info", "term.fit_tx", { address, s: e.p?.s, fit: e.p?.fit ?? null });
        notify(e.m, e.p);
      } else if (e.type === "notify") {
        typed(e);
      } else if (e.type === "view") {
        post(e.msg.t === "out" ? { t: "out", d: e.msg.d, fresh: e.msg.fresh } : e.msg);
        if (e.msg.t === "open" && e.msg.reopened) probeWebView("reopen");
      } else if (e.type === "notice") {
        notice.set(e.text);
      } else if (e.type === "retry") {
        setTimeout(() => ses.send({ type: "retry" }), e.ms);
      }
    }
  });
  const sid = () => session.state.s;

  function lightKey(label: string) {
    clearTimeout(litTimer);
    litKey.set(label);
    litTimer = setTimeout(() => litKey.set(""), 3000);
  }
  function clearLit() {
    if (!litKey()) return;
    clearTimeout(litTimer);
    litKey.set("");
  }
  function stopRepeat() {
    clearTimeout(repeatDelay);
    clearInterval(repeatEvery);
    repeatDelay = repeatEvery = 0;
  }

  function out(d: string, after = 0, scrollLatest = true) {
    if (scrollLatest) {
      post({ t: "typing" });
      termTyped();
    }
    session.send({ type: "input", m: "term.input", p: { d }, after });
  }
  const line = new LiveLine((d) => out(d));
  const sync = () => { burst.set(line.value); };

  const onStream = (msg: any) => {
    if (msg.ev === "out") termOutputArrived();
    else if (msg.ev === "size") clientLog("info", "term.size_ev", { address, s: msg.s, cols: msg.cols, rows: msg.rows });
    else if (msg.ev === "closed") clientLog("info", "term.closed_ev", { address, s: msg.s, reason: msg.reason ?? null, exitCode: msg.exitCode ?? null });
    session.send({ type: "stream", msg });
  };

  activeTermAddress.set(address);
  setStreamListener(onStream);

  let seenEpoch = linkEpoch();
  effect(() => {
    const n = linkEpoch();
    const ready = status() === "ready";
    session.send({ type: "link", ready, renewed: ready && n !== seenEpoch });
    if (ready) seenEpoch = n;
  });
  effect(() => { if (webReady()) session.send({ type: "view" }); });
  effect(() => {
    const t = term();
    const st = session.state;
    if (t && st.opened && !st.sized) post({ t: "size", cols: t.cols, rows: t.rows });
  });
  let wasAway = false;
  effect(() => {
    const st = lifecycle();
    if (st === "background") {
      wasAway = true;
      clearPing();
      clientLog("info", "term.away", { address, s: sid(), on: true, fit: session.state.fit ?? null, phase: session.state.phase });
      session.send({ type: "away", on: true });
    } else if (st === "active") {
      clientLog("info", "term.away", { address, s: sid(), on: false, fit: session.state.fit ?? null, phase: session.state.phase });
      session.send({ type: "away", on: false });
      if (webDeadInBg) {
        wasAway = false;
        recoverWebView("bg_resume");
      } else if (wasAway) {
        wasAway = false;
        probeWebView("resume");
      }
    }
  });

  function clearVoiceTimers() {
    clearInterval(voiceTickTimer);
    clearInterval(voiceMeterTimer);
    clearTimeout(voiceLimitTimer);
    voiceTickTimer = voiceMeterTimer = voiceLimitTimer = 0;
  }

  cleanup(() => {
    disposed = true;
    voiceGen++;
    clientLog("info", "term.cleanup", { address, s: sid() });
    if (activeTermAddress() === address) activeTermAddress.set(null);
    clearTimeout(bootTimer);
    clearPing();
    clearTimeout(litTimer);
    clearTimeout(noticeTimer);
    stopRepeat();
    clearVoiceTimers();
    if (voiceState() === "starting" || voiceState() === "rec") {
      try { host.call("voice.cancel").catch(() => {}); } catch {}
    }
    clearStreamListener(onStream);
    session.send({ type: "dispose" });
  });

  function fromPage(data: string) {
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    clearPing();
    if (m.t === "pong") {
      recoverCount = 0;
      return;
    }
    if (m.t === "ready") {
      clearTimeout(bootTimer);
      const webMs = Date.now() - mountedAt;
      termWebReady(webMs);
      clientLog("info", "term.ready", { ms: webMs, fit: m.fit ?? null, gen: webEpoch() });
      pageReady = true;
      if (m.fit) session.send({ type: "fit", fit: m.fit });
      for (const x of toPage.splice(0)) web?.postMessage(x);
      webReady.set(true);
    } else if (m.t === "fit") {
      session.send({ type: "fit", fit: m.fit });
    } else if (m.t === "ack" && sid() !== null) {
      notify("term.ack", { s: sid(), n: m.n });
    } else if (m.t === "drawn") {
      recoverCount = 0;
      termDrawn();
      clearLit();
      appCursor.set(Boolean(m.appCursor));
    } else if (m.t === "atLatest") {
      atLatest.set(Boolean(m.on));
    } else if (m.t === "wheel" && sid() !== null) {
      notify("term.input", { s: sid(), d: m.d });
    } else if (m.t === "coast" && sid() !== null) {
      if (m.stop) notify("term.coast", { s: sid(), stop: true });
      else notify("term.coast", { s: sid(), d: m.d, v: m.v, cell: m.cell });
    } else if (m.t === "tap") {
      field.focus();
    } else if (m.t === "haptic") {
      tapHaptic();
    } else if (m.t === "copy" && typeof m.text === "string" && m.text) {
      tapHaptic();
      Clipboard.writeText(m.text).then(() => flashNotice("已复制", 1500)).catch(() => {});
    } else if (m.t === "openUrl" && typeof m.url === "string") {
      const safe = safeHttpUrl(m.url);
      if (safe && host.available()) {
        tapHaptic();
        host.call("url.open", { url: safe }).catch((err: any) => flashNotice(err?.message || "无法打开链接"));
      }
    } else if (m.t === "diag" && typeof m.ev === "string") {
      const { t: _t, ev, ...rest } = m;
      clientLog("info", ev, { address, s: sid(), ...rest });
    } else if (m.t === "log") {
      console.warn(`term page: ${m.m}`);
    }
  }

  const named = computed(() => Boolean(info()?.keys));
  const agentShortcuts = computed(() => (named() ? agentKeys(term()) : []));

  function toggleMod(m: string) {
    tapHaptic();
    const cur = mods();
    mods.set(cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]);
  }
  function clearMods() { if (mods().length) mods.set([]); }

  function pressNamed(names: string | string[], label = "") {
    const klist = Array.isArray(names) ? names : [names];
    clearMods();
    if (label) lightKey(label);
    tapHaptic();
    line.commit();
    sync();
    post({ t: "typing" });
    termTyped();
    recordOp("key", klist.join("+"));
    session.send({ type: "input", m: "term.press", p: { keys: klist } });
  }

  async function pasteFromClipboard() {
    try {
      if (await Clipboard.hasImage()) {
        const img = await Clipboard.readImage();
        if (img?.url) {
          uploading.set("剪贴板图片");
          const res = await fetch(img.url);
          const blob = await res.blob();
          const path = await sendImage(blob, address, "clipboard.png");
          line.commit();
          sync();
          out(imageInput(path, 0, 1).d);
          return;
        }
      }
      const txt = await Clipboard.readText();
      if (!txt) { flashNotice("剪贴板是空的"); return; }
      tapHaptic();
      line.commit();
      sync();
      out(pasteText(txt.replace(/\r\n?/g, "\n")));
    } catch (e: any) {
      flashNotice(`粘贴失败：${e.message}`);
    } finally {
      uploading.set("");
    }
  }

  function key(label: string, seq: string) {
    if (mods().length && NAME_OF[seq]) {
      pressNamed(combo(new Set(mods()), NAME_OF[seq]), label);
      return;
    }
    clearMods();
    lightKey(label);
    if (seq === "paste") { pasteFromClipboard(); return; }
    tapHaptic();
    line.commit();
    sync();
    const bytes = ARROWS[seq] ? `\x1b${appCursor() ? "O" : "["}${ARROWS[seq]}` : seq;
    out(bytes);
  }

  function onKeyPress(label: string, seq: string) {
    if (didRepeat) { didRepeat = false; return; }
    key(label, seq);
  }

  function onKeyDown(label: string, seq: string) {
    if (!REPEAT.has(seq)) return;
    stopRepeat();
    didRepeat = false;
    repeatDelay = setTimeout(() => {
      didRepeat = true;
      key(label, seq);
      repeatEvery = setInterval(() => key(label, seq), 70);
    }, 380);
  }

  function send() {
    if (mods().length && named()) {
      pressNamed(combo(new Set(mods()), "enter"), "⏎");
      return;
    }
    tapHaptic();
    line.submit();
    notice.set("");
    sync();
  }

  function onInputChange(val: string) {
    if (mods().length && val.length === burst().length + 1) {
      const ch = val.slice(-1);
      const k = keyOfChar(ch);
      if (k) { pressNamed(combo(new Set(mods()), k)); sync(); return; }
    }
    line.set(val);
    sync();
  }

  async function pick() {
    try {
      const got = await Picker.pickImages({ multiple: true, limit: 6, maxDimension: 2048, quality: 0.85 });
      for (const [i, g] of got.entries()) {
        uploading.set(`图片 ${i + 1}/${got.length}`);
        const path = await sendImage(g.file, address);
        line.commit();
        sync();
        const { d, after } = imageInput(path, i, got.length);
        out(d, after);
      }
    } catch (e: any) {
      flashNotice(`图片没发出去：${e.message}`);
    } finally {
      uploading.set("");
    }
  }

  async function pickFiles() {
    try {
      const got = await Picker.pickFiles({ multiple: true, limit: 6, maxSize: 8 * 1024 * 1024 });
      const usable = got.filter((f) => f.status === "read" && f.file);
      const tooBig = got.filter((f) => f.status === "tooLarge");
      if (tooBig.length) flashNotice(`${tooBig[0].name} 超过 8 MB 上限`, 2600);
      for (const [i, item] of usable.entries()) {
        uploading.set(`文件 ${i + 1}/${usable.length}`);
        const path = await sendFile(item.file!, address, item.name);
        line.commit();
        sync();
        const { d, after } = imageInput(path, i, usable.length);
        out(d, after);
      }
    } catch (e: any) {
      flashNotice(`文件没发出去：${e.message}`);
    } finally {
      uploading.set("");
    }
  }

  // ---- Liquid Glass live-waveform voice recording (tap mic → [✕ | waveform 0:01 | ✓])
  async function startVoice() {
    if (voiceState()) return;
    if (!host.available() || !info()?.voice) {
      flashNotice(info()?.voice ? "当前环境不支持录音" : "Mac 未配置语音 Key");
      return;
    }
    tapHaptic();
    notice.set("");
    const gen = ++voiceGen;
    voiceState.set("starting");
    voiceSec.set(0);
    waveBars.set(emptyWave());
    try {
      await host.call("voice.start");
      if (disposed || gen !== voiceGen) {
        host.call("voice.cancel").catch(() => {});
        return;
      }
      recStartedAt = Date.now();
      voiceState.set("rec");
      voiceTickTimer = setInterval(() => {
        if (gen !== voiceGen) return;
        voiceSec.set(Math.floor((Date.now() - recStartedAt) / 1000));
      }, 250);
      voiceMeterTimer = setInterval(() => {
        if (gen !== voiceGen) return;
        host.call<{ level?: number }>("voice.meter").then((r) => {
          if (disposed || gen !== voiceGen || voiceState() !== "rec") return;
          const level = typeof r?.level === "number" ? Math.max(0, Math.min(1, r.level)) : 0;
          waveBars.update((prev) => [...prev.slice(1), level]);
        }).catch(() => {});
      }, WAVE_POLL_MS);
      voiceLimitTimer = setTimeout(() => {
        if (gen === voiceGen && voiceState() === "rec") confirmVoice();
      }, MAX_VOICE_MS);
    } catch (err: any) {
      if (gen === voiceGen) {
        clearVoiceTimers();
        voiceState.set("");
        flashNotice(err?.message || "录音启动失败");
      }
    }
  }

  function cancelVoice() {
    tapHaptic();
    voiceGen++;
    clearVoiceTimers();
    voiceState.set("");
    voiceSec.set(0);
    waveBars.set(emptyWave());
    try { host.call("voice.cancel").catch(() => {}); } catch {}
  }

  async function confirmVoice() {
    if (voiceState() !== "rec") return;
    tapHaptic();
    const gen = ++voiceGen;
    clearVoiceTimers();
    voiceState.set("busy");
    try {
      const res = await host.call<{ data: string; mime: string }>("voice.stop");
      if (disposed || gen !== voiceGen) return;
      if (!res?.data) {
        flashNotice("没录到声音");
        return;
      }
      const { text } = await transcribeAudio(res.data, res.mime || "audio/mp4", address);
      if (disposed || gen !== voiceGen) return;
      if (text) {
        tapHaptic();
        const sep = line.value && !/\s$/.test(line.value) ? " " : "";
        line.set(line.value + sep + text);
        sync();
      } else {
        flashNotice("没听清");
      }
    } catch (err: any) {
      if (!disposed && gen === voiceGen) flashNotice(`识别失败：${err.message}`);
    } finally {
      if (!disposed && gen === voiceGen) {
        voiceState.set("");
        voiceSec.set(0);
        waveBars.set(emptyWave());
      }
    }
  }

  const spaceLabel = computed(() => {
    const { terminals, layout } = list();
    const byAddr = new Map(terminals.map((x) => [x.address, x]));
    const sp = layout.find((s) => s.tabs.some((tab) => tab.terminals.includes(address)));
    return sp ? spaceName(sp, byAddr) : base(term()?.cwd) || address;
  });

  const title = computed(() => {
    const t = term();
    const cwdName = base(t?.cwd);
    return cwdName || spaceLabel() || t?.app || t?.program || address;
  });

  const macName = computed(() => paired()?.desktopName ?? info()?.desktopName ?? "Mac");

  const subtitle = computed(() => {
    const sp = spaceLabel();
    const left = sp && sp !== title() ? sp : address;
    return `${left} · ${macName()}`;
  });

  const floatingStatus = computed(() => {
    if (uploading()) return { text: `上传${uploading()}…`, spin: true };
    if (status() !== "ready") return { text: `重连 ${macName()}…`, spin: true };
    if (notice()) return { text: notice(), spin: false };
    return null;
  });

  const voiceOk = computed(() => Boolean(info()?.voice) && host.available());

  return (
    <NavPage title={title()} headerVisible={false} statusBar={{ foreground: "light" }}>
      <View class="flex-1 bg-term-bg pt-[env(safe-area-inset-top)] pb-[env(keyboard-inset-height)]">
        {/* Borderless Floating Liquid Glass Header */}
        <View class="flex-row items-center gap-3 px-3.5 pt-1 pb-2">
          <GlassCircle
            onPress={() => { tapHaptic(); props.onBack(); }}
            size={42}
            tone="term"
            accessibilityLabel="返回"
            testID="term-back"
          >
            <View style={{ rotate: "180deg" }}>
              <Icon src={chevronIcon} size={20} class="tint-term-fg" />
            </View>
          </GlassCircle>

          <View class="flex-1 gap-0.5">
            <Text class="text-[17px] font-semibold tracking-[-0.01em] text-term-fg" style={{ numberOfLines: 1 }}>
              {title()}
            </Text>
            <Text class="text-[13px] text-term-muted" style={{ numberOfLines: 1 }}>
              {subtitle()}
            </Text>
          </View>

          <GlassCircle
            onPress={() => { tapHaptic(); filesOpen.set(true); }}
            size={42}
            tone="term"
            accessibilityLabel="文件"
            testID="term-files"
          >
            <Icon src={folderOutlineIcon} size={20} class="tint-term-fg" />
          </GlassCircle>
        </View>

        {/* Live Pure OLED Black Terminal Stage */}
        <View class="relative flex-1 bg-term-bg">
          <Each of={[webEpoch()]}>
            {(k) => {
              const gen = k();
              return (
                <WebView
                  ref={(el) => { if (gen === webEpoch()) web = el; }}
                  html={TERM_HTML}
                  style={{ flex: 1 }}
                  scrollable={false}
                  onMessage={(e) => { if (gen === webEpoch()) fromPage(e.data); }}
                  onError={(e) => {
                    if (gen !== webEpoch()) return;
                    clientLog("warn", "term.web_error", { address, gen, code: e.code ?? null, msg: e.message });
                    if (e.code === "ERR_NSH_WEBVIEW_TERMINATED") recoverWebView("terminated");
                  }}
                  testID="term-web"
                />
              );
            }}
          </Each>

          <If when={!atLatest()}>
            <View class="absolute right-3.5 bottom-3">
              <GlassCircle
                onPress={() => post({ t: "toLatest" })}
                size={38}
                tone="term"
                accessibilityLabel="回到最新"
                testID="to-latest"
              >
                <Icon src={downIcon} size={18} class="tint-term-fg" />
              </GlassCircle>
            </View>
          </If>
        </View>

        {/* Floating Liquid Glass Controls (Shortcut Strip + Single Unified Bar / Live Waveform Bar) */}
        <View class="relative items-center gap-2 bg-term-bg px-3.5 pt-1.5" style={{ paddingBottom: safeArea().bottom + 8 }}>
          <If when={floatingStatus()}>
            {(st) => (
              <GlassCapsule tone="term" class="h-9 gap-2 px-4">
                {st().spin ? <Icon src={spinnerIcon} size={15} class="tint-term-muted" /> : null}
                <Text class="text-[13.5px] font-medium text-term-fg" style={{ numberOfLines: 1 }}>
                  {st().text}
                </Text>
              </GlassCapsule>
            )}
          </If>

          {/* Slim Pure Liquid Glass Shortcut Strip */}
          <GlassCapsule tone="term" class="h-[38px] w-full px-1.5">
            <Scroll
              horizontal
              scrollbar={false}
              keyboardShouldPersistTaps="always"
              class="flex-1"
              contentClass="flex-row items-center gap-1"
            >
              {KEYBAR_FRONT.map(([label, seq]) => (
                <Button
                  onPress={() => onKeyPress(label, seq)}
                  onPressDown={() => onKeyDown(label, seq)}
                  onPressUp={stopRepeat}
                  testID={seq === "\r" ? "send" : undefined}
                  class={`h-[28px] min-w-[32px] items-center justify-center rounded-full bg-term-key px-2.5 active:bg-term-key-press ${
                    litKey() === label ? "border border-term-fg" : ""
                  }`}
                >
                  <Text class="text-[13px] font-medium text-term-fg">{label}</Text>
                </Button>
              ))}
              {agentShortcuts().map(([label, names]) => (
                <Button
                  onPress={() => pressNamed(names, label)}
                  class={`h-[28px] min-w-[32px] items-center justify-center rounded-full bg-term-key px-2.5 active:bg-term-key-press ${
                    litKey() === label ? "border border-term-fg" : ""
                  }`}
                >
                  <Text class="text-[13px] font-medium text-term-fg">{label}</Text>
                </Button>
              ))}
              {named()
                ? MODS.map((m) => {
                    const active = mods().includes(m);
                    return (
                      <Button
                        onPress={() => toggleMod(m)}
                        class={`h-[28px] min-w-[32px] items-center justify-center rounded-full px-2.5 active:bg-term-key-press ${
                          active ? "bg-term-fg" : "bg-term-key"
                        }`}
                      >
                        <Text class={`text-[13px] font-medium ${active ? "text-term-bg" : "text-term-fg"}`}>
                          {MOD_LABELS[m]}
                        </Text>
                      </Button>
                    );
                  })
                : null}
              {KEYBAR_BACK.map(([label, seq]) => (
                <Button
                  onPress={() => onKeyPress(label, seq)}
                  class={`h-[28px] min-w-[32px] items-center justify-center rounded-full bg-term-key px-2.5 active:bg-term-key-press ${
                    litKey() === label ? "border border-term-fg" : ""
                  }`}
                >
                  <Text class="text-[13px] font-medium text-term-fg">{label}</Text>
                </Button>
              ))}
            </Scroll>
          </GlassCapsule>

          {/* Main Single Liquid Glass Bar: Idle (IMG_1852/1854) <-> Recording Waveform (IMG_1853) <-> Busy */}
          <If when={voiceState() === "rec" || voiceState() === "starting"}>
            <GlassCapsule tone="term" class="h-[50px] w-full gap-2 px-1.5">
              <Button
                onPress={cancelVoice}
                class="h-[38px] w-[38px] items-center justify-center rounded-full transition-transform duration-150 active:scale-95 active:bg-term-key-press"
                accessibilityLabel="取消录音"
                testID="voice-cancel"
              >
                <Icon src={xIcon} size={18} class="tint-term-fg" />
              </Button>

              <View class="h-full flex-1 flex-row items-center justify-end gap-[3px] overflow-hidden px-1">
                {waveBars().map((lvl) => (
                  <View
                    class={`w-[2.5px] rounded-full ${lvl > 0.06 ? "bg-wave-active" : "bg-wave-idle"}`}
                    style={{ height: Math.max(3, Math.round(3 + lvl * 20)) }}
                  />
                ))}
              </View>

              <Text
                class="min-w-[36px] text-right text-[14px] text-term-muted"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {formatClock(voiceSec())}
              </Text>

              <Button
                onPress={confirmVoice}
                disabled={voiceState() !== "rec"}
                class="h-[36px] w-[36px] items-center justify-center rounded-full bg-accent transition-transform duration-150 active:scale-95 disabled:opacity-50"
                accessibilityLabel="完成录音"
                testID="voice-confirm"
              >
                <Icon src={checkIcon} size={17} class="tint-accent-foreground" />
              </Button>
            </GlassCapsule>
          </If>

          <If when={voiceState() === "busy"}>
            <GlassCapsule tone="term" class="h-[50px] w-full items-center justify-center gap-2 px-4">
              <Icon src={spinnerIcon} size={16} class="tint-term-muted" />
              <Text class="text-[14.5px] font-medium text-term-muted">识别中…</Text>
            </GlassCapsule>
          </If>

          <If when={!voiceState()}>
            <GlassCapsule tone="term" class="h-[50px] w-full gap-1 px-1.5">
              <Popover
                open={attachOpen()}
                onOpenChange={(e) => { if (e.open) tapHaptic(); attachOpen.set(e.open); }}
                placement="top"
                align="start"
                offset={12}
                popupClass={`w-[216px] overflow-hidden rounded-[24px] py-1.5 transition-all duration-150 ${glassFallbackClass("term")}`}
                popupStyle={glassStyle("term")}
                popupStartingClass="opacity-0 scale-95"
                popupEndingClass="opacity-0 scale-95"
                trigger={
                  <View
                    accessibilityLabel="添加"
                    testID="pick"
                    class="h-[38px] w-[38px] items-center justify-center rounded-full active:bg-term-key-press"
                  >
                    <Icon src={plusIcon} size={20} class="tint-term-fg" />
                  </View>
                }
              >
                <View>
                  <Button
                    onPress={() => { attachOpen.set(false); tapHaptic(); pickFiles(); }}
                    class="min-h-[48px] flex-row items-center gap-3.5 px-5 active:bg-term-key"
                    testID="attach-files"
                    accessibilityLabel="选择文件"
                  >
                    <Icon src={folderOutlineIcon} size={19} class="tint-term-fg" />
                    <Text class="text-[16px] font-medium text-term-fg">选择文件</Text>
                  </Button>
                  <Button
                    onPress={() => { attachOpen.set(false); tapHaptic(); pick(); }}
                    class="min-h-[48px] flex-row items-center gap-3.5 px-5 active:bg-term-key"
                    testID="attach-photo"
                    accessibilityLabel="照片图库"
                  >
                    <Icon src={photoIcon} size={19} class="tint-term-fg" />
                    <Text class="text-[16px] font-medium text-term-fg">照片图库</Text>
                  </Button>
                  <Button
                    onPress={() => { attachOpen.set(false); tapHaptic(); pasteFromClipboard(); }}
                    class="min-h-[48px] flex-row items-center gap-3.5 px-5 active:bg-term-key"
                    testID="attach-paste"
                    accessibilityLabel="粘贴剪贴板"
                  >
                    <Icon src={pasteIcon} size={19} class="tint-term-fg" />
                    <Text class="text-[16px] font-medium text-term-fg">粘贴剪贴板</Text>
                  </Button>
                </View>
              </Popover>

              <Button
                onPress={() => { tapHaptic(); field.focus(); }}
                class="h-full flex-1"
                accessibilityLabel="输入到终端"
              />

              <Button
                onPress={startVoice}
                class="h-[38px] w-[38px] items-center justify-center rounded-full transition-transform duration-150 active:scale-95 active:bg-term-key-press"
                testID="voice"
                accessibilityLabel="语音输入"
              >
                <Icon src={micIcon} size={19} class={voiceOk() ? "tint-term-fg" : "tint-term-muted"} />
              </Button>

              <Button
                onPress={() => {
                  tapHaptic();
                  if (focused()) Keyboard.dismiss();
                  else field.focus();
                }}
                class={`h-[36px] w-[36px] items-center justify-center rounded-full transition-all duration-150 active:scale-95 ${
                  focused() ? "bg-term-fg" : "bg-term-key"
                }`}
                testID="kbd-toggle"
                accessibilityLabel="键盘"
              >
                <Icon src={kbdIcon} size={18} class={focused() ? "tint-term-bg" : "tint-term-fg"} />
              </Button>
            </GlassCapsule>
          </If>

          {/* Invisible direct-to-terminal input field: zero duplicate text echo */}
          <Input
            ref={field}
            value={burst()}
            multiline
            submitBehavior="submit"
            returnKeyType="send"
            autoCapitalize="none"
            autoCorrect={false}
            onChange={(e) => onInputChange(e.value)}
            onCompositionChange={(e) => { line.compose(e.composing); sync(); }}
            onKeyPress={(e) => { if (e.key === "Backspace") line.backspace(); }}
            onSubmit={send}
            onFocus={() => focused.set(true)}
            onBlur={() => focused.set(false)}
            class="pointer-events-none absolute bottom-0 left-1/2 h-px w-px opacity-0"
            testID="composer"
            accessibilityLabel="输入到终端"
          />
        </View>

        <FilesSheet
          open={filesOpen()}
          rootId={`term:${address}`}
          subtitle={spaceLabel()}
          onClose={() => filesOpen.set(false)}
          onOpenFile={(rootId, path, fileTitle) => props.onOpenPreview(rootId, path, fileTitle)}
        />
      </View>
    </NavPage>
  );
}
