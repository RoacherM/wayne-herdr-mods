import { computed, effect, lifecycle, safeArea, Scroll, signal, Text, View } from "nsh";
import { AlertDialog, Button, Input, NavPage } from "nsh/base";
import {
  addingMac, connVia, consumePendingNotificationTap, desktops, disableNotifications, enableNotifications,
  forget, info, list, macStatuses, notifyEnabled, notifyPermission, paired, problem, refresh,
  refreshNotifyStatus, rpc, sendTestNotification, status, switchDesktop,
  type Saved, type Space, type Terminal,
} from "../conn";
import {
  AppSwitch, base, BottomSheet, FilterPill, formatRelTime, GlassCapsule, GlassCircle, Icon,
  KIND_TEXT, MonogramBadge, ProgIcon, SettingsGroup, SettingsRow, spaceName, STATE_TEXT,
  STATUS_TEXT, tapHaptic,
} from "../ui/controls";
import bellIcon from "../../assets/bell.svg";
import brushIcon from "../../assets/brush.svg";
import chatFilledIcon from "../../assets/chat-filled.svg";
import chatIcon from "../../assets/chat.svg";
import checkIcon from "../../assets/check.svg";
import clockIcon from "../../assets/clock.svg";
import composeIcon from "../../assets/compose.svg";
import gearIcon from "../../assets/gear.svg";
import globeIcon from "../../assets/globe.svg";
import monitorIcon from "../../assets/monitor.svg";
import scanIcon from "../../assets/scan.svg";
import searchIcon from "../../assets/search.svg";
import slidersIcon from "../../assets/sliders.svg";
import trashIcon from "../../assets/trash.svg";
import userIcon from "../../assets/user.svg";
import wifiIcon from "../../assets/wifi.svg";
import wifiOffIcon from "../../assets/wifi-off.svg";
import xIcon from "../../assets/x.svg";

export type AppearancePref = "system" | "dark" | "light";
type HomeTab = "sessions" | "settings";
type SheetKind = null | "env" | "project" | "new-term" | "macs" | "appearance";

const APPEARANCE_LABEL: Record<AppearancePref, string> = {
  system: "跟随系统",
  dark: "深色",
  light: "浅色",
};

type SessionItem = {
  term: Terminal;
  spaceId: string;
  spaceTitle: string;
  title: string;
  sub: string;
  urgent: boolean;
  rightMeta: string;
};

