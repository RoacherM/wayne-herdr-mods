/**
 * The connection to the active Mac, shared by every screen: the PWA's own Link (app/src/link.js)
 * and E2E code (shared/e2e.js), unchanged, running on QuickJS. Supports multiple paired Macs in
 * nsh Storage under key "herdr-relay" while staying backward-compatible with the single-Mac shape,
 * and watches terminal state transitions across paired Macs to post native iOS notifications.
 */
import "./shim";
import { batch, host, lifecycle, signal, Storage } from "nsh";
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
export const macStatuses = signal<Record<string, string>>({}); // desktopId -> status
export const problem = signal<string>("");
export const sas = signal<string>("");
export const paired = signal<Saved | null>(null);
export const desktops = signal<Saved[]>([]);
export const addingMac = signal<boolean>(false);
export const list = signal<List>({ terminals: [], layout: [] });
export const info = signal<any>(null);
export const activeTermAddress = signal<string | null>(null);
export const notifyPermission = signal<"prompt" | "granted" | "denied">("prompt");
export const notifyEnabled = signal<boolean>(false);

/** Events for the open terminal page: { ev: 'out' | 'size' | 'closed', s, ... } */
let onStream: ((msg: any) => void) | null = null;
export const setStreamListener = (fn: ((msg: any) => void) | null) => { onStream = fn; };

let link: any = null;
const bgLinks = new Map<string, { link: any; timer: any }>();

export const rpc = (m: string, p: object = {}, ms?: number) => (link ? link.rpc(m, p, ms) : Promise.reject(new Error("尚未连接")));
export const notify = (m: string, p: object = {}) => link?.notify(m, p);

function setMacStatus(desktopId: string, st: string) {
  const cur = macStatuses();
  if (cur[desktopId] === st) return;
  macStatuses.set({ ...cur, [desktopId]: st });
}

// ---- Native iOS Notification Bridge & Agent Status Watcher (matching host/notify.js)
type WatchedEntry = { state?: string | null; workingSince?: number; label: string };
const watchedByMac = new Map<string, Map<string, WatchedEntry>>();
const MIN_RUN_MS = 10_000;

function termLabel(t: Partial<Terminal>) {
  return [t.app || t.program, t.where].filter(Boolean).join(" · ") || t.address || "终端";
}

async function postLocalNotification(payload: { title: string; body: string; tag: string; desktopId: string; address: string }) {
  if (!host.available() || !notifyEnabled() || notifyPermission() !== "granted") return;
  // Skip banner if the user is actively looking at this exact terminal on the active Mac in foreground
  if (
    lifecycle() === "active" &&
    paired()?.desktopId === payload.desktopId &&
    activeTermAddress() === payload.address
  ) {
    return;
  }
  try {
    await host.call("notify.send", payload);
  } catch {}
}

function observeTerminals(desktopId: string, desktopName: string | undefined, terminals: Terminal[]) {
  const prefix = desktops().length > 1 ? `[${desktopName || "Mac"}] ` : "";
  const prevMap = watchedByMac.get(desktopId);
  const now = Date.now();

  if (!prevMap) {
    // First snapshot for this Mac: seed current states without firing notifications for existing states
    const seeded = new Map<string, WatchedEntry>();
    for (const t of terminals) {
      seeded.set(t.address, {
        state: t.state ?? null,
        workingSince: t.state === "working" ? now : undefined,
        label: termLabel(t),
      });
    }
    watchedByMac.set(desktopId, seeded);
    return;
  }

  const nextMap = new Map<string, WatchedEntry>();
  const currentAddrs = new Set<string>();

  for (const t of terminals) {
    currentAddrs.add(t.address);
    const prev = prevMap.get(t.address);
    const was = prev?.state ?? null;
    const is = t.state ?? null;
    const label = termLabel(t);

    let workingSince = prev?.workingSince;
    if (is === "working" && was !== "working") {
      workingSince = now;
    } else if (is !== "working") {
      workingSince = undefined;
    }
    nextMap.set(t.address, { state: is, workingSince, label });

    if (is === was || !is) continue;

    if (is === "blocked") {
      const what = ({ permission: "等你确认", question: "在问你问题", auth: "需要登录" } as Record<string, string>)[t.kind ?? ""] ?? "等你处理";
      postLocalNotification({
        title: `${prefix}✋ ${what}`,
        body: [label, t.msg].filter(Boolean).join("：").slice(0, 160),
        tag: `need-${desktopId}-${t.address}`,
        desktopId,
        address: t.address,
      });
    } else if (is === "error") {
      postLocalNotification({
        title: `${prefix}⚠️ 出错`,
        body: [label, t.msg].filter(Boolean).join("：").slice(0, 160),
        tag: `err-${desktopId}-${t.address}`,
        desktopId,
        address: t.address,
      });
    } else if (is === "done" && was === "working") {
      const ranMs = prev?.workingSince ? now - prev.workingSince : MIN_RUN_MS;
      if (ranMs >= MIN_RUN_MS || lifecycle() !== "active" || paired()?.desktopId !== desktopId) {
        postLocalNotification({
          title: `${prefix}✅ 完成`,
          body: label,
          tag: `done-${desktopId}-${t.address}`,
          desktopId,
          address: t.address,
        });
      }
    }
  }

  // Check if an agent terminal exited
  for (const [addr, prev] of prevMap.entries()) {
    if (!currentAddrs.has(addr) && prev.state && prev.state !== "idle") {
      postLocalNotification({
        title: `${prefix}⏹ 已退出`,
        body: prev.label,
        tag: `exit-${desktopId}-${addr}`,
        desktopId,
        address: addr,
      });
    }
  }

  watchedByMac.set(desktopId, nextMap);
}

