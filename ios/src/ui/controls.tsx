import { colorScheme, host, Image, platform, safeArea, Text, token, View, windowSize } from "nsh";
import type { JSX, SheetDetent, ViewStyle } from "nsh/types";
import { Button, Sheet, Switch as BaseSwitch } from "nsh/base";
import { Haptics, isAvailable as mobileAvailable } from "nsh/mobile";
import type { Space, Terminal } from "../conn";
import { PROG_ICONS } from "../prog-icons";
import chevronDownIcon from "../../assets/chevron-down.svg";
import chevronIcon from "../../assets/chevron.svg";
import spinnerIcon from "../../assets/spinner.svg";
import xIcon from "../../assets/x.svg";

const MAJOR_OS = Number(String(platform.version ?? "0").split(".")[0]) || 0;
export const HAS_NATIVE_GLASS = (platform.os === "ios" || platform.os === "macos") && MAJOR_OS >= 26;

/**
 * Pure Apple Liquid Glass on iOS 26+ / macOS 26+: zero opaque fill and zero double border so
 * native `UIGlassEffect` refraction and Fresnel specular rim show unobstructed. Older OSes
 * fall back to frosted blur + subtle translucent surface classes.
 */
export const GLASS_STYLE: ViewStyle = {
  glassEffect: "regular",
  borderCurve: "continuous",
  backdropFilter: "blur(24px)",
};

/**
 * Keeps terminal Liquid Glass smoked dark even if the user explicitly switches the app to Light
 * Mode in Settings (so native `UIGlassEffect` never turns milky white over `#000000`).
 */
export function glassStyle(tone: "default" | "term" = "default", extra?: ViewStyle): ViewStyle {
  const needsDarkTint = HAS_NATIVE_GLASS && tone === "term" && colorScheme() === "light";
  return {
    ...GLASS_STYLE,
    ...(needsDarkTint ? { glassTintColor: token("term-glass-tint") } : {}),
    ...extra,
  };
}

export const CARD_CURVE: ViewStyle = {
  borderCurve: "continuous",
};

export const STATE_TEXT: Record<string, string> = {
  blocked: "等你处理",
  working: "工作中",
  done: "完成",
  idle: "空闲",
  error: "出错",
};

export const KIND_TEXT: Record<string, string> = {
  permission: "等你确认",
  question: "在问你",
  auth: "要登录",
};

export const STATUS_TEXT: Record<string, string> = {
  connecting: "连接中…",
  offline: "电脑离线",
  ready: "已连接",
  error: "连接出错",
  idle: "未连接",
};

const SHELLS = new Set([
  "zsh", "bash", "fish", "sh", "dash", "nu", "pwsh", "powershell",
  "cmd", "elvish", "xonsh", "tcsh", "csh", "ksh", "ion",
]);
const ALIASES: Record<string, string> = {
  "claude-code": "claude",
  agy: "antigravity",
  "cursor-agent": "cursor",
};

const BADGE_CLASSES: [string, string][] = [
  ["bg-badge-0", "text-badge-0-fg"],
  ["bg-badge-1", "text-badge-1-fg"],
  ["bg-badge-2", "text-badge-2-fg"],
  ["bg-badge-3", "text-badge-3-fg"],
  ["bg-badge-4", "text-badge-4-fg"],
  ["bg-badge-5", "text-badge-5-fg"],
];

export const base = (p?: string | null) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "");

export const tapHaptic = () => {
  if (mobileAvailable) {
    try { Haptics.impact("light"); return; } catch {}
  }
  if (host.available()) try { host.post("haptic"); } catch {}
};

