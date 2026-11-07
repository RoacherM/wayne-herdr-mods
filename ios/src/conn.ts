/**
 * The connection to the active Mac, shared by every screen: the PWA's own Link (app/src/link.js)
 * and E2E code (shared/e2e.js), unchanged, running on QuickJS. Supports multiple paired Macs in
 * nsh Storage under key "herdr-relay" while staying backward-compatible with the single-Mac shape.
 */
import "./shim";
import { batch, signal, Storage } from "nsh";
import { b64, boxKeysFromSecret, decodePairLink, newBoxKeys, unb64 } from "../../shared/e2e.js";
import { Link } from "../../app/src/link.js";

export type Terminal = {
  address: string; program?: string; app?: string; icon?: string; where?: string; cwd?: string;
  state?: "blocked" | "working" | "done" | "idle" | "error"; kind?: string; msg?: string; cols: number; rows: number;
};
export type Space = { id: string; name?: string; folder?: string; tabs: { id: string; name?: string; terminals: string[] }[] };
export type List = { core?: string; terminals: Terminal[]; layout: Space[]; icons?: Record<string, any> };
export type Saved = { relay: string; desktopId: string; desktopKey: string; desktopName?: string; deviceSecret: string; pairedAt?: number };

const KEY = "herdr-relay";
export const status = signal<string>("idle"); // idle | connecting | offline | ready | error
export const problem = signal<string>("");
export const sas = signal<string>("");
export const paired = signal<Saved | null>(null);
export const desktops = signal<Saved[]>([]);
export const addingMac = signal<boolean>(false);
export const list = signal<List>({ terminals: [], layout: [] });
export const info = signal<any>(null);

/** Events for the open terminal page: { ev: 'out' | 'size' | 'closed', s, ... } */
let onStream: ((msg: any) => void) | null = null;
export const setStreamListener = (fn: ((msg: any) => void) | null) => { onStream = fn; };

let link: any = null;
export const rpc = (m: string, p: object = {}, ms?: number) => (link ? link.rpc(m, p, ms) : Promise.reject(new Error("尚未连接")));
export const notify = (m: string, p: object = {}) => link?.notify(m, p);

const CHUNK = 48 * 1024;

/** Upload raw bytes to the Mac in 48 KB E2E chunks. Returns the upload id. */
async function uploadBytes(bytes: Uint8Array, mime: string): Promise<string> {
  if (!bytes.length) throw new Error("文件是空的");
  let id: string | null = null;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const r = await rpc("upload.put", { id, offset, total: bytes.length, mime, data: b64(bytes.subarray(offset, offset + CHUNK)) });
    id = r.id;
  }
  return id as string;
}

/**
 * A picked image → a file beside the terminal on the Mac (upload.put in chunks, then image.put).
 * Returns the path on the Mac.
 */
export async function sendImage(file: Blob & { name?: string }, address: string) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = await uploadBytes(bytes, file.type || "image/jpeg");
  const { path } = await rpc("image.put", { id, address, name: file.name || "image" }, 30_000);
  return path as string;
}

/**
 * Recorded audio (base64 from Swift host) → uploaded in chunks → Volcengine flash ASR on the Mac.
 */
export async function transcribeAudio(b64Data: string, mime: string, address: string): Promise<{ text: string; ms?: number }> {
  const bytes = unb64(b64Data);
  if (!bytes.length) throw new Error("没录到声音：请再按住说一次");
  const id = await uploadBytes(bytes, mime || "audio/mp4");
  return await rpc("voice.done", { id, address }, 70_000);
}

async function saveAll(active: Saved | null, all: Saved[]) {
  if (!active || !all.length) {
    await Storage.removeItem(KEY);
    batch(() => { paired.set(null); desktops.set([]); addingMac.set(false); });
    return;
  }
  await Storage.setItem(KEY, JSON.stringify({ ...active, desktops: all }));
  batch(() => { paired.set(active); desktops.set(all); });
}

function upsertDesktop(entry: Saved): Saved[] {
  const cur = desktops().filter((d) => d.desktopId !== entry.desktopId);
  return [entry, ...cur];
}

let refreshTimer: any = null;
export async function refresh() {
  try { list.set(await rpc("terminals.list")); } catch {}
}

