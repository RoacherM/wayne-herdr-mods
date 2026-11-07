import "./src/shim";
import { cleanup, Clipboard, computed, effect, host, Image, Keyboard, lifecycle, mount, Picker, Scroll, signal, Text, View, WebView } from "nsh";
import type { InputRef, WebViewRef } from "nsh/types";
import { Button, createNavStack, Input, NavPage, NavStack } from "nsh/base";
import {
  addingMac, boot, cancelPair, desktops, forget, info, list, notify, paired, pairWith,
  problem, refresh, rpc, sas, sendImage, setStreamListener, status, switchDesktop, transcribeAudio, wake,
  type Saved, type Space, type Terminal,
} from "./src/conn";
import { PROG_ICONS } from "./src/prog-icons";
import { TERM_HTML } from "./src/term-html";
import { LiveLine, PASTE_LF, pasteText } from "../app/src/live-line.js";
import { agentKeys, combo, keyOfChar, MODS } from "../app/src/agent-keys.js";
import downIcon from "./assets/down.svg";
import gearIcon from "./assets/gear.svg";
import herdrIcon from "./assets/herdr-icon.png";
import kbdIcon from "./assets/kbd.svg";
import plusIcon from "./assets/plus.svg";
import scanIcon from "./assets/scan.svg";
import spinnerIcon from "./assets/spinner.svg";

type Route = { name: "home" } | { name: "term"; address: string } | { name: "settings" };
const nav = createNavStack<Route>([{ name: "home" }]);

const STATE_TEXT: Record<string, string> = { blocked: "等你处理", working: "工作中", done: "完成", idle: "空闲", error: "出错" };
const KIND_TEXT: Record<string, string> = { permission: "等你确认", question: "在问你", auth: "要登录" };
const STATUS_TEXT: Record<string, string> = { connecting: "连接中…", offline: "电脑离线", ready: "已连接", error: "连接出错", idle: "未连接" };
const STATUS_DOT: Record<string, string> = { ready: "bg-ok", connecting: "bg-warn", offline: "bg-idle", error: "bg-bad", idle: "bg-idle" };
const TAG_STYLE: Record<string, string> = {
  working: "bg-warn/15 text-warn",
  blocked: "bg-warn/20 text-warn",
  error: "bg-bad/15 text-bad",
  done: "bg-[#28569a]/15 text-[#28569a]",
};

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh", "powershell", "cmd", "elvish", "xonsh", "tcsh", "csh", "ksh", "ion"]);
const ALIASES: Record<string, string> = { "claude-code": "claude", agy: "antigravity", "cursor-agent": "cursor" };

const base = (p?: string) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "");
const tapHaptic = () => { if (host.available()) try { host.post("haptic"); } catch {} };

function Icon(props: { src: any; size?: number; color?: string; class?: string }) {
  const n = props.size ?? 20;
  return (
    <Image
      src={props.src}
      class={props.class ?? (props.color ? undefined : "tint-muted-foreground")}
      style={props.color ? { width: n, height: n, tintColor: props.color } : { width: n, height: n }}
    />
  );
}

/** Signature Bauhaus triadic architectural rule (Vermilion Red · Ochre Yellow · Cobalt Blue · Hairline). */
function BauhausRule() {
  return (
    <View class="h-[3px] flex-row overflow-hidden rounded-[1px]">
      <View class="w-7 bg-[#d13b27]" />
      <View class="w-11 bg-[#e5a93b]" />
      <View class="w-16 bg-[#28569a]" />
      <View class="flex-1 bg-border" />
    </View>
  );
}

/** Resolve a terminal's icon key matching app/src/prog-icons.js and DESIGN.md「图标跟着 Herdr.app」. */
function resolveIconKey(t?: Terminal | null): string {
  if (!t) return "shell";
  if (t.icon) return t.icon;
  const raw = String(t.app || t.program || "").toLowerCase();
  if (!raw || SHELLS.has(raw)) return "shell";
  return ALIASES[raw] ?? raw;
}

/** Program icon on the left of a terminal row or in the terminal header, matching Herdr.app's sidebar. */
function ProgIcon(props: { t?: Terminal | null; size?: number; dark?: boolean }) {
  const n = props.size ?? 18;
  const key = resolveIconKey(props.t);
  const fallback = props.t?.app ? PROG_ICONS.agent : PROG_ICONS.program;
  const entry = PROG_ICONS[key] ?? fallback ?? PROG_ICONS.shell;
  return (
    <View class="items-center justify-center" style={{ width: n, height: n }}>
      <Image
        src={entry.src}
        class={entry.tint && !props.dark ? "tint-muted-foreground" : undefined}
        style={entry.tint && props.dark ? { width: n, height: n, tintColor: "#f2efe9" } : { width: n, height: n }}
      />
    </View>
  );
}

