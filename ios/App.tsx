import "./src/shim";
import { cleanup, Clipboard, computed, effect, Image, mount, Picker, Scroll, signal, Text, View, WebView } from "nsh";
import type { InputRef, WebViewRef } from "nsh/types";
import { Button, createNavStack, Input, NavPage, NavStack } from "nsh/base";
import { boot, forget, info, list, notify, paired, pairWith, problem, refresh, rpc, sas, sendImage, setStreamListener, status, type Space, type Terminal } from "./src/conn";
import { TERM_HTML } from "./src/term-html";
import { LiveLine, pasteText } from "../app/src/live-line.js";
import arrowUp from "./assets/arrow-up.svg";
import chevron from "./assets/chevron.svg";
import plus from "./assets/plus.svg";
import terminalIcon from "./assets/terminal.svg";

type Route = { name: "home" } | { name: "term"; address: string } | { name: "settings" };
const nav = createNavStack<Route>([{ name: "home" }]);

const STATE_TEXT: Record<string, string> = { blocked: "等你处理", working: "工作中", done: "完成", idle: "空闲", error: "出错" };
const KIND_TEXT: Record<string, string> = { permission: "等你确认", question: "在问你", auth: "要登录" };
// Theme tokens (theme.json): iOS system colors, light and dark.
const STATE_TONE: Record<string, string> = { blocked: "bad", error: "bad", working: "warn", done: "ok" };
const STATUS_TEXT: Record<string, string> = { connecting: "连接中…", offline: "Mac 离线", ready: "已连接", error: "出错", idle: "未连接" };
const STATUS_TONE: Record<string, string> = { ready: "ok", connecting: "warn", offline: "idle", error: "bad", idle: "idle" };
const base = (p?: string) => (p ? p.replace(/\/+$/, "").split("/").pop() : "");
const tone = (state?: string | null) => STATE_TONE[state ?? ""] ?? "idle";
const BG: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", idle: "bg-idle" };
const BADGE: Record<string, string> = { ok: "bg-ok/15 text-ok", warn: "bg-warn/15 text-warn", bad: "bg-bad/15 text-bad", idle: "bg-secondary text-muted-foreground" };

function Icon(props: { src: any; size?: number; color?: string }) {
  const n = props.size ?? 20;
  return <Image src={props.src} style={{ width: n, height: n, tintColor: props.color ?? "#8e8e93" }} />;
}

