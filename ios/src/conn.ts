/**
 * The one connection to the Mac, shared by every screen: the PWA's own Link (app/src/link.js) and
 * E2E code (shared/e2e.js), unchanged, running on QuickJS. Saved pairing lives in nsh Storage.
 */
import "./shim";
import { batch, signal, Storage } from "nsh";
import { b64, boxKeysFromSecret, decodePairLink, newBoxKeys, unb64 } from "../../shared/e2e.js";
import { Link } from "../../app/src/link.js";

export type Terminal = {
  address: string; program?: string; app?: string; where?: string; cwd?: string;
  state?: "blocked" | "working" | "done" | "idle" | "error"; kind?: string; msg?: string; cols: number; rows: number;
};
export type Space = { id: string; name?: string; folder?: string; tabs: { id: string; name?: string; terminals: string[] }[] };
export type List = { core?: string; terminals: Terminal[]; layout: Space[] };
type Saved = { relay: string; desktopId: string; desktopKey: string; desktopName?: string; deviceSecret: string };

const KEY = "herdr-relay";
export const status = signal<string>("idle"); // idle | connecting | offline | ready | error
export const problem = signal<string>("");
export const sas = signal<string>("");
export const paired = signal<Saved | null>(null);
export const list = signal<List>({ terminals: [], layout: [] });
export const info = signal<any>(null);
/** Events for the open terminal page: { ev: 'out' | 'closed', s, ... } */
let onStream: ((msg: any) => void) | null = null;
export const setStreamListener = (fn: ((msg: any) => void) | null) => { onStream = fn; };

let link: any = null;
export const rpc = (m: string, p: object = {}, ms?: number) => (link ? link.rpc(m, p, ms) : Promise.reject(new Error("尚未连接")));
export const notify = (m: string, p: object = {}) => link?.notify(m, p);

async function save(v: Saved | null) {
  if (v) await Storage.setItem(KEY, JSON.stringify(v)); else await Storage.removeItem(KEY);
  paired.set(v);
}

export async function refresh() {
  try { list.set(await rpc("terminals.list")); } catch {}
}

function start(saved: Saved, pair?: { token: string; name: string }) {
  link?.close();
  problem.set("");
  const l = new Link({ relay: saved.relay, desktopId: saved.desktopId, desktopKey: saved.desktopKey, deviceKeys: boxKeysFromSecret(unb64(saved.deviceSecret)), pair });
  link = l;
  console.log(`link: start ${pair ? "pairing" : "resume"} → ${saved.relay} desktop ${saved.desktopId}`);
  l.addEventListener("status", (e: any) => { console.log(`link: status ${JSON.stringify(e.detail)}`); if (link === l) status.set(e.detail.status); });
  l.addEventListener("confirm", (e: any) => sas.set(e.detail.sas));
  l.addEventListener("ready", async (e: any) => {
    const r = e.detail;
    batch(() => { info.set(r); sas.set(""); });
    if (pair || saved.desktopName !== r.desktopName) await save({ ...saved, desktopName: r.desktopName });
    refresh();
  });
  l.addEventListener("fatal", async (e: any) => {
    console.warn(`link: fatal ${JSON.stringify(e.detail)}`);
    problem.set(e.detail.message ?? e.detail.code);
    if (["unknown-device", "revoked"].includes(e.detail.code)) await save(null);
  });
  l.addEventListener("ev", (e: any) => {
    const msg = e.detail;
    if (msg.ev === "terminals") refresh();
    else onStream?.(msg);
  });
}

/** Called once at startup: reconnect to the saved Mac, if any. */
export async function boot() {
  const raw = await Storage.getItem(KEY);
  const saved: Saved | null = raw ? JSON.parse(raw) : null;
  paired.set(saved);
  if (saved) start(saved);
}

/** Pair with a link from `herdr-relay pair`. */
export async function pairWith(text: string, deviceName: string) {
  console.log(`pair: link of ${text.trim().length} chars`);
  const offer = decodePairLink(text.trim());
  if (offer.e && offer.e < Date.now()) throw new Error("这个配对链接已过期，在 Mac 上重新运行 herdr-relay pair");
  const saved: Saved = { relay: offer.r, desktopId: offer.i, desktopKey: offer.k, desktopName: offer.n, deviceSecret: b64(newBoxKeys().secretKey) };
  paired.set(null);
  start(saved, { token: offer.t, name: deviceName });
  // Keep it only once the Mac said yes (the ready handler saves it).
}

export async function forget() {
  try { await rpc("device.forget"); } catch {}
  link?.close(); link = null;
  batch(() => { status.set("idle"); list.set({ terminals: [], layout: [] }); info.set(null); });
  await save(null);
}

/** Back in the foreground: check the socket now instead of waiting for a timer. */
export const wake = () => link?.wake();