export function fmtBytes(n?: number) {
  if (!n || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelTime(ms?: number | null): string {
  if (!ms || ms <= 0) return "";
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function spaceName(space: Space, byAddr: Map<string, Terminal>) {
  if (space.name) return space.name;
  for (const tab of space.tabs) {
    for (const a of tab.terminals) {
      const w = byAddr.get(a)?.where;
      if (w) return w.replace(/ \/ \d+$/, "");
    }
  }
  return base(space.folder) || "工作区";
}

export function monogramOf(label: string): string {
  const clean = label.trim().replace(/^[^A-Za-z0-9\u4e00-\u9fa5]+/, "");
  if (!clean) return "HD";
  const parts = clean.split(/[-_./\s]+/).filter(Boolean);
  if (parts.length >= 2 && /^[A-Za-z0-9]/.test(parts[0]) && /^[A-Za-z0-9]/.test(parts[1])) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  const alnum = clean.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length >= 2) return alnum.slice(0, 2).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function MonogramBadge(props: { label: string; size?: "sm" | "md" }) {
  const idx = hashSeed(props.label) % BADGE_CLASSES.length;
  const [bgCls, fgCls] = BADGE_CLASSES[idx];
  const md = props.size === "md";
  return (
    <View
      class={`items-center justify-center ${md ? "h-10 w-10 rounded-[11px]" : "mt-0.5 h-7 w-7 rounded-[8px]"} ${bgCls}`}
      style={CARD_CURVE}
    >
      <Text class={`${md ? "text-[14px]" : "text-[11px]"} font-bold tracking-[0.02em] ${fgCls}`}>{monogramOf(props.label)}</Text>
    </View>
  );
}

export function Icon(props: { src: any; size?: number; class?: string }) {
  const n = props.size ?? 20;
  return (
    <Image
      src={props.src}
      class={props.class ?? "tint-muted-foreground"}
      style={{ width: n, height: n }}
    />
  );
}

export function resolveIconKey(t?: Terminal | null): string {
  if (!t) return "shell";
  if (t.icon) return t.icon;
  const raw = String(t.app || t.program || "").toLowerCase();
  if (!raw || SHELLS.has(raw)) return "shell";
  return ALIASES[raw] ?? raw;
}

export function ProgIcon(props: { t?: Terminal | null; size?: number; tone?: "muted" | "term" }) {
  const n = props.size ?? 16;
  const key = resolveIconKey(props.t);
  const fallback = props.t?.app ? PROG_ICONS.agent : PROG_ICONS.program;
  const entry = PROG_ICONS[key] ?? fallback ?? PROG_ICONS.shell;
  const tintClass = entry.tint ? (props.tone === "term" ? "tint-term-fg" : "tint-muted-foreground") : undefined;
  return (
    <View class="items-center justify-center" style={{ width: n, height: n }}>
      <Image src={entry.src} class={tintClass} style={{ width: n, height: n }} />
    </View>
  );
}

export function glassFallbackClass(tone: "default" | "term" = "default"): string {
  if (HAS_NATIVE_GLASS) return "";
  return tone === "term"
    ? "border border-term-glass-border bg-term-glass"
    : "border border-glass-border bg-glass";
}

export function GlassCircle(props: {
  onPress: () => void;
  size?: number;
  tone?: "default" | "term";
  accessibilityLabel: string;
  testID?: string;
  disabled?: boolean;
  children?: JSX.Element;
}) {
  const sz = props.size ?? 44;
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class={`items-center justify-center rounded-full transition-transform duration-150 active:scale-95 ${glassFallbackClass(props.tone)}`}
      style={glassStyle(props.tone, { width: sz, height: sz })}
    >
      {props.children}
    </Button>
  );
}

export function GlassCapsule(props: {
  tone?: "default" | "term";
  class?: string;
  style?: ViewStyle;
  children?: JSX.Element;
}) {
  return (
    <View
      class={`flex-row items-center rounded-full ${glassFallbackClass(props.tone)} ${props.class ?? ""}`}
      style={glassStyle(props.tone, props.style)}
    >
      {props.children}
    </View>
  );
}

export function FilterPill(props: {
  label: string;
  active?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      class={`h-[34px] flex-row items-center gap-1.5 rounded-full border bg-pill px-3.5 transition-transform duration-150 active:scale-95 ${
        props.active ? "border-border" : "border-pill-border"
      }`}
      style={CARD_CURVE}
    >
      <Text class={`text-[14px] font-medium ${props.active ? "text-foreground" : "text-muted-foreground"}`} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      <Icon src={chevronDownIcon} size={12} class="tint-muted-foreground" />
    </Button>
  );
}

export function AppSwitch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  return (
    <BaseSwitch
      checked={props.checked}
      onChange={(e) => props.onChange(e.checked)}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      hitSlop={8}
      trackClass="h-[31px] w-[51px] justify-center rounded-full bg-secondary p-[2px] transition-colors duration-150 checked:bg-ok"
      thumbClass="h-[27px] w-[27px] rounded-full bg-white shadow-sm transition-transform duration-150 checked:translate-x-[20px]"
    />
  );
}

export function SettingsGroup(props: { title?: string; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      {props.title ? (
        <Text class="px-4 text-[13.5px] font-medium text-muted-foreground">{props.title}</Text>
      ) : null}
      <View class="overflow-hidden rounded-[22px] bg-card" style={CARD_CURVE}>
        {props.children}
      </View>
    </View>
  );
}

export function RowDivider() {
  return <View class="ml-[54px] h-px bg-separator" />;
}

export function SettingsRow(props: {
  icon: any;
  label: string;
  value?: string;
  tone?: "default" | "danger";
  onPress?: () => void;
  trailing?: JSX.Element;
  showChevron?: boolean;
  testID?: string;
}) {
  const isDanger = props.tone === "danger";
  const icoTint = isDanger ? "tint-destructive" : "tint-foreground";
  const textCls = isDanger ? "text-destructive" : "text-card-foreground";
  const inner = (
    <View class="min-h-[52px] flex-row items-center gap-4 px-[18px] py-2">
      <Icon src={props.icon} size={20} class={icoTint} />
      <Text class={`flex-1 text-[16.5px] ${textCls}`} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      {props.value ? (
        <Text class="max-w-[160px] text-[15.5px] text-muted-foreground" style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}>
          {props.value}
        </Text>
      ) : null}
      {props.trailing}
      {props.showChevron !== false && !props.trailing ? (
        <Icon src={chevronIcon} size={14} class="tint-chevron" />
      ) : null}
    </View>
  );
  if (!props.onPress) return inner;
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      accessibilityLabel={props.label}
      class="active:bg-secondary/70"
    >
      {inner}
    </Button>
  );
}