export function HomeShell(props: {
  appearance: () => AppearancePref;
  onChangeAppearance: (next: AppearancePref) => void;
  onOpenTerm: (address: string, reason?: string) => void;
}) {
  const tab = signal<HomeTab>("sessions");
  const filterSpaceId = signal<string>("ALL");
  const searchOpen = signal<boolean>(false);
  const query = signal<string>("");
  const setSearchOpen = signal<boolean>(false);
  const setQuery = signal<string>("");
  const picker = signal<SheetKind>(null);
  const testResult = signal<string>("");
  const creating = signal<boolean>(false);

  async function checkNotificationTap() {
    const tap = await consumePendingNotificationTap();
    if (!tap?.address) return;
    if (tap.desktopId && tap.desktopId !== paired()?.desktopId) {
      await switchDesktop(tap.desktopId);
    }
    props.onOpenTerm(tap.address, "notification");
  }

  effect(() => {
    if (lifecycle() === "active") {
      refreshNotifyStatus();
      checkNotificationTap();
    }
  });
  checkNotificationTap();

  const macName = computed(() => paired()?.desktopName ?? info()?.desktopName ?? "Mac");
  const isOnline = computed(() => status() === "ready" && (!list().core || list().core === "online"));
  const headerTitle = computed(() => {
    if (status() === "ready" && list().core && list().core !== "online") return "herdr 未运行";
    if (status() === "connecting") return `重连 ${macName()}…`;
    if (status() === "offline") return `${macName()} 离线`;
    if (status() === "error") return problem() || "连接出错";
    return macName();
  });

  const spaces = computed(() => {
    const { terminals, layout } = list();
    const byAddr = new Map(terminals.map((t) => [t.address, t]));
    return layout.map((sp) => ({ space: sp, name: spaceName(sp, byAddr) }));
  });

  const selectedSpaceName = computed(() => {
    const id = filterSpaceId();
    if (id === "ALL") return "全部工作区";
    return spaces().find((s) => s.space.id === id)?.name ?? "全部工作区";
  });

  const sessions = computed<SessionItem[]>(() => {
    const { terminals, layout } = list();
    const byAddr = new Map(terminals.map((t) => [t.address, t]));
    const termSpace = new Map<string, { id: string; name: string }>();
    for (const sp of layout) {
      const name = spaceName(sp, byAddr);
      for (const tb of sp.tabs) {
        for (const addr of tb.terminals) {
          termSpace.set(addr, { id: sp.id, name });
        }
      }
    }

    const q = query().trim().toLowerCase();
    const spFilter = filterSpaceId();
    const rows: SessionItem[] = [];

    for (const t of terminals) {
      const spInfo = termSpace.get(t.address);
      const spId = spInfo?.id ?? "";
      const spTitle = spInfo?.name ?? base(t.cwd) ?? t.address;
      if (spFilter !== "ALL" && spId !== spFilter) continue;

      const cwdBase = base(t.cwd);
      const what = t.app || t.program || "shell";
      const title = cwdBase && cwdBase !== spTitle ? `${spTitle} · ${cwdBase}` : spTitle || what;
      const st = t.state ?? "idle";
      const urgent = st === "blocked" || st === "error";
      const statusHint = st === "blocked" ? (KIND_TEXT[t.kind ?? ""] ?? STATE_TEXT.blocked) : "";
      const sub = t.msg && st !== "idle"
        ? t.msg
        : statusHint || (what !== title ? what : "");

      if (q && !`${title} ${spTitle} ${sub} ${what} ${t.address}`.toLowerCase().includes(q)) continue;

      rows.push({
        term: t,
        spaceId: spId,
        spaceTitle: spTitle,
        title,
        sub,
        urgent,
        rightMeta: formatRelTime(t.statusMs) || t.address,
      });
    }

    // Urgent (blocked/error) first, then working, then rest
    const rank = (s: SessionItem) => (s.urgent ? 0 : s.term.state === "working" ? 1 : 2);
    rows.sort((a, b) => rank(a) - rank(b));
    return rows;
  });

  async function createTerminalIn(sp: Space) {
    if (creating()) return;
    creating.set(true);
    tapHaptic();
    picker.set(null);
    try {
      const { address } = (await rpc("term.new", { space: sp.id }, 15_000)) as { address: string };
      await refresh();
      props.onOpenTerm(address, "term.new");
    } catch (e: any) {
      problem.set(e.message || "新建终端失败");
    } finally {
      creating.set(false);
    }
  }

  // ---- Settings actions ----
  const pushOn = computed(() => notifyEnabled() && notifyPermission() === "granted");

  async function toggleNotify(want: boolean) {
    tapHaptic();
    try {
      if (want) await enableNotifications();
      else await disableNotifications();
    } catch {}
  }

  async function runTestNotify() {
    tapHaptic();
    try {
      await sendTestNotification();
      testResult.set("已发送");
      setTimeout(() => testResult.set(""), 1800);
    } catch (e: any) {
      testResult.set(e.message ? "失败" : "");
      setTimeout(() => testResult.set(""), 2000);
    }
  }

  async function confirmForget(desktopId?: string) {
    tapHaptic();
    const target = desktops().find((d) => d.desktopId === desktopId) ?? paired();
    const name = target?.desktopName || "Mac";
    const res = await AlertDialog.show({
      title: "移除当前电脑？",
      description: `需要重新扫码才能连接 ${name}。`,
      actions: [
        { id: "cancel", label: "取消", role: "cancel" },
        { id: "remove", label: "移除", role: "destructive" },
      ],
    });
    if (res.action === "remove") {
      await forget(desktopId);
    }
  }

  function matchSetting(keywords: string) {
    const q = setQuery().trim().toLowerCase();
    return !q || keywords.toLowerCase().includes(q);
  }

  return (
    <NavPage title={macName()} headerVisible={false}>
      <View class="relative flex-1 bg-background pt-[env(safe-area-inset-top)]">

        {/* ==================== TAB 1: SESSIONS (Screenshot 1) ==================== */}
        <If when={tab() === "sessions"}>
          <View class="flex-1">
            <View class="flex-row items-center justify-between gap-2.5 px-[18px] pt-1.5 pb-3">
              <Button
                onPress={() => { if (desktops().length > 1) { tapHaptic(); picker.set("env"); } }}
                class="flex-1 flex-row items-center gap-2"
                testID="status"
                accessibilityLabel={headerTitle()}
              >
                <Icon
                  src={isOnline() ? wifiIcon : wifiOffIcon}
                  size={17}
                  class={isOnline() ? "tint-ok" : "tint-muted-foreground"}
                />
                <Text
                  class={`flex-1 text-[20px] font-semibold ${isOnline() ? "text-foreground" : "text-muted-foreground"}`}
                  style={{ numberOfLines: 1 }}
                >
                  {headerTitle()}
                </Text>
              </Button>

              <GlassCircle
                onPress={() => {
                  tapHaptic();
                  const next = !searchOpen();
                  searchOpen.set(next);
                  if (!next) query.set("");
                }}
                size={44}
                accessibilityLabel="搜索"
                testID="home-search"
              >
                <Icon src={searchIcon} size={20} class="tint-foreground" />
              </GlassCircle>
            </View>

            <If when={searchOpen()}>
              <View class="px-[18px] pb-3">
                <GlassCapsule class="h-11 gap-2.5 px-3.5">
                  <Icon src={searchIcon} size={17} class="tint-muted-foreground" />
                  <Input
                    value={query()}
                    onChange={(e) => query.set(e.value)}
                    placeholder="搜索会话或工作区"
                    autoCapitalize="none"
                    autoCorrect={false}
                    class="flex-1 text-[16px] text-foreground"
                    testID="home-search-input"
                  />
                  {query() ? (
                    <Button onPress={() => query.set("")} class="h-7 w-7 items-center justify-center rounded-full">
                      <Icon src={xIcon} size={14} class="tint-muted-foreground" />
                    </Button>
                  ) : null}
                </GlassCapsule>
              </View>
            </If>

            <View class="flex-row items-center gap-2.5 px-[18px] pb-3">
              <FilterPill
                label={desktops().length > 1 ? macName() : "全部电脑"}
                active={desktops().length > 1}
                onPress={() => { tapHaptic(); picker.set("env"); }}
                testID="filter-env"
              />
              <FilterPill
                label={selectedSpaceName()}
                active={filterSpaceId() !== "ALL"}
                onPress={() => { tapHaptic(); picker.set("project"); }}
                testID="filter-space"
              />
            </View>

            <Scroll class="flex-1" contentStyle={{ paddingBottom: safeArea().bottom + 104 }}>
              {sessions().length ? (
                sessions().map((row) => (
                  <Button
                    onPress={() => { tapHaptic(); props.onOpenTerm(row.term.address, "row"); }}
                    class="flex-row items-start gap-3 border-b border-separator px-[18px] py-[15px] active:bg-secondary/60"
                    testID={`row-${row.term.address}`}
                  >
                    <MonogramBadge label={row.spaceTitle} />
                    <View class="flex-1 gap-1">
                      <Text class="text-[17px] font-medium text-foreground" style={{ numberOfLines: 1 }}>
                        {row.title}
                      </Text>
                      {row.sub ? (
                        <Text
                          class={`text-[13.5px] ${row.urgent ? "text-warn" : "text-muted-foreground"}`}
                          style={{ numberOfLines: 1 }}
                        >
                          {row.sub}
                        </Text>
                      ) : null}
                    </View>
                    <View class="items-end gap-1.5 pt-0.5">
                      <Text
                        class="text-[14px] text-muted-foreground"
                        style={{ fontVariant: ["tabular-nums"] }}
                      >
                        {row.rightMeta}
                      </Text>
                      <View class="flex-row items-center gap-1.5">
                        {row.urgent ? (
                          <View class="h-1.5 w-1.5 rounded-full bg-warn" />
                        ) : row.term.state === "working" ? (
                          <View class="h-1.5 w-1.5 rounded-full bg-accent" />
                        ) : null}
                        <ProgIcon t={row.term} size={14} tone="muted" />
                      </View>
                    </View>
                  </Button>
                ))
              ) : (
                <View class="items-center justify-center py-16">
                  <Text class="text-[15px] text-muted-foreground">
                    {status() === "ready" ? "暂无终端" : STATUS_TEXT[status()] ?? "连接中…"}
                  </Text>
                </View>
              )}
            </Scroll>
          </View>
        </If>

        {/* ==================== TAB 2: SETTINGS (Screenshot 2) ==================== */}
        <If when={tab() === "settings"}>
          <View class="flex-1">
            <View class="flex-row items-center justify-between px-[18px] pt-1.5 pb-3">
              <Text class="text-[23px] font-semibold text-foreground">设置</Text>
              <GlassCapsule class="h-[42px] gap-0.5 px-1">
                <Button
                  onPress={() => { tapHaptic(); picker.set("appearance"); }}
                  class="h-9 w-10 items-center justify-center rounded-full active:bg-secondary"
                  accessibilityLabel="外观"
                >
                  <Icon src={slidersIcon} size={19} class="tint-foreground" />
                </Button>
                <Button
                  onPress={() => {
                    tapHaptic();
                    const next = !setSearchOpen();
                    setSearchOpen.set(next);
                    if (!next) setQuery.set("");
                  }}
                  class="h-9 w-10 items-center justify-center rounded-full active:bg-secondary"
                  accessibilityLabel="搜索设置"
                >
                  <Icon src={searchIcon} size={19} class="tint-foreground" />
                </Button>
              </GlassCapsule>
            </View>

            <If when={setSearchOpen()}>
              <View class="px-[18px] pb-3">
                <GlassCapsule class="h-11 gap-2.5 px-3.5">
                  <Icon src={searchIcon} size={17} class="tint-muted-foreground" />
                  <Input
                    value={setQuery()}
                    onChange={(e) => setQuery.set(e.value)}
                    placeholder="搜索设置"
                    autoCapitalize="none"
                    autoCorrect={false}
                    class="flex-1 text-[16px] text-foreground"
                  />
                </GlassCapsule>
              </View>
            </If>

            <Scroll class="flex-1" contentClass="gap-4 px-4 pt-1" contentStyle={{ paddingBottom: safeArea().bottom + 108 }}>
              <SettingsGroup title="连接">
                {matchSetting("当前电脑 mac") ? (
                  <SettingsRow
                    icon={userIcon}
                    label="当前电脑"
                    value={macName()}
                    onPress={() => { tapHaptic(); picker.set("macs"); }}
                  />
                ) : null}
                {matchSetting("已配对电脑 环境") ? (
                  <SettingsRow
                    icon={monitorIcon}
                    label="已配对电脑"
                    value={String(desktops().length)}
                    onPress={() => { tapHaptic(); picker.set("macs"); }}
                  />
                ) : null}
                {matchSetting("通知 推送") ? (
                  <SettingsRow
                    icon={bellIcon}
                    label="通知"
                    trailing={
                      <AppSwitch
                        checked={pushOn()}
                        onChange={toggleNotify}
                        accessibilityLabel="状态通知"
                        testID="toggle-notify"
                      />
                    }
                  />
                ) : null}
              </SettingsGroup>

              <SettingsGroup>
                {matchSetting("外观 深色 浅色 主题") ? (
                  <SettingsRow
                    icon={brushIcon}
                    label="外观"
                    value={APPEARANCE_LABEL[props.appearance()]}
                    onPress={() => { tapHaptic(); picker.set("appearance"); }}
                    testID="settings-appearance"
                  />
                ) : null}
                {matchSetting("中继 直连 通道") ? (
                  <SettingsRow
                    icon={globeIcon}
                    label="连接通道"
                    value={connVia() === "direct" ? "局域网直连" : (paired()?.relay ?? "中继").replace(/^https?:\/\//, "")}
                    showChevron={false}
                  />
                ) : null}
                {matchSetting("发送测试通知") ? (
                  <SettingsRow
                    icon={clockIcon}
                    label="发送测试通知"
                    value={testResult()}
                    onPress={runTestNotify}
                    testID="test-notify"
                  />
                ) : null}
              </SettingsGroup>

              <SettingsGroup title="设备">
                {matchSetting("配对新电脑 扫码") ? (
                  <SettingsRow
                    icon={scanIcon}
                    label="配对新电脑"
                    onPress={() => { tapHaptic(); addingMac.set(true); }}
                    testID="add-mac"
                  />
                ) : null}
                {matchSetting("移除当前电脑 解绑") ? (
                  <SettingsRow
                    icon={trashIcon}
                    label="移除当前电脑"
                    tone="danger"
                    onPress={() => confirmForget()}
                    testID="forget-mac"
                  />
                ) : null}
              </SettingsGroup>
            </Scroll>
          </View>
        </If>

        {/* ==================== FLOATING BOTTOM LIQUID GLASS DOCK (2 tabs: Sessions | Settings) ==================== */}
        <View
          class="absolute right-[18px] left-[18px] flex-row items-center justify-between"
          style={{ bottom: safeArea().bottom + 12 }}
        >
          <GlassCapsule class="h-[60px] w-[192px] p-[5px]">
            <Button
              onPress={() => { tapHaptic(); tab.set("sessions"); }}
              class={`h-[50px] flex-1 items-center justify-center rounded-full transition-colors duration-150 ${
                tab() === "sessions" ? "bg-glass-active" : ""
              }`}
              accessibilityLabel="会话"
              testID="tab-sessions"
            >
              <Icon
                src={tab() === "sessions" ? chatFilledIcon : chatIcon}
                size={21}
                class={tab() === "sessions" ? "tint-accent" : "tint-foreground"}
              />
            </Button>

            <Button
              onPress={() => { tapHaptic(); refreshNotifyStatus(); tab.set("settings"); }}
              class={`h-[50px] flex-1 items-center justify-center rounded-full transition-colors duration-150 ${
                tab() === "settings" ? "bg-glass-active" : ""
              }`}
              accessibilityLabel="设置"
              testID="settings"
            >
              <Icon
                src={gearIcon}
                size={21}
                class={tab() === "settings" ? "tint-accent" : "tint-foreground"}
              />
            </Button>
          </GlassCapsule>

          <If when={tab() === "sessions"}>
            <GlassCircle
              onPress={() => { tapHaptic(); picker.set("new-term"); }}
              size={60}
              accessibilityLabel="新建终端"
              testID="new-term"
            >
              <Icon src={composeIcon} size={21} class="tint-foreground" />
            </GlassCircle>
          </If>
        </View>

        {/* ==================== PICKER BOTTOM SHEETS ==================== */}
        <BottomSheet
          open={picker() === "env" || picker() === "macs"}
          onClose={() => picker.set(null)}
          title="已配对电脑"
          detents={[{ fraction: 0.48 }, "large"]}
        >
          <Scroll class="flex-1" contentClass="pb-8">
            {desktops().map((d: Saved) => {
              const active = d.desktopId === paired()?.desktopId;
              const st = active ? status() : (macStatuses()[d.desktopId] ?? "idle");
              return (
                <Button
                  onPress={() => { tapHaptic(); switchDesktop(d.desktopId); picker.set(null); }}
                  class="min-h-[52px] flex-row items-center justify-between gap-3 px-5 active:bg-secondary/60"
                  testID={`mac-${d.desktopId}`}
                >
                  <View class="flex-1 gap-0.5">
                    <Text class="text-[16.5px] font-medium text-foreground" style={{ numberOfLines: 1 }}>
                      {d.desktopName || "Mac"}
                    </Text>
                    <Text class="text-[13px] text-muted-foreground">
                      {STATUS_TEXT[st] ?? st}
                    </Text>
                  </View>
                  {active ? <Icon src={checkIcon} size={18} class="tint-accent" /> : null}
                </Button>
              );
            })}
            <Button
              onPress={() => { tapHaptic(); picker.set(null); addingMac.set(true); }}
              class="mt-2 min-h-[50px] flex-row items-center gap-3 px-5 active:bg-secondary/60"
            >
              <Icon src={scanIcon} size={18} class="tint-accent" />
              <Text class="text-[16px] font-medium text-accent">配对新电脑</Text>
            </Button>
          </Scroll>
        </BottomSheet>

        <BottomSheet
          open={picker() === "project"}
          onClose={() => picker.set(null)}
          title="选择工作区"
          detents={[{ fraction: 0.52 }, "large"]}
        >
          <Scroll class="flex-1" contentClass="pb-8">
            <Button
              onPress={() => { tapHaptic(); filterSpaceId.set("ALL"); picker.set(null); }}
              class="min-h-[50px] flex-row items-center justify-between px-5 active:bg-secondary/60"
            >
              <Text class="text-[16.5px] text-foreground">全部工作区</Text>
              {filterSpaceId() === "ALL" ? <Icon src={checkIcon} size={18} class="tint-accent" /> : null}
            </Button>
            {spaces().map((s) => (
              <Button
                onPress={() => {
                  tapHaptic();
                  filterSpaceId.set(s.space.id);
                  picker.set(null);
                }}
                class="min-h-[50px] flex-row items-center justify-between px-5 active:bg-secondary/60"
              >
                <Text class="text-[16.5px] text-foreground">{s.name}</Text>
                {filterSpaceId() === s.space.id ? <Icon src={checkIcon} size={18} class="tint-accent" /> : null}
              </Button>
            ))}
          </Scroll>
        </BottomSheet>

        <BottomSheet
          open={picker() === "new-term"}
          onClose={() => picker.set(null)}
          title="新建终端"
          detents={[{ fraction: 0.52 }, "large"]}
        >
          <Scroll class="flex-1" contentClass="pb-8">
            {spaces().map((s) => (
              <Button
                onPress={() => createTerminalIn(s.space)}
                class="min-h-[50px] flex-row items-center gap-3 px-5 active:bg-secondary/60"
                testID={`add-${s.space.id}`}
              >
                <MonogramBadge label={s.name} />
                <Text class="flex-1 text-[16.5px] text-foreground" style={{ numberOfLines: 1 }}>
                  {s.name}
                </Text>
              </Button>
            ))}
          </Scroll>
        </BottomSheet>

        <BottomSheet
          open={picker() === "appearance"}
          onClose={() => picker.set(null)}
          title="外观"
          detents={[{ fraction: 0.36 }]}
        >
          <View class="pb-6">
            {(["system", "dark", "light"] as AppearancePref[]).map((mode) => (
              <Button
                onPress={() => {
                  tapHaptic();
                  props.onChangeAppearance(mode);
                  picker.set(null);
                }}
                class="min-h-[50px] flex-row items-center justify-between px-5 active:bg-secondary/60"
                testID={`appearance-${mode}`}
              >
                <Text class="text-[16.5px] text-foreground">{APPEARANCE_LABEL[mode]}</Text>
                {props.appearance() === mode ? <Icon src={checkIcon} size={18} class="tint-accent" /> : null}
              </Button>
            ))}
          </View>
        </BottomSheet>
      </View>
    </NavPage>
  );
}
