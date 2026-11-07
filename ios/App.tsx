import "./src/shim";
import { cleanup, Clipboard, computed, effect, host, Image, Keyboard, lifecycle, mount, Picker, Scroll, signal, Text, View, WebView } from "nsh";
import type { InputRef, WebViewRef } from "nsh/types";
import { Button, createNavStack, Input, NavPage, NavStack } from "nsh/base";
import {
  activeTermAddress, addingMac, boot, cancelPair, consumePendingNotificationTap, desktops,
  disableNotifications, enableNotifications, forget, info, list, macStatuses, notify,
  notifyEnabled, notifyPermission, paired, pairWith, problem, refresh, refreshNotifyStatus,
  rpc, sas, sendImage, sendTestNotification, setStreamListener, status, switchDesktop,
  transcribeAudio, wake, type Saved, type Space, type Terminal,
} from "./src/conn";
import { PROG_ICONS } from "./src/prog-icons";
import { TERM_HTML } from "./src/term-html";
import { LiveLine, PASTE_LF, pasteText } from "../app/src/live-line.js";
import { agentKeys, combo, keyOfChar, MODS } from "../app/src/agent-keys.js";
import chevronIcon from "./assets/chevron.svg";
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
  working: "bg-secondary text-foreground",
  blocked: "bg-foreground text-background",
  error: "bg-bad/15 text-bad",
  done: "bg-[#879fb0]/20 text-[#688296]",
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
        style={entry.tint && props.dark ? { width: n, height: n, tintColor: "#f2f2f7" } : { width: n, height: n }}
      />
    </View>
  );
}

