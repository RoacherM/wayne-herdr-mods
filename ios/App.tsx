import "./src/shim";
import { cleanup, Clipboard, computed, effect, mount, Scroll, signal, Text, View, WebView } from "nsh";
import type { WebViewRef } from "nsh/types";
import { Button, createNavStack, Input, NavPage, NavStack } from "nsh/base";
import { boot, forget, info, list, notify, paired, pairWith, problem, refresh, rpc, sas, setStreamListener, status, type Space, type Terminal } from "./src/conn";
import { TERM_HTML } from "./src/term-html";

type Route = { name: "home" } | { name: "term"; address: string } | { name: "settings" };
const nav = createNavStack<Route>([{ name: "home" }]);

const STATE_TEXT: Record<string, string> = { blocked: "等你处理", working: "工作中", done: "完成", idle: "空闲", error: "出错" };
const KIND_TEXT: Record<string, string> = { permission: "等你确认", question: "在问你", auth: "要登录" };
const STATE_COLOR: Record<string, string> = { blocked: "#d1242f", error: "#d1242f", working: "#bf8700", done: "#1a7f37" };
const STATUS_TEXT: Record<string, string> = { connecting: "连接中…", offline: "Mac 离线", ready: "已连接", error: "出错", idle: "未连接" };
const base = (p?: string) => (p ? p.replace(/\/+$/, "").split("/").pop() : "");

// ------------------------------------------------------------------ pairing ----------------
function PairScreen() {
  const text = signal("");
  const busy = computed(() => status() === "connecting" && !problem());
  async function go() {
    problem.set("");
    try { await pairWith(text(), "nsh iPhone"); } catch (e: any) { console.warn(`pair failed: ${e.message}`); problem.set(e.message); }
  }
  return (
    <View class="flex-1 justify-center gap-4 bg-background px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <Text class="text-3xl font-semibold text-foreground">herdr 远程</Text>
      <Text class="text-base text-muted-foreground">在 Mac 上运行 herdr-relay pair，把配对链接复制过来。</Text>
      <Input value={text()} onChange={(e) => text.set(e.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoCorrect={false}
        class="rounded-lg border border-border px-3 py-3 text-base text-foreground" testID="pair-link" />
      <View class="flex-row gap-3">
        <Button onPress={async () => text.set(await Clipboard.readText())} class="flex-1 items-center rounded-lg bg-secondary py-3 active:opacity-70">
          <Text class="text-base text-secondary-foreground">粘贴</Text>
        </Button>
        <Button onPress={go} disabled={busy()} class="flex-1 items-center rounded-lg bg-primary py-3 active:opacity-80">
          <Text class="text-base font-semibold text-primary-foreground">配对</Text>
        </Button>
      </View>
      <If when={sas()}>
        {(code) => (
          <View class="items-center gap-2 rounded-xl bg-secondary p-4">
            <Text class="text-sm text-muted-foreground">核对 Mac 上显示的数字，在 Mac 上点允许</Text>
            <Text class="text-4xl font-semibold tracking-widest text-foreground" testID="sas">{code()}</Text>
          </View>
        )}
      </If>
      <If when={problem()}>{(p) => <Text class="text-sm text-[#d1242f]">{p()}</Text>}</If>
      <If when={status() !== "idle" && !sas() && !problem()}>
        <Text class="text-sm text-muted-foreground" testID="pair-status">{STATUS_TEXT[status()] ?? status()}</Text>
      </If>
    </View>
  );
}

// ------------------------------------------------------------------ home -------------------
function Row(props: { t: Terminal }) {
  const t = props.t;
  const label = t.state === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : STATE_TEXT[t.state ?? ""];
  const sub = [t.msg && t.state !== "idle" ? t.msg : null, base(t.cwd)].filter(Boolean).join(" · ");
  return (
    <Button onPress={() => nav.push({ name: "term", address: t.address })} class="flex-row items-center gap-3 px-4 py-3 active:bg-secondary" testID={`row-${t.address}`}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATE_COLOR[t.state ?? ""] ?? "#8c959f" }} />
      <View class="flex-1 gap-0.5">
        <Text class="text-base font-semibold text-foreground" style={{ numberOfLines: 1 }}>{t.app || t.program || "shell"}</Text>
        {sub ? <Text class="text-sm text-muted-foreground" style={{ numberOfLines: 1 }}>{sub}</Text> : null}
      </View>
      {label ? <Text class="text-xs" style={{ color: STATE_COLOR[t.state ?? ""] ?? "#57606a" }}>{label}</Text> : null}
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
    <View class="gap-2">
      <View class="flex-row items-center justify-between px-1">
        <Text class="text-sm font-semibold text-muted-foreground">{props.title}</Text>
        {props.space ? (
          <Button onPress={add} disabled={adding()} class="h-8 w-8 items-center justify-center rounded-full bg-secondary active:opacity-70" testID={`add-${props.space.id}`}>
            <Text class="text-lg text-foreground">+</Text>
          </Button>
        ) : null}
      </View>
      {props.rows.length ? (
        <View class="overflow-hidden rounded-xl bg-card border border-border">
          {props.rows.map((t) => <Row t={t} />)}
        </View>
      ) : null}
    </View>
  );
}