// ------------------------------------------------------------------ pairing ----------------
function PairScreen() {
  const text = signal("");
  const busy = computed(() => status() === "connecting" && !problem());
  async function go() {
    problem.set("");
    try { await pairWith(text(), "nsh iPhone"); } catch (e: any) { console.warn(`pair failed: ${e.message}`); problem.set(e.message); }
  }
  return (
    <View class="flex-1 bg-background px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <View class="flex-1 justify-center gap-7">
        <View class="items-center gap-3">
          <View class="h-[76px] w-[76px] items-center justify-center rounded-[20px] bg-foreground">
            <Icon src={terminalIcon} size={40} color="#30d158" />
          </View>
          <Text class="text-[28px] font-bold text-foreground">herdr 远程</Text>
          <Text class="text-center text-[15px] leading-snug text-muted-foreground">在 Mac 的终端运行 herdr-relay pair，{"\n"}把配对链接粘贴到这里。</Text>
        </View>
        <View class="gap-3">
          <View class="rounded-xl bg-card px-4">
            <Input value={text()} onChange={(e) => text.set(e.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoCorrect={false}
              class="py-3.5 text-[17px] text-foreground" testID="pair-link" />
          </View>
          <Button onPress={go} disabled={busy() || !text()} class={`h-[50px] items-center justify-center rounded-xl bg-primary active:opacity-80 ${!text() ? "opacity-40" : ""}`}>
            <Text class="text-[17px] font-semibold text-primary-foreground">{busy() ? "连接中…" : "配对"}</Text>
          </Button>
          <Button onPress={async () => text.set(await Clipboard.readText())} class="h-11 items-center justify-center active:opacity-50">
            <Text class="text-[17px] text-primary">从剪贴板粘贴</Text>
          </Button>
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
          <Text class="text-[17px] text-card-foreground" style={{ numberOfLines: 1 }}>{t.app || t.program || "shell"}</Text>
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
      out.push({ title: space.name || base(space.folder) || "工作区", rows, space });
    }
    const loose = terminals.filter((t) => !placed.has(t.address));
    if (loose.length) out.push({ title: "其他终端", rows: loose });
    return out;
  });
  return (
    <NavPage title={paired()?.desktopName ?? info()?.desktopName ?? "Mac"} headerLargeTitle>
      <Scroll class="flex-1 bg-background" contentClass="gap-6 px-4 pb-10 pt-2">
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
      <Scroll class="flex-1 bg-background" contentClass="gap-8 px-4 pt-4">
        <View class="gap-1.5">
          <Text class="px-4 text-[13px] text-muted-foreground">已配对</Text>
          <View class="overflow-hidden rounded-xl bg-card">
            <Field label="电脑" value={paired()?.desktopName ?? "Mac"} />
            <Field label="这台设备" value={info()?.deviceName ?? "—"} />
            <Field label="中继" value={(paired()?.relay ?? "—").replace(/^https?:\/\//, "")} last />
          </View>
          <Text class="px-4 text-[13px] leading-snug text-muted-foreground">消息端到端加密，中继只转发看不懂的密文。</Text>
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
const KEYBAR: [string, string][] = [
  ["Esc", "\x1b"], ["Tab", "\t"], ["^C", "\x03"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["⏎", "\r"],
  ["1", "1"], ["2", "2"], ["3", "3"], ["y", "y"], ["n", "n"], ["⇧Tab", "\x1b[Z"], ["^D", "\x04"],
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function TermScreen(props: { address: string }) {
  const address = props.address;
  const term = computed(() => list().terminals.find((t) => t.address === address));
  const blocked = computed(() => term()?.state === "blocked");
  const notice = signal("");
  // One input box: the program's own line. The field below is only a keyboard (src: live-line.js).
  const burst = signal("");       // the field's text: typed since the last commit
  const pending = signal("");     // part of it that has not gone in (held while the program asks)
  const composing = signal("");   // pinyin being composed
  const focused = signal(false);
  const uploading = signal("");
  let field!: InputRef;
  let web!: WebViewRef;
  let s: number | null = null;
  let opening = false;
  let pageReady = false;
  let closed = false;
  const toPage: string[] = []; // held until the page says ready
  const early: any[] = []; // stream events that beat term.open's reply
  const post = (v: object) => { const m = JSON.stringify(v); if (pageReady) web.postMessage(m); else toPage.push(m); };

  // Everything typed goes out in order; an image path waits for the program to read the file.
  let chain = Promise.resolve();
  function out(d: string, after = 0) {
    chain = chain.then(async () => {
      if (s !== null) { notify("term.input", { s, d }); post({ t: "typing" }); }
      if (after) await sleep(after);
    });
  }
  const line = new LiveLine((d) => out(d));
  const sync = () => { burst.set(line.value); pending.set(line.pending); };

  function onStream(msg: any) {
    if (s === null && opening) { early.push(msg); return; }
    if (msg.s !== s) return;
    if (msg.ev === "out") post({ t: "out", d: msg.d });
    else if (msg.ev === "closed") {
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
      const r = (await rpc("term.open", { address })) as { s: number; cols: number; rows: number };
      if (closed) { rpc("term.close", { s: r.s }).catch(() => {}); return; }
      s = r.s;
      post({ t: "reset" });
      post({ t: "size", cols: r.cols, rows: r.rows });
      notice.set("");
      for (const m of early.splice(0)) onStream(m);
    } catch (e: any) { notice.set(`打不开：${e.message}`); } finally { opening = false; }
  }

  setStreamListener(onStream);
  // (Re)open whenever the link becomes ready: first entry, and after every reconnect.
  effect(() => { if (status() === "ready" && s === null) open(); else if (status() !== "ready") s = null; });
  // Follow the Mac windows' size.
  effect(() => { const t = term(); if (t) post({ t: "size", cols: t.cols, rows: t.rows }); });
  // While the program asks, typing waits: a letter could answer its question.
  effect(() => { line.hold(blocked()); sync(); });
  cleanup(() => {
    closed = true;
    setStreamListener(null);
    if (s !== null) rpc("term.close", { s }).catch(() => {});
  });

  function fromPage(data: string) {
    let m: any; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "ready") { pageReady = true; for (const x of toPage.splice(0)) web.postMessage(x); }
    else if (m.t === "ack" && s !== null) notify("term.ack", { s, n: m.n });
    else if (m.t === "tap") field.focus();
    else if (m.t === "log") console.warn(`term page: ${m.m}`);
  }

  /** A key from the bar: the program owns what went in (Tab may complete it), then the key. */
  function key(seq: string) {
    line.commit(); sync();
    out(seq);
  }
  function send() {
    if (!line.submit()) { notice.set("先回答终端里的问题（1 / 2 / 3、⏎ 或 Esc），刚打的字随后会进去"); return; }
    notice.set("");
    sync();
  }
  /** Images go into the program's line as their own pastes: Claude Code / Codex show [Image #N]. */
  async function pick() {
    if (blocked()) { notice.set("先回答终端里的问题，再插图片"); return; }
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

  const title = computed(() => { const t = term(); return t ? t.app || t.program || address : address; });
  const subtitle = computed(() => {
    const t = term();
    if (!t) return "";
    const st = t.state === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : STATE_TEXT[t.state ?? ""];
    return [t.where || base(t.cwd), st].filter(Boolean).join(" · ");
  });
  // What the handle says: it is not a second input box, the program's line is.
  const handle = computed(() =>
    uploading() ? { text: `上传图片 ${uploading()}…`, color: "#8d8d93" }
    : composing() ? { text: composing(), color: "#ffffff" }
    : pending() ? { text: `等你回答后输入：${pending()}`, color: "#ffd60a" }
    : blocked() ? { text: "终端在问你：用上面的蓝色键回答", color: "#ffd60a" }
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
        <WebView ref={web} html={TERM_HTML} style={{ flex: 1 }} scrollable={false} onMessage={(e) => fromPage(e.data)} testID="term-web" />
        <If when={notice()}>{(n) => <Text class="bg-[#3a2e00] px-4 py-2 text-[13px] text-[#ffd60a]">{n()}</Text>}</If>
        <View class="gap-2 bg-[#1c1c1e] px-2 pt-2 pb-[env(safe-area-inset-bottom)]">
          <Scroll horizontal scrollbar={false} class="flex-none" contentClass="flex-row gap-1.5 px-0.5">
            {KEYBAR.map(([label, seq]) => (
              <Button onPress={() => key(seq)} class={`h-[34px] min-w-[42px] items-center justify-center rounded-lg px-3 ${blocked() && /^[123yn⏎]$|^Esc$/.test(label) ? "bg-[#0a84ff]" : "bg-[#2c2c2e]"} active:bg-[#48484a]`}>
                <Text class="text-[15px] font-medium text-[#f2f2f7]">{label}</Text>
              </Button>
            ))}
          </Scroll>
          <View class="flex-row items-center gap-2 pb-1">
            <Button onPress={pick} class="h-9 w-9 items-center justify-center rounded-full bg-[#2c2c2e] active:bg-[#48484a]" testID="pick" accessibilityLabel="插入图片">
              <Icon src={plus} size={20} color="#aeaeb2" />
            </Button>
            <View class="h-9 flex-1 justify-center overflow-hidden rounded-[18px] bg-[#2c2c2e] px-3.5">
              <Text class="text-[15px]" style={{ color: handle().color, numberOfLines: 1 }} testID="handle">{handle().text}</Text>
              {/* The keyboard: nearly invisible (alpha 0 would not take taps), over the handle. */}
              <Input ref={field} value={burst()} multiline submitBehavior="submit" returnKeyType="send" autoCapitalize="none" autoCorrect={false}
                onChange={(e) => { line.set(e.value); sync(); }}
                onCompositionChange={(e) => { composing.set(e.composing ? e.text : ""); line.compose(e.composing); sync(); }}
                onKeyPress={(e) => { if (e.key === "Backspace") line.backspace(); }}
                onSubmit={send} onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
                class="absolute inset-0 text-[15px] opacity-[0.02]" testID="composer" accessibilityLabel="输入到终端" />
            </View>
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
  return (
    <If when={paired()} else={<PairScreen />}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route) => route.name === "home" ? <HomeScreen /> : route.name === "settings" ? <SettingsScreen /> : <TermScreen address={route.address} />}
      </NavStack>
    </If>
  );
}

boot();
mount(App);