/** Right-side status indicator matching Herdr.app's sidebar with Bauhaus geometric shapes. */
function StatusMark(props: { state?: string | null }) {
  const st = props.state;
  if (st === "working") {
    return (
      <View class="h-3.5 w-3.5 items-center justify-center">
        <Image src={spinnerIcon} style={{ width: 14, height: 14, tintColor: "#d98a16" }} />
      </View>
    );
  }
  if (st === "done") return <View class="h-2 w-2 rounded-[2px] bg-[#28569a]" />;
  if (st === "idle") return <View class="h-2 w-2 rounded-full border border-idle" />;
  return null;
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
    <Scroll class="flex-1 bg-background" contentClass="grow justify-center px-5 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <If when={sas()} else={
        <View class="gap-4 py-6">
          <View class="gap-3">
            <View class="flex-row items-center gap-3.5">
              <View class="h-16 w-16 overflow-hidden rounded-[12px] border border-border bg-card">
                <Image src={herdrIcon} style={{ width: 64, height: 64 }} />
              </View>
              <View class="flex-1 gap-1">
                <Text class="text-[26px] font-bold text-foreground">herdr 远程</Text>
                <Text class="text-[13.5px] leading-snug text-muted-foreground">
                  在手机上看和操作 Mac 上 Herdr 的终端与 agent。端到端加密。
                </Text>
              </View>
            </View>
            <BauhausRule />
          </View>

          <If when={problem()}>
            {(p) => (
              <View class="rounded-[10px] border border-bad/30 bg-bad/10 px-3.5 py-2.5">
                <Text class="text-[13px] text-bad">{p()}</Text>
              </View>
            )}
          </If>

          <View class="overflow-hidden rounded-[10px] border border-border bg-card">
            <View class="flex-row items-start gap-3 border-b border-separator px-3.5 py-3">
              <Text class="w-6 font-mono text-[12px] font-bold text-[#d13b27]" style={{ fontVariant: ["tabular-nums"] }}>01</Text>
              <Text class="flex-1 text-[13.5px] leading-snug text-card-foreground">在 Mac 的 Herdr.app 里点标签栏右上角的手机图标，再点「配对新手机」</Text>
            </View>
            <View class="flex-row items-start gap-3 border-b border-separator px-3.5 py-3">
              <Text class="w-6 font-mono text-[12px] font-bold text-[#d98a16]" style={{ fontVariant: ["tabular-nums"] }}>02</Text>
              <Text class="flex-1 text-[13.5px] leading-snug text-card-foreground">点下面的按钮扫描 Mac 上的二维码</Text>
            </View>
            <View class="flex-row items-start gap-3 px-3.5 py-3">
              <Text class="w-6 font-mono text-[12px] font-bold text-[#28569a]" style={{ fontVariant: ["tabular-nums"] }}>03</Text>
              <Text class="flex-1 text-[13.5px] leading-snug text-card-foreground">在 Mac 上核对 6 位数字，输入 y 确认</Text>
            </View>
          </View>

          {host.available() ? (
            <Button onPress={scan} disabled={busy()} class="h-12 flex-row items-center justify-center gap-2 rounded-[10px] bg-primary active:opacity-80" testID="scan-qr">
              <Icon src={scanIcon} size={18} class="tint-primary-foreground" />
              <Text class="text-[15px] font-semibold text-primary-foreground">扫描二维码</Text>
            </Button>
          ) : null}

          <View class="gap-2.5 rounded-[10px] border border-border bg-card p-3.5">
            <View class="flex-row items-center justify-between">
              <Text class="text-[12.5px] font-medium text-muted-foreground">或粘贴配对链接</Text>
              <Button onPress={async () => { const c = await Clipboard.readText(); if (c) text.set(c); }} class="px-1 py-0.5 active:opacity-50">
                <Text class="text-[12.5px] font-semibold text-[#28569a]">从剪贴板粘贴</Text>
              </Button>
            </View>
            <View class="rounded-[8px] border border-separator bg-secondary px-3">
              <Input value={text()} onChange={(e) => text.set(e.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoCorrect={false}
                class="py-2.5 text-[15px] text-foreground" testID="pair-link" />
            </View>
            <Button onPress={() => go()} disabled={busy() || !text()}
              class={`h-10 items-center justify-center rounded-[8px] bg-secondary active:opacity-80 ${!text() ? "opacity-40" : ""}`}>
              <Text class="text-[14.5px] font-semibold text-foreground">{busy() ? "连接中…" : "配对"}</Text>
            </Button>
          </View>

          {addingMac() ? (
            <Button onPress={cancelPair} class="h-10 items-center justify-center active:opacity-50" testID="cancel-pair">
              <Text class="text-[14px] text-muted-foreground">取消</Text>
            </Button>
          ) : null}
          <If when={status() !== "idle" && !problem()}>
            <Text class="text-center text-[13px] text-muted-foreground" testID="pair-status">{STATUS_TEXT[status()] ?? status()}</Text>
          </If>
        </View>
      }>
        {(code) => (
          <View class="gap-4 py-8">
            <View class="flex-row items-center gap-3">
              <View class="h-12 w-12 overflow-hidden rounded-[10px] border border-border bg-card">
                <Image src={herdrIcon} style={{ width: 48, height: 48 }} />
              </View>
              <View class="flex-1">
                <Text class="text-[22px] font-bold text-foreground">在 Mac 上确认</Text>
                <Text class="text-[13px] text-muted-foreground">核对终端里的 6 位数字并输入 y</Text>
              </View>
            </View>
            <BauhausRule />
            <View class="my-2 items-center justify-center rounded-[10px] border border-border bg-card px-6 py-6">
              <Text class="font-mono text-[46px] font-bold tracking-[0.12em] text-foreground" style={{ fontVariant: ["tabular-nums"] }} testID="sas">
                {code().length === 6 ? `${code().slice(0, 3)} ${code().slice(3)}` : code()}
              </Text>
            </View>
            <Button onPress={cancelPair} class="h-11 w-full items-center justify-center rounded-[10px] border border-border bg-card active:bg-secondary" testID="cancel-pair">
              <Text class="text-[15px] font-medium text-muted-foreground">取消</Text>
            </Button>
          </View>
        )}
      </If>
    </Scroll>
  );
}

