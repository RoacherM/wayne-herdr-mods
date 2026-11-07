import "./src/shim";
import { cleanup, Clipboard, computed, effect, host, Image, Keyboard, lifecycle, mount, Picker, Scroll, signal, Text, View, WebView } from "nsh";
import type { InputRef, WebViewRef } from "nsh/types";
import { Button, createNavStack, Input, NavPage, NavStack } from "nsh/base";
import {
  addingMac, boot, cancelPair, desktops, forget, info, list, notify, paired, pairWith,
  problem, refresh, rpc, sas, sendImage, setStreamListener, status, switchDesktop, transcribeAudio, wake,
  type Saved, type Space, type Terminal,
} from "./src/conn";
import { TERM_HTML } from "./src/term-html";
import { LiveLine, PASTE_LF, pasteText } from "../app/src/live-line.js";
import { agentKeys, combo, keyOfChar, MODS } from "../app/src/agent-keys.js";
import arrowUp from "./assets/arrow-up.svg";
import chevron from "./assets/chevron.svg";
import micIcon from "./assets/mic.svg";
import plus from "./assets/plus.svg";
import terminalIcon from "./assets/terminal.svg";

type Route = { name: "home" } | { name: "term"; address: string } | { name: "settings" };
const nav = createNavStack<Route>([{ name: "home" }]);

const STATE_TEXT: Record<string, string> = { blocked: "等你处理", working: "工作中", done: "完成", idle: "空闲", error: "出错" };
const KIND_TEXT: Record<string, string> = { permission: "等你确认", question: "在问你", auth: "要登录" };
const STATE_TONE: Record<string, string> = { blocked: "bad", error: "bad", working: "warn", done: "ok" };
const STATUS_TEXT: Record<string, string> = { connecting: "连接中…", offline: "Mac 离线", ready: "已连接", error: "出错", idle: "未连接" };
const STATUS_TONE: Record<string, string> = { ready: "ok", connecting: "warn", offline: "idle", error: "bad", idle: "idle" };
const base = (p?: string) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "");
const tone = (state?: string | null) => STATE_TONE[state ?? ""] ?? "idle";
const BG: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-idle" };
const BADGE: Record<string, string> = { ok: "bg-ok/15 text-ok", warn: "bg-warn/15 text-warn", bad: "bg-bad/15 text-bad", idle: "bg-secondary text-muted-foreground" };
const tapHaptic = () => { if (host.available()) try { host.post("haptic"); } catch {} };

function Icon(props: { src: any; size?: number; color?: string }) {
  const n = props.size ?? 20;
  return <Image src={props.src} style={{ width: n, height: n, tintColor: props.color ?? "#8e8e93" }} />;
}

/** A space's name as Herdr.app shows it: its explicit name, or derived from its terminals' `where` label. */
function spaceName(space: Space, byAddr: Map<string, Terminal>) {
  if (space.name) return space.name;
  for (const tab of space.tabs) {
    for (const a of tab.terminals) {
      const w = byAddr.get(a)?.where;
      if (w) return w.replace(/ \/ \d+$/, "");
    }
  }
  return base(space.folder) || "工作区";
}

