import { cleanup, Clipboard, computed, effect, host, lifecycle, Picker, safeArea, Scroll, signal, Text, View, WebView } from "nsh";
import type { InputRef, WebViewRef } from "nsh/types";
import { Button, Input, NavPage } from "nsh/base";
import {
  activeTermAddress, clearStreamListener, clientLog, info, linkEpoch, list, notify,
  paired, recordOp, rpc, sendImage, setStreamListener, status,
  termDrawn, termOpening, termOutputArrived, termRpcOpened, termTyped, termWebReady,
  transcribeAudio,
} from "../conn";
import { TERM_HTML } from "../term-html";
import { imageInput, LiveLine, PASTE_LF, pasteText } from "../../../app/src/live-line.js";
import { agentKeys, combo, keyOfChar, MODS } from "../../../app/src/agent-keys.js";
import { safeHttpUrl } from "../../../app/src/term-select.js";
import { enqueue, termSession } from "../../../app/src/term-session.js";
import { voiceHold } from "../../../app/src/voice-hold.js";
import { base, GlassCapsule, GlassCircle, Icon, spaceName, tapHaptic } from "../ui/controls";
import { FilesSheet } from "./FilesSheet";
import chevronDownIcon from "../../assets/chevron-down.svg";
import chevronIcon from "../../assets/chevron.svg";
import downIcon from "../../assets/down.svg";
import folderOutlineIcon from "../../assets/folder-outline.svg";
import kbdIcon from "../../assets/kbd.svg";
import micIcon from "../../assets/mic.svg";
import plusIcon from "../../assets/plus.svg";
import sendUpIcon from "../../assets/send-up.svg";
import spinnerIcon from "../../assets/spinner.svg";

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
const PAGE_READY_FALLBACK_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const uploading = signal("");
  const voiceState = signal<"" | "rec" | "busy">("");
  const voiceLeftSec = signal(60);
  const mods = signal<string[]>([]);
  const litKey = signal("");
  const keysOpen = signal(false);
  const filesOpen = signal(false);
  const webReady = signal(false);

  let litTimer: any = 0;
  let noticeTimer: any = 0;
  let repeatDelay: any = 0;
  let repeatEvery: any = 0;
  let didRepeat = false;
  let voiceTickTimer: any = 0;
  let voiceLimitTimer: any = 0;

  const mountedAt = Date.now();
  termOpening(address, false);
  const bootTimer: any = setTimeout(() => {
    clientLog("warn", "term.ready_timeout", { address, ms: PAGE_READY_FALLBACK_MS });
    webReady.set(true);
  }, PAGE_READY_FALLBACK_MS);

  let field!: InputRef;
  let web!: WebViewRef;
  let pageReady = false;
  const toPage: string[] = [];
  const post = (v: object) => {
    const m = JSON.stringify(v);
    if (pageReady) web.postMessage(m);
    else toPage.push(m);
  };

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
  effect(() => {
    const st = lifecycle();
    if (st === "active" || st === "background") {
      const on = st === "background";
      clientLog("info", "term.away", { address, s: sid(), on, fit: session.state.fit ?? null, phase: session.state.phase });
      session.send({ type: "away", on });
    }
  });

  cleanup(() => {
    clientLog("info", "term.cleanup", { address, s: sid() });
    if (activeTermAddress() === address) activeTermAddress.set(null);
    clearTimeout(bootTimer);
    clearTimeout(litTimer);
    clearTimeout(noticeTimer);
    stopRepeat();
    clearInterval(voiceTickTimer);
    clearTimeout(voiceLimitTimer);
    clearStreamListener(onStream);
    voice.send({ type: "dispose" });
    session.send({ type: "dispose" });
  });

  function fromPage(data: string) {
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === "ready") {
      clearTimeout(bootTimer);
      const webMs = Date.now() - mountedAt;
      termWebReady(webMs);
      clientLog("info", "term.ready", { ms: webMs, fit: m.fit ?? null });
      pageReady = true;
      if (m.fit) session.send({ type: "fit", fit: m.fit });
      for (const x of toPage.splice(0)) web.postMessage(x);
      webReady.set(true);
    } else if (m.t === "fit") {
      session.send({ type: "fit", fit: m.fit });
    } else if (m.t === "ack" && sid() !== null) {
      notify("term.ack", { s: sid(), n: m.n });
    } else if (m.t === "drawn") {
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
          const path = await sendImage(Object.assign(blob, { name: "clipboard.png" }), address);
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
        uploading.set(`${i + 1}/${got.length}`);
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

  // ---- Hold-to-talk voice input (AVAudioRecorder → Mac Volcengine ASR → direct LiveLine)
  let recStartedAt = 0;
  function clearVoiceTimers() {
    clearInterval(voiceTickTimer);
    clearTimeout(voiceLimitTimer);
    voiceTickTimer = voiceLimitTimer = 0;
  }

  const voice = voiceHold((effects) => {
    voiceState.set(voice.state.phase === "rec" || voice.state.phase === "busy" ? voice.state.phase : "");
    for (const e of effects) runVoiceEffect(e);
  });

  function runVoiceEffect(e: string) {
    if (e === "start") {
      (async () => {
        try {
          notice.set("");
          await host.call("voice.start");
          voice.send({ type: "started" });
        } catch (err: any) {
          flashNotice(err.message || "录音启动失败");
          voice.send({ type: "startFailed" });
        }
      })();
    } else if (e === "recording") {
      recStartedAt = Date.now();
      voiceLeftSec.set(60);
      tapHaptic();
      voiceTickTimer = setInterval(() => {
        if (voice.state.phase !== "rec") return;
        voiceLeftSec.set(Math.max(0, Math.ceil((MAX_VOICE_MS - (Date.now() - recStartedAt)) / 1000)));
      }, 500);
      voiceLimitTimer = setTimeout(() => voice.send({ type: "release" }), MAX_VOICE_MS);
    } else if (e === "finish") {
      clearVoiceTimers();
      const elapsed = Date.now() - recStartedAt;
      if (elapsed < 400) {
        host.call("voice.cancel").catch(() => {});
        flashNotice("按住说话", 1200);
        voice.send({ type: "done" });
        return;
      }
      voice.send({ type: "busy" });
      (async () => {
        try {
          const res = await host.call<{ data: string; mime: string }>("voice.stop");
          if (!res?.data) { flashNotice("没录到声音"); return; }
          const { text } = await transcribeAudio(res.data, res.mime || "audio/mp4", address);
          if (text) {
            tapHaptic();
            const sep = line.value && !/\s$/.test(line.value) ? " " : "";
            line.set(line.value + sep + text);
            sync();
          } else {
            flashNotice("没听清");
          }
        } catch (err: any) {
          flashNotice(`识别失败：${err.message}`);
        } finally {
          voice.send({ type: "done" });
        }
      })();
    } else if (e === "cancel") {
      clearVoiceTimers();
      try { host.call("voice.cancel").catch(() => {}); } catch {}
    } else if (e === "hint") {
      flashNotice("按住说话", 1200);
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
    if (voiceState() === "rec") return { text: voiceLeftSec() <= 10 ? `松开输入 · ${voiceLeftSec()}s` : "松开输入", spin: false };
    if (voiceState() === "busy") return { text: "识别中…", spin: true };
    if (uploading()) return { text: `上传图片 ${uploading()}…`, spin: true };
    if (status() !== "ready") return { text: `重连 ${macName()}…`, spin: true };
    if (notice()) return { text: notice(), spin: false };
    return null;
  });

  return (
    <NavPage title={title()} headerVisible={false} statusBar={{ foreground: "light" }}>
      <View class="flex-1 bg-term-bg pt-[env(safe-area-inset-top)] pb-[env(keyboard-inset-height)]">
        {/* Session Header (Screenshot 3 without >_ or diff: circular glass < | 2-line title | circular glass 📁) */}
        <View class="flex-row items-center gap-2.5 border-b border-term-border px-3.5 pt-1 pb-2.5">
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
            <Text class="text-[17px] font-semibold text-term-fg" style={{ numberOfLines: 1 }}>
              {title()}
            </Text>
            <Text class="text-[13.5px] text-term-muted" style={{ numberOfLines: 1 }}>
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

        {/* Live OLED Black Terminal Stage */}
        <View class="relative flex-1 bg-term-bg">
          <WebView
            ref={web}
            html={TERM_HTML}
            style={{ flex: 1 }}
            scrollable={false}
            onMessage={(e) => fromPage(e.data)}
            testID="term-web"
          />

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

        {/* Floating Bottom Status Pill + Optional Quick Keys + Single Liquid Glass Composer Capsule */}
        <View class="items-center gap-2.5 bg-term-bg px-3 pt-1.5" style={{ paddingBottom: safeArea().bottom + 10 }}>
          <If when={floatingStatus()}>
            {(st) => (
              <GlassCapsule tone="term" class="h-9 gap-2 px-4">
                {st().spin ? <Icon src={spinnerIcon} size={15} class="tint-term-muted" /> : null}
                <Text class="text-[14px] font-medium text-term-fg" style={{ numberOfLines: 1 }}>
                  {st().text}
                </Text>
              </GlassCapsule>
            )}
          </If>

          <If when={keysOpen()}>
            <GlassCapsule tone="term" class="w-full px-1.5 py-1">
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
                    class={`h-[30px] min-w-[32px] items-center justify-center rounded-full bg-term-key px-2.5 active:bg-term-key-press ${
                      litKey() === label ? "border border-term-fg" : ""
                    }`}
                  >
                    <Text class="text-[12.5px] font-medium text-term-fg">{label}</Text>
                  </Button>
                ))}
                {agentShortcuts().map(([label, names]) => (
                  <Button
                    onPress={() => pressNamed(names, label)}
                    class={`h-[30px] min-w-[32px] items-center justify-center rounded-full bg-term-key px-2.5 active:bg-term-key-press ${
                      litKey() === label ? "border border-term-fg" : ""
                    }`}
                  >
                    <Text class="text-[12.5px] font-medium text-term-fg">{label}</Text>
                  </Button>
                ))}
                {named()
                  ? MODS.map((m) => {
                      const active = mods().includes(m);
                      return (
                        <Button
                          onPress={() => toggleMod(m)}
                          class={`h-[30px] min-w-[32px] items-center justify-center rounded-full px-2.5 active:bg-term-key-press ${
                            active ? "bg-term-fg" : "bg-term-key"
                          }`}
                        >
                          <Text class={`text-[12.5px] font-medium ${active ? "text-term-bg" : "text-term-fg"}`}>
                            {MOD_LABELS[m]}
                          </Text>
                        </Button>
                      );
                    })
                  : null}
                {KEYBAR_BACK.map(([label, seq]) => (
                  <Button
                    onPress={() => onKeyPress(label, seq)}
                    class={`h-[30px] min-w-[32px] items-center justify-center rounded-full bg-term-key px-2.5 active:bg-term-key-press ${
                      litKey() === label ? "border border-term-fg" : ""
                    }`}
                  >
                    <Text class="text-[12.5px] font-medium text-term-fg">{label}</Text>
                  </Button>
                ))}
              </Scroll>
            </GlassCapsule>
          </If>

          {/* Signature T3 Code Bottom Liquid Glass Capsule */}
          <GlassCapsule tone="term" class="h-12 w-full gap-1 pr-1.5 pl-2">
            <Button
              onPress={pick}
              class="h-9 w-9 items-center justify-center rounded-full active:bg-term-key-press"
              testID="pick"
              accessibilityLabel="插入图片"
            >
              <Icon src={plusIcon} size={20} class="tint-term-fg" />
            </Button>

            <Input
              ref={field}
              value={burst()}
              multiline
              submitBehavior="submit"
              returnKeyType="send"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="输入到终端"
              onChange={(e) => onInputChange(e.value)}
              onCompositionChange={(e) => { line.compose(e.composing); sync(); }}
              onKeyPress={(e) => { if (e.key === "Backspace") line.backspace(); }}
              onSubmit={send}
              class="max-h-20 flex-1 px-1 py-2 text-[15.5px] text-term-fg"
              testID="composer"
              accessibilityLabel="输入到终端"
            />

            <Button
              onPress={() => { tapHaptic(); keysOpen.set(!keysOpen()); }}
              class={`h-8 flex-row items-center gap-0.5 rounded-full px-2 active:bg-term-key-press ${
                keysOpen() ? "bg-term-key" : ""
              }`}
              testID="kbd-toggle"
              accessibilityLabel="终端快捷键"
            >
              <Icon src={kbdIcon} size={16} class="tint-term-fg" />
              <Icon src={chevronDownIcon} size={11} class="tint-term-muted" />
            </Button>

            <Button
              disabled={voiceState() === "busy"}
              onPressDown={() => {
                if (!host.available() || !info()?.voice) {
                  flashNotice(info()?.voice ? "当前环境不支持录音" : "Mac 未配置语音 Key");
                  return;
                }
                voice.send({ type: "press" });
              }}
              onPressUp={() => voice.send({ type: "release" })}
              onPress={() => {
                if (voice.state.phase === "rec" && Date.now() - recStartedAt >= 400) {
                  voice.send({ type: "release" });
                }
              }}
              class={`h-9 w-9 items-center justify-center rounded-full transition-colors duration-150 ${
                voiceState() === "rec" ? "bg-accent" : "active:bg-term-key-press"
              } ${voiceState() === "busy" ? "opacity-50" : ""}`}
              testID="voice"
              accessibilityLabel="按住说话"
            >
              <Icon src={micIcon} size={18} class="tint-term-fg" />
            </Button>

            <Button
              onPress={send}
              class={`h-9 w-9 items-center justify-center rounded-full transition-transform duration-150 active:scale-95 ${
                burst().trim() ? "bg-term-fg" : "bg-term-key"
              }`}
              testID="send"
              accessibilityLabel="发送回车"
            >
              <Icon
                src={sendUpIcon}
                size={17}
                class={burst().trim() ? "tint-term-bg" : "tint-term-fg"}
              />
            </Button>
          </GlassCapsule>
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