export async function refreshNotifyStatus() {
  if (!host.available()) return notifyPermission();
  try {
    const r = await host.call<{ permission: "prompt" | "granted" | "denied" }>("notify.status");
    if (r?.permission) notifyPermission.set(r.permission);
  } catch {}
  return notifyPermission();
}

export async function enableNotifications(): Promise<boolean> {
  if (!host.available()) return false;
  const r = await host.call<{ granted: boolean; permission: "prompt" | "granted" | "denied" }>("notify.request");
  const granted = Boolean(r?.granted);
  notifyPermission.set(r?.permission ?? (granted ? "granted" : "denied"));
  notifyEnabled.set(granted);
  await saveAll(paired(), desktops());
  return granted;
}

export async function disableNotifications() {
  notifyEnabled.set(false);
  await saveAll(paired(), desktops());
}

export async function sendTestNotification() {
  if (!host.available()) throw new Error("当前环境不支持原生通知");
  if (notifyPermission() !== "granted") {
    const ok = await enableNotifications();
    if (!ok) throw new Error("没有获得通知权限：请在 iPhone 设置 ▸ Herdr ▸ 通知 里打开");
  } else if (!notifyEnabled()) {
    notifyEnabled.set(true);
    await saveAll(paired(), desktops());
  }
  const active = paired();
  const firstAddr = list().terminals[0]?.address ?? "";
  await host.call("notify.send", {
    title: "✋ 等你确认（测试通知）",
    body: `${active?.desktopName || "Mac"} · 点这条通知会直接打开 Herdr 终端`,
    tag: `test-${Date.now()}`,
    desktopId: active?.desktopId ?? "",
    address: firstAddr,
  });
}

export async function consumePendingNotificationTap(): Promise<{ desktopId?: string; address?: string } | null> {
  if (!host.available()) return null;
  try {
    const tap = await host.call<{ desktopId?: string; address?: string } | null>("notify.consumeTap");
    if (tap && tap.address) return tap;
  } catch {}
  return null;
}

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
    for (const bg of bgLinks.values()) {
      clearTimeout(bg.timer);
      bg.link?.close();
    }
    bgLinks.clear();
    batch(() => { paired.set(null); desktops.set([]); addingMac.set(false); macStatuses.set({}); });
    return;
  }
  await Storage.setItem(KEY, JSON.stringify({ ...active, desktops: all, push: notifyEnabled() }));
  batch(() => { paired.set(active); desktops.set(all); });
  syncBackgroundLinks(active.desktopId, all);
}

function upsertDesktop(entry: Saved): Saved[] {
  const cur = desktops().filter((d) => d.desktopId !== entry.desktopId);
  return [entry, ...cur];
}

