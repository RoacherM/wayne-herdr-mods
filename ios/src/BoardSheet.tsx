/**
 * Bottom topology sheet for the active terminal (`DESIGN.md`「手机端拓扑抽屉与新旧协议兼容」).
 * Thin NSH renderer over canonical `shared/board.js`.
 */
import { cleanup, computed, effect, host, Image, reduceMotion, Scroll, signal, Text, token, View } from "nsh";
import type { JSX, ViewStyle } from "nsh/types";
import { Button, Sheet } from "nsh/base";
import {
  layoutMetro,
  SIZE,
  type BoardHeader,
  type BoardLane,
  type BoardTone,
  type MetroBridge,
  type MetroCurve,
  type MetroHeadline,
  type MetroRow,
  type MetroStation,
} from "../../shared/board.js";
import arrowIcon from "../assets/arrow.svg";
import boardIcon from "../assets/board.svg";
import failIcon from "../assets/fail.svg";
import forkIcon from "../assets/fork.svg";
import mergeIcon from "../assets/merge.svg";
import spinnerIcon from "../assets/spinner.svg";
import stopIcon from "../assets/stop.svg";
import tipIcon from "../assets/tip.svg";

export type BoardSnapshot = {
  lane: BoardLane | null;
  at: number;
  fetchedAt: number;
};

// Categorical Metro rail palette (data colors shared with Mac `wayne-board`).
const PALETTE = ["#7aa2f7", "#bb9af7", "#4ec970", "#f5a623", "#56d4dd", "#e5675f", "#89b4fa", "#f5c2e7"];
// Matches `pt-2` (8pt) + half of `h-4` (16pt) headline = 16pt center across collapsed & expanded rows.
const DOT_Y = 16;
const ICONS = { fork: forkIcon, merge: mergeIcon, fail: failIcon, stop: stopIcon } as const;
type ColorTokenKey = "accent" | "term-warn" | "term-ok" | "term-bad" | "term-fg" | "term-muted";
const TONE_TOKEN: Partial<Record<BoardTone, ColorTokenKey>> = {
  working: "accent",
  accent: "accent",
  warn: "term-warn",
  ok: "term-ok",
  bad: "term-bad",
  fg: "term-fg",
};

const pickRail = (idx: number) => (idx >= 0 ? PALETTE[idx % PALETTE.length] : token("accent"));
const tapHaptic = () => { if (host.available()) try { host.post("haptic"); } catch {} };

function resolveTone(tone: BoardTone, colorIdx: number): string {
  if (tone === "rail") return pickRail(colorIdx);
  const tok = TONE_TOKEN[tone];
  return token(tok ?? "term-muted");
}

const SPIN_STYLE: ViewStyle = {
  animationName: "spin",
  animationDuration: 900,
  animationTimingFunction: "linear",
  animationIterationCount: "infinite",
};

function TintGlyph(props: { src: any; size: number; color: string; spin?: boolean; opacity?: number }) {
  const box = (): ViewStyle => ({ width: props.size, height: props.size, opacity: props.opacity });
  return (
    <View class="flex-none items-center justify-center" style={props.spin && !reduceMotion() ? [box(), SPIN_STYLE] : box()}>
      <Image src={props.src} style={{ width: props.size, height: props.size, tintColor: props.color }} />
    </View>
  );
}

function VerticalLine(props: { x: number; top: number; bottom?: number; height?: number; color: string; dashed?: boolean }) {
  const pos = (): ViewStyle => (props.height !== undefined
    ? { position: "absolute", left: props.x - 1, top: props.top, height: props.height }
    : { position: "absolute", left: props.x - 1, top: props.top, bottom: props.bottom ?? 0 });
  return (
    <View
      style={props.dashed
        ? [pos(), { width: 0, borderLeftWidth: 2, borderColor: props.color, borderStyle: "dashed" }]
        : [pos(), { width: 2, backgroundColor: props.color }]}
    />
  );
}

