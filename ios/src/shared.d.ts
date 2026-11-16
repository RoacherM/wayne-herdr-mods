// The PWA's plain-JS modules, used as they are.
declare module "*/shared/e2e.js" {
  export const b64: (bytes: Uint8Array) => string;
  export const unb64: (text: string) => Uint8Array;
  export const newBoxKeys: () => { publicKey: Uint8Array; secretKey: Uint8Array };
  export const boxKeysFromSecret: (secretKey: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
  export const decodePairLink: (link: string) => { v: number; r: string; i: string; k: string; t: string; n?: string; e?: number };
}
declare module "*/app/src/link.js" {
  export class Link extends EventTarget {
    constructor(options: { relay: string; desktopId: string; desktopKey: string; deviceKeys: { publicKey: Uint8Array; secretKey: Uint8Array }; pair?: { token: string; name: string }; timeouts?: object });
    status: string;
    info: any;
    rpc(m: string, p?: object, timeoutMs?: number): Promise<any>;
    notify(m: string, p?: object): void;
    wake(): void;
    close(): void;
  }
}
declare module "*/app/src/live-line.js" {
  export const PASTE_LF: string;
  export const pasteText: (text: string) => string;
  export const IMAGE_GAP_MS: number;
  export const imageInput: (path: string, i: number, n: number) => { d: string; after: number };
  export class LiveLine {
    constructor(write: (data: string) => void);
    value: string;
    typed: string;
    held: boolean;
    readonly pending: string;
    set(value: string): void;
    compose(on: boolean): void;
    hold(on: boolean): void;
    commit(): void;
    submit(): boolean;
    backspace(): boolean;
  }
}
declare module "*/app/src/term-session.js" {
  export type Grid = { cols: number; rows: number };
  export type Effect =
    | { type: "rpc"; m: "term.open"; p: { address: string; fit: Grid | null; lead: boolean }; epoch: number }
    | { type: "rpc"; m: "term.close"; p: { s: number } }
    | { type: "notify"; m: string; p: any; after?: number }
    | { type: "view"; msg: any }
    | { type: "notice"; text: string }
    | { type: "retry"; ms: number };
  export type Session = { readonly state: { phase: string; s: number | null; sized: boolean; opened: boolean; [k: string]: any }; send: (ev: any) => Effect[] };
  export const RETRY_MS: number;
  export const QUEUE_MAX: number;
  export const leadsAfterSize: (leads: boolean, fitSent: string, size: Grid) => boolean;
  export const termSession: (address: string, run: (effects: Effect[], session: Session) => void) => Session;
  export const enqueue: (q: Promise<void>, fn: () => unknown) => Promise<void>;
}
declare module "*/app/src/agent-keys.js" {
  export type AgentKey = [label: string, names: string[], what: string];
  export const MODS: readonly ("ctrl" | "alt" | "shift")[];
  export const agentKeys: (t: { icon?: string; app?: string; program?: string } | undefined | null) => AgentKey[];
  export const combo: (mods: Set<string>, key: string) => string;
  export const keyOfChar: (ch: string) => string | null;
}
declare module "*/app/src/voice-hold.js" {
  export type VoicePhase = "" | "starting" | "rec" | "busy";
  export type VoiceState = { phase: VoicePhase; held: boolean; gone: boolean };
  export type VoiceEffect = "start" | "recording" | "finish" | "cancel" | "hint";
  export type VoiceSession = { readonly state: VoiceState; send: (ev: { type: string }) => VoiceEffect[] };
  export const initial: () => VoiceState;
  export const step: (st: VoiceState, ev: { type: string }) => { state: VoiceState; fx: VoiceEffect[] };
  export const voiceHold: (run: (effects: VoiceEffect[], session: VoiceSession) => void) => VoiceSession;
}
declare module "*/shared/board.js" {
  export type SubState = "working" | "waiting" | "blocked" | "done" | "failed" | "stopped";
  export type BoardTone = "rail" | "working" | "accent" | "warn" | "ok" | "bad" | "fg" | "muted" | "neutral";
  export type BoardStats = {
    totalSubs: number;
    running: number;
    waiting?: number;
    blocked: number;
    done: number;
    failed: number;
    stopped?: number;
    messages: number;
  };
  export type BoardBadge = {
    kind: "blocked" | "running" | "none";
    count: number;
    tone: "warn" | "accent" | "neutral";
  };
  export type BoardAgent = {
    id: string;
    name: string;
    via?: string | null;
    model?: string | null;
    terminal?: string | null;
    parentAgent?: string | null;
    agentId?: string | null;
    state: SubState;
    msg?: string | null;
    activity?: string | null;
    start?: number | null;
    end?: number | null;
    prompt?: string | null;
    reply?: string | null;
    colorIdx: number;
  };
  export type BoardEvent = {
    kind: "spawn" | "message" | "return";
    id: string;
    at: number;
    from: string;
    to: string;
    title?: string | null;
    summary?: string | null;
    detail?: string | null;
    via?: string | null;
    model?: string | null;
    status?: string | null;
  };
  export type BoardLane = {
    t: string;
    app: string;
    since: number;
    ended: number | null;
    state: string;
    msg?: string | null;
    activity?: string | null;
    cwd?: string | null;
    where?: string | null;
    sessionId?: string | null;
    model?: string | null;
    agents: BoardAgent[];
    events: BoardEvent[];
    stats?: BoardStats;
  };
  export type BoardHeader = {
    title: string;
    address: string;
    muted: boolean;
    running: number;
    blocked: number;
    badge: BoardBadge;
  };
  export type MetroThru = {
    rail: number;
    x: number;
    colorIdx: number;
    state: string;
    tone: BoardTone;
    dashed: boolean;
    part: "full" | "top" | "bottom";
  };
  export type MetroCurve = {
    kind: "fork" | "merge";
    from: number;
    to: number;
    x0: number;
    x1: number;
    colorIdx: number;
    state: string;
    tone: BoardTone;
    dashed: boolean;
  };
  export type MetroBridge = {
    from: number;
    to: number;
    x0: number;
    x1: number;
    tip: number;
    dir: 1 | -1;
    colorIdx: number;
  };
  export type MetroStation = {
    shape: "spin" | "solid" | "ring";
    colorIdx: number;
    tone: BoardTone;
  };
  export type MetroHeadline =
    | {
        kind: "standard";
        icon: "fork" | "merge" | "fail" | "stop" | null;
        iconTone: BoardTone;
        title: string;
        titleTone: BoardTone;
        right: string;
        rightTone: BoardTone;
        bold: boolean;
      }
    | {
        kind: "message";
        from: string;
        to: string;
        colorIdx: number;
        right: string;
      };
  export type MetroRow = {
    id: string;
    kind: "main" | "spawn" | "message" | "return" | "live";
    isTip: boolean;
    event: BoardEvent | null;
    agent: BoardAgent | null;
    rail: number;
    x: number;
    dotY: number;
    colorIdx: number;
    y: number;
    h: number;
    expandable: boolean;
    expanded: boolean;
    thru: MetroThru[];
    curves: MetroCurve[];
    bridge: MetroBridge | null;
    trunkTop: boolean;
    trunkBottom: boolean;
    station: MetroStation;
    headline: MetroHeadline;
    subline: { text: string; tone: BoardTone } | null;
    detail: string | null;
  };
  export const SUB_STATES: readonly SubState[];
  export const SIZE: {
    pad: number;
    railLeft: number;
    railStep: number;
    compactRailStep: number;
    compactThreshold: number;
    maxRails: number;
    rowH: number;
    subRowH: number;
    detailLineH: number;
    detailPad: number;
    dotY: number;
  };
  export const railX: (rail: number, step?: number) => number;
  export const hhmm: (ms: number) => string;
  export const span: (ms: number) => string;
  export const laneTitle: (lane: BoardLane | null | undefined) => string;
  export const stripBoilerplateReply: (raw: string | null | undefined) => string;
  export const normalizeSubState: (raw: string | null | undefined, flags?: { ended?: boolean; failed?: boolean; stopped?: boolean }) => SubState;
  export const computeStats: (agents?: BoardAgent[], events?: BoardEvent[]) => BoardStats;
  export const boardBadgeOf: (stats?: Partial<BoardStats> | null) => BoardBadge;
  export const laneOf: (board: { lanes?: BoardLane[] } | null | undefined, address: string | null | undefined) => BoardLane | null;
  export const layoutMetro: (lane: BoardLane | null | undefined, options?: { openIds?: Set<string>; now?: number }) => {
    header: BoardHeader | null;
    rows: MetroRow[];
    maxRail: number;
    railStep: number;
    gutterW: number;
    height: number;
  };
}