function HomeScreen() {
  const groups = computed(() => {
    const { terminals, layout } = list();
    const byAddr = new Map(terminals.map((t) => [t.address, t]));
    const out: { title: string; rows: Terminal[]; space?: Space }[] = [];
    const waiting = terminals.filter((t) => t.state === "blocked" || t.state === "error");
    if (waiting.length) out.push({ title: `需要你（${waiting.length}）`, rows: waiting });
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
      <Scroll class="flex-1 bg-background" contentClass="gap-5 p-4">
        <View class="flex-row items-center justify-between">
          <Text class="flex-1 text-sm text-muted-foreground" testID="status">{STATUS_TEXT[status()] ?? status()}{problem() ? ` · ${problem()}` : ""}</Text>
          <Button onPress={() => nav.push({ name: "settings" })} class="px-2 py-1 active:opacity-60" testID="settings">
            <Text class="text-sm text-primary">设置</Text>
          </Button>
        </View>
        {list().core && list().core !== "online" ? <Text class="text-sm text-muted-foreground">Mac 在线，但 Herdr 没有运行。</Text> : null}
        {groups().map((g) => <Group title={g.title} rows={g.rows} space={g.space} />)}
      </Scroll>
    </NavPage>
  );
}

function SettingsScreen() {
  return (
    <NavPage title="设置">
      <View class="flex-1 gap-4 bg-background p-4">
        <View class="gap-1 rounded-xl bg-card border border-border p-4">
          <Text class="text-base font-semibold text-foreground">{paired()?.desktopName ?? "Mac"}</Text>
          <Text class="text-sm text-muted-foreground">这台设备：{info()?.deviceName ?? "—"}</Text>
          <Text class="text-sm text-muted-foreground">中继：{paired()?.relay ?? "—"}</Text>
        </View>
        <Button onPress={async () => { nav.pop(); await forget(); }} class="items-center rounded-lg bg-[#d1242f] py-3 active:opacity-80">
          <Text class="text-base font-semibold text-white">取消配对</Text>
        </Button>
      </View>
    </NavPage>
  );
}

// ------------------------------------------------------------------ terminal ---------------
const KEYBAR: [string, string][] = [
  ["Esc", "\x1b"], ["Tab", "\t"], ["^C", "\x03"], ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"],
  ["⏎", "\r"], ["1", "1"], ["2", "2"], ["3", "3"], ["y", "y"], ["n", "n"], ["^D", "\x04"], ["⇧Tab", "\x1b[Z"],
];

function TermScreen(props: { address: string }) {
  const address = props.address;
  const term = computed(() => list().terminals.find((t) => t.address === address));
  const notice = signal("");
  const draft = signal("");
  let web!: WebViewRef;
  let s: number | null = null;
  let opening = false;
  let pageReady = false;
  let closed = false;
  const toPage: string[] = []; // held until the page says ready
  const early: any[] = []; // stream events that beat term.open's reply
  const post = (v: object) => { const m = JSON.stringify(v); if (pageReady) web.postMessage(m); else toPage.push(m); };

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
  cleanup(() => {
    closed = true;
    setStreamListener(null);
    if (s !== null) rpc("term.close", { s }).catch(() => {});
  });

  function fromPage(data: string) {
    let m: any; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "ready") { pageReady = true; for (const x of toPage.splice(0)) web.postMessage(x); }
    else if (m.t === "ack" && s !== null) notify("term.ack", { s, n: m.n });
    else if (m.t === "input" && s !== null) notify("term.input", { s, d: m.d });
    else if (m.t === "log") console.warn(`term page: ${m.m}`);
  }

  function key(seq: string) {
    if (s !== null) notify("term.input", { s, d: seq });
  }
  async function send() {
    const text = draft().trim();
    if (!text) return;
    try { await rpc("term.send", { address, text }, 20_000); draft.set(""); } catch (e: any) { notice.set(e.message); }
  }

  const title = computed(() => { const t = term(); return t ? t.app || t.program || address : address; });
  return (
    <NavPage title={title()}>
      <View class="flex-1 bg-background pb-[env(keyboard-inset-height)]">
        <WebView ref={web} html={TERM_HTML} style={{ flex: 1 }} scrollable={false} onMessage={(e) => fromPage(e.data)} testID="term-web" />
        <If when={notice()}>{(n) => <Text class="bg-[#fff8c5] px-4 py-2 text-sm text-[#4d2d00]">{n()}</Text>}</If>
        <View class="gap-2 border-t border-border px-2 pt-2 pb-[env(safe-area-inset-bottom)]">
          <Scroll horizontal scrollbar={false} class="flex-none" contentClass="flex-row gap-1.5">
            {KEYBAR.map(([label, seq]) => (
              <Button onPress={() => key(seq)} class="h-8 min-w-10 items-center justify-center rounded-md bg-secondary px-2.5 active:opacity-60">
                <Text class="text-sm text-secondary-foreground">{label}</Text>
              </Button>
            ))}
          </Scroll>
          <View class="flex-row items-end gap-2">
            <Input value={draft()} onChange={(e) => draft.set(e.value)} placeholder="发消息" multiline submitBehavior="submit" onSubmit={send}
              autoCapitalize="none" autoCorrect={false} class="max-h-30 flex-1 rounded-2xl border border-border px-3.5 py-2 text-base text-foreground" testID="composer" />
            <Button onPress={send} class="h-9 w-9 items-center justify-center rounded-full bg-primary active:opacity-80" testID="send">
              <Text class="text-base font-semibold text-primary-foreground">↑</Text>
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
