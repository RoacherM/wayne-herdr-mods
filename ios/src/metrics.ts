/**
 * Experience & connection stability metrics for the native iOS app (DESIGN.md「体验记录」).
 * Times and event kinds only — never terminal text or user input. Batches go to the Mac via
 * `metrics.put` on foreground settle, every 15 s while active, and when entering background.
 *
 * Measurement helpers never read nsh signals, so calling them inside an `effect` cannot add
 * accidental reactive subscriptions (same invariant as `clientLog` in `conn.ts`).
 */

const KEEP = 400;
const QUIET_MS = 300;
const ECHO_GIVE_UP_MS = 2_000;
const OPEN_GIVE_UP_MS = 15_000;
const RESUME_GIVE_UP_MS = 5_000;
const FLUSH_MS = 15_000;
const SETTLE_FLUSH_MS = 1_500;
const MAX_SPAN_MS = 7 * 86_400_000;

const CTX = { src: "phone", ver: "nsh-ios", browser: "nsh-ios", standalone: true };
const clampMs = (n: number) => Math.min(MAX_SPAN_MS, Math.max(0, Math.round(n)));

type LogFn = (level: "info" | "warn" | "error", event: string, detail?: Record<string, any>) => void;

const queue: Record<string, any>[] = [];
let activeLink: any = null;
let logFn: LogFn = () => {};
let isForeground: () => boolean = () => true;
let sending = false;
let flushTimer: any = 0;
let settleTimer: any = 0;

let lastOutAt = -Infinity;
let echoState: { t0: number; net?: number } | null = null;
let openState: { address: string; again: boolean; t0: number; webMs: number; openRpcMs: number; armed: boolean } | null = null;
let resumeState: { t0: number; away: number; ready?: number; armed: boolean; timer: any } | null = null;
let hiddenAt: number | null = null;

function mark(ev: string, data: Record<string, any> = {}) {
  queue.push({ t: Date.now(), ev, via: "relay", ...data });
  if (queue.length > KEEP) queue.splice(0, queue.length - KEEP);
}

export function initIosMetrics(opts: { log: LogFn; fg: () => boolean }) {
  logFn = opts.log;
  isForeground = opts.fg;
  startTimer();
}

function startTimer() {
  stopTimer();
  flushTimer = setInterval(flushMetrics, FLUSH_MS);
  flushTimer?.unref?.();
}

function stopTimer() {
  clearInterval(flushTimer);
  flushTimer = 0;
}

function scheduleSettleFlush() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(flushMetrics, SETTLE_FLUSH_MS);
  settleTimer?.unref?.();
}

export async function flushMetrics() {
  if (sending || !queue.length || activeLink?.status !== "ready") return;
  sending = true;
  const events = queue.splice(0);
  const t0 = Date.now();
  try {
    await activeLink.rpc("metrics.put", { ctx: CTX, events }, 10_000);
    mark("rtt", { ms: clampMs(Date.now() - t0), n: events.length });
  } catch {
    queue.unshift(...events);
    if (queue.length > KEEP) queue.splice(0, queue.length - KEEP);
  } finally {
    sending = false;
  }
}

function onLinkStatus(l: any, prev: { v: string }) {
  if (l !== activeLink || l.status === prev.v) return;
  prev.v = l.status;
  mark("link", { status: l.status });
  if (l.status === "ready") scheduleSettleFlush();
  if (!resumeState) return;
  if (l.status !== "ready") resumeState.ready = undefined;
  else if (resumeState.ready === undefined) resumeState.ready = clampMs(Date.now() - resumeState.t0);
}

function onLinkConnected(l: any, detail: any) {
  if (l !== activeLink) return;
  mark("connect", detail);
  logFn("info", "link.connect", detail);
}

function onLinkDropped(l: any, detail: any, wakeBox: { pending: any }) {
  if (l !== activeLink) return;
  if (wakeBox.pending && detail?.reason === "wake_pong") {
    mark("wake", { ...wakeBox.pending, action: "ping_timeout", rttMs: null });
    wakeBox.pending = null;
  }
  mark("drop", detail);
  logFn("info", "link.drop", { ...detail, fg: isForeground() });
}

function onLinkWake(l: any, detail: any, wakeBox: { pending: any }) {
  if (l !== activeLink) return;
  logFn("info", "link.wake", detail);
  if (detail?.action === "ping") { wakeBox.pending = detail; return; }
  mark("wake", { ...detail, rttMs: null });
}

function onLinkWakeOk(l: any, detail: any, wakeBox: { pending: any }) {
  if (l !== activeLink) return;
  logFn("info", "link.wake_ok", detail);
  if (!wakeBox.pending) return;
  mark("wake", { ...wakeBox.pending, action: "ping_ok", rttMs: detail.rttMs });
  wakeBox.pending = null;
}

