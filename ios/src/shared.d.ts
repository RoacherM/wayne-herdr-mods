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
  export const pasteText: (text: string) => string;
  export class LiveLine {
    constructor(write: (data: string) => void);
    value: string;
    typed: string;
    readonly pending: string;
    set(value: string): void;
    compose(on: boolean): void;
    hold(on: boolean): void;
    commit(): void;
    submit(): boolean;
    backspace(): boolean;
  }
}
