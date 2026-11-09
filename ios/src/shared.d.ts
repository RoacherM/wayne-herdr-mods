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