function curvePairStyles(x0: number, x1: number, col: string, stroke: "solid" | "dashed"): [ViewStyle, ViewStyle] {
  const midX = Math.round((x0 + x1) / 2);
  if (x1 > x0) {
    return [
      { position: "absolute", left: x0 - 1, top: 0, width: midX - (x0 - 1), height: 9, borderLeftWidth: 2, borderBottomWidth: 2, borderBottomLeftRadius: 7, borderColor: col, borderStyle: stroke },
      { position: "absolute", left: midX - 1, top: 7, width: (x1 + 1) - (midX - 1), height: DOT_Y - 7, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 7, borderColor: col, borderStyle: stroke },
    ];
  }
  return [
    { position: "absolute", left: midX, top: 0, width: (x0 + 1) - midX, height: 9, borderRightWidth: 2, borderBottomWidth: 2, borderBottomRightRadius: 7, borderColor: col, borderStyle: stroke },
    { position: "absolute", left: x1 - 1, top: 7, width: (midX + 1) - (x1 - 1), height: DOT_Y - 7, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 7, borderColor: col, borderStyle: stroke },
  ];
}

function CurveSegment(props: { curve: MetroCurve }) {
  const col = () => resolveTone(props.curve.tone, props.curve.colorIdx);
  const stroke = (): "solid" | "dashed" => (props.curve.dashed ? "dashed" : "solid");
  return (
    <If
      when={props.curve.x0 !== props.curve.x1}
      else={<VerticalLine x={props.curve.x0} top={0} height={DOT_Y} color={col()} dashed={props.curve.dashed} />}
    >
      <View class="pointer-events-none absolute inset-0">
        <View style={curvePairStyles(props.curve.x0, props.curve.x1, col(), stroke())[0]} />
        <View style={curvePairStyles(props.curve.x0, props.curve.x1, col(), stroke())[1]} />
      </View>
    </If>
  );
}

function BridgeSegment(props: { bridge: MetroBridge | null }) {
  return (
    <If when={props.bridge && props.bridge.x0 !== props.bridge.x1 ? props.bridge : null}>
      {(b) => {
        const col = () => pickRail(b().colorIdx);
        const shaftEnd = () => b().tip - b().dir * 5;
        return (
          <View class="pointer-events-none absolute inset-0">
            <View style={{
              position: "absolute",
              left: Math.min(b().x0, shaftEnd()),
              top: DOT_Y - 1,
              width: Math.max(0, Math.abs(shaftEnd() - b().x0)),
              height: 2,
              backgroundColor: col(),
            }} />
            <View style={{
              position: "absolute", left: b().x0 - 2.5, top: DOT_Y - 2.5,
              width: 5, height: 5, borderRadius: 2.5, backgroundColor: col(),
            }} />
            <View style={[
              { position: "absolute", left: b().dir > 0 ? b().tip - 7 : b().tip - 1, top: DOT_Y - 4 },
              b().dir < 0 ? { rotate: "180deg" } : {},
            ]}>
              <TintGlyph src={tipIcon} size={8} color={col()} />
            </View>
          </View>
        );
      }}
    </If>
  );
}

function StationMark(props: { station: MetroStation }) {
  const col = () => resolveTone(props.station.tone, props.station.colorIdx);
  return (
    <If when={props.station.shape === "spin"} else={
      <If when={props.station.shape === "solid"} else={
        <View style={{ width: 7.5, height: 7.5, borderRadius: 4, borderWidth: 1.8, borderColor: col(), backgroundColor: token("term-sheet") }} />
      }>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: col() }} />
      </If>
    }>
      <TintGlyph src={spinnerIcon} size={11.5} color={col()} spin />
    </If>
  );
}

