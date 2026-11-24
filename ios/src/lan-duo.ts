/**
 * Native iOS dual transport: direct E2E LAN WebSocket + Cloudflare Relay warm fallback
 * (DESIGN.md「局域网直连」).
 *
 * Mirrors `app/src/direct.js`'s `Duo` state machine without WebRTC: every LAN candidate dials
 * `ws://<mac-lan-ip>:<port>/v1/lan` and runs the exact same `shared/e2e.js` X25519 + XSalsa20
 * handshake and paired-device auth through `Link({ socket })`.
 */
import { Link } from "../../app/src/link.js";

export const LAN_TIMEOUTS = {
  connect: 2_000,
  handshake: 3_000,
  ping: 5_000,
  silent: 15_000,
  asleep: 30_000,
  wakePong: 3_500,
};

const RETRY_MS = [1_500, 10_000, 45_000, 120_000];
const STEADY_MS = 30_000;
const MAX_CANDIDATES = 3;
const PRIVATE_LAN_URL_RE = /^ws:\/\/((?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})):(\d{1,5})\/v1\/lan$/;

function validLanUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  const m = PRIVATE_LAN_URL_RE.exec(u);
  if (!m) return false;
  const octets = m[1].split(".").map(Number);
  const port = Number(m[2]);
  return octets.every((n) => n >= 0 && n <= 255) && octets[3] > 0 && octets[3] < 255 && port >= 1 && port <= 65535;
}

function normalizeLanUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (validLanUrl(item) && !out.includes(item)) out.push(item);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function forwardDiag(from: any, via: "direct" | "relay", duo: LanDuo) {
  for (const ev of ["connected", "dropped", "wake", "wake_ok"]) {
    from.addEventListener(ev, (e: any) => duo.emit(ev, { ...e.detail, via }));
  }
}

type SocketFactory = (url: string) => any;

function dialLanUrl(
  url: string,
  opts: { desktopKey: any; deviceKeys: any; createSocket: SocketFactory; timeouts: typeof LAN_TIMEOUTS },
): { link: any; done: Promise<{ link: any; url: string; info: any }> } {
  const link: any = new Link({
    desktopKey: opts.desktopKey,
    deviceKeys: opts.deviceKeys,
    timeouts: opts.timeouts,
    socket: () => opts.createSocket(url),
  });
  const done = new Promise<{ link: any; url: string; info: any }>((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, val: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve(val);
      else {
        link.close();
        reject(val);
      }
    };
    const timer = setTimeout(() => finish(false, new Error("lan timeout")), opts.timeouts.connect + opts.timeouts.handshake);
    link.addEventListener("ready", (e: any) => finish(true, { link, url, info: e.detail }), { once: true });
    link.addEventListener("status", () => {
      if (link.status === "offline" || link.status === "error") finish(false, new Error("lan failed"));
    });
    link.addEventListener("fatal", () => finish(false, new Error("lan fatal")), { once: true });
  });
  return { link, done };
}

/** Race candidate LAN URLs; resolves with the first fully E2E-authenticated Link, closing all losers. */
export async function raceLan(
  urls: string[],
  opts: { desktopKey: any; deviceKeys: any; createSocket?: SocketFactory; timeouts?: typeof LAN_TIMEOUTS },
): Promise<{ link: any; url: string; info: any } | null> {
  const list = normalizeLanUrls(urls);
  if (!list.length) return null;
  const createSocket = opts.createSocket ?? ((u: string) => new WebSocket(u));
  const timeouts = opts.timeouts ?? LAN_TIMEOUTS;
  const attempts = list.map((u) => dialLanUrl(u, { desktopKey: opts.desktopKey, deviceKeys: opts.deviceKeys, createSocket, timeouts }));

  return new Promise((resolve) => {
    let remaining = attempts.length;
    let won = false;
    for (const a of attempts) {
      a.done.then(
        (winner) => {
          if (won) { winner.link.close(); return; }
          won = true;
          for (const other of attempts) if (other.link !== winner.link) other.link.close();
          resolve(winner);
        },
        () => {
          remaining--;
          if (!won && remaining === 0) resolve(null);
        },
      );
    }
  });
}

export class LanDuo extends EventTarget {
  relay: any;
  direct: any = null;
  active: any;
  info: any = null;
  lanUrls: string[] = [];
  closed = false;

  private trying = false;
  private tries = 0;
  private since = 0;
  private timer: any = 0;
  private createSocket: SocketFactory;
  private lanTimeouts: typeof LAN_TIMEOUTS;
  private onLanUrls?: (urls: string[]) => void;