function start(saved: Saved, pair?: { token: string; name: string }) {
  link?.close();
  problem.set("");
  sas.set("");
  const l = new Link({
    relay: saved.relay,
    desktopId: saved.desktopId,
    desktopKey: saved.desktopKey,
    deviceKeys: boxKeysFromSecret(unb64(saved.deviceSecret)),
    pair,
  });
  link = l;
  console.log(`link: start ${pair ? "pairing" : "resume"} → ${saved.relay} desktop ${saved.desktopId}`);
  l.addEventListener("status", (e: any) => {
    if (link === l) status.set(e.detail.status);
  });
  l.addEventListener("confirm", (e: any) => {
    if (link === l) sas.set(e.detail.sas);
  });
  l.addEventListener("ready", async (e: any) => {
    if (link !== l) return;
    const r = e.detail;
    batch(() => { info.set(r); sas.set(""); addingMac.set(false); });
    if (pair || saved.desktopName !== r.desktopName || !paired()) {
      const updated: Saved = { ...saved, desktopName: r.desktopName || saved.desktopName, pairedAt: saved.pairedAt ?? Date.now() };
      const all = upsertDesktop(updated);
      await saveAll(updated, all);
    }
    refresh();
  });
  l.addEventListener("fatal", async (e: any) => {
    if (link !== l) return;
    console.warn(`link: fatal ${JSON.stringify(e.detail)}`);
    problem.set(e.detail.message ?? e.detail.code);
    if (["unknown-device", "revoked"].includes(e.detail.code)) {
      const rest = desktops().filter((d) => d.desktopId !== saved.desktopId);
      if (rest.length) {
        await saveAll(rest[0], rest);
        start(rest[0]);
      } else {
        await saveAll(null, []);
      }
    }
  });
  l.addEventListener("ev", (e: any) => {
    if (link !== l) return;
    const msg = e.detail;
    if (msg.ev === "terminals") {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 150);
    } else {
      onStream?.(msg);
    }
  });
}

/** Called once at startup: reconnect to the saved Mac, if any. */
export async function boot() {
  const raw = await Storage.getItem(KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    const all: Saved[] = Array.isArray(parsed.desktops) && parsed.desktops.length
      ? parsed.desktops
      : parsed.desktopId ? [parsed] : [];
    const active = all.find((d) => d.desktopId === parsed.desktopId) ?? all[0] ?? null;
    if (active) {
      batch(() => { desktops.set(all); paired.set(active); });
      start(active);
    }
  } catch {}
}

/** Pair with a link from `wayne-herdr-mods pair`. Reuses the phone's device key across Macs. */
export async function pairWith(text: string, deviceName: string) {
  const offer = decodePairLink(text.trim());
  if (offer.e && offer.e < Date.now()) throw new Error("这个配对链接已过期，请在 Mac 的 Herdr.app 里重新打开配对");
  const secret = paired()?.deviceSecret ?? desktops()[0]?.deviceSecret ?? b64(newBoxKeys().secretKey);
  const saved: Saved = {
    relay: offer.r,
    desktopId: offer.i,
    desktopKey: offer.k,
    desktopName: offer.n,
    deviceSecret: secret,
    pairedAt: Date.now(),
  };
  start(saved, { token: offer.t, name: deviceName });
}

/** Cancel an in-progress pairing and return to the previous Mac if one is saved. */
export function cancelPair() {
  sas.set("");
  problem.set("");
  addingMac.set(false);
  const cur = paired();
  if (cur) start(cur);
  else { link?.close(); link = null; status.set("idle"); }
}

/** Switch to another paired Mac. */
export async function switchDesktop(desktopId: string) {
  const target = desktops().find((d) => d.desktopId === desktopId);
  if (!target) return;
  if (paired()?.desktopId === desktopId && status() === "ready") return;
  batch(() => {
    status.set("connecting");
    list.set({ terminals: [], layout: [] });
    info.set(null);
    problem.set("");
  });
  const all = upsertDesktop(target);
  await saveAll(target, all);
  start(target);
}

/** Forget a paired Mac (default: the active one). Switches to the next Mac if any remain. */
export async function forget(desktopId?: string) {
  const targetId = desktopId ?? paired()?.desktopId;
  if (!targetId) return;
  const isCurrent = paired()?.desktopId === targetId;
  if (isCurrent) {
    try { await rpc("device.forget"); } catch {}
    link?.close();
    link = null;
  }
  const rest = desktops().filter((d) => d.desktopId !== targetId);
  if (rest.length) {
    const next = isCurrent ? rest[0] : (paired() ?? rest[0]);
    await saveAll(next, rest);
    if (isCurrent) {
      batch(() => { status.set("connecting"); list.set({ terminals: [], layout: [] }); info.set(null); });
      start(next);
    }
  } else {
    batch(() => { status.set("idle"); list.set({ terminals: [], layout: [] }); info.set(null); });
    await saveAll(null, []);
  }
}

/** Back in the foreground: check the socket now instead of waiting for a timer. */
export const wake = () => link?.wake();