function GutterCell(props: { row: MetroRow; gutterW: number }) {
  const halo = () => (props.row.station.shape === "spin" ? 14 : 10);
  return (
    <View
      class="relative flex-none self-stretch overflow-hidden"
      style={{ width: props.gutterW, minHeight: 44 }}
      accessibilityElementsHidden
    >
      <If when={props.row.trunkTop}>
        <VerticalLine x={SIZE.railLeft} top={0} height={DOT_Y} color={token("term-trunk")} />
      </If>
      <If when={props.row.trunkBottom}>
        <VerticalLine x={SIZE.railLeft} top={DOT_Y} bottom={0} color={token("term-trunk")} />
      </If>
      <Each of={props.row.thru} key={(s) => `${s.rail}-${s.part}`}>
        {(seg) => (
          <VerticalLine
            x={seg().x}
            top={seg().part === "bottom" ? DOT_Y : 0}
            height={seg().part === "top" ? DOT_Y : undefined}
            bottom={seg().part === "top" ? undefined : 0}
            color={resolveTone(seg().tone, seg().colorIdx)}
            dashed={seg().dashed}
          />
        )}
      </Each>
      <Each of={props.row.curves} key={(c) => `${c.kind}-${c.from}-${c.to}`}>
        {(curve) => <CurveSegment curve={curve()} />}
      </Each>
      <BridgeSegment bridge={props.row.bridge} />
      <View
        class="items-center justify-center rounded-full bg-term-sheet"
        style={{ position: "absolute", left: props.row.x - halo() / 2, top: DOT_Y - halo() / 2, width: halo(), height: halo() }}
      >
        <StationMark station={props.row.station} />
      </View>
    </View>
  );
}

function StandardHeadline(props: { headline: Extract<MetroHeadline, { kind: "standard" }>; colorIdx: number }) {
  return (
    <View class="h-4 flex-row items-center gap-1.5">
      <If when={props.headline.icon}>
        {(ic) => <TintGlyph src={ICONS[ic()]} size={12} color={resolveTone(props.headline.iconTone, props.colorIdx)} />}
      </If>
      <Text
        class={`flex-1 text-xs ${props.headline.bold ? "font-semibold" : "font-medium"}`}
        style={{ color: resolveTone(props.headline.titleTone, props.colorIdx), numberOfLines: 1 }}
      >
        {props.headline.title}
      </Text>
      <If when={Boolean(props.headline.right)}>
        <Text class="flex-none font-mono text-xs" style={{ color: resolveTone(props.headline.rightTone, props.colorIdx), fontVariant: ["tabular-nums"] }}>
          {props.headline.right}
        </Text>
      </If>
    </View>
  );
}

function RowHeadline(props: { headline: MetroHeadline; colorIdx: number }) {
  return (
    <If
      when={props.headline.kind === "message" ? props.headline : null}
      else={<StandardHeadline headline={props.headline as Extract<MetroHeadline, { kind: "standard" }>} colorIdx={props.colorIdx} />}
    >
      {(m) => (
        <View class="h-4 flex-row items-center gap-1">
          <Text class="max-w-[110px] text-xs font-medium text-term-fg" style={{ numberOfLines: 1 }}>{m().from}</Text>
          <TintGlyph src={arrowIcon} size={11} color={pickRail(m().colorIdx)} />
          <Text class="flex-1 text-xs font-medium text-term-fg" style={{ numberOfLines: 1 }}>{m().to}</Text>
          <Text class="flex-none font-mono text-xs text-term-muted" style={{ fontVariant: ["tabular-nums"] }}>{m().right}</Text>
        </View>
      )}
    </If>
  );
}

function MetroRowBody(props: { row: MetroRow; gutterW: number }) {
  return (
    <View class="min-h-11 flex-1 flex-row items-stretch">
      <GutterCell row={props.row} gutterW={props.gutterW} />
      <View class="flex-1 gap-0.5 pt-2 pr-3.5 pb-2">
        <RowHeadline headline={props.row.headline} colorIdx={props.row.colorIdx} />
        <If when={props.row.subline}>
          {(sub) => (
            <Text class="text-xs" style={{ color: resolveTone(sub().tone, props.row.colorIdx), numberOfLines: 1 }}>
              {sub().text}
            </Text>
          )}
        </If>
        <If when={props.row.expanded && props.row.detail ? props.row.detail : null}>
          {(det) => (
            <View class="mt-1 rounded-lg border border-term-border bg-term-card px-2.5 py-2">
              <Text class="text-xs leading-relaxed text-term-fg">{det()}</Text>
            </View>
          )}
        </If>
      </View>
    </View>
  );
}

