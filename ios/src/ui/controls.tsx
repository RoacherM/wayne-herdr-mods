import { host, Image, Text, View } from "nsh";
import type { JSX, SheetDetent, ViewStyle } from "nsh/types";
import { Button, Sheet, Switch } from "nsh/base";
import type { Space, Terminal } from "../conn";
import { PROG_ICONS } from "../prog-icons";
import chevronDownIcon from "../../assets/chevron-down.svg";
import chevronIcon from "../../assets/chevron.svg";
import xIcon from "../../assets/x.svg";

export const GLASS_STYLE: ViewStyle = {
  glassEffect: "regular",
  backdropFilter: "blur(24px)",
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

export function MonogramBadge(props: { label: string }) {
  const idx = hashSeed(props.label) % BADGE_CLASSES.length;
  const [bgCls, fgCls] = BADGE_CLASSES[idx];
  return (
    <View class={`mt-0.5 h-7 w-7 items-center justify-center rounded-[7px] ${bgCls}`}>
      <Text class={`text-[11px] font-bold tracking-[0.02em] ${fgCls}`}>{monogramOf(props.label)}</Text>
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
  const surface = props.tone === "term"
    ? "bg-term-glass border-term-glass-border"
    : "bg-glass border-glass-border";
  return (
    <Button
      onPress={props.onPress}
      disabled={props.disabled}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class={`items-center justify-center rounded-full border transition-transform duration-150 active:scale-95 ${surface}`}
      style={{ ...GLASS_STYLE, width: sz, height: sz }}
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
  const surface = props.tone === "term"
    ? "bg-term-glass border-term-glass-border"
    : "bg-glass border-glass-border";
  return (
    <View
      class={`flex-row items-center rounded-full border ${surface} ${props.class ?? ""}`}
      style={{ ...GLASS_STYLE, ...props.style }}
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
      class={`h-9 flex-row items-center gap-1.5 rounded-full border bg-pill px-3.5 transition-transform duration-150 active:scale-95 ${
        props.active ? "border-glass-border" : "border-pill-border"
      }`}
    >
      <Text class={`text-[14.5px] ${props.active ? "text-foreground" : "text-muted-foreground"}`} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      <Icon src={chevronDownIcon} size={13} class="tint-muted-foreground" />
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
    <Switch
      checked={props.checked}
      onChange={(e) => props.onChange(e.checked)}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      hitSlop={8}
      trackClass="h-7 w-12 justify-center rounded-full bg-secondary p-0.5 transition-colors duration-150 checked:bg-ok"
      thumbClass="h-6 w-6 rounded-full bg-white transition-transform duration-150 checked:translate-x-5"
    />
  );
}

export function SettingsGroup(props: { title?: string; children?: JSX.Element }) {
  return (
    <View class="gap-2">
      {props.title ? (
        <Text class="px-3.5 text-[15px] text-muted-foreground">{props.title}</Text>
      ) : null}
      <View class="overflow-hidden rounded-[22px] bg-card py-1">
        {props.children}
      </View>
    </View>
  );
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
    <View class="min-h-[54px] flex-row items-center gap-4 px-[18px] py-2">
      <Icon src={props.icon} size={20} class={icoTint} />
      <Text class={`flex-1 text-[17px] ${textCls}`} style={{ numberOfLines: 1 }}>
        {props.label}
      </Text>
      {props.value ? (
        <Text class="max-w-[155px] text-[16px] text-muted-foreground" style={{ numberOfLines: 1, fontVariant: ["tabular-nums"] }}>
          {props.value}
        </Text>
      ) : null}
      {props.trailing}
      {props.showChevron !== false && !props.trailing ? (
        <Icon src={chevronIcon} size={15} class="tint-chevron" />
      ) : null}
    </View>
  );
  if (!props.onPress) return inner;
  return (
    <Button
      onPress={props.onPress}
      testID={props.testID}
      accessibilityLabel={props.label}
      class="active:bg-secondary"
    >
      {inner}
    </Button>
  );
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
      grabberClass="mx-auto mt-2.5 mb-1 h-1 w-10 rounded-full bg-idle/50"
      backdropClass="bg-scrim"
      popupClass="overflow-hidden rounded-t-[30px] border-t border-border bg-sheet"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      onOpenChange={(e) => { if (!e.open) props.onClose(); }}
      footer={props.footer}
    >
      <View class="flex-1">
        <View class="flex-row items-center justify-between gap-3 px-5 pt-1.5 pb-3.5">
          <View class="flex-1 gap-0.5">
            <Text class="text-[19px] font-semibold text-foreground" style={{ numberOfLines: 1 }}>
              {props.title}
            </Text>
            {props.subtitle ? (
              <Text class="text-[14px] text-muted-foreground" style={{ numberOfLines: 1 }}>
                {props.subtitle}
              </Text>
            ) : null}
          </View>
          <GlassCircle onPress={props.onClose} size={40} accessibilityLabel="关闭" testID="sheet-close">
            <Icon src={xIcon} size={17} class="tint-foreground" />
          </GlassCircle>
        </View>
        {props.children}
      </View>
    </Sheet>
  );
}