// ------------------------------------------------------------------ home -------------------
function Row(props: { t: Terminal; first: boolean }) {
  const t = props.t;
  const st = t.state ?? "idle";
  const label = st === "idle" ? "" : st === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : (STATE_TEXT[st] ?? "");
  const sub = [t.msg && st !== "idle" ? t.msg : null, base(t.cwd)].filter(Boolean).join(" · ");
  const what = t.app || t.program || "shell";
  return (
    <Button onPress={() => nav.push({ name: "term", address: t.address })}
      class={`min-h-[52px] flex-row items-center gap-3 px-3.5 py-2.5 active:bg-secondary ${props.first ? "" : "border-t border-separator"}`}
      testID={`row-${t.address}`}>
      <View class="h-7 w-7 items-center justify-center rounded-[6px] bg-secondary">
        <ProgIcon t={t} size={18} />
      </View>
      <View class="flex-1 gap-0.5">
        <View class="flex-row items-baseline gap-2">
          <Text class={`text-[15px] font-semibold ${st === "idle" ? "text-muted-foreground" : "text-card-foreground"}`} style={{ numberOfLines: 1 }}>
            {what}
          </Text>
          <Text class="font-mono text-[11px] font-medium text-idle">{t.address}</Text>
        </View>
        {sub ? <Text class="text-[12.5px] text-muted-foreground" style={{ numberOfLines: 1 }}>{sub}</Text> : null}
      </View>
      {label ? (
        <View class={`rounded-[5px] px-2 py-0.5 ${TAG_STYLE[st] ?? "bg-secondary"}`}>
          <Text class={`text-[11.5px] font-semibold ${TAG_STYLE[st] ? "" : "text-muted-foreground"}`}>{label}</Text>
        </View>
      ) : null}
      <StatusMark state={st} />
    </Button>
  );
}

type GroupItem = { kind: "tab"; label: string } | { kind: "term"; t: Terminal; firstAfterLabel: boolean };

