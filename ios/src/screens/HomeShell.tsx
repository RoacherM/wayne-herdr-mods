import { computed, effect, lifecycle, safeArea, Scroll, signal, Text, View } from "nsh";
import { AlertDialog, Button, Input, NavPage } from "nsh/base";
import {
  addingMac, connVia, consumePendingNotificationTap, desktops, disableNotifications, enableNotifications,
  forget, info, list, macStatuses, notifyEnabled, notifyPermission, paired, problem, refresh,
  refreshNotifyStatus, rpc, sendTestNotification, status, switchDesktop,
  type Saved, type Space, type Terminal,
} from "../conn";
import {
  AppSwitch, base, BottomSheet, CardDivider, DockTab, FilterPill, fitDetent, formatRelTime, GlassCapsule,
  GlassCircle, Icon, KIND_TEXT, ListCard, MonogramBadge, RowDivider, SectionHeader, SessionRow,
  SettingsGroup, SettingsRow, spaceName, STATUS_TEXT, tapHaptic,
} from "../ui/controls";
import bellIcon from "../../assets/bell.svg";
import brushIcon from "../../assets/brush.svg";
import chatFilledIcon from "../../assets/chat-filled.svg";
import chatIcon from "../../assets/chat.svg";
import checkIcon from "../../assets/check.svg";
import chevronDownIcon from "../../assets/chevron-down.svg";
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
  note: string;
  where: string;
  badge: { label: string; tone: "warn" | "bad" } | null;
  time: string;
};

/** The inbox's groups, in the order they need you (DESIGN.md「原生 App 首页（收件箱）（2026-11-27）」). */
type Group = "needs" | "done" | "working" | "idle";
const GROUPS: { id: Group; title: string }[] = [
  { id: "needs", title: "需要你" },
  { id: "done", title: "完成" },
  { id: "working", title: "工作中" },
  { id: "idle", title: "空闲" },
];
const groupOf = (t: Terminal): Group =>
  t.state === "blocked" || t.state === "error" ? "needs" : t.state === "done" ? "done" : t.state === "working" ? "working" : "idle";

