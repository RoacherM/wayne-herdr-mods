// Prerequisites: none (read-only summary of local wayne-herdr-mods logs/metrics + macOS sshd unified log).
//   node dev/conn-stats.mjs [--hours 24] [--json] [--no-sshd] [--dir ~/.config/wayne-herdr-mods]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { quantile } from '../host/metrics.js';
import { defaultDataDir } from '../host/state.js';

function dist(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v.at(-1) ?? null };
}

function inc(map, key) {
  const k = key || 'unknown';
  map[k] = (map[k] ?? 0) + 1;
}

function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 60_000) return `${(v / 60_000).toFixed(1)}m`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}s`;
  return `${Math.round(v)}ms`;
}

function fmtDist(d) {
  if (!d?.n) return 'n=0';
  return `n=${d.n}  p50=${fmtMs(d.p50)}  p95=${fmtMs(d.p95)}  max=${fmtMs(d.max)}`;
}

function parseCompactTs(line) {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d+)/.exec(line);
  if (!m) return null;
  const t = new Date(`${m[1]}T${m[2]}`).getTime();
  return Number.isFinite(t) ? t : null;
}

const isSshdOpen = (line) => line.includes('pam_sm_open_session') || /Accepted \S+ for /.test(line);
const isSshdClose = (line) => line.includes('pam_sm_setcred') || line.includes('GSSCred') || /Disconnected from|Connection closed/.test(line);

function recordSshdLine(byPid, line) {
  const ts = parseCompactTs(line);
  const pm = ts !== null && /\bsshd(?:-session)?\[(\d+):/.exec(line);
  if (!pm) return;
  const pid = Number(pm[1]);
  let s = byPid.get(pid);
  if (!s) { s = { tConn: ts, tOpen: 0, tClose: 0 }; byPid.set(pid, s); }
  if (!s.tOpen && isSshdOpen(line)) s.tOpen = ts;
  else if (s.tOpen && ts - s.tOpen > 50 && isSshdClose(line)) s.tClose = ts;
}

/** Parse macOS unified log lines (`process BEGINSWITH "sshd"`). */
export function parseSshdLog(text, { now = Date.now(), livePids = null } = {}) {
  const byPid = new Map();
  for (const line of text.split('\n')) recordSshdLine(byPid, line);
  const handshakes = [], uptimes = [], activeAges = [];
  for (const [pid, s] of byPid) {
    if (!s.tOpen) continue;
    handshakes.push(Math.max(0, s.tOpen - s.tConn));
    if (s.tClose) uptimes.push(Math.max(0, s.tClose - s.tOpen));
    else if (!livePids || livePids.has(pid)) activeAges.push(Math.max(0, now - s.tOpen));
  }
  return {
    sessions: handshakes.length,
    handshake: dist(handshakes),
    uptime: dist(uptimes),
    activeNow: activeAges.length,
    activeAge: dist(activeAges),
  };
}

function readJsonlSince(file, cutoffMs, tsOf) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const t = tsOf(row);
      if (Number.isFinite(t) && t >= cutoffMs) out.push(row);
    } catch {}
  }
  return out;
}

function readMetricsSince(dir, cutoffMs) {
  const mdir = join(dir, 'metrics');
  if (!existsSync(mdir)) return [];
  const oldestDay = new Date(cutoffMs - 86_400_000).toISOString().slice(0, 10);
  const out = [];
  for (const f of readdirSync(mdir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || f.slice(0, 10) < oldestDay) continue;
    out.push(...readJsonlSince(join(mdir, f), cutoffMs, (r) => r.t));
  }
  return out;
}

function parseHostLog(file) {
  if (!existsSync(file)) return { relayOnlineMs: [], relayUpMs: [], phoneUpMs: [] };
  const relayOnlineMs = [], relayUpMs = [], phoneUpMs = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const ro = /\[relay\] online ms=(\d+)/.exec(line);
    if (ro) relayOnlineMs.push(Number(ro[1]));
    const rf = /\[relay\] offline .*?upMs=(\d+)/.exec(line);
    if (rf) relayUpMs.push(Number(rf[1]));
    const pc = /session\.close .*?upMs=(\d+)/.exec(line);
    if (pc) phoneUpMs.push(Number(pc[1]));
  }
  return { relayOnlineMs, relayUpMs, phoneUpMs };
}

function countField(rows, field) {
  const out = {};
  for (const r of rows) inc(out, r?.[field]);
  return out;
}

function summarizeWakes(wakes, clientLogs) {
  if (wakes.length) return { actions: countField(wakes, 'action'), pingRtt: dist(wakes.map((w) => w.rttMs)) };
  const actions = {};
  for (const l of clientLogs) {
    if (l.event === 'link.wake' && l.detail?.action !== 'ping') inc(actions, l.detail?.action);
    else if (l.event === 'link.wake_ok') inc(actions, 'ping_ok');
  }
  return { actions, pingRtt: dist(clientLogs.filter((l) => l.event === 'link.wake_ok').map((l) => l.detail?.rttMs)) };
}

function summarizeTermOpen(opens, clientLogs) {
  const src = opens.length ? opens : clientLogs.filter((l) => l.event === 'term.drawn').map((l) => l.detail);
  return {
    webviewBoot: dist(clientLogs.filter((l) => l.event === 'term.ready').map((l) => l.detail?.ms)),
    rpcOpen: dist(clientLogs.filter((l) => l.event === 'rpc.term.open').map((l) => l.detail?.ms)),
    firstPaint: dist(src.filter((o) => !o.again).map((o) => o.ms)),
    reopenPaint: dist(src.filter((o) => o.again).map((o) => o.ms)),
  };
}

export function analyzeOurs({ metricsRows, clientLogs, hostLog }) {
  const phoneRows = metricsRows.filter((r) => !r.src || r.src === 'phone');
  const byEv = (ev) => phoneRows.filter((r) => r.ev === ev);
  const connects = byEv('connect'), drops = byEv('drop'), resumes = byEv('resume'), echoes = byEv('echo');
  const logConnects = connects.length ? connects : clientLogs.filter((l) => l.event === 'link.connect').map((l) => l.detail);
  const logDrops = drops.length ? drops : clientLogs.filter((l) => l.event === 'link.drop').map((l) => l.detail);
  const upSamples = logDrops.filter((d) => d.ready && Number.isFinite(d.upMs)).map((d) => d.upMs);
  return {
    readyCount: clientLogs.filter((l) => l.event === 'link.ready').length || logConnects.length,
    connect: {
      total: dist(logConnects.map((c) => c.ms)),
      ws: dist(logConnects.map((c) => c.wsMs)),
      room: dist(logConnects.map((c) => c.roomMs)),
      hs: dist(logConnects.map((c) => c.hsMs)),
      why: countField(logConnects, 'why'),
    },
    uptime: dist(upSamples.length ? upSamples : hostLog.phoneUpMs),
    drops: {
      total: logDrops.length,
      asleepWhileOpen: logDrops.filter((d) => d.reason === 'wake_asleep' && d.rs === 1).length,
      reasons: countField(logDrops, 'reason'),
    },
    wakes: summarizeWakes(byEv('wake'), clientLogs),
    termOpen: summarizeTermOpen(byEv('open'), clientLogs),
    resume: {
      away: dist(resumes.map((r) => r.away)),
      ready: dist(resumes.map((r) => r.ready)),
      paint: dist(resumes.map((r) => r.paint)),
    },
    echo: { net: dist(echoes.map((e) => e.net)), paint: dist(echoes.map((e) => e.paint)) },
    hostRelay: { onlineMs: dist(hostLog.relayOnlineMs), upMs: dist(hostLog.relayUpMs) },
  };
}

function formatPairs(obj) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join('  ') : '—';
}

function printReport(hours, ours, sshd) {
  console.log(`=== 连接与长连接观测对比（最近 ${hours} 小时） ===\n`);
  console.log('【1. 我们的 iOS App (wayne-herdr-mods · Cloudflare E2E 中继)】');
  console.log(`  握手就绪次数        : ${ours.readyCount}`);
  console.log(`  建连总耗时 (ms)     : ${fmtDist(ours.connect.total)}`);
  console.log(`    ├─ WebSocket 打开 : ${fmtDist(ours.connect.ws)}`);
  console.log(`    ├─ 中继房间 online: ${fmtDist(ours.connect.room)}`);
  console.log(`    └─ E2E 加密握手   : ${fmtDist(ours.connect.hs)}`);
  console.log(`  建连触发原因 (why)  : ${formatPairs(ours.connect.why)}`);
  console.log(`  单次连接存活 (upMs) : ${fmtDist(ours.uptime)}`);
  console.log(`  断线原因 (drop)     : ${formatPairs(ours.drops.reasons)}`);
  console.log(`    └─ 满30s主动掐OPEN: ${ours.drops.asleepWhileOpen} / ${ours.drops.total} 次`);
  console.log(`  前台唤醒动作 (wake) : ${formatPairs(ours.wakes.actions)}`);
  console.log(`    └─ <30s ping 往返 : ${fmtDist(ours.wakes.pingRtt)}`);
  console.log(`  打开终端拆解        :`);
  console.log(`    ├─ WebView 启动   : ${fmtDist(ours.termOpen.webviewBoot)}`);
  console.log(`    ├─ term.open RPC  : ${fmtDist(ours.termOpen.rpcOpen)}`);
  console.log(`    ├─ 首屏画出(首次) : ${fmtDist(ours.termOpen.firstPaint)}`);
  console.log(`    └─ 首屏画出(重开) : ${fmtDist(ours.termOpen.reopenPaint)}`);
  console.log(`  回前台恢复 (resume) : ready=[${fmtDist(ours.resume.ready)}]  paint=[${fmtDist(ours.resume.paint)}]`);
  console.log(`  打字回显 (echo)     : net=[${fmtDist(ours.echo.net)}]  paint=[${fmtDist(ours.echo.paint)}]`);
  console.log(`  Mac↔中继常驻连接    : 建连=[${fmtDist(ours.hostRelay.onlineMs)}]  存活=[${fmtDist(ours.hostRelay.upMs)}]`);

  if (!sshd) return;
  console.log('\n【2. 官方 Herdr Mobile (macOS sshd · Tailscale / LAN)】');
  console.log(`  SSH 登录次数        : ${sshd.sessions}（当前仍在线: ${sshd.activeNow}）`);
  console.log(`  SSH 握手耗时        : ${fmtDist(sshd.handshake)}`);
  console.log(`  单次会话存活(已断开): ${fmtDist(sshd.uptime)}`);
  if (sshd.activeNow) console.log(`  当前在线会话已持续  : ${fmtDist(sshd.activeAge)}`);
}

function liveSshdPids() {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+\S*sshd/.exec(line);
      if (m) pids.add(Number(m[1]));
    }
    return pids;
  } catch {
    return null;
  }
}

function querySshd(hours) {
  try {
    const out = execFileSync('/usr/bin/log', [
      'show', '--style', 'compact', '--info', '--last', `${Math.max(1, Math.ceil(hours))}h`,
      '--predicate', 'process BEGINSWITH "sshd"',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return parseSshdLog(out, { livePids: liveSshdPids() });
  } catch {
    return null;
  }
}

function main() {
  const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i < 0 ? dflt : process.argv[i + 1]; };
  const hours = Number(arg('--hours', 24));
  const dir = arg('--dir', defaultDataDir());
  const cutoffMs = Date.now() - hours * 3_600_000;
  const metricsRows = readMetricsSince(dir, cutoffMs);
  const clientLogs = readJsonlSince(join(dir, 'ios-client.log'), cutoffMs, (r) => Date.parse(r.ts));
  const hostLog = parseHostLog(join(homedir(), 'Library/Logs/wayne-herdr-mods.log'));
  const ours = analyzeOurs({ metricsRows, clientLogs, hostLog });
  const sshd = process.argv.includes('--no-sshd') ? null : querySshd(hours);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ hours, ours, sshd }, null, 2));
  else printReport(hours, ours, sshd);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