// ------------------------------------------------------------------ pairing ----------------
function PairScreen() {
  const text = signal("");
  const busy = computed(() => status() === "connecting" && !problem());
  async function go(linkStr?: string) {
    const raw = (linkStr ?? text()).trim();
    if (!raw) return;
    problem.set("");
    try { await pairWith(raw, "Herdr iPhone"); } catch (e: any) { console.warn(`pair failed: ${e.message}`); problem.set(e.message); }
  }
  async function scan() {
    problem.set("");
    try {
      const scanned = await host.call<string | null>("qr.scan", null, { timeout: 0 });
      if (scanned) { text.set(scanned); await go(scanned); }
    } catch (e: any) { problem.set(e.message || "无法打开相机扫码"); }
  }
  return (
    <View class="flex-1 bg-background px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <View class="flex-1 justify-center gap-6">
        <View class="items-center gap-3">
          <View class="h-[76px] w-[76px] items-center justify-center rounded-[20px] bg-foreground">
            <Icon src={terminalIcon} size={40} color="#30d158" />
          </View>
          <Text class="text-[28px] font-bold text-foreground">herdr 远程</Text>
          <Text class="text-center text-[15px] leading-snug text-muted-foreground">
            在 Mac 的 Herdr.app 右上角点手机图标，{"\n"}扫码或粘贴配对链接。
          </Text>
        </View>
        <View class="gap-3">
          {host.available() ? (
            <Button onPress={scan} disabled={busy()} class="h-[50px] items-center justify-center rounded-xl bg-primary active:opacity-80" testID="scan-qr">
              <Text class="text-[17px] font-semibold text-primary-foreground">扫描二维码</Text>
            </Button>
          ) : null}
          <View class="rounded-xl bg-card px-4">
            <Input value={text()} onChange={(e) => text.set(e.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoCorrect={false}
              class="py-3.5 text-[17px] text-foreground" testID="pair-link" />
          </View>
          <Button onPress={() => go()} disabled={busy() || !text()} class={`h-[50px] items-center justify-center rounded-xl ${host.available() ? "bg-card" : "bg-primary"} active:opacity-80 ${!text() ? "opacity-40" : ""}`}>
            <Text class={`text-[17px] font-semibold ${host.available() ? "text-primary" : "text-primary-foreground"}`}>{busy() ? "连接中…" : "配对"}</Text>
          </Button>
          <Button onPress={async () => { const c = await Clipboard.readText(); if (c) text.set(c); }} class="h-11 items-center justify-center active:opacity-50">
            <Text class="text-[17px] text-primary">从剪贴板粘贴</Text>
          </Button>
          {addingMac() || sas() ? (
            <Button onPress={cancelPair} class="h-11 items-center justify-center active:opacity-50" testID="cancel-pair">
              <Text class="text-[17px] text-muted-foreground">取消</Text>
            </Button>
          ) : null}
        </View>
        <If when={sas()}>
          {(code) => (
            <View class="items-center gap-1.5 rounded-xl bg-card p-5">
              <Text class="text-[13px] text-muted-foreground">确认 Mac 上显示的是这串数字，再在 Mac 上点允许</Text>
              <Text class="font-mono text-[40px] font-semibold tracking-[0.2em] text-foreground" testID="sas">{code()}</Text>
            </View>
          )}
        </If>
        <If when={problem()}>{(p) => <Text class="text-center text-[15px] text-bad">{p()}</Text>}</If>
        <If when={status() !== "idle" && !sas() && !problem()}>
          <Text class="text-center text-[13px] text-muted-foreground" testID="pair-status">{STATUS_TEXT[status()] ?? status()}</Text>
        </If>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ home -------------------
function Row(props: { t: Terminal; last: boolean }) {
  const t = props.t;
  const label = t.state === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : t.state === "idle" ? "" : STATE_TEXT[t.state ?? ""];
  const sub = [t.msg && t.state !== "idle" ? t.msg : null, base(t.cwd)].filter(Boolean).join(" · ");
  return (
    <Button onPress={() => nav.push({ name: "term", address: t.address })} class="flex-row items-center pl-4 active:bg-secondary" testID={`row-${t.address}`}>
      <View class={`h-2.5 w-2.5 rounded-full ${BG[tone(t.state)]}`} />
      <View class={`ml-3 min-h-[60px] flex-1 flex-row items-center gap-2 py-2.5 pr-3 ${props.last ? "" : "border-b border-separator"}`}>
        <View class="flex-1 gap-0.5">
          <View class="flex-row items-center gap-1.5">
            <Text class="text-[17px] text-card-foreground" style={{ numberOfLines: 1 }}>{t.app || t.program || "shell"}</Text>
            <Text class="text-[12px] text-muted-foreground">{t.address}</Text>
          </View>
          {sub ? <Text class="text-[14px] text-muted-foreground" style={{ numberOfLines: 1 }}>{sub}</Text> : null}
        </View>
        {label ? <Text class={`overflow-hidden rounded-full px-2 py-0.5 text-[12px] font-medium ${BADGE[tone(t.state)]}`}>{label}</Text> : null}
        <Icon src={chevron} size={14} color="#c4c4c7" />
      </View>
    </Button>
  );
}

function Group(props: { title: string; rows: Terminal[]; space?: Space }) {
  const adding = signal(false);
  async function add() {
    if (adding() || !props.space) return;
    adding.set(true);
    try {
      const { address } = (await rpc("term.new", { space: props.space.id }, 15_000)) as { address: string };
      await refresh();
      nav.push({ name: "term", address });
    } catch (e: any) { problem.set(e.message); } finally { adding.set(false); }
  }
  return (
    <View class="gap-1.5">
      <View class="min-h-7 flex-row items-end justify-between px-4">
        <Text class="text-[13px] text-muted-foreground">{props.title}</Text>
        {props.space ? (
          <Button onPress={add} disabled={adding()} class="flex-row items-center gap-1 active:opacity-50" testID={`add-${props.space.id}`}>
            <Icon src={plus} size={14} color="#007aff" />
            <Text class="text-[15px] text-primary">{adding() ? "新建中…" : "新终端"}</Text>
          </Button>
        ) : null}
      </View>
      {props.rows.length ? (
        <View class="overflow-hidden rounded-xl bg-card">
          {props.rows.map((t, i) => <Row t={t} last={i === props.rows.length - 1} />)}
        </View>
      ) : (
        <View class="rounded-xl bg-card px-4 py-3.5"><Text class="text-[15px] text-muted-foreground">没有终端</Text></View>
      )}
    </View>
  );
}

function HomeScreen() {
  effect(() => { if (lifecycle() === "active") wake(); });
  const groups = computed(() => {
    const { terminals, layout } = list();
    const byAddr = new Map(terminals.map((t) => [t.address, t]));
    const out: { title: string; rows: Terminal[]; space?: Space }[] = [];
    const waiting = terminals.filter((t) => t.state === "blocked" || t.state === "error");
    if (waiting.length) out.push({ title: `需要你 · ${waiting.length}`, rows: waiting });
    const placed = new Set<string>();
    for (const space of layout) {
      const rows = space.tabs.flatMap((tab) => tab.terminals).map((a) => byAddr.get(a)).filter(Boolean) as Terminal[];
      rows.forEach((t) => placed.add(t.address));
      out.push({ title: spaceName(space, byAddr), rows, space });
    }
    const loose = terminals.filter((t) => !placed.has(t.address));
    if (loose.length) out.push({ title: "其他终端", rows: loose });
    return out;
  });
  return (
    <NavPage title={paired()?.desktopName ?? info()?.desktopName ?? "Mac"} headerLargeTitle>
      <Scroll class="flex-1 bg-background" contentClass="gap-5 px-4 pb-10 pt-2">
        {desktops().length > 1 ? (
          <Scroll horizontal scrollbar={false} class="flex-none" contentClass="flex-row gap-2">
            {desktops().map((d: Saved) => {
              const active = d.desktopId === paired()?.desktopId;
              return (
                <Button onPress={() => switchDesktop(d.desktopId)} class={`h-9 flex-row items-center gap-1.5 rounded-full px-3.5 ${active ? "bg-primary" : "bg-card"}`} testID={`mac-${d.desktopId}`}>
                  <Text class={`text-[14px] font-medium ${active ? "text-primary-foreground" : "text-card-foreground"}`}>{d.desktopName || "Mac"}</Text>
                </Button>
              );
            })}
          </Scroll>
        ) : null}
        <Button onPress={() => nav.push({ name: "settings" })} class="flex-row items-center gap-3 rounded-xl bg-card py-3 pl-3 pr-3 active:opacity-60" testID="settings">
          <View class="h-10 w-10 items-center justify-center rounded-[10px] bg-foreground">
            <Icon src={terminalIcon} size={22} color="#30d158" />
          </View>
          <View class="flex-1 gap-0.5">
            <View class="flex-row items-center gap-1.5">
              <View class={`h-2 w-2 rounded-full ${BG[STATUS_TONE[status()] ?? "idle"]}`} />
              <Text class="text-[17px] text-card-foreground" testID="status">{STATUS_TEXT[status()] ?? status()}</Text>
            </View>
            <Text class="text-[13px] text-muted-foreground" style={{ numberOfLines: 1 }}>{problem() || `${list().terminals.length} 个终端 · 端到端加密`}</Text>
          </View>
          <Icon src={chevron} size={14} color="#c4c4c7" />
        </Button>
        {list().core && list().core !== "online" ? <Text class="px-1 text-[15px] text-muted-foreground">Mac 在线，但 Herdr 没有运行。</Text> : null}
        {groups().map((g) => <Group title={g.title} rows={g.rows} space={g.space} />)}
      </Scroll>
    </NavPage>
  );
}

function Field(props: { label: string; value: string; last?: boolean }) {
  return (
    <View class={`ml-4 min-h-11 flex-row items-center gap-3 py-2.5 pr-4 ${props.last ? "" : "border-b border-separator"}`}>
      <Text class="text-[17px] text-card-foreground">{props.label}</Text>
      <Text class="flex-1 text-right text-[17px] text-muted-foreground" style={{ numberOfLines: 1 }}>{props.value}</Text>
    </View>
  );
}

function SettingsScreen() {
  return (
    <NavPage title="设置" headerClass="bg-background">
      <Scroll class="flex-1 bg-background" contentClass="gap-7 px-4 pt-4 pb-10">
        <View class="gap-1.5">
          <Text class="px-4 text-[13px] text-muted-foreground">当前设备</Text>
          <View class="overflow-hidden rounded-xl bg-card">
            <Field label="电脑" value={paired()?.desktopName ?? "Mac"} />
            <Field label="这台设备" value={info()?.deviceName ?? "—"} />
            <Field label="中继" value={(paired()?.relay ?? "—").replace(/^https?:\/\//, "")} last />
          </View>
          <Text class="px-4 text-[13px] leading-snug text-muted-foreground">消息端到端加密，中继只转发看不懂的密文。</Text>
        </View>
        <View class="gap-1.5">
          <Text class="px-4 text-[13px] text-muted-foreground">已配对的 Mac（{desktops().length}）</Text>
          <View class="overflow-hidden rounded-xl bg-card">
            {desktops().map((d: Saved, i: number) => {
              const active = d.desktopId === paired()?.desktopId;
              return (
                <Button onPress={() => { switchDesktop(d.desktopId); nav.pop(); }}
                  class={`ml-4 min-h-11 flex-row items-center gap-3 py-2.5 pr-4 ${i === desktops().length - 1 ? "" : "border-b border-separator"}`}>
                  <View class={`h-2 w-2 rounded-full ${active ? "bg-ok" : "bg-idle"}`} />
                  <Text class="flex-1 text-[17px] text-card-foreground" style={{ numberOfLines: 1 }}>{d.desktopName || "Mac"}</Text>
                  <Text class="text-[14px] text-muted-foreground">{active ? "当前" : "切换"}</Text>
                </Button>
              );
            })}
          </View>
          <Button onPress={() => { nav.pop(); addingMac.set(true); }} class="h-11 items-center justify-center rounded-xl bg-card active:opacity-60" testID="add-mac">
            <Text class="text-[17px] text-primary">配对另一台 Mac</Text>
          </Button>
        </View>
        <Button onPress={async () => { nav.pop(); await forget(); }} class="h-11 items-center justify-center rounded-xl bg-card active:opacity-60">
          <Text class="text-[17px] text-destructive">取消配对</Text>
        </Button>
      </Scroll>
    </NavPage>
  );
}

// ------------------------------------------------------------------ terminal ---------------
const DARK = { bar: "#1c1c1e", tint: "#0a84ff" };
// Matches DESIGN.md「键盘栏的顺序」: Esc ← ↑ ↓ → ⏎ ⇧Tab ^C │ agent keys │ ^ ⌥ ⇧ │ Tab 粘贴 换行 1 2 3 y n ^D ^R ^L
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function TermScreen(props: { address: string }) {
  const address = props.address;
  const term = computed(() => list().terminals.find((t) => t.address === address));
  const blocked = computed(() => term()?.state === "blocked");
  const cursorHidden = signal(true);
  const appCursor = signal(false);
  const letGo = signal(false);
  const held = computed(() => blocked() && cursorHidden() && !letGo());
  const atLatest = signal(true);
  const notice = signal("");
  const burst = signal("");
  const pending = signal("");
  const composing = signal("");
  const focused = signal(false);
  const uploading = signal("");
  const voiceState = signal<"" | "rec" | "busy">("");
  const mods = signal<string[]>([]);
  const litKey = signal("");
  let litTimer: any = 0;

  let field!: InputRef;
  let web!: WebViewRef;
  let s: number | null = null;
  let opening = false;
  let pageReady = false;
  let closed = false;
  let sized = false;
  let opened = false;
  let leads = true;
  let lastFit: { cols: number; rows: number } | null = null;
  let fitSent = "";
  const toPage: string[] = [];
  const early: any[] = [];
  const post = (v: object) => { const m = JSON.stringify(v); if (pageReady) web.postMessage(m); else toPage.push(m); };

  function refit(away = false) {
    if (s === null || !sized || status() !== "ready") return;
    const fit = away ? null : lastFit;
    const key = JSON.stringify(fit);
    if (key === fitSent) return;
    fitSent = key;
    notify("term.fit", { s, fit });
  }

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

  let chain = Promise.resolve();
  function out(d: string, after = 0, scrollLatest = true) {
    if (scrollLatest) post({ t: "typing" });
    chain = chain.then(async () => {
      if (s !== null) notify("term.input", { s, d });
      if (after) await sleep(after);
    });
  }
  const line = new LiveLine((d) => out(d));
  const sync = () => { burst.set(line.value); pending.set(line.pending); };

  function onStream(msg: any) {
    if (s === null && opening) { early.push(msg); return; }
    if (msg.s !== s) return;
    if (msg.ev === "out") post({ t: "out", d: msg.d, fresh: Boolean(msg.fresh) });
    else if (msg.ev === "size") {
      post({ t: "size", cols: msg.cols, rows: msg.rows });
      leads = fitSent === JSON.stringify({ cols: msg.cols, rows: msg.rows });
    } else if (msg.ev === "closed") {
      s = null;
      if (msg.reason === "replaced" || closed) return;
      notice.set(msg.reason === "exited" ? "程序已退出" : "连接断开，正在重连…");
      if (msg.reason !== "exited") setTimeout(open, 800);
    }
  }

  async function open() {
    if (opening || closed || status() !== "ready") return;
    opening = true;
    early.length = 0;
    try {
      const r = (await rpc("term.open", { address, fit: lastFit, lead: leads || !opened })) as {
        s: number; cols: number; rows: number; sized?: boolean;
      };
      fitSent = JSON.stringify(lastFit);
      if (closed) { rpc("term.close", { s: r.s }).catch(() => {}); return; }
      s = r.s;
      sized = r.sized === true;
      post({ t: "open", sized, reopened: opened, cols: r.cols, rows: r.rows });
      opened = true;
      notice.set("");
      for (const m of early.splice(0)) onStream(m);
    } catch (e: any) { notice.set(`打不开：${e.message}`); } finally { opening = false; }
  }

  setStreamListener(onStream);
  effect(() => { if (status() === "ready" && s === null) open(); else if (status() !== "ready") s = null; });
  effect(() => { const t = term(); if (t && !sized) post({ t: "size", cols: t.cols, rows: t.rows }); });
  effect(() => { if (!blocked()) letGo.set(false); });
  effect(() => { line.hold(held()); sync(); });
  effect(() => {
    const st = lifecycle();
    if (st === "active") { wake(); refit(false); }
    else if (st === "background") refit(true);
  });
  cleanup(() => {
    closed = true;
    clearTimeout(litTimer);
    setStreamListener(null);
    if (voiceState() === "rec" && host.available()) host.call("voice.cancel").catch(() => {});
    if (s !== null) rpc("term.close", { s }).catch(() => {});
  });

  function fromPage(data: string) {
    let m: any; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "ready") {
      pageReady = true;
      if (m.fit) { lastFit = m.fit; refit(false); }
      for (const x of toPage.splice(0)) web.postMessage(x);
    } else if (m.t === "fit") {
      lastFit = m.fit;
      refit(false);
    } else if (m.t === "ack" && s !== null) {
      notify("term.ack", { s, n: m.n });
    } else if (m.t === "drawn") {
      clearLit();
      cursorHidden.set(Boolean(m.cursorHidden));
      appCursor.set(Boolean(m.appCursor));
    } else if (m.t === "atLatest") {
      atLatest.set(Boolean(m.on));
    } else if (m.t === "wheel" && s !== null) {
      notify("term.input", { s, d: m.d });
    } else if (m.t === "coast" && s !== null) {
      if (m.stop) notify("term.coast", { s, stop: true });
      else notify("term.coast", { s, d: m.d, v: m.v, cell: m.cell });
    } else if (m.t === "tap") {
      field.focus();
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
    line.commit(); sync();
    post({ t: "typing" });
    chain = chain.then(() => { if (s !== null) notify("term.press", { s, keys: klist }); });
  }

  async function pasteFromClipboard() {
    if (held()) { notice.set("先回答终端里的问题，再粘贴（或点上方黄条直接输入）"); return; }
    try {
      if (await Clipboard.hasImage()) {
        const img = await Clipboard.readImage();
        if (img?.url) {
          uploading.set("剪贴板图片");
          const res = await fetch(img.url);
          const blob = await res.blob();
          const path = await sendImage(Object.assign(blob, { name: "clipboard.png" }), address);
          line.commit(); sync();
          out(pasteText(/\s/.test(path) ? `"${path}"` : path), 400);
          out(" ");
          return;
        }
      }
      const txt = await Clipboard.readText();
      if (!txt) { notice.set("剪贴板是空的"); return; }
      tapHaptic();
      line.commit(); sync();
      out(pasteText(txt.replace(/\r\n?/g, "\n")));
    } catch (e: any) { notice.set(`粘贴失败：${e.message}`); } finally { uploading.set(""); }
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
    line.commit(); sync();
    const bytes = ARROWS[seq] ? `\x1b${appCursor() ? "O" : "["}${ARROWS[seq]}` : seq;
    out(bytes);
  }

  function send() {
    if (mods().length && named()) { pressNamed(combo(new Set(mods()), "enter"), "⏎"); return; }
    if (!line.submit()) { notice.set("先回答终端里的问题（或点黄条直接打字），刚打的字随后会进去"); return; }
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
    if (held()) { notice.set("先回答终端里的问题，再插图片"); return; }
    try {
      const got = await Picker.pickImages({ multiple: true, limit: 6, maxDimension: 2048, quality: 0.85 });
      for (const [i, g] of got.entries()) {
        uploading.set(`${i + 1}/${got.length}`);
        const path = await sendImage(g.file, address);
        line.commit(); sync();
        out(pasteText(/\s/.test(path) ? `"${path}"` : path), 400);
        out(" ");
      }
    } catch (e: any) { notice.set(`图片没发出去：${e.message}`); } finally { uploading.set(""); }
  }

  // ---- Voice input via Swift host (AVAudioRecorder → Mac Volcengine flash ASR)
  let recStartedAt = 0;
  async function startVoice() {
    if (!host.available() || !info()?.voice) {
      notice.set("这台 Mac 没配语音识别：在 Mac 上运行 wayne-herdr-mods voice key");
      return;
    }
    if (voiceState() !== "") return;
    try {
      notice.set("");
      await host.call("voice.start");
      recStartedAt = Date.now();
      tapHaptic();
      voiceState.set("rec");
    } catch (e: any) {
      notice.set(e.message || "录音启动失败");
    }
  }
  async function stopVoice(cancel = false) {
    if (voiceState() !== "rec") return;
    if (cancel) {
      voiceState.set("");
      await host.call("voice.cancel").catch(() => {});
      return;
    }
    voiceState.set("busy");
    try {
      const res = await host.call<{ data: string; mime: string }>("voice.stop");
      if (!res?.data) { notice.set("没录到声音，请再说一次"); return; }
      const { text } = await transcribeAudio(res.data, res.mime || "audio/mp4", address);
      if (text) {
        tapHaptic();
        const sep = line.value && !/\s$/.test(line.value) ? " " : "";
        line.set(line.value + sep + text);
        sync();
      } else {
        notice.set("没听清，请再说一次");
      }
    } catch (e: any) {
      notice.set(`语音识别失败：${e.message}`);
    } finally {
      voiceState.set("");
    }
  }

  const title = computed(() => { const t = term(); return t ? t.app || t.program || address : address; });
  const subtitle = computed(() => {
    const t = term();
    if (!t) return "";
    const st = t.state === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : STATE_TEXT[t.state ?? ""];
    return [t.where || base(t.cwd), st].filter(Boolean).join(" · ");
  });
  const banner = computed(() => {
    if (voiceState() === "rec") return { text: "正在录音… 松开或点「完成」识别", tap: false };
    if (voiceState() === "busy") return { text: "正在识别语音…", tap: false };
    if (uploading()) return { text: `上传图片 ${uploading()}…`, tap: false };
    if (held() && pending()) return { text: `等你回答后输入：${pending()} · 点这里照样输入`, tap: true };
    if (held()) return { text: "终端在问你 · 点这里照样打字", tap: true };
    if (pending()) return { text: `待输入：${pending()}`, tap: false };
    if (notice()) return { text: notice(), tap: false };
    return null;
  });
  const handle = computed(() =>
    composing() ? { text: composing(), color: "#ffffff" }
    : pending() ? { text: `待输入：${pending()}`, color: "#ffd60a" }
    : focused() ? { text: "直接打字，字会出现在终端里", color: "#8d8d93" }
    : { text: "轻点这里或终端，开始输入", color: "#8d8d93" });

  return (
    <NavPage title={title()} headerStyle={{ backgroundColor: DARK.bar, color: "#ffffff", tintColor: DARK.tint }} statusBar={{ foreground: "light" }}
      headerTitle={
        <View class="items-center">
          <Text class="text-[16px] font-semibold text-white" style={{ numberOfLines: 1 }}>{title()}</Text>
          {subtitle() ? <Text class="text-[11px] text-[#8d8d93]" style={{ numberOfLines: 1 }}>{subtitle()}</Text> : null}
        </View>
      }>
      <View class="flex-1 bg-[#0b0b0c] pb-[env(keyboard-inset-height)]">
        <View class="relative flex-1">
          <WebView ref={web} html={TERM_HTML} style={{ flex: 1 }} scrollable={false} onMessage={(e) => fromPage(e.data)} testID="term-web" />
          <If when={!atLatest()}>
            <Button onPress={() => post({ t: "toLatest" })}
              class="absolute right-3 bottom-3 h-9 w-9 items-center justify-center rounded-full border border-[#3a3a3c] bg-[#1c1c1e]/90"
              testID="to-latest" accessibilityLabel="回到最新">
              <Text class="text-[16px] font-bold text-[#f2f2f7]">↓</Text>
            </Button>
          </If>
        </View>
        <If when={banner()}>
          {(b) => (
            <Button onPress={() => { if (b().tap) { letGo.set(true); field.focus(); } else notice.set(""); }}
              class="flex-row items-center justify-between bg-[#3a2e00] px-4 py-2" testID="term-banner">
              <Text class="flex-1 text-[13px] text-[#ffd60a]">{b().text}</Text>
              {voiceState() === "rec" ? (
                <View class="flex-row gap-3">
                  <Button onPress={() => stopVoice(true)} class="rounded bg-[#48484a] px-2.5 py-1"><Text class="text-[12px] text-white">取消</Text></Button>
                  <Button onPress={() => stopVoice(false)} class="rounded bg-[#0a84ff] px-2.5 py-1"><Text class="text-[12px] font-semibold text-white">完成</Text></Button>
                </View>
              ) : null}
            </Button>
          )}
        </If>
        <View class="gap-2 bg-[#1c1c1e] px-2 pt-2 pb-[env(safe-area-inset-bottom)]">
          <Scroll horizontal scrollbar={false} keyboardShouldPersistTaps="always" class="flex-none" contentClass="flex-row items-center gap-1.5 px-0.5">
            {KEYBAR_FRONT.map(([label, seq]) => (
              <Button onPress={() => key(label, seq)}
                class={`h-[34px] min-w-[40px] items-center justify-center rounded-lg px-2.5 bg-[#2c2c2e] active:bg-[#48484a] ${litKey() === label ? "border border-[#ffd60a]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2f2f7]">{label}</Text>
              </Button>
            ))}
            {agentShortcuts().map(([label, names]) => (
              <Button onPress={() => pressNamed(names, label)}
                class={`h-[34px] min-w-[40px] items-center justify-center rounded-lg px-2.5 bg-[#253040] active:bg-[#3a4a60] ${litKey() === label ? "border border-[#ffd60a]" : ""}`}>
                <Text class="text-[14px] font-medium text-[#7cc0ff]">{label}</Text>
              </Button>
            ))}
            {named() ? MODS.map((m) => {
              const active = mods().includes(m);
              return (
                <Button onPress={() => toggleMod(m)}
                  class={`h-[34px] min-w-[38px] items-center justify-center rounded-lg px-2.5 ${active ? "bg-[#0a84ff]" : "bg-[#2c2c2e]"}`}>
                  <Text class="text-[15px] font-semibold text-[#f2f2f7]">{MOD_LABELS[m]}</Text>
                </Button>
              );
            }) : null}
            {KEYBAR_BACK.map(([label, seq]) => (
              <Button onPress={() => key(label, seq)}
                class={`h-[34px] min-w-[40px] items-center justify-center rounded-lg px-2.5 bg-[#2c2c2e] active:bg-[#48484a] ${litKey() === label ? "border border-[#ffd60a]" : ""}`}>
                <Text class="text-[14px] font-medium text-[#f2f2f7]">{label}</Text>
              </Button>
            ))}
          </Scroll>
          <View class="flex-row items-center gap-1.5 pb-1">
            <Button onPress={pick} class="h-9 w-9 items-center justify-center rounded-full bg-[#2c2c2e] active:bg-[#48484a]" testID="pick" accessibilityLabel="插入图片">
              <Icon src={plus} size={20} color="#aeaeb2" />
            </Button>
            {host.available() && info()?.voice ? (
              <Button
                onPressDown={() => startVoice()}
                onPressUp={() => { if (voiceState() === "rec" && Date.now() - recStartedAt >= 400) stopVoice(false); }}
                onPress={() => { if (voiceState() === "rec" && Date.now() - recStartedAt >= 400) stopVoice(false); }}
                class={`h-9 w-9 items-center justify-center rounded-full ${voiceState() === "rec" ? "bg-[#ff453a]" : "bg-[#2c2c2e]"} active:bg-[#48484a]`}
                testID="voice" accessibilityLabel="按住说话">
                <Icon src={micIcon} size={18} color={voiceState() === "rec" ? "#ffffff" : "#aeaeb2"} />
              </Button>
            ) : null}
            <View class="h-9 flex-1 justify-center overflow-hidden rounded-[18px] bg-[#2c2c2e] px-3.5">
              <Text class="text-[15px]" style={{ color: handle().color, numberOfLines: 1 }} testID="handle">{handle().text}</Text>
              <Input ref={field} value={burst()} multiline submitBehavior="submit" returnKeyType="send" autoCapitalize="none" autoCorrect={false}
                onChange={(e) => onInputChange(e.value)}
                onCompositionChange={(e) => { composing.set(e.composing ? e.text : ""); line.compose(e.composing); sync(); }}
                onKeyPress={(e) => { if (e.key === "Backspace") line.backspace(); }}
                onSubmit={send} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
                class="absolute inset-0 text-[15px] opacity-[0.02]" testID="composer" accessibilityLabel="输入到终端" />
            </View>
            <Button onPress={() => { if (focused()) Keyboard.dismiss(); else field.focus(); }}
              class={`h-9 px-2.5 items-center justify-center rounded-full ${focused() ? "bg-[#0a84ff]" : "bg-[#2c2c2e]"}`}
              testID="kbd-toggle" accessibilityLabel="切换键盘">
              <Text class="text-[13px] font-medium text-[#f2f2f7]">{focused() ? "收起" : "键盘"}</Text>
            </Button>
            <Button onPress={send} class={`h-9 w-9 items-center justify-center rounded-full ${pending() ? "bg-[#3a3a3c]" : "bg-[#0a84ff]"}`} testID="send" accessibilityLabel="回车">
              <Icon src={arrowUp} size={18} color="#ffffff" />
            </Button>
          </View>
        </View>
      </View>
    </NavPage>
  );
}

// ------------------------------------------------------------------ root -------------------
function App() {
  const showHome = computed(() => Boolean(paired()) && !addingMac());
  return (
    <If when={showHome()} else={<PairScreen />}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => route.name === "home" ? <HomeScreen /> : route.name === "settings" ? <SettingsScreen /> : <TermScreen address={route.address} />}
      </NavStack>
    </If>
  );
}

boot();
mount(App);