export function HomeShell(props: {
  appearance: () => AppearancePref;
  onChangeAppearance: (next: AppearancePref) => void;
  onOpenTerm: (address: string, reason?: string) => void;
}) {
  const tab = signal<HomeTab>("sessions");
  const filterSpaceId = signal<string>("ALL");
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
    if (status() === "ready" && list().core && list().core !== "online") return `${macName()} · herdr 未运行`;
    if (status() === "connecting") return `重连 ${macName()}…`;
    if (status() === "offline") return `${macName()} 离线`;
    if (status() === "error") return problem() || "连接出错";
    return `${macName()} · ${connVia() === "direct" ? "局域网直连" : "已连接"}`;
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
      const badge = st === "blocked"
        ? { label: KIND_TEXT[t.kind ?? ""] ?? "需要你", tone: "warn" as const }
        : st === "error" ? { label: "出错", tone: "bad" as const } : null;
      const note = t.msg && st !== "idle" ? t.msg : "";

      if (q && !`${title} ${spTitle} ${note} ${what} ${t.address}`.toLowerCase().includes(q)) continue;

      rows.push({
        term: t,
        spaceId: spId,
        spaceTitle: spTitle,
        title,
        note,
        where: what,
        badge,
        time: formatRelTime(t.statusMs),
      });
    }
    return rows;
  });

  /** The rows by group, newest change first within a group; empty groups are left out. */
  const groups = computed(() => {
    const by = new Map<Group, SessionItem[]>();
    for (const r of sessions()) {
      const g = groupOf(r.term);
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(r);
    }
    return GROUPS.filter((g) => by.has(g.id)).map((g) => ({
      ...g,
      rows: by.get(g.id)!.sort((a, b) => (b.term.statusMs ?? 0) - (a.term.statusMs ?? 0)),
    }));
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

        {/* ==================== TAB 1: SESSIONS (inbox) ==================== */}
        <If when={tab() === "sessions"}>
          <View class="flex-1">
            <View class="flex-row items-center gap-3 pt-2 pr-4 pb-1 pl-5">
              <View class="flex-1 gap-1">
                <Text class="text-[32px] font-bold tracking-[-0.02em] text-foreground">会话</Text>
                <Button
                  onPress={() => { tapHaptic(); picker.set("env"); }}
                  class="flex-row items-center gap-1.5 self-start active:opacity-60"
                  testID="status"
                  accessibilityLabel={`${headerTitle()}，切换电脑`}
                >
                  <Icon
                    src={isOnline() ? wifiIcon : wifiOffIcon}
                    size={14}
                    class={isOnline() ? "tint-ok" : "tint-muted-foreground"}
                  />
                  <Text class="text-[14px] text-muted-foreground" style={{ numberOfLines: 1 }}>
                    {headerTitle()}
                  </Text>
                  <Icon src={chevronDownIcon} size={11} class="tint-muted-foreground" />
                </Button>
              </View>
              <GlassCircle
                onPress={() => { tapHaptic(); picker.set("new-term"); }}
                size={46}
                accessibilityLabel="新建终端"
                testID="new-term"
              >
                <Icon src={composeIcon} size={20} class="tint-foreground" />
              </GlassCircle>
            </View>

            <Scroll class="flex-1" contentStyle={{ paddingBottom: safeArea().bottom + 104 }} keyboardDismissMode="on-drag">
              <View class="gap-3 px-4 pt-3">
                <View class="h-12 flex-row items-center gap-2.5 rounded-full bg-card px-4" style={{ borderCurve: "continuous" }}>
                  <Icon src={searchIcon} size={17} class="tint-muted-foreground" />
                  <Input
                    value={query()}
                    onChange={(e) => query.set(e.value)}
                    placeholder="跳到某个终端…"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    class="flex-1 text-[16px] text-foreground"
                    testID="home-search-input"
                  />
                  {query() ? (
                    <Button onPress={() => query.set("")} class="h-8 w-8 items-center justify-center rounded-full active:bg-secondary" accessibilityLabel="清空">
                      <Icon src={xIcon} size={14} class="tint-muted-foreground" />
                    </Button>
                  ) : null}
                </View>
                {spaces().length > 1 ? (
                  <View class="flex-row">
                    <FilterPill
                      label={selectedSpaceName()}
                      active={filterSpaceId() !== "ALL"}
                      onPress={() => { tapHaptic(); picker.set("project"); }}
                      testID="filter-space"
                    />
                  </View>
                ) : null}
              </View>

              {groups().length ? (
                groups().map((g) => (
                  <View>
                    <SectionHeader title={g.title} count={g.rows.length} />
                    <ListCard>
                      {g.rows.map((row, i) => (
                        <View>
                          {i > 0 ? <CardDivider /> : null}
                          <SessionRow
                            avatar={row.spaceTitle}
                            title={row.title}
                            note={row.note}
                            noteTone={row.badge?.tone ?? "muted"}
                            where={row.where}
                            term={row.term}
                            badge={row.badge}
                            mark={g.id === "done" ? "unread" : g.id === "working" ? "working" : null}
                            time={row.time}
                            onPress={() => { tapHaptic(); props.onOpenTerm(row.term.address, "row"); }}
                            testID={`row-${row.term.address}`}
                          />
                        </View>
                      ))}
                    </ListCard>
                  </View>
                ))
              ) : (
                <View class="items-center justify-center gap-2 py-20">
                  <Text class="text-[15px] text-muted-foreground">
                    {query().trim()
                      ? "没有匹配的终端"
                      : status() === "ready" ? "暂无终端" : STATUS_TEXT[status()] ?? "连接中…"}
                  </Text>
                </View>
              )}
            </Scroll>
          </View>
        </If>

        {/* ==================== TAB 2: SETTINGS ==================== */}
        <If when={tab() === "settings"}>
          <View class="flex-1">
            <View class="flex-row items-center justify-between pt-2 pr-4 pb-3 pl-5">
              <Text class="text-[32px] font-bold tracking-[-0.02em] text-foreground">设置</Text>
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

            <Scroll class="flex-1" contentClass="gap-5 px-4 pt-1" contentStyle={{ paddingBottom: safeArea().bottom + 108 }}>
              <SettingsGroup title="连接">
                {matchSetting("当前电脑 mac") ? (
                  <SettingsRow
                    icon={userIcon}
                    label="当前电脑"
                    value={macName()}
                    onPress={() => { tapHaptic(); picker.set("macs"); }}
                  />
                ) : null}
                {matchSetting("当前电脑 mac") && matchSetting("已配对电脑 环境") ? <RowDivider /> : null}
                {matchSetting("已配对电脑 环境") ? (
                  <SettingsRow
                    icon={monitorIcon}
                    label="已配对电脑"
                    value={String(desktops().length)}
                    onPress={() => { tapHaptic(); picker.set("macs"); }}
                  />
                ) : null}
                {matchSetting("已配对电脑 环境") && matchSetting("通知 推送") ? <RowDivider /> : null}
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
                {matchSetting("外观 深色 浅色 主题") && matchSetting("中继 直连 通道") ? <RowDivider /> : null}
                {matchSetting("中继 直连 通道") ? (
                  <SettingsRow
                    icon={globeIcon}
                    label="连接通道"
                    value={connVia() === "direct" ? "局域网直连" : (paired()?.relay ?? "中继").replace(/^https?:\/\//, "")}
                    showChevron={false}
                  />
                ) : null}
                {matchSetting("中继 直连 通道") && matchSetting("发送测试通知") ? <RowDivider /> : null}
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
                {matchSetting("配对新电脑 扫码") && matchSetting("移除当前电脑 解绑") ? <RowDivider /> : null}
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

        {/* ==================== FLOATING LIQUID GLASS DOCK (会话 | 设置) ==================== */}
        <View
          class="absolute right-0 left-0 items-center"
          style={{ bottom: safeArea().bottom + 10 }}
        >
          <GlassCapsule class="h-[62px] w-[208px] gap-1 p-[5px]">
            <DockTab
              icon={chatIcon}
              activeIcon={chatFilledIcon}
              label="会话"
              active={tab() === "sessions"}
              onPress={() => { tapHaptic(); tab.set("sessions"); }}
              testID="tab-sessions"
            />
            <DockTab
              icon={gearIcon}
              label="设置"
              active={tab() === "settings"}
              onPress={() => { tapHaptic(); refreshNotifyStatus(); tab.set("settings"); }}
              testID="settings"
            />
          </GlassCapsule>
        </View>

        {/* ==================== PICKER BOTTOM SHEETS ==================== */}
        <BottomSheet
          open={picker() === "env" || picker() === "macs"}
          onClose={() => picker.set(null)}
          title="已配对电脑"
          detents={fitDetent(desktops().length, 52, 58)}
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
          detents={fitDetent(spaces().length + 1, 50)}
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
                testID={`space-${s.space.id}`}
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
          detents={fitDetent(spaces().length, 50)}
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