/** Right-side status indicator matching Herdr.app's sidebar (.st-spin / .st-dot.done / .st-ring). */
function StatusMark(props: { state?: string | null }) {
  const st = props.state;
  if (st === "working") {
    return (
      <View class="h-3.5 w-3.5 items-center justify-center">
        <Image src={spinnerIcon} style={{ width: 14, height: 14, tintColor: "#879fb0" }} />
      </View>
    );
  }
  if (st === "done") return <View class="h-2 w-2 rounded-full bg-[#879fb0]" />;
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
          <View class="items-center gap-2 py-2">
            <View class="h-20 w-20 overflow-hidden rounded-[22px] bg-[#161616]">
              <Image src={herdrIcon} style={{ width: 80, height: 80 }} />
            </View>
            <Text class="mt-1 text-[24px] font-semibold text-foreground">herdr 远程</Text>
            <Text class="px-4 text-center text-[14px] leading-snug text-muted-foreground">
              在手机上看和操作 Mac 上 Herdr 的终端与 agent。端到端加密。
            </Text>
          </View>

          <If when={problem()}>
            {(p) => (
              <View class="rounded-2xl bg-bad/15 px-4 py-3">
                <Text class="text-[13px] text-bad">{p()}</Text>
              </View>
            )}
          </If>

          <View class="gap-3 rounded-[20px] bg-card p-4">
            <View class="flex-row items-center gap-3">
              <View class="h-6 w-6 items-center justify-center rounded-full bg-secondary">
                <Text class="text-[12px] font-medium text-foreground" style={{ fontVariant: ["tabular-nums"] }}>1</Text>
              </View>
              <Text class="flex-1 text-[14px] leading-snug text-card-foreground">在 Mac 的 Herdr.app 里点标签栏右上角的手机图标，再点「配对新手机」</Text>
            </View>
            <View class="flex-row items-center gap-3">
              <View class="h-6 w-6 items-center justify-center rounded-full bg-secondary">
                <Text class="text-[12px] font-medium text-foreground" style={{ fontVariant: ["tabular-nums"] }}>2</Text>
              </View>
              <Text class="flex-1 text-[14px] leading-snug text-card-foreground">点下面的按钮扫描 Mac 上的二维码</Text>
            </View>
            <View class="flex-row items-center gap-3">
              <View class="h-6 w-6 items-center justify-center rounded-full bg-secondary">
                <Text class="text-[12px] font-medium text-foreground" style={{ fontVariant: ["tabular-nums"] }}>3</Text>
              </View>
              <Text class="flex-1 text-[14px] leading-snug text-card-foreground">在 Mac 上核对 6 位数字，输入 y 确认</Text>
            </View>
          </View>

          {host.available() ? (
            <Button onPress={scan} disabled={busy()} class="h-12 flex-row items-center justify-center gap-2 rounded-full bg-primary active:opacity-80" testID="scan-qr">
              <Icon src={scanIcon} size={18} class="tint-primary-foreground" />
              <Text class="text-[15px] font-medium text-primary-foreground">扫描二维码</Text>
            </Button>
          ) : null}

          <View class="gap-3 rounded-[20px] bg-card p-4">
            <View class="flex-row items-center justify-between">
              <Text class="text-[13px] font-medium text-muted-foreground">或粘贴配对链接</Text>
              <Button onPress={async () => { const c = await Clipboard.readText(); if (c) text.set(c); }} class="px-1 py-1 active:opacity-50">
                <Text class="text-[13px] font-medium text-foreground">从剪贴板粘贴</Text>
              </Button>
            </View>
            <View class="rounded-[12px] bg-secondary px-3">
              <Input value={text()} onChange={(e) => text.set(e.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoCorrect={false}
                class="py-3 text-[15px] text-foreground" testID="pair-link" />
            </View>
            <Button onPress={() => go()} disabled={busy() || !text()}
              class={`h-11 items-center justify-center rounded-full bg-secondary active:opacity-80 ${!text() ? "opacity-40" : ""}`}>
              <Text class="text-[15px] font-medium text-foreground">{busy() ? "连接中…" : "配对"}</Text>
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
          <View class="items-center gap-4 py-8">
            <View class="h-16 w-16 overflow-hidden rounded-[18px] bg-[#161616]">
              <Image src={herdrIcon} style={{ width: 64, height: 64 }} />
            </View>
            <Text class="text-[24px] font-semibold text-foreground">在 Mac 上确认</Text>
            <View class="my-2 w-full items-center justify-center rounded-[20px] bg-card px-6 py-6">
              <Text class="font-mono text-[44px] font-semibold tracking-[0.12em] text-foreground" style={{ fontVariant: ["tabular-nums"] }} testID="sas">
                {code().length === 6 ? `${code().slice(0, 3)} ${code().slice(3)}` : code()}
              </Text>
            </View>
            <Text class="px-4 text-center text-[14px] text-muted-foreground">在 Mac 终端里核对上面 6 位数字，输入 y 并回车</Text>
            <Button onPress={cancelPair} class="mt-2 h-11 w-full items-center justify-center rounded-full bg-card active:bg-secondary" testID="cancel-pair">
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
      class={`min-h-13 flex-row items-center gap-3 px-4 py-3 active:bg-secondary ${props.first ? "" : "border-t border-separator"}`}
      testID={`row-${t.address}`}>
      <ProgIcon t={t} size={18} />
      <View class="flex-1 gap-0.5">
        <View class="flex-row items-baseline gap-2">
          <Text class={`text-[15px] font-medium ${st === "idle" ? "text-muted-foreground" : "text-card-foreground"}`} style={{ numberOfLines: 1 }}>
            {what}
          </Text>
          <Text class="font-mono text-[12px] text-idle" style={{ fontVariant: ["tabular-nums"] }}>{t.address}</Text>
        </View>
        {sub ? <Text class="text-[13px] text-muted-foreground" style={{ numberOfLines: 1 }}>{sub}</Text> : null}
      </View>
      {label ? (
        <View class={`rounded-full px-2.5 py-0.5 ${TAG_STYLE[st] ?? "bg-secondary"}`}>
          <Text class={`text-[12px] font-medium ${TAG_STYLE[st] ? "" : "text-muted-foreground"}`}>{label}</Text>
        </View>
      ) : null}
      <StatusMark state={st} />
    </Button>
  );
}

type GroupItem = { kind: "tab"; label: string } | { kind: "term"; t: Terminal; firstAfterLabel: boolean };

function Group(props: { title: string; items: GroupItem[]; space?: Space; needs?: boolean }) {
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
    <View class="gap-2">
      <View class="min-h-7 flex-row items-center justify-between px-1">
        <Text class={`text-[13px] font-medium ${props.needs ? "text-foreground" : "text-muted-foreground"}`}>{props.title}</Text>
        {props.space ? (
          <Button onPress={add} disabled={adding()} class="h-7 w-7 items-center justify-center rounded-full bg-card active:bg-secondary" testID={`add-${props.space.id}`} accessibilityLabel="新建终端">
            <Icon src={plusIcon} size={16} class="tint-muted-foreground" />
          </Button>
        ) : null}
      </View>
      {props.items.length ? (
        <View class="overflow-hidden rounded-[20px] bg-card">
          {props.items.map((item) =>
            item.kind === "tab" ? (
              <View class="px-4 pt-2 pb-1">
                <Text class="text-[12px] text-idle">{item.label}</Text>
              </View>
            ) : (
              <Row t={item.t} first={item.firstAfterLabel} />
            )
          )}
        </View>
      ) : (
        <View class="rounded-[20px] bg-card px-4 py-3">
          <Text class="text-[13px] text-muted-foreground">没有正在运行的终端</Text>
        </View>
      )}
    </View>
  );
}

