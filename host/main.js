#!/usr/bin/env node
/**
 * wayne-herdr-mods — control Herdr.app terminals from a phone browser, and our part of Herdr.app's
 * UI (herdr-app/). SKILL.md: how an agent uses it. Called herdr-relay until 2026-11-04; `install`
 * moves that setup over (migrateOld).
 *
 *   wayne-herdr-mods serve       run the host in the foreground (what the LaunchAgent runs)
 *   wayne-herdr-mods pair        open Herdr.app's 手机 dialog with a pairing QR
 *   wayne-herdr-mods ctl <m> [json]  one control call, JSON out (what the dialog runs)
 *   wayne-herdr-mods devices     list paired devices;  devices rm <id>  removes one
 *   wayne-herdr-mods status      relay / herdr-core / phones at a glance
 *   wayne-herdr-mods install     install the build, the LaunchAgent, herdr-app/ and the skill
 *   wayne-herdr-mods uninstall   take them away again (keeps keys and devices)
 *   wayne-herdr-mods --skill     print SKILL.md (for an agent)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { controlCall, DEFAULT_RELAY, startService, VOICE_TEST, voiceWords } from './service.js';
import { readHerdrFiles } from './herdr-files.js';
import { createMetricsStore, summarize } from './metrics.js';
import { renderReport } from './metrics-report.js';
import { defaultDataDir } from './state.js';
import { checkKey, deleteKey, KEYCHAIN, readKey, saveKey, sayAndRecognize } from './voice.js';

const NAME = 'wayne-herdr-mods';
const LABEL = `com.roacherm.${NAME}`;
const HELP = `wayne-herdr-mods — 在手机浏览器里操作 Herdr.app 的终端；Herdr.app 里我们的界面

  wayne-herdr-mods serve       前台运行（LaunchAgent 跑的就是它）
  wayne-herdr-mods pair        打开 Herdr.app 的「手机」窗口，显示配对二维码
  wayne-herdr-mods devices     列出已配对设备；devices rm <id> 移除一台
  wayne-herdr-mods status      中继、herdr-core、手机连接状态
  wayne-herdr-mods metrics     手机体验记录的报告页（--days N 看几天，默认 7；--json 只出数字；--no-open 不打开）
  wayne-herdr-mods install     安装：命令、开机自启、Herdr.app 的界面、agent skill（旧的 herdr-relay 配置一起搬过来）
  wayne-herdr-mods uninstall   全部移除（保留密钥和设备）
  wayne-herdr-mods voice key   设置火山语音识别的 API Key（存进钥匙串）
  wayne-herdr-mods voice test  用一段 Mac 朗读的中文试一次识别
  wayne-herdr-mods voice off   删除 API Key，关掉语音输入
  wayne-herdr-mods --skill     给 agent 看的用法（SKILL.md）`;
const dataDir = defaultDataDir();
const [cmd = 'help', ...args] = process.argv.slice(2);

const fmtAgo = (ms) => {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};

async function serve() {
  const svc = await startService({ dataDir, log: (m) => console.error(`${new Date().toISOString()} ${m}`) });
  console.error(`${new Date().toISOString()} wayne-herdr-mods: 已启动，中继 ${svc.view().relayUrl}，desktop ${svc.desktopId}`);
  const stop = async () => { await svc.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ------------------------------------------------------------------ Herdr.app ---
// Our part of Herdr.app lives in the repo's herdr-app/ (DESIGN.md「Herdr.app 里的界面」): the layout
// main-preview, its tab bar my-tabs (with the phone icon) and file panel my-files, and the 手机
// dialog, the mod wayne-phones. `install` writes it into ~/.config/herdr-app; the repo is where to edit.
// `uninstall` takes the dialog away and leaves the layout.
const MOD = 'wayne-phones';
const herdrHome = () => process.env.HERDR_APP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr-app');
// eslint-disable-next-line no-undef
const herdrFiles = () => (typeof __HERDR_APP__ !== 'undefined' ? __HERDR_APP__ : readHerdrFiles(join(dirname(fileURLToPath(import.meta.url)), '..', 'herdr-app')));

function installMod() {
  const appDir = herdrHome();
  if (!existsSync(appDir)) return null; // no Herdr.app here
  const files = herdrFiles();
  // Only what changed: writing a mod's file reloads it in Herdr.app.
  for (const [rel, text] of Object.entries(files)) {
    const p = join(appDir, rel);
    if (existsSync(p) && readFileSync(p, 'utf8') === text) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return appDir;
}

function uninstallMod() {
  const appDir = herdrHome();
  rmSync(join(appDir, 'mods', MOD), { recursive: true, force: true });
  rmSync(join(appDir, 'data', MOD), { recursive: true, force: true });
}

/** Open the 手机 dialog in the running Herdr.app (unless it is open already). */
function openInHerdr() {
  if (!existsSync(join(herdrHome(), 'mods', MOD, 'main.js'))) throw new Error('Herdr.app 里还没有「手机」窗口：先在仓库里运行 node dist/wayne-herdr-mods.mjs install');
  let st;
  try { st = JSON.parse(execFileSync('herdr-app', ['status'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { throw new Error('Herdr.app 没有打开：打开它，点标签栏右上角的手机图标'); }
  if (!JSON.stringify(st.overlays ?? []).includes(MOD)) execFileSync('herdr-app', ['do', 'mod.open', '--name', MOD], { timeout: 5000, stdio: 'ignore' });
}

/** One control call for the mod: JSON out. A pairing offer carries its QR as SVG. */
async function ctl() {
  const [method, json = '{}'] = args;
  if (!method) throw new Error('用法：wayne-herdr-mods ctl <method> [json]');
  const v = await controlCall(dataDir, method, JSON.parse(json), { timeoutMs: 40_000 });
  const offer = v?.pairing?.offer;
  if (offer) offer.qrSvg = await QRCode.toString(offer.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' });
  process.stdout.write(`${JSON.stringify(v)}\n`);
}

/** Pairing happens in Herdr.app: the dialog shows the QR, then the code and allow / deny. */
async function pair() {
  openInHerdr();
  await controlCall(dataDir, 'pair.start');
  console.log('已在 Herdr.app 的「手机」窗口里显示二维码。用手机相机扫码，再在窗口里核对 6 位数字。');
}

async function devices() {
  if (args[0] === 'rm' || args[0] === 'remove') {
    if (!args[1]) throw new Error('用法：wayne-herdr-mods devices rm <id 前几位>');
    await controlCall(dataDir, 'devices.remove', { id: args[1] });
    console.log('已移除。这台设备要重新扫码才能连接。');
    return;
  }
  const v = await controlCall(dataDir, 'status');
  if (!v.devices.length) { console.log('还没有配对的设备。在 Herdr.app 里点标签栏右上角的手机图标配对。'); return; }
  for (const d of v.devices) {
    console.log(`${d.id.slice(0, 8)}  ${d.name.padEnd(16)}  ${d.online ? '在线' : '离线'}  推送${d.push ? '开' : '关'}  上次 ${fmtAgo(d.lastSeen)}`);
  }
}

async function status() {
  let v;
  try { v = await controlCall(dataDir, 'status', {}, { timeoutMs: 5000 }); }
  catch (error) { if (error.code === 'NOT_RUNNING') { console.log(error.message); process.exitCode = 1; return; } throw error; }
  const rows = [
    ['电脑', v.desktopName],
    ['中继', `${v.relay}  ${v.relayUrl}`],
    ['herdr-core', `${v.core}  ${v.terminals} 个终端`],
    ['设备', `${v.devices.length} 台已配对，${v.connected.length} 个连接在线`],
  ];
  for (const [k, val] of rows) console.log(`${k.padEnd(11)} ${val}`);
}

// ------------------------------------------------------------------ install ----
const home = homedir();
const installDir = join(home, '.local', 'share', NAME);
const binDir = join(home, '.local', 'bin');
const binPath = join(binDir, NAME);
// The skill, where this Mac keeps skills (~/.agents/skills), linked from ~/.claude/skills.
const skillDir = join(home, '.agents', 'skills', NAME);
const skillLink = join(home, '.claude', 'skills', NAME);
// eslint-disable-next-line no-undef
const skillText = () => (typeof __SKILL__ !== 'undefined' ? __SKILL__ : readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'SKILL.md'), 'utf8'));
const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = join(home, 'Library', 'Logs', `${NAME}.log`);
const uid = process.getuid();

async function install() {
  const self = fileURLToPath(import.meta.url);
  if (!/\.mjs$/.test(self) || !readFileSync(self, 'utf8').includes('wayne-herdr-mods bundle')) {
    throw new Error('install 要从打包好的文件运行：npm run build && node dist/wayne-herdr-mods.mjs install');
  }
  const moved = await migrateOld();
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const target = join(installDir, `${NAME}.mjs`);
  copyFileSync(self, target);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`);
  chmodSync(binPath, 0o755);
  const skill = installSkill();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${target}</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>WAYNE_HERDR_MODS_URL</key><string>${process.env.WAYNE_HERDR_MODS_URL ?? DEFAULT_RELAY}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict></plist>
`);
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  // bootout returns before the old job is gone; bootstrap right after fails with "Input/output
  // error" (seen 2026-11-02). Retry for a few seconds.
  for (let i = 0; ; i++) {
    try { execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'pipe' }); break; }
    catch (error) { if (i >= 20) throw error; execFileSync('/bin/sleep', ['0.3']); }
  }
  const mod = installMod();
  const herdr = mod ? `\n  Herdr  ${mod}（布局 main-preview；标签栏右上角的手机图标打开「手机」窗口）` : '';
  const old = moved.length ? `\n\n从 herdr-relay 搬过来：\n${moved.map((m) => `  ${m}`).join('\n')}` : '';
  console.log(`已安装：\n  程序   ${target}\n  命令   ${binPath}\n  自启动 ${plistPath}\n  日志   ${logPath}${herdr}\n  Skill  ${skill}${old}\n\n配对：在 Herdr.app 里点标签栏右上角的手机图标。`);
}