  constructor(
    relay: any,
    opts: {
      cachedLan?: string[];
      createSocket?: SocketFactory;
      lanTimeouts?: typeof LAN_TIMEOUTS;
      onLanUrls?: (urls: string[]) => void;
    } = {},
  ) {
    super();
    this.relay = relay;
    this.active = relay;
    this.lanUrls = normalizeLanUrls(opts.cachedLan);
    this.createSocket = opts.createSocket ?? ((u: string) => new WebSocket(u));
    this.lanTimeouts = opts.lanTimeouts ?? LAN_TIMEOUTS;
    this.onLanUrls = opts.onLanUrls;

    relay.addEventListener("status", (e: any) => {
      if (this.active === relay) this.emit("status", { status: this.status, ...e.detail, via: "relay" });
    });
    relay.addEventListener("ready", (e: any) => {
      this.info = e.detail;
      if (Array.isArray(e.detail?.lan)) {
        const fresh = normalizeLanUrls(e.detail.lan);
        const changed = fresh.join(",") !== this.lanUrls.join(",");
        this.lanUrls = fresh;
        if (changed) {
          this.tries = 0;
          this.onLanUrls?.(fresh);
        }
      }
      if (this.active === relay) this.emit("ready", { ...e.detail, via: "relay" });
      if (this.lanUrls.length && !this.direct) this.schedule(100);
    });
    relay.addEventListener("ev", (e: any) => { if (this.active === relay) this.emit("ev", e.detail); });
    relay.addEventListener("fatal", (e: any) => this.emit("fatal", e.detail));
    relay.addEventListener("confirm", (e: any) => this.emit("confirm", e.detail));
    forwardDiag(relay, "relay", this);

    // Cold-boot race: if we already know the Mac's LAN address from last session, try LAN right away.
    if (this.lanUrls.length && !relay.pair) this.schedule(20);
  }

  emit(type: string, detail: any) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get status(): string {
    return this.active === this.direct && this.direct?.status === "ready" ? "ready" : this.relay.status;
  }

  get via(): "direct" | "relay" {
    return this.active === this.direct ? "direct" : "relay";
  }

  rpc(m: string, p?: any, timeoutMs?: number) {
    return this.active.rpc(m, p, timeoutMs);
  }

  notify(m: string, p?: any) {
    return this.active.notify(m, p);
  }

  wake() {
    this.relay.wake();
    if (this.direct) {
      this.direct.wake();
    } else if (this.lanUrls.length) {
      this.tries = 0;
      this.schedule(50);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.direct?.close();
    this.direct = null;
    this.relay.close();
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (this.closed || this.direct || !this.lanUrls.length) return;
    this.timer = setTimeout(() => this.attempt(), ms);
  }

  private async attempt() {
    if (this.closed || this.direct || this.trying || !this.lanUrls.length) return;
    this.trying = true;
    const winner = await raceLan(this.lanUrls, {
      desktopKey: this.relay.desktopKey,
      deviceKeys: this.relay.deviceKeys,
      createSocket: this.createSocket,
      timeouts: this.lanTimeouts,
    });
    this.trying = false;
    if (!winner) {
      this.schedule(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
      return;
    }
    if (this.closed) { winner.link.close(); return; }
    const { link, url, info } = winner;
    if (link.status !== "ready") {
      link.close();
      this.schedule(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
      return;
    }
    this.direct = link;
    this.since = Date.now();
    this.info = { ...(this.info ?? {}), ...info };
    if (link.lastConnected) this.emit("connected", { ...link.lastConnected, via: "direct", url });
    forwardDiag(link, "direct", this);
    link.addEventListener("ev", (e: any) => { if (this.active === link) this.emit("ev", e.detail); });
    link.addEventListener("fatal", (e: any) => { if (this.active === link) this.emit("fatal", e.detail); });
    link.addEventListener("status", () => { if (link.status !== "ready") this.lost(link); });
    this.use(link);
  }

  private lost(link: any) {
    if (this.direct !== link) return;
    this.direct = null;
    link.close();
    if (Date.now() - this.since > STEADY_MS) this.tries = 0;
    if (this.active === link) {
      this.use(this.relay);
      if (this.relay.status !== "ready") this.relay.wake();
    }
    this.schedule(RETRY_MS[Math.min(this.tries++, RETRY_MS.length - 1)]);
  }

  private use(link: any) {
    const from = this.active;
    this.active = link;
    if (from === link) return;
    if (from.status === "ready") from.rpc("link.idle").catch(() => {});
    this.emit("status", { status: this.status, via: this.via });
    if (link.status === "ready") {
      this.emit("ready", { ...(this.info ?? {}), paired: false, via: this.via });
    }
  }
}