function SheetHeader(props: { header: BoardHeader; renderIcon: () => JSX.Element }) {
  return (
    <View class="min-h-9 flex-row items-center gap-2 border-b border-term-border px-4 pb-2.5">
      {props.renderIcon()}
      <Text
        class="flex-1 text-sm font-semibold"
        style={{ color: props.header.muted ? token("term-muted") : token("term-fg"), numberOfLines: 1 }}
      >
        {props.header.title}
      </Text>
      <If when={props.header.badge.kind === "blocked"}>
        <View class="flex-none flex-row items-center gap-1">
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: token("term-warn") }} />
          <Text class="font-mono text-xs font-semibold text-term-warn" style={{ fontVariant: ["tabular-nums"] }}>
            {String(props.header.badge.count)}
          </Text>
        </View>
      </If>
      <If when={props.header.badge.kind === "running"}>
        <View class="flex-none flex-row items-center gap-1">
          <TintGlyph src={spinnerIcon} size={11} color={token("accent")} spin />
          <Text class="font-mono text-xs font-semibold text-accent" style={{ fontVariant: ["tabular-nums"] }}>
            {String(props.header.badge.count)}
          </Text>
        </View>
      </If>
      <Text class="flex-none font-mono text-xs text-term-muted" style={{ fontVariant: ["tabular-nums"] }}>
        {props.header.address}
      </Text>
    </View>
  );
}

function toggleId(cur: string[], id: string): string[] {
  return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

function snapshotNow(snap: BoardSnapshot | null, tick: number): number {
  return snap ? snap.at + Math.max(0, tick - snap.fetchedAt) : tick;
}

export function BoardSheet(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  address: string;
  snapshot: BoardSnapshot | null;
  renderIcon: () => JSX.Element;
}) {
  const openIds = signal<string[]>([]);
  const tickNow = signal(Date.now());

  effect(() => {
    void props.address;
    openIds.set([]);
  });

  effect(() => {
    const lane = props.snapshot?.lane;
    if (!props.open || !lane || lane.ended) return;
    tickNow.set(Date.now());
    const timer = setInterval(() => tickNow.set(Date.now()), 1000);
    cleanup(() => clearInterval(timer));
  });

  const toggleRow = (id: string) => { tapHaptic(); openIds.set(toggleId(openIds(), id)); };
  const metro = computed(() => layoutMetro(props.snapshot?.lane ?? null, {
    openIds: new Set(openIds()),
    now: snapshotNow(props.snapshot, tickNow()),
  }));

  return (
    <Sheet
      open={props.open}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      closeOnSwipe
      backdropClass="bg-black/50"
      popupClass="max-h-[82%] rounded-t-3xl border-t border-term-border bg-term-sheet pb-[env(safe-area-inset-bottom)]"
    >
      <View class="items-center pt-2.5 pb-1.5" accessibilityElementsHidden>
        <View class="h-1 w-9 rounded-full bg-term-trunk" />
      </View>
      <If
        when={props.snapshot}
        else={
          <View class="h-[220px] items-center justify-center" testID="board-loading" accessibilityLabel="正在加载通信拓扑">
            <TintGlyph src={spinnerIcon} size={20} color={token("term-muted")} spin />
          </View>
        }
      >
        {(snap) => (
          <If
            when={snap().lane && metro().header ? metro().header : null}
            else={
              <View class="h-[220px] items-center justify-center" testID="board-empty" accessibilityLabel="无子代理通信">
                <TintGlyph src={boardIcon} size={24} color={token("term-muted")} opacity={0.35} />
              </View>
            }
          >
            {(hdr) => (
              <View class="max-h-full shrink">
                <SheetHeader header={hdr()} renderIcon={props.renderIcon} />
                <Scroll class="shrink" contentClass="py-1.5" testID="board-scroll">
                  <Each of={metro().rows} key={(r) => r.id}>
                    {(row) => (
                      <If
                        when={row().expandable}
                        else={
                          <View class="flex-row items-stretch" testID={`board-row-${row().id}`}>
                            <MetroRowBody row={row()} gutterW={metro().gutterW} />
                          </View>
                        }
                      >
                        <Button
                          onPress={() => toggleRow(row().id)}
                          class="min-h-11 flex-row items-stretch active:bg-term-card"
                          selected={row().expanded}
                          testID={`board-row-${row().id}`}
                        >
                          <MetroRowBody row={row()} gutterW={metro().gutterW} />
                        </Button>
                      </If>
                    )}
                  </Each>
                </Scroll>
              </View>
            )}
          </If>
        )}
      </If>
    </Sheet>
  );
}