/** A list's section title, on the list's leading spine (inside the card's inset). */
export function SectionHeader(props: { title: string; count?: number }) {
  return (
    <View class="flex-row items-baseline gap-1.5 px-6 pt-6 pb-2">
      <Text class="text-[14px] font-semibold text-muted-foreground">{props.title}</Text>
      {props.count != null && props.count > 1 ? (
        <Text class="text-[13px] text-idle" style={{ fontVariant: ["tabular-nums"] }}>{String(props.count)}</Text>
      ) : null}
    </View>
  );
}

/** A grouped card of rows: the rows' press wash stays inside its corners. */
export function ListCard(props: { children?: JSX.Element }) {
  return (
    <View class="mx-4 overflow-hidden rounded-[22px] bg-card" style={CARD_CURVE}>
      {props.children}
    </View>
  );
}

/** The divider between two rows of a card, from the text's spine (after the 40pt avatar). */
export function CardDivider() {
  return <View class="mr-4 ml-[70px] h-px bg-separator" />;
}

/** "Needs you" and the like: text on its status color, never color alone. */
export function StateBadge(props: { label: string; tone: "warn" | "bad" }) {
  return (
    <View class={`h-[26px] items-center justify-center rounded-[8px] px-2.5 ${props.tone === "bad" ? "bg-bad/15" : "bg-warn/15"}`} style={CARD_CURVE}>
      <Text class={`text-[13px] font-semibold ${props.tone === "bad" ? "text-bad" : "text-warn"}`} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
    </View>
  );
}

const NOTE_TONE = { muted: "text-muted-foreground", warn: "text-warn", bad: "text-bad" } as const;

/** A terminal in the inbox: avatar · title + what it says / where it runs · state and time. */
export function SessionRow(props: {
  avatar: string;
  title: string;
  note?: string;
  noteTone?: "muted" | "warn" | "bad";
  where: string;
  term: Terminal;
  badge?: { label: string; tone: "warn" | "bad" } | null;
  mark?: "unread" | "working" | null;
  time: string;
  onPress: () => void;
  testID?: string;
}) {
  const noteCls = props.note ? NOTE_TONE[props.noteTone ?? "muted"] : NOTE_TONE.muted;
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      accessibilityLabel={[props.title, props.badge?.label, props.note].filter(Boolean).join("，")}
      class="min-h-[68px] flex-row items-center gap-3.5 px-4 py-3 transition-colors duration-100 active:bg-secondary"
    >
      <MonogramBadge label={props.avatar} size="md" />
      <View class="min-w-0 flex-1 gap-1">
        <Text class="text-[16.5px] font-semibold tracking-[-0.01em] text-card-foreground" style={{ numberOfLines: 1 }}>
          {props.title}
        </Text>
        <View class="flex-row items-center gap-1.5">
          <ProgIcon t={props.term} size={13} tone="muted" />
          <Text class={`flex-1 text-[14px] ${noteCls}`} style={{ numberOfLines: 1 }}>
            {props.note || props.where}
          </Text>
        </View>
      </View>
      <View class="flex-row items-center gap-2.5">
        {props.badge ? <StateBadge label={props.badge.label} tone={props.badge.tone} /> : null}
        {props.mark === "unread" ? <View class="h-2 w-2 rounded-full bg-accent" accessibilityLabel="完成" /> : null}
        {props.mark === "working" ? <Spinner /> : null}
        {props.time ? (
          <Text class="min-w-[30px] text-right text-[13.5px] text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
            {props.time}
          </Text>
        ) : null}
      </View>
    </Button>
  );
}