export function watchActiveLink(l: any) {
  activeLink = l;
  const prev = { v: l.status };
  const wakeBox = { pending: null as any };
  l.addEventListener("status", () => onLinkStatus(l, prev));
  l.addEventListener("connected", (e: any) => onLinkConnected(l, e.detail));
  l.addEventListener("dropped", (e: any) => onLinkDropped(l, e.detail, wakeBox));
  l.addEventListener("wake", (e: any) => onLinkWake(l, e.detail, wakeBox));
  l.addEventListener("wake_ok", (e: any) => onLinkWakeOk(l, e.detail, wakeBox));
}

function finishResumeTimeout(expected: NonNullable<typeof resumeState>) {
  if (resumeState !== expected) return;
  resumeState = null;
  const payload = { away: expected.away, ready: expected.ready ?? null, paint: null };
  mark("resume", payload);
  logFn("info", "app.resume", payload);
  scheduleSettleFlush();
}

function beginResume(awayMs: number, now: number) {
  const cur = { t0: now, away: awayMs, ready: undefined as number | undefined, armed: false, timer: 0 as any };
  if (resumeState) clearTimeout(resumeState.timer);
  resumeState = cur;
  setTimeout(() => {
    if (resumeState === cur && cur.ready === undefined && activeLink?.status === "ready") cur.ready = 0;
  }, 0);
  cur.timer = setTimeout(() => finishResumeTimeout(cur), RESUME_GIVE_UP_MS);
  cur.timer?.unref?.();
}

export function onAppLifecycle(state: string) {
  if (state === "background") {
    hiddenAt = Date.now();
    flushMetrics();
    stopTimer();
    return;
  }
  if (state !== "active") return;
  startTimer();
  if (hiddenAt === null) return;
  const now = Date.now();
  const away = clampMs(now - hiddenAt);
  hiddenAt = null;
  beginResume(away, now);
}

export function recordOp(op: string, key?: string) {
  mark("op", key ? { op, key: key.slice(0, 40) } : { op });
}

export function termOpening(address: string, again: boolean) {
  if (!again) recordOp("open");
  openState = { address, again, t0: Date.now(), webMs: 0, openRpcMs: 0, armed: false };
}

export function termWebReady(ms: number) {
  if (openState && !openState.again) openState.webMs = clampMs(ms);
}

export function termRpcOpened(ms: number) {
  if (openState) openState.openRpcMs = clampMs(ms);
}

export function termTyped() {
  const now = Date.now();
  if (!echoState && now - lastOutAt > QUIET_MS) echoState = { t0: now };
}

export function termOutputArrived() {
  const now = Date.now();
  lastOutAt = now;
  if (echoState && echoState.net === undefined) {
    if (now - echoState.t0 <= ECHO_GIVE_UP_MS) echoState.net = clampMs(now - echoState.t0);
    else echoState = null;
  }
  if (openState) {
    if (now - openState.t0 <= OPEN_GIVE_UP_MS) openState.armed = true;
    else openState = null;
  }
  if (resumeState?.ready !== undefined) resumeState.armed = true;
}

function settleEcho(now: number) {
  if (!echoState || echoState.net === undefined) return;
  mark("echo", { net: echoState.net, paint: clampMs(now - echoState.t0) });
  echoState = null;
}

function settleOpen(now: number) {
  if (!openState?.armed) return;
  const o = openState;
  openState = null;
  const ms = clampMs(now - o.t0);
  mark("open", { ms, again: o.again });
  logFn("info", "term.drawn", { address: o.address, again: o.again, ms, webMs: o.webMs, openRpcMs: o.openRpcMs });
  scheduleSettleFlush();
}

function settleResume(now: number) {
  if (!resumeState?.armed || resumeState.ready === undefined) return;
  const r = resumeState;
  resumeState = null;
  clearTimeout(r.timer);
  const payload = { away: r.away, ready: r.ready, paint: clampMs(now - r.t0) };
  mark("resume", payload);
  logFn("info", "app.resume", payload);
  scheduleSettleFlush();
}

export function termDrawn() {
  const now = Date.now();
  settleEcho(now);
  settleOpen(now);
  settleResume(now);
}

/** Tear down module timers when forgetting all Macs (keeps Node tests clean). */
export function resetIosMetrics() {
  stopTimer();
  clearTimeout(settleTimer);
  if (resumeState) clearTimeout(resumeState.timer);
  resumeState = null;
  openState = null;
  echoState = null;
  activeLink = null;
}