function HomeScreen() {
  async function checkNotificationTap() {
    const tap = await consumePendingNotificationTap();
    if (!tap?.address) return;
    if (tap.desktopId && tap.desktopId !== paired()?.desktopId) {
      await switchDesktop(tap.desktopId);
    }
    nav.push({ name: "term", address: tap.address });
  }

  effect(() => {
    if (lifecycle() === "active") {
      wake();
      refreshNotifyStatus();
      checkNotificationTap();
    }
  });
  checkNotificationTap();

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
    const out: { title: string; items: GroupItem[]; space?: Space; needs?: boolean }[] = [];
    const waiting = terminals.filter((t) => t.state === "blocked" || t.state === "error");
    if (waiting.length) {
      out.push({
        title: "需要你",
        needs: true,
        items: waiting.map((t, i) => ({ kind: "term", t, firstAfterLabel: i === 0 })),
      });
    }
    const placed = new Set<string>();
    for (const space of layout) {
      const items: GroupItem[] = [];
      for (const [tabIdx, tab] of space.tabs.entries()) {
        const ts = tab.terminals.map((a) => byAddr.get(a)).filter(Boolean) as Terminal[];
        if (!ts.length) continue;
        ts.forEach((t) => placed.add(t.address));
        const hasTabLabel = space.tabs.length > 1;
        if (hasTabLabel) items.push({ kind: "tab", label: tab.name || `标签 ${tabIdx + 1}` });
        ts.forEach((t, i) => items.push({ kind: "term", t, firstAfterLabel: hasTabLabel ? i === 0 : items.length === 0 }));
      }
      if (items.length || space.id) out.push({ title: spaceName(space, byAddr), items, space });
    }
    const loose = terminals.filter((t) => !placed.has(t.address));
    if (loose.length) {
      out.push({
        title: "其他终端",
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
      ios={{ headerRightSymbol: "gearshape" }}
      headerRight={
        <Button onPress={() => nav.push({ name: "settings" })} class="h-9 w-9 items-center justify-center rounded-full active:bg-secondary" accessibilityLabel="设置">
          <Icon src={gearIcon} size={20} class="tint-foreground" />
        </Button>
      }
    >
      <Scroll class="flex-1 bg-background" contentClass="gap-4 px-4 pb-10 pt-2">
        {/* Multi-Mac pill bar: always visible so switching Macs or pairing a 2nd/3rd Mac is 1 tap away */}
        <Scroll horizontal scrollbar={false} class="flex-none" contentClass="flex-row items-center gap-2">
          {desktops().map((d: Saved) => {
            const active = d.desktopId === paired()?.desktopId;
            const st = active ? status() : (macStatuses()[d.desktopId] ?? "idle");
            const dotClass = STATUS_DOT[st] ?? "bg-idle";
            return (
              <Button
                onPress={() => { tapHaptic(); switchDesktop(d.desktopId); }}
                class={`h-9 flex-row items-center gap-2 rounded-full px-4 active:opacity-80 ${active ? "bg-primary" : "bg-card"}`}
                testID={`mac-${d.desktopId}`}
              >
                <View class={`h-2 w-2 rounded-full ${dotClass}`} />
                <Text class={`text-[14px] font-medium ${active ? "text-primary-foreground" : "text-card-foreground"}`}>
                  {d.desktopName || "Mac"}
                </Text>
              </Button>
            );
          })}
          <Button
            onPress={() => { tapHaptic(); addingMac.set(true); }}
            class="h-9 flex-row items-center gap-2 rounded-full bg-card px-4 active:bg-secondary"
            testID="home-add-mac"
          >
            <Icon src={plusIcon} size={15} class="tint-muted-foreground" />
            <Text class="text-[14px] font-medium text-muted-foreground">配对新电脑</Text>
          </Button>
        </Scroll>

        {/* Soft rounded status & settings card (guarantees 100% reliable touch target + shows cute Bauhaus sheep icon) */}
        <Button
          onPress={() => nav.push({ name: "settings" })}
          class="flex-row items-center gap-3 rounded-[20px] bg-card px-4 py-3 active:bg-secondary"
          testID="settings"
        >
          <View class="h-10 w-10 overflow-hidden rounded-[12px] bg-[#161616]">
            <Image src={herdrIcon} style={{ width: 40, height: 40 }} />
          </View>
          <View class="flex-1 gap-0.5">
            <View class="flex-row items-center gap-2">
              <View class={`h-2 w-2 rounded-full ${statusInfo().dot}`} />
              <Text class="text-[15px] font-medium text-card-foreground" testID="status">{statusInfo().text}</Text>
            </View>
            <Text class="text-[13px] text-muted-foreground" style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}>
              {problem() || `${list().terminals.length} 个终端 · ${notifyEnabled() ? "通知已开启" : "端到端加密"}`}
            </Text>
          </View>
          <View class="flex-row items-center gap-1">
            <Text class="text-[13px] text-muted-foreground">设置</Text>
            <Icon src={chevronIcon} size={14} class="tint-muted-foreground" />
          </View>
        </Button>

        {status() === "offline" ? (
          <View class="rounded-[20px] bg-card px-4 py-3">
            <Text class="text-[13px] text-muted-foreground">Mac 离线或后台服务没在运行，恢复后会自动重连</Text>
          </View>
        ) : null}
        {status() === "ready" && list().core && list().core !== "online" ? (
          <View class="rounded-[20px] bg-card px-4 py-3">
            <Text class="text-[13px] text-muted-foreground">Mac 在线，但 Herdr 没有运行（herdr-core 不在），打开 Herdr.app 后会自动出现终端</Text>
          </View>
        ) : null}
        {groups().length ? (
          groups().map((g) => <Group title={g.title} items={g.items} space={g.space} needs={g.needs} />)
        ) : (
          <View class="rounded-[20px] bg-card px-4 py-4">
            <Text class="text-[14px] text-muted-foreground">{status() === "ready" ? "没有正在运行的终端" : "连接中…"}</Text>
          </View>
        )}
      </Scroll>
    </NavPage>
  );
}

function Field(props: { label: string; value: string; last?: boolean }) {
  return (
    <View class={`ml-4 min-h-11 flex-row items-center gap-3 py-3 pr-4 ${props.last ? "" : "border-b border-separator"}`}>
      <Text class="text-[15px] text-card-foreground">{props.label}</Text>
      <Text class="flex-1 text-right text-[14px] text-muted-foreground" style={{ numberOfLines: 1 }}>{props.value}</Text>
    </View>
  );
}

function SettingsScreen() {
  const feedback = signal("");
  effect(() => { refreshNotifyStatus(); });

  async function toggleNotify() {
    tapHaptic();
    feedback.set("");
    try {
      if (notifyEnabled() && notifyPermission() === "granted") {
        await disableNotifications();
        feedback.set("已暂停状态通知");
      } else {
        const ok = await enableNotifications();
        feedback.set(ok ? "通知已开启：agent 等你确认、完成或出错时会提醒你" : "没有通知权限：请在 iPhone 设置 ▸ Herdr ▸ 通知 里打开");
      }
    } catch (e: any) {
      feedback.set(e.message || "通知设置失败");
    }
  }

  async function testNotify() {
    tapHaptic();
    feedback.set("");
    try {
      await sendTestNotification();
      feedback.set("已发送测试通知（顶部横幅）");
    } catch (e: any) {
      feedback.set(e.message || "发送测试通知失败");
    }
  }

  const pushOn = computed(() => notifyEnabled() && notifyPermission() === "granted");

  return (
    <NavPage title="设置" headerClass="bg-background">
      <Scroll class="flex-1 bg-background" contentClass="gap-5 px-4 pt-2 pb-10">
        <View class="gap-2">
          <View class="overflow-hidden rounded-[20px] bg-card">
            <Field label="当前电脑" value={paired()?.desktopName ?? "Mac"} />
            <Field label="这台设备" value={info()?.deviceName ?? "Herdr iPhone"} />
            <Field label="中继" value={(paired()?.relay ?? "—").replace(/^https?:\/\//, "")} last />
          </View>
          <Text class="px-2 text-[13px] leading-snug text-muted-foreground">消息端到端加密，中继只转发看不懂的密文</Text>
        </View>

        {/* Status Notification Card */}
        <View class="gap-2">
          <Text class="px-2 text-[13px] font-medium text-muted-foreground">状态通知</Text>
          <View class="gap-3 rounded-[20px] bg-card p-4">
            <View class="flex-row items-center justify-between">
              <View class="flex-row items-center gap-2">
                <View class={`h-2 w-2 rounded-full ${pushOn() ? "bg-ok" : "bg-idle"}`} />
                <Text class="text-[15px] font-medium text-card-foreground">
                  {pushOn() ? "通知已开启" : notifyPermission() === "denied" ? "系统通知权限未开启" : "通知未开启"}
                </Text>
              </View>
            </View>
            <Text class="text-[13px] leading-snug text-muted-foreground">
              当已配对电脑上的 agent 等你确认、完成任务、出错或退出时推送提醒，点通知直达对应终端
            </Text>
            {feedback() ? (
              <View class="rounded-2xl bg-secondary px-3 py-2">
                <Text class="text-[13px] text-foreground">{feedback()}</Text>
              </View>
            ) : null}
            <View class="flex-row gap-2 pt-1">
              <Button
                onPress={toggleNotify}
                class={`h-10 flex-1 items-center justify-center rounded-full active:opacity-80 ${pushOn() ? "bg-secondary" : "bg-primary"}`}
                testID="toggle-notify"
              >
                <Text class={`text-[14px] font-medium ${pushOn() ? "text-foreground" : "text-primary-foreground"}`}>
                  {pushOn() ? "暂停通知" : "开启通知"}
                </Text>
              </Button>
              <Button
                onPress={testNotify}
                class="h-10 flex-1 items-center justify-center rounded-full bg-secondary active:opacity-80"
                testID="test-notify"
              >
                <Text class="text-[14px] font-medium text-foreground">发一条测试</Text>
              </Button>
            </View>
          </View>
        </View>

        {/* Multi-Mac Management Card */}
        <View class="gap-2">
          <Text class="px-2 text-[13px] font-medium text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
            已配对的电脑（{desktops().length} 台）
          </Text>
          <View class="overflow-hidden rounded-[20px] bg-card">
            {desktops().map((d: Saved, i: number) => {
              const active = d.desktopId === paired()?.desktopId;
              const st = active ? status() : (macStatuses()[d.desktopId] ?? "idle");
              const dotClass = STATUS_DOT[st] ?? "bg-idle";
              const stLabel = active ? "当前" : (STATUS_TEXT[st] ?? "切换");
              return (
                <View class={`ml-4 min-h-12 flex-row items-center gap-3 py-3 pr-4 ${i === desktops().length - 1 ? "" : "border-b border-separator"}`}>
                  <Button
                    onPress={() => { tapHaptic(); switchDesktop(d.desktopId); nav.pop(); }}
                    class="flex-1 flex-row items-center gap-3 py-1 active:opacity-60"
                  >
                    <View class={`h-2 w-2 rounded-full ${dotClass}`} />
                    <View class="flex-1">
                      <Text class="text-[15px] font-medium text-card-foreground" style={{ numberOfLines: 1 }}>{d.desktopName || "Mac"}</Text>
                      <Text class="text-[12px] text-muted-foreground">{active ? "当前正在查看" : `${stLabel} · 点此切换`}</Text>
                    </View>
                  </Button>
                  {desktops().length > 1 ? (
                    <Button
                      onPress={() => { tapHaptic(); forget(d.desktopId); }}
                      class="rounded-full bg-secondary px-3 py-1 active:opacity-60"
                    >
                      <Text class="text-[12px] font-medium text-destructive">移除</Text>
                    </Button>
                  ) : (
                    <Text class="text-[13px] text-muted-foreground">当前</Text>
                  )}
                </View>
              );
            })}
          </View>
          <Button onPress={() => { tapHaptic(); nav.pop(); addingMac.set(true); }} class="h-11 flex-row items-center justify-center gap-2 rounded-full bg-card active:bg-secondary" testID="add-mac">
            <Icon src={plusIcon} size={16} class="tint-foreground" />
            <Text class="text-[15px] font-medium text-foreground">配对另一台电脑</Text>
          </Button>
        </View>
        <Button onPress={async () => { tapHaptic(); nav.pop(); await forget(); }} class="h-11 items-center justify-center rounded-full bg-card active:bg-secondary">
          <Text class="text-[15px] font-medium text-destructive">取消当前电脑配对</Text>
        </Button>
      </Scroll>
    </NavPage>
  );
}

// ------------------------------------------------------------------ terminal ---------------
const DARK = { bar: "#1c1c1e", tint: "#f2f2f7" };
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
  const webReady = signal(false);
  let litTimer: any = 0;
  let repeatDelay: any = 0;
  let repeatEvery: any = 0;
  let didRepeat = false;
  let voiceMeterTimer: any = 0;
  let voiceLimitTimer: any = 0;
  let bootTimer: any = setTimeout(() => webReady.set(true), 250);

  let field!: InputRef;
  let web!: WebViewRef;
  let s: number | null = null;
  let opening = false;
  let pageReady = false;
  let closed = false;
  let sized = true;
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
      const fit = lastFit;
      const r = (await rpc("term.open", { address, fit, lead: leads || !opened })) as {
        s: number; cols: number; rows: number; sized?: boolean;
      };
      fitSent = JSON.stringify(fit);
      if (closed) { rpc("term.close", { s: r.s }).catch(() => {}); return; }
      s = r.s;
      sized = r.sized === true;
      post({ t: "open", sized, reopened: opened, cols: r.cols, rows: r.rows });
      opened = true;
      notice.set("");
      for (const m of early.splice(0)) onStream(m);
      refit(false);
    } catch (e: any) { notice.set(`打不开：${e.message}`); } finally { opening = false; }
  }

  activeTermAddress.set(address);
  setStreamListener(onStream);
  effect(() => { if (webReady() && status() === "ready" && s === null) open(); else if (status() !== "ready") s = null; });
  effect(() => { const t = term(); if (t && opened && !sized) post({ t: "size", cols: t.cols, rows: t.rows }); });
  effect(() => { if (!blocked()) letGo.set(false); });
  effect(() => { line.hold(held()); sync(); });
  effect(() => {
    const st = lifecycle();
    if (st === "active") { wake(); refit(false); }
    else if (st === "background") refit(true);
  });
  cleanup(() => {
    closed = true;
    if (activeTermAddress() === address) activeTermAddress.set(null);
    clearTimeout(bootTimer);
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
      clearTimeout(bootTimer);
      pageReady = true;
      if (m.fit) lastFit = m.fit;
      webReady.set(true);
      refit(false);
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
      headerStyle={{ backgroundColor: DARK.bar, color: "#f2f2f7", tintColor: DARK.tint }}
      statusBar={{ foreground: "light" }}
      headerTitle={
        <View class="items-center gap-0.5" accessibilityLabel={title()}>
          <ProgIcon t={term()} size={20} dark />
          <Text class="text-[12px] text-[#8d8d93]" style={{ numberOfLines: 1 }}>{subtitle()}</Text>
        </View>
      }
    >
      <View class="flex-1 bg-[#0b0b0c] pb-[env(keyboard-inset-height)]">
        {/* Terminal stage + floating status bubble + scroll-to-latest button */}
        <View class="relative flex-1 bg-[#0b0b0c]">
          <WebView ref={web} html={TERM_HTML} style={{ flex: 1 }} scrollable={false} onMessage={(e) => fromPage(e.data)} testID="term-web" />
          <If when={bubble()}>
            {(b) => (
              <View class="absolute inset-x-4 bottom-3 items-center" style={{ pointerEvents: "box-none" }}>
                <Button
                  onPress={() => {
                    const action = b().tap;
                    if (action === "let-go") { letGo.set(true); field.focus(); }
                    else if (action === "cancel-voice") stopVoice(true);
                    else if (action === "dismiss") notice.set("");
                  }}
                  class="max-w-full flex-row items-center gap-2 rounded-full border border-[#3a3a3c] bg-[#232325]/95 px-4 py-2"
                  testID="term-bubble"
                >
                  {b().level !== undefined ? (
                    <View class="h-1.5 w-14 overflow-hidden rounded-full bg-[#3a3a3c]">
                      <View class="h-full rounded-full bg-[#879fb0]" style={{ width: Math.round((0.08 + (b().level ?? 0) * 0.92) * 56) }} />
                    </View>
                  ) : null}
                  {b().busy ? <View class="h-2 w-2 rounded-full bg-[#8d8d93]" /> : null}
                  {b().warn ? <View class="h-2 w-2 rounded-full bg-[#f5a623]" /> : null}
                  <Text class="text-[13px] font-medium text-[#ededed]" style={{ numberOfLines: 1 }}>
                    {b().text}
                  </Text>
                </Button>
              </View>
            )}
          </If>
          <If when={!atLatest()}>
            <Button onPress={() => post({ t: "toLatest" })}
              class="absolute right-3 bottom-3 h-[38px] w-[38px] items-center justify-center rounded-full bg-[#2c2c2e]"
              testID="to-latest" accessibilityLabel="回到最新">
              <Icon src={downIcon} size={20} color="#f2f2f7" />
            </Button>
          </If>
        </View>

        {/* Soft rounded footer matching .term-foot in app/src/app.css */}
        <View class="gap-2 bg-[#1c1c1e] px-2 pt-2 pb-[env(safe-area-inset-bottom)]">
          <Scroll horizontal scrollbar={false} keyboardShouldPersistTaps="always" class="flex-none" contentClass="flex-row items-center gap-1.5 px-0.5">
            {KEYBAR_FRONT.map(([label, seq]) => (
              <Button
                onPress={() => onKeyPress(label, seq)}
                onPressDown={() => onKeyDown(label, seq)}
                onPressUp={stopRepeat}
                testID={seq === "\r" ? "send" : undefined}
                class={`h-[34px] min-w-[42px] items-center justify-center rounded-[10px] bg-[#2c2c2e] px-3 active:bg-[#48484a] ${litKey() === label ? "border-2 border-[#f2f2f7]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2f2f7]">{label}</Text>
              </Button>
            ))}
            {agentShortcuts().map(([label, names]) => (
              <Button onPress={() => pressNamed(names, label)}
                class={`h-[34px] min-w-[42px] items-center justify-center rounded-[10px] bg-[#2c2c2e] px-3 active:bg-[#48484a] ${litKey() === label ? "border-2 border-[#f2f2f7]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2f2f7]">{label}</Text>
              </Button>
            ))}
            {named() ? MODS.map((m) => {
              const active = mods().includes(m);
              return (
                <Button onPress={() => toggleMod(m)}
                  class={`h-[34px] min-w-[42px] items-center justify-center rounded-[10px] px-3 ${active ? "bg-[#f2f2f7]" : "bg-[#2c2c2e]"} active:bg-[#48484a]`}>
                  <Text class={`text-[15px] font-medium ${active ? "text-[#1c1c1e]" : "text-[#f2f2f7]"}`}>{MOD_LABELS[m]}</Text>
                </Button>
              );
            }) : null}
            {KEYBAR_BACK.map(([label, seq]) => (
              <Button onPress={() => onKeyPress(label, seq)}
                class={`h-[34px] min-w-[42px] items-center justify-center rounded-[10px] bg-[#2c2c2e] px-3 active:bg-[#48484a] ${litKey() === label ? "border-2 border-[#f2f2f7]" : ""}`}>
                <Text class="text-[15px] font-medium text-[#f2f2f7]">{label}</Text>
              </Button>
            ))}
          </Scroll>

          <View class="relative flex-row items-center gap-2 pb-1">
            <Button onPress={pick} class="h-10 w-10 items-center justify-center rounded-full bg-[#2c2c2e] active:bg-[#48484a]" testID="pick" accessibilityLabel="插入图片">
              <Icon src={plusIcon} size={21} color="#aeaeb2" />
            </Button>
            <Button
              disabled={voiceState() === "busy"}
              onPressDown={() => startVoice()}
              onPressUp={() => { if (voiceState() === "rec") stopVoice(false); }}
              onPress={() => { if (voiceState() === "rec" && Date.now() - recStartedAt >= 400) stopVoice(false); }}
              class={`h-10 flex-1 items-center justify-center rounded-full ${voiceState() === "rec" ? "bg-[#f2f2f7]" : "bg-[#2c2c2e]"} active:bg-[#48484a] ${voiceState() === "busy" ? "opacity-60" : ""}`}
              testID="voice"
              accessibilityLabel="按住说话"
            >
              <Text class={`text-[15.5px] font-semibold tracking-[0.02em] ${voiceState() === "rec" ? "text-[#1c1c1e]" : voiceOk() ? "text-[#f2f2f7]" : "text-[#8d8d93]"}`}>
                {voiceState() === "rec" ? "松开 输入" : voiceState() === "busy" ? "识别中…" : "按住 说话"}
              </Text>
            </Button>
            <Button
              onPress={() => { if (focused()) Keyboard.dismiss(); else field.focus(); }}
              class={`h-10 w-10 items-center justify-center rounded-full ${focused() ? "bg-[#f2f2f7]" : "bg-[#2c2c2e]"} active:bg-[#48484a]`}
              testID="kbd-toggle"
              accessibilityLabel="键盘"
            >
              <Icon src={kbdIcon} size={21} color={focused() ? "#1c1c1e" : "#aeaeb2"} />
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