function syncBackgroundLinks(activeId: string | undefined, all: Saved[]) {
  // Close background links that are no longer secondary Macs
  const keepIds = new Set(all.filter((d) => d.desktopId !== activeId).map((d) => d.desktopId));
  for (const [id, bg] of bgLinks.entries()) {
    if (!keepIds.has(id)) {
      clearTimeout(bg.timer);
      bg.link?.close();
      bgLinks.delete(id);
    }
  }
  // Open background watcher links for secondary paired Macs so their online status and notifications stay live
  for (const d of all) {
    if (d.desktopId === activeId || bgLinks.has(d.desktopId)) continue;
    const entry = { link: null as any, timer: null as any };
    const bl = new Link({
      relay: d.relay,
      desktopId: d.desktopId,
      desktopKey: d.desktopKey,
      deviceKeys: boxKeysFromSecret(unb64(d.deviceSecret)),
    });
    entry.link = bl;
    bgLinks.set(d.desktopId, entry);

    const pollBgList = async () => {
      if (bgLinks.get(d.desktopId)?.link !== bl) return;
      try {
        const res = (await bl.rpc("terminals.list")) as List;
        if (Array.isArray(res?.terminals)) {
          observeTerminals(d.desktopId, d.desktopName, res.terminals);
        }
      } catch {}
    };

    bl.addEventListener("status", (e: any) => {
      if (bgLinks.get(d.desktopId)?.link === bl) {
        setMacStatus(d.desktopId, e.detail.status);
      }
    });
    bl.addEventListener("ready", () => {
      if (bgLinks.get(d.desktopId)?.link === bl) {
        setMacStatus(d.desktopId, "ready");
        pollBgList();
      }
    });
    bl.addEventListener("ev", (e: any) => {
      if (bgLinks.get(d.desktopId)?.link !== bl) return;
      if (e.detail?.ev === "terminals") {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(pollBgList, 200);
      }
    });
  }
}

let refreshTimer: any = null;
export async function refresh() {
  try {
    const res = (await rpc("terminals.list")) as List;
    list.set(res);
    const cur = paired();
    if (cur && Array.isArray(res?.terminals)) {
      observeTerminals(cur.desktopId, cur.desktopName, res.terminals);
    }
  } catch {}
}

function start(saved: Saved, pair?: { token: string; name: string }) {
  // Ensure no background link is open for the Mac becoming primary
  const existingBg = bgLinks.get(saved.desktopId);
  if (existingBg) {
    clearTimeout(existingBg.timer);
    existingBg.link?.close();
    bgLinks.delete(saved.desktopId);
  }
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
    if (link === l) {
      status.set(e.detail.status);
      setMacStatus(saved.desktopId, e.detail.status);
    }
  });
  l.addEventListener("confirm", (e: any) => {
    if (link === l) sas.set(e.detail.sas);
  });
  l.addEventListener("ready", async (e: any) => {
    if (link !== l) return;
    const r = e.detail;
    setMacStatus(saved.desktopId, "ready");
    batch(() => { info.set(r); sas.set(""); addingMac.set(false); });
    const updated: Saved = { ...saved, desktopName: r.desktopName || saved.desktopName, pairedAt: saved.pairedAt ?? Date.now() };
    const all = upsertDesktop(updated);
    if (pair || saved.desktopName !== r.desktopName || !paired()) {
      await saveAll(updated, all);
    } else {
      syncBackgroundLinks(updated.desktopId, all);
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

/** Called once at startup: reconnect to the saved Mac, if any, and sync notification state. */
export async function boot() {
  const perm = await refreshNotifyStatus();
  const raw = await Storage.getItem(KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.push === "boolean") {
      notifyEnabled.set(parsed.push && perm === "granted");
    } else if (perm === "granted") {
      notifyEnabled.set(true);
    }
    const all: Saved[] = Array.isArray(parsed.desktops) && parsed.desktops.length
      ? parsed.desktops
      : parsed.desktopId ? [parsed] : [];
    const active = all.find((d) => d.desktopId === parsed.desktopId) ?? all[0] ?? null;
    if (active) {
      batch(() => { desktops.set(all); paired.set(active); });
      start(active);
      syncBackgroundLinks(active.desktopId, all);
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
  } else {
    const bg = bgLinks.get(targetId);
    if (bg) {
      try { await bg.link?.rpc("device.forget"); } catch {}
      clearTimeout(bg.timer);
      bg.link?.close();
      bgLinks.delete(targetId);
    }
  }
  watchedByMac.delete(targetId);
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

/** Back in the foreground: check all sockets now instead of waiting for a timer. */
export const wake = () => {
  link?.wake();
  for (const bg of bgLinks.values()) bg.link?.wake?.();
};