function Group(props: { title: string; items: GroupItem[]; count: number; space?: Space; needs?: boolean }) {
  const adding = signal(false);
  async function add() {
    if (adding() || !props.space) return;
    adding.set(true);
    tapHaptic();
    try {
      const { address } = (await rpc("term.new", { space: props.space.id }, 15_000)) as { address: string };
      await refresh();
      nav.push({ name: "term", address });
    } catch (e: any) { problem.set(e.message); } finally { adding.set(false); }
  }
  return (
    <View class="gap-1.5">
      <View class="min-h-7 flex-row items-center justify-between px-1">
        <View class="flex-row items-center gap-2">
          <View class={`h-2 w-2 ${props.needs ? "bg-[#d13b27]" : "bg-[#28569a]"}`} />
          <Text class={`text-[13px] font-semibold ${props.needs ? "text-[#d13b27]" : "text-foreground"}`}>{props.title}</Text>
          <Text class="font-mono text-[11.5px] text-idle" style={{ fontVariant: ["tabular-nums"] }}>
            {String(props.count).padStart(2, "0")}
          </Text>
        </View>
        {props.space ? (
          <Button onPress={add} disabled={adding()} class="h-7 w-7 items-center justify-center rounded-[6px] border border-border bg-card active:bg-secondary" testID={`add-${props.space.id}`} accessibilityLabel="新建终端">
            <Icon src={plusIcon} size={15} class="tint-foreground" />
          </Button>
        ) : null}
      </View>
      {props.items.length ? (
        <View class="overflow-hidden rounded-[10px] border border-border bg-card">
          {props.items.map((item) =>
            item.kind === "tab" ? (
              <View class="border-t border-separator bg-secondary/50 px-3.5 py-1">
                <Text class="font-mono text-[11px] font-medium text-muted-foreground">{item.label}</Text>
              </View>
            ) : (
              <Row t={item.t} first={item.firstAfterLabel} />
            )
          )}
        </View>
      ) : (
        <View class="rounded-[10px] border border-separator bg-card px-3.5 py-2.5">
          <Text class="text-[13px] text-muted-foreground">没有正在运行的终端</Text>
        </View>
      )}
    </View>
  );
}

function HomeScreen() {
  effect(() => { if (lifecycle() === "active") wake(); });
  const statusInfo = computed(() => {
    const s = status();
    const core = list().core;
    if (s === "ready") {
      return core && core !== "online"
        ? { dot: "bg-bad", text: "herdr 未运行" }
        : { dot: "bg-ok", text: "已连接" };
    }
    return { dot: STATUS_DOT[s] ?? "bg-idle", text: STATUS_TEXT[s] ?? s };
  });
  const groups = computed(() => {
    const { terminals, layout } = list();
    const byAddr = new Map(terminals.map((t) => [t.address, t]));
    const out: { title: string; items: GroupItem[]; count: number; space?: Space; needs?: boolean }[] = [];
    const waiting = terminals.filter((t) => t.state === "blocked" || t.state === "error");
    if (waiting.length) {
      out.push({
        title: "需要你",
        needs: true,
        count: waiting.length,
        items: waiting.map((t, i) => ({ kind: "term", t, firstAfterLabel: i === 0 })),
      });
    }
    const placed = new Set<string>();
    for (const space of layout) {
      const items: GroupItem[] = [];
      let count = 0;
      for (const [tabIdx, tab] of space.tabs.entries()) {
        const ts = tab.terminals.map((a) => byAddr.get(a)).filter(Boolean) as Terminal[];
        if (!ts.length) continue;
        count += ts.length;
        ts.forEach((t) => placed.add(t.address));
        const hasTabLabel = space.tabs.length > 1;
        if (hasTabLabel) items.push({ kind: "tab", label: tab.name || `标签 ${tabIdx + 1}` });
        ts.forEach((t, i) => items.push({ kind: "term", t, firstAfterLabel: hasTabLabel ? i === 0 : items.length === 0 }));
      }
      if (items.length || space.id) out.push({ title: spaceName(space, byAddr), items, count, space });
    }
    const loose = terminals.filter((t) => !placed.has(t.address));
    if (loose.length) {
      out.push({
        title: "其他终端",
        count: loose.length,
        items: loose.map((t, i) => ({ kind: "term", t, firstAfterLabel: i === 0 })),
      });
    }
    return out;
  });

  const macName = computed(() => paired()?.desktopName ?? info()?.desktopName ?? "Mac");

  return (
    <NavPage
      title={macName()}
      headerClass="bg-background"
      headerTitle={
        <View class="items-center">
          <Text class="text-[16px] font-semibold text-foreground" style={{ numberOfLines: 1 }}>{macName()}</Text>
          <View class="flex-row items-center gap-1.5">
            <View class={`h-2 w-2 rounded-full ${statusInfo().dot}`} />
            <Text class="text-[11.5px] text-muted-foreground" testID="status">{statusInfo().text}</Text>
          </View>
        </View>
      }
      headerRight={
        <Button onPress={() => nav.push({ name: "settings" })} class="h-8 w-8 items-center justify-center rounded-[8px] active:bg-secondary" testID="settings" accessibilityLabel="设置">
          <Icon src={gearIcon} size={19} class="tint-foreground" />
        </Button>
      }
    >
      <Scroll class="flex-1 bg-background" contentClass="gap-4 px-4 pb-10 pt-2">
        <BauhausRule />
        {desktops().length > 1 ? (
          <Scroll horizontal scrollbar={false} class="flex-none" contentClass="flex-row gap-2">
            {desktops().map((d: Saved) => {
              const active = d.desktopId === paired()?.desktopId;
              return (
                <Button onPress={() => switchDesktop(d.desktopId)}
                  class={`h-8 flex-row items-center gap-1.5 rounded-[6px] px-3 ${active ? "bg-primary" : "border border-border bg-card"}`}
                  testID={`mac-${d.desktopId}`}>
                  <View class={`h-1.5 w-1.5 ${active ? "bg-[#e5a93b]" : "bg-idle"}`} />
                  <Text class={`text-[13px] font-semibold ${active ? "text-primary-foreground" : "text-card-foreground"}`}>{d.desktopName || "Mac"}</Text>
                </Button>
              );
            })}
          </Scroll>
        ) : null}
        {status() === "offline" ? (
          <View class="rounded-[10px] border border-warn/30 bg-warn/15 px-3.5 py-2.5">
            <Text class="text-[13px] text-warn">Mac 离线或后台服务没在运行。恢复后会自动重连。</Text>
          </View>
        ) : null}
        {status() === "ready" && list().core && list().core !== "online" ? (
          <View class="rounded-[10px] border border-border bg-card px-3.5 py-2.5">
            <Text class="text-[13px] text-muted-foreground">Mac 在线，但 Herdr 没有运行（herdr-core 不在）。打开 Herdr.app 后这里会自动出现终端。</Text>
          </View>
        ) : null}
        {groups().length ? (
          groups().map((g) => <Group title={g.title} items={g.items} count={g.count} space={g.space} needs={g.needs} />)
        ) : (
          <View class="rounded-[10px] border border-border bg-card px-3.5 py-3">
            <Text class="text-[13px] text-muted-foreground">{status() === "ready" ? "没有正在运行的终端。" : "连接中…"}</Text>
          </View>
        )}
      </Scroll>
    </NavPage>
  );
}