/** A small turning ring: something is working. Rests with reduced motion. */
export function Spinner() {
  return (
    <View
      class="h-3.5 w-3.5 motion-safe:animate-spin"
      accessibilityLabel="工作中"
    >
      <Image src={spinnerIcon} class="tint-accent" style={{ width: 14, height: 14 }} />
    </View>
  );
}

/** One tab of the floating dock: icon over label, the chosen one on a lifted pill. */
export function DockTab(props: {
  icon: any;
  activeIcon?: any;
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      accessibilityLabel={props.label}
      selected={props.active}
      class="h-[52px] flex-1 items-center justify-center gap-0.5 rounded-full transition-all duration-150 active:scale-95 selected:bg-glass-active"
    >
      <Icon
        src={props.active && props.activeIcon ? props.activeIcon : props.icon}
        size={21}
        class={props.active ? "tint-accent" : "tint-foreground"}
      />
      <Text class={`text-[11px] font-medium ${props.active ? "text-accent" : "text-foreground"}`}>{props.label}</Text>
    </Button>
  );
}

/** A sheet's header (grabber + title row) and the room under its last row, in points. */
const SHEET_CHROME = 86;

/**
 * One detent as tall as a list sheet's rows, at most 88% of the screen. A sheet whose panel is
 * taller than the detent it rests at hides the panel's bottom below the screen, and its list cannot
 * scroll there: with `[{ fraction: 0.52 }, "large"]` and 14 workspaces the last 5 could not be reached
 * (2026-11-27, iOS 27 simulator). A single detent makes the panel exactly what shows, so the list
 * scrolls only when its rows do not fit.
 */
export function fitDetent(rows: number, rowHeight: number, extra = 0): SheetDetent[] {
  const want = SHEET_CHROME + extra + rows * rowHeight + safeArea().bottom;
  const max = Math.round(windowSize().height * 0.88);
  return [{ height: Math.max(220, Math.min(want, max)) }];
}

export function BottomSheet(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  detents?: SheetDetent[];
  footer?: JSX.Element;
  accessibilityLabel?: string;
  children?: JSX.Element;
}) {
  return (
    <Sheet
      open={props.open}
      side="bottom"
      detents={props.detents}
      closeOnSwipe
      closeOnBackdropPress
      closeOnEscape
      grabber
      grabberClass="mx-auto mt-2.5 mb-1 h-1 w-9 rounded-full bg-idle/50"
      backdropClass="bg-scrim"
      popupClass="overflow-hidden rounded-t-[30px] bg-sheet"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      onOpenChange={(e) => { if (!e.open) props.onClose(); }}
      footer={props.footer}
    >
      <View class="min-h-0 flex-1 overflow-hidden">
        <View class="flex-none flex-row items-center justify-between gap-3 px-5 pt-1.5 pb-3.5">
          <View class="flex-1 gap-0.5">
            <Text class="text-[19px] font-semibold text-foreground" style={{ numberOfLines: 1 }}>
              {props.title}
            </Text>
            {props.subtitle ? (
              <Text class="text-[13.5px] text-muted-foreground" style={{ numberOfLines: 1 }}>
                {props.subtitle}
              </Text>
            ) : null}
          </View>
          <GlassCircle onPress={props.onClose} size={38} accessibilityLabel="关闭" testID="sheet-close">
            <Icon src={xIcon} size={16} class="tint-foreground" />
          </GlassCircle>
        </View>
        {props.children}
      </View>
    </Sheet>
  );
}