// ------------------------------------------------------------------ the old name --
// Until 2026-11-04 this was herdr-relay. install moves that setup over once; nothing reads the old
// names after. Not moved, on purpose: the relay URL and the e2e labels (paired phones use them),
// and the phone page's localStorage key (the phone's pairing lives under it).
const OLD = 'herdr-relay';

async function migrateOld() {
  const moved = [];
  const oldLabel = `com.roacherm.${OLD}`, oldPlist = join(home, 'Library', 'LaunchAgents', `${oldLabel}.plist`);
  const running = () => { try { execFileSync('launchctl', ['print', `gui/${uid}/${oldLabel}`], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (running()) {
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${oldLabel}`], { stdio: 'ignore' }); } catch {}
    for (let i = 0; i < 30 && running(); i++) execFileSync('/bin/sleep', ['0.2']); // bootout returns before the job is gone
    moved.push(`后台服务 ${oldLabel} → ${LABEL}`);
  }
  rmSync(oldPlist, { force: true });
  const oldData = join(home, '.config', OLD);
  if (!process.env.WAYNE_HERDR_MODS_DIR && existsSync(oldData)) {
    if (existsSync(dataDir)) throw new Error(`${oldData} 和 ${dataDir} 都在：不知道用哪个。看一下，删掉不要的那个再 install。`);
    rmSync(join(oldData, 'control.sock'), { force: true });
    renameSync(oldData, dataDir);
    moved.push(`密钥和已配对的手机 ${oldData} → ${dataDir}`);
  }
  const oldLog = join(home, 'Library', 'Logs', `${OLD}.log`);
  if (existsSync(oldLog) && !existsSync(logPath)) { renameSync(oldLog, logPath); moved.push(`日志 → ${logPath}`); }
  const security = (...a) => execFileSync('/usr/bin/security', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let oldKey = null;
  try { oldKey = security('find-generic-password', '-s', `${OLD}.voice`, '-a', KEYCHAIN.account, '-w'); } catch {}
  if (oldKey) {
    if (!(await readKey())) await saveKey(oldKey);
    security('delete-generic-password', '-s', `${OLD}.voice`, '-a', KEYCHAIN.account);
    moved.push(`语音识别 Key：钥匙串 ${OLD}.voice → ${KEYCHAIN.service}`);
  }
  for (const p of [join(binDir, OLD), join(herdrHome(), 'mods', OLD), join(herdrHome(), 'data', OLD)]) {
    if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); moved.push(`删掉 ${p}`); }
  }
  // The old install folder: its build goes; anything else in it (a whisper model, 550 MB) is left for a person.
  const oldInstall = join(home, '.local', 'share', OLD);
  if (existsSync(oldInstall)) {
    rmSync(join(oldInstall, `${OLD}.mjs`), { force: true });
    const rest = readdirSync(oldInstall);
    if (rest.length) moved.push(`留着 ${oldInstall}（里面还有 ${rest.join('、')}，不是这个程序用的，要不要删你定）`);
    else { rmSync(oldInstall, { recursive: true, force: true }); moved.push(`删掉 ${oldInstall}`); }
  }
  const keysPath = join(herdrHome(), 'keys.json'); // the ⌘⇧M an install on 2026-11-04 added
  try {
    const keys = JSON.parse(readFileSync(keysPath, 'utf8'));
    if (keys.global?.['cmd-shift-m'] === `mod.open:${OLD}`) { delete keys.global['cmd-shift-m']; writeFileSync(keysPath, `${JSON.stringify(keys, null, 2)}\n`); moved.push('删掉快捷键 ⌘⇧M'); }
  } catch {}
  return moved;
}

/** SKILL.md for agents: ~/.agents/skills/<name>/, and a link in ~/.claude/skills when that exists. */
function installSkill() {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), skillText());
  if (existsSync(dirname(skillLink)) && !existsSync(skillLink)) symlinkSync(join('..', '..', '.agents', 'skills', NAME), skillLink);
  return skillDir;
}

function uninstall() {
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  for (const p of [plistPath, binPath]) if (existsSync(p)) rmSync(p);
  rmSync(skillLink, { force: true });
  rmSync(skillDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  uninstallMod();
  console.log(`已停止并移除。密钥和已配对设备保留在 ${dataDir}（删除这个目录等于重置所有配对）。`);
}

/** A change the running service should know about; without a service, done here. */
async function viaService(m, p, alone) {
  try { await controlCall(dataDir, m, p, { timeoutMs: 40_000 }); }
  catch (error) { if (error.code !== 'NOT_RUNNING') throw error; await alone(); }
}

async function voiceCmd() {
  const sub = args[0];
  if (sub === 'key') {
    let key = args[1];
    if (!key) {
      if (process.stdin.isTTY) {
        process.stdout.write('粘贴火山引擎控制台的 API Key（输入不显示），回车：');
        key = await readHidden();
      } else {
        key = (await new Promise((r) => { let b = ''; process.stdin.on('data', (d) => (b += d)).on('end', () => r(b)); })).trim();
      }
    }
    key = checkKey(key);
    // Through the running service when there is one (over its 0600 socket), so「手机」window's status follows.
    await viaService('voice.set', { key }, () => saveKey(key));
    console.log(`已存进钥匙串（${KEYCHAIN.service}）。运行 wayne-herdr-mods voice test 试一次。`);
    return;
  }
  if (sub === 'off') { await viaService('voice.off', {}, deleteKey); console.log('已删除 API Key。手机上不再显示麦克风键（重开网页后生效）。'); return; }
  if (sub === 'test') {
    const key = await readKey();
    if (!key) throw new Error('还没有 Key：先运行 wayne-herdr-mods voice key');
    const text = args.slice(1).join(' ') || VOICE_TEST;
    console.log(`朗读：${text}`);
    // As on the phone: the built-in words, voice-words.txt, and the folder of the terminal (here: phones.js's).
    const { hints, spell } = await voiceWords(dataDir, null);
    spell.push('phones.js'); hints.push('phones.js');
    const r = await sayAndRecognize(text, { key, words: hints, spell });
    console.log(`识别：${r.text || '（空）'}\n用时：${r.ms} ms`);
    return;
  }
  const key = await readKey();
  console.log(key ? `语音输入：已开启（Key 末 4 位 …${key.slice(-4)}）` : '语音输入：未开启。运行 wayne-herdr-mods voice key');
}

function readHidden() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(value); return; }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') value = value.slice(0, -1); else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** The phones' experience records → a report page (or JSON for scripts and agents). */
async function metrics() {
  const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const days = Math.max(1, Math.min(30, Number(opt('--days') ?? 7) || 7));
  const store = createMetricsStore({ dir: dataDir });
  const summary = summarize(await store.read(days));
  if (args.includes('--json')) {
    // Without the timeline: an agent wants the numbers.
    for (const g of Object.values(summary.groups)) delete g.recent;
    return console.log(JSON.stringify(summary));
  }
  const out = opt('--out') ?? join(store.root, 'report.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(summary, { title: `手机体验记录（最近 ${days} 天）` }));
  const n = Object.values(summary.groups).reduce((s, g) => s + g.n, 0);
  console.log(`${n} 条记录 → ${out}`);
  if (!args.includes('--no-open')) execFileSync('open', [out]);
}

const commands = { serve, pair, ctl, devices, status, metrics, install, uninstall, voice: voiceCmd, '--skill': () => process.stdout.write(skillText()) };
if (!commands[cmd]) {
  console.log(HELP);
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
Promise.resolve(commands[cmd]()).catch((error) => { console.error(error.message); process.exit(1); });