function Field(props: { label: string; value: string; last?: boolean }) {
  return (
    <View class={`ml-3.5 min-h-11 flex-row items-center gap-3 py-2.5 pr-3.5 ${props.last ? "" : "border-b border-separator"}`}>
      <Text class="text-[14.5px] font-medium text-card-foreground">{props.label}</Text>
      <Text class="flex-1 text-right font-mono text-[13.5px] text-muted-foreground" style={{ numberOfLines: 1 }}>{props.value}</Text>
    </View>
  );
}

function SettingsScreen() {
  return (
    <NavPage title="设置" headerClass="bg-background">
      <Scroll class="flex-1 bg-background" contentClass="gap-5 px-4 pt-2 pb-10">
        <BauhausRule />
        <View class="gap-1.5">
          <View class="flex-row items-center gap-2 px-1">
            <View class="h-2 w-2 bg-[#28569a]" />
            <Text class="text-[12.5px] font-semibold text-foreground">当前设备</Text>
          </View>
          <View class="overflow-hidden rounded-[10px] border border-border bg-card">
            <Field label="电脑" value={paired()?.desktopName ?? "Mac"} />
            <Field label="这台设备" value={info()?.deviceName ?? "—"} />
            <Field label="中继" value={(paired()?.relay ?? "—").replace(/^https?:\/\//, "")} last />
          </View>
          <Text class="px-1 text-[12px] leading-snug text-muted-foreground">消息端到端加密，中继只转发看不懂的密文。</Text>
        </View>
        <View class="gap-1.5">
          <View class="flex-row items-center gap-2 px-1">
            <View class="h-2 w-2 bg-[#e5a93b]" />
            <Text class="text-[12.5px] font-semibold text-foreground">已配对的 Mac（{desktops().length}）</Text>
          </View>
          <View class="overflow-hidden rounded-[10px] border border-border bg-card">
            {desktops().map((d: Saved, i: number) => {
              const active = d.desktopId === paired()?.desktopId;
              return (
                <Button onPress={() => { switchDesktop(d.desktopId); nav.pop(); }}
                  class={`ml-3.5 min-h-11 flex-row items-center gap-3 py-2.5 pr-3.5 ${i === desktops().length - 1 ? "" : "border-b border-separator"}`}>
                  <View class={`h-2 w-2 ${active ? "bg-ok" : "bg-idle"}`} />
                  <Text class="flex-1 text-[15px] font-medium text-card-foreground" style={{ numberOfLines: 1 }}>{d.desktopName || "Mac"}</Text>
                  <Text class="font-mono text-[12.5px] text-muted-foreground">{active ? "当前" : "切换"}</Text>
                </Button>
              );
            })}
          </View>
          <Button onPress={() => { nav.pop(); addingMac.set(true); }} class="h-11 items-center justify-center rounded-[10px] border border-border bg-card active:bg-secondary" testID="add-mac">
            <Text class="text-[14.5px] font-semibold text-foreground">配对另一台 Mac</Text>
          </Button>
        </View>
        <Button onPress={async () => { nav.pop(); await forget(); }} class="h-11 items-center justify-center rounded-[10px] border border-bad/30 bg-card active:bg-secondary">
          <Text class="text-[14.5px] font-semibold text-destructive">取消配对</Text>
        </Button>
      </Scroll>
    </NavPage>
  );
}

// ------------------------------------------------------------------ terminal ---------------
const DARK = { bar: "#161614", tint: "#f2efe9" };
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
const REPEAT = new Set(["up", "down", "left", "right"]);
const MAX_VOICE_MS = 60_000;
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
  const voiceLevel = signal(0);
  const voiceLeftSec = signal(60);
  const mods = signal<string[]>([]);
  const litKey = signal("");
  let litTimer: any = 0;
  let repeatDelay: any = 0;
  let repeatEvery: any = 0;
  let didRepeat = false;
  let voiceMeterTimer: any = 0;
  let voiceLimitTimer: any = 0;

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
  function stopRepeat() {
    clearTimeout(repeatDelay);
    clearInterval(repeatEvery);
    repeatDelay = repeatEvery = 0;
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
    stopRepeat();
    clearInterval(voiceMeterTimer);
    clearTimeout(voiceLimitTimer);
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
    if (held()) { notice.set("先回答终端里的问题，再粘贴（或点气泡直接打字）"); return; }
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
    if (mods().length && named()) { pressNamed(combo(new Set(mods()), "enter"), "⏎"); return; }
    if (!line.submit()) { notice.set("先回答终端里的问题（1 / 2 / 3、⏎ 或 Esc），刚打的字随后会进去"); return; }
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

  // ---- Hold-to-talk voice input (AVAudioRecorder → Mac Volcengine flash ASR)
  let recStartedAt = 0;
  function clearVoiceTimers() {
    clearInterval(voiceMeterTimer);
    clearTimeout(voiceLimitTimer);
    voiceMeterTimer = voiceLimitTimer = 0;
  }

  async function startVoice() {
    if (!host.available() || !info()?.voice) {
      notice.set(info()?.voice ? "当前环境不支持录音" : "这台 Mac 没开语音识别：在 Mac 上运行 wayne-herdr-mods voice key 设置");
      return;
    }
    if (voiceState() !== "") return;
    try {
      notice.set("");
      await host.call("voice.start");
      recStartedAt = Date.now();
      voiceLevel.set(0.1);
      voiceLeftSec.set(60);
      tapHaptic();
      voiceState.set("rec");
      voiceMeterTimer = setInterval(async () => {
        if (voiceState() !== "rec") return;
        const left = Math.max(0, Math.ceil((MAX_VOICE_MS - (Date.now() - recStartedAt)) / 1000));
        voiceLeftSec.set(left);
        try {
          const r = await host.call<{ level: number }>("voice.level");
          if (typeof r?.level === "number") voiceLevel.set(r.level);
        } catch {}
      }, 90);
      voiceLimitTimer = setTimeout(() => stopVoice(false), MAX_VOICE_MS);
    } catch (e: any) {
      notice.set(e.message || "录音启动失败");
    }
  }

  async function stopVoice(cancel = false) {
    if (voiceState() !== "rec") return;
    clearVoiceTimers();
    const elapsed = Date.now() - recStartedAt;
    if (cancel || elapsed < 400) {
      voiceState.set("");
      await host.call("voice.cancel").catch(() => {});
      if (!cancel && elapsed < 400) notice.set("按住说话，松开输入");
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
    if (!t) return address;
    const st = t.state === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : STATE_TEXT[t.state ?? ""];
    return [t.where || base(t.cwd) || address, st].filter(Boolean).join(" · ");
  });

  // Floating status bubble at the bottom of the terminal stage, matching .term-bubble in app/src/main.js
  const bubble = computed(() => {
    if (voiceState() === "rec") {
      const left = voiceLeftSec();
      return {
        text: left <= 10 ? `还剩 ${left} 秒 · 松开 输入` : "松开 输入 · 点气泡取消",
        warn: false,
        tap: "cancel-voice" as const,
        level: voiceLevel(),
        busy: false,
      };
    }
    if (voiceState() === "busy") return { text: "识别中…", warn: false, tap: null, level: undefined, busy: true };
    if (uploading()) return { text: `上传图片 ${uploading()}…`, warn: false, tap: null, level: undefined, busy: false };
    if (composing()) return { text: composing(), warn: false, tap: null, level: undefined, busy: false };
    if (held() && pending()) return { text: `等你回答后输入：${pending()} · 点这里照样输入`, warn: true, tap: "let-go" as const, level: undefined, busy: false };
    if (pending()) return { text: `等你回答后输入：${pending()}`, warn: true, tap: null, level: undefined, busy: false };
    if (held()) return { text: "终端在问你 · 点这里照样打字", warn: true, tap: "let-go" as const, level: undefined, busy: false };
    if (notice()) return { text: notice(), warn: true, tap: "dismiss" as const, level: undefined, busy: false };
    return null;
  });

  const voiceOk = computed(() => Boolean(info()?.voice) && host.available());

  return (
    <NavPage
      title={title()}
      headerStyle={{ backgroundColor: DARK.bar, color: "#f2efe9", tintColor: DARK.tint }}
      statusBar={{ foreground: "light" }}
      headerTitle={
        <View class="items-center gap-0.5" accessibilityLabel={title()}>
          <ProgIcon t={term()} size={20} dark />
          <Text class="text-[11.5px] text-[#8a857c]" style={{ numberOfLines: 1 }}>{subtitle()}</Text>
        </View>
      }
    >
      <View class="flex-1 bg-[#0b0b0c] pb-[env(keyboard-inset-height)]">
        {/* Terminal stage + floating status bubble + scroll-to-latest button */}
        <View class="relative flex-1 bg-[#0b0b0c]">
          <WebView ref={web} html={TERM_HTML} style={{ flex: 1 }} scrollable={false} onMessage={(e) => fromPage(e.data)} testID="term-web" />
          <If when={bubble()}>
            {(b) => (
              <View class="absolute inset-x-4 bottom-2.5 items-center" style={{ pointerEvents: "box-none" }}>
                <Button
                  onPress={() => {
                    const action = b().tap;
                    if (action === "let-go") { letGo.set(true); field.focus(); }
                    else if (action === "cancel-voice") stopVoice(true);
                    else if (action === "dismiss") notice.set("");
                  }}
                  class="max-w-full flex-row items-center gap-2.5 rounded-full border border-[#383630] bg-[#262522]/95 px-3.5 py-1.5"
                  testID="term-bubble"
                >
                  {b().level !== undefined ? (
                    <View class="h-1.5 w-14 overflow-hidden rounded-full bg-[#383630]">
                      <View class="h-full rounded-full bg-[#28569a]" style={{ width: Math.round((0.08 + (b().level ?? 0) * 0.92) * 56) }} />
                    </View>
                  ) : null}
                  {b().busy ? <View class="h-2 w-2 rounded-full bg-[#e5a93b]" /> : null}
                  <Text class={`text-[13.5px] ${b().warn ? "text-[#e5a93b]" : "text-[#f2efe9]"}`} style={{ numberOfLines: 1 }}>
                    {b().text}
                  </Text>
                </Button>
              </View>
            )}
          </If>
          <If when={!atLatest()}>
            <Button onPress={() => post({ t: "toLatest" })}
              class="absolute right-3 bottom-3 h-[38px] w-[38px] items-center justify-center rounded-[10px] border border-[#383630] bg-[#262522]"
              testID="to-latest" accessibilityLabel="回到最新">
              <Icon src={downIcon} size={20} color="#f2efe9" />
            </Button>
          </If>
        </View>

        {/* Braun / Bauhaus control deck matching .term-foot in app/src/main.js */}
        <View class="gap-2 border-t border-[#2a2925] bg-[#161614] px-2 pt-2 pb-[env(safe-area-inset-bottom)]">
          <Scroll horizontal scrollbar={false} keyboardShouldPersistTaps="always" class="flex-none" contentClass="flex-row items-center gap-1.5 px-0.5">
            {KEYBAR_FRONT.map(([label, seq]) => (
              <Button
                onPress={() => onKeyPress(label, seq)}
                onPressDown={() => onKeyDown(label, seq)}
                onPressUp={stopRepeat}
                testID={seq === "\r" ? "send" : undefined}
                class={`h-[34px] min-w-[42px] items-center justify-center rounded-[6px] bg-[#262522] px-3 active:bg-[#3a3833] ${litKey() === label ? "border-2 border-[#e5a93b]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2efe9]">{label}</Text>
              </Button>
            ))}
            {agentShortcuts().map(([label, names]) => (
              <Button onPress={() => pressNamed(names, label)}
                class={`h-[34px] min-w-[42px] items-center justify-center rounded-[6px] bg-[#262522] px-3 active:bg-[#3a3833] ${litKey() === label ? "border-2 border-[#e5a93b]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2efe9]">{label}</Text>
              </Button>
            ))}
            {named() ? MODS.map((m) => {
              const active = mods().includes(m);
              return (
                <Button onPress={() => toggleMod(m)}
                  class={`h-[34px] min-w-[42px] items-center justify-center rounded-[6px] px-3 ${active ? "bg-[#f2efe9]" : "bg-[#262522]"} active:bg-[#3a3833]`}>
                  <Text class={`text-[15px] font-medium ${active ? "text-[#161614]" : "text-[#f2efe9]"}`}>{MOD_LABELS[m]}</Text>
                </Button>
              );
            }) : null}
            {KEYBAR_BACK.map(([label, seq]) => (
              <Button onPress={() => onKeyPress(label, seq)}
                class={`h-[34px] min-w-[42px] items-center justify-center rounded-[6px] bg-[#262522] px-3 active:bg-[#3a3833] ${litKey() === label ? "border-2 border-[#e5a93b]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2efe9]">{label}</Text>
              </Button>
            ))}
          </Scroll>

          <View class="relative flex-row items-center gap-2 pb-1">
            <Button onPress={pick} class="h-10 w-10 items-center justify-center rounded-[10px] bg-[#262522] active:bg-[#3a3833]" testID="pick" accessibilityLabel="插入图片">
              <Icon src={plusIcon} size={21} color="#a6a196" />
            </Button>
            <Button
              disabled={voiceState() === "busy"}
              onPressDown={() => startVoice()}
              onPressUp={() => { if (voiceState() === "rec") stopVoice(false); }}
              onPress={() => { if (voiceState() === "rec" && Date.now() - recStartedAt >= 400) stopVoice(false); }}
              class={`h-10 flex-1 flex-row items-center justify-center gap-2 rounded-[10px] ${voiceState() === "rec" ? "bg-[#28569a]" : "bg-[#262522]"} active:bg-[#3a3833] ${voiceState() === "busy" ? "opacity-60" : ""}`}
              testID="voice"
              accessibilityLabel="按住说话"
            >
              <View class={`h-2 w-2 rounded-full ${voiceState() === "rec" ? "bg-[#e5a93b]" : voiceOk() ? "bg-[#d13b27]" : "bg-[#757067]"}`} />
              <Text class={`text-[15px] font-semibold tracking-[0.02em] ${voiceState() === "rec" ? "text-[#f2efe9]" : voiceOk() ? "text-[#f2efe9]" : "text-[#757067]"}`}>
                {voiceState() === "rec" ? "松开 输入" : voiceState() === "busy" ? "识别中…" : "按住 说话"}
              </Text>
            </Button>
            <Button
              onPress={() => { if (focused()) Keyboard.dismiss(); else field.focus(); }}
              class={`h-10 w-10 items-center justify-center rounded-[10px] ${focused() ? "bg-[#f2efe9]" : "bg-[#262522]"} active:bg-[#3a3833]`}
              testID="kbd-toggle"
              accessibilityLabel="键盘"
            >
              <Icon src={kbdIcon} size={21} color={focused() ? "#161614" : "#a6a196"} />
            </Button>
            {/* Invisible focusable input field (matches .term-keys in app/src/app.css) */}
            <Input
              ref={field}
              value={burst()}
              multiline
              submitBehavior="submit"
              returnKeyType="send"
              autoCapitalize="none"
              autoCorrect={false}
              onChange={(e) => onInputChange(e.value)}
              onCompositionChange={(e) => { composing.set(e.composing ? e.text : ""); line.compose(e.composing); sync(); }}
              onKeyPress={(e) => { if (e.key === "Backspace") line.backspace(); }}
              onSubmit={send}
              onFocus={() => focused.set(true)}
              onBlur={() => focused.set(false)}
              class="pointer-events-none absolute left-1/2 bottom-0 h-px w-px opacity-0"
              testID="composer"
              accessibilityLabel="输入到终端"
            />
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
