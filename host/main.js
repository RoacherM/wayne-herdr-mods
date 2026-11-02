#!/usr/bin/env node
/**
 * herdr-relay — control Herdr.app terminals from a phone browser.
 *
 *   herdr-relay serve       run the host in the foreground (what the LaunchAgent runs)
 *   herdr-relay pair        show a pairing QR, confirm the phone's 6-digit code here
 *   herdr-relay devices     list paired devices;  devices rm <id>  removes one
 *   herdr-relay status      relay / herdr-core / phones at a glance
 *   herdr-relay install     copy this build to ~/.local/share/herdr-relay and start it at login
 *   herdr-relay uninstall   stop it and remove the LaunchAgent (keeps keys and devices)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { controlCall, DEFAULT_RELAY, startService, voiceWords } from './service.js';
import { defaultDataDir } from './state.js';
import { deleteKey, readKey, recognize, saveKey, toWav } from './voice.js';

const LABEL = 'com.roacherm.herdr-relay';
const HELP = `herdr-relay — 在手机浏览器里操作 Herdr.app 的终端

  herdr-relay serve       前台运行（LaunchAgent 跑的就是它）
  herdr-relay pair        显示配对二维码，在这里确认手机上的 6 位核对码
  herdr-relay devices     列出已配对设备；devices rm <id> 移除一台
  herdr-relay status      中继、herdr-core、手机连接状态
  herdr-relay install     复制到 ~/.local/share/herdr-relay 并开机自启
  herdr-relay uninstall   停止并移除自启（保留密钥和设备）
  herdr-relay voice key   设置火山语音识别的 API Key（存进钥匙串）
  herdr-relay voice test  用一段 Mac 朗读的中文试一次识别
  herdr-relay voice off   删除 API Key，关掉语音输入`;
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
  console.error(`${new Date().toISOString()} herdr-relay: 已启动，中继 ${svc.view().relayUrl}，desktop ${svc.desktopId}`);
  const stop = async () => { await svc.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function pair() {
  let v = await controlCall(dataDir, 'pair.start');
  const link = v.pairing.offer.link;
  console.log(await QRCode.toString(link, { type: 'terminal', small: true }));
  console.log(`用手机相机扫码，或在手机浏览器打开：\n${link}\n`);
  console.log(`二维码 10 分钟内有效，只能配对一台设备。中继：${v.relay === 'online' ? '已连接' : v.relay}。等待手机…（Ctrl-C 取消）`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.on('SIGINT', async () => { await controlCall(dataDir, 'pair.cancel').catch(() => {}); rl.close(); process.exit(130); });
  const known = new Set(v.devices.map((d) => d.id));
  for (;;) {
    v = await controlCall(dataDir, 'watch', { ms: 25_000 });
    const added = v.devices.find((d) => !known.has(d.id));
    if (added) { console.log(`\n✓ 已配对「${added.name}」。`); break; }
    if (v.pairing.request) {
      const { name, sas } = v.pairing.request;
      console.log(`\n「${name}」请求连接。手机上的核对码应为：${sas.slice(0, 3)} ${sas.slice(3)}`);
      const answer = (await rl.question('一致吗？允许连接 [y/N] ')).trim().toLowerCase();
      await controlCall(dataDir, 'pair.decide', { allow: answer === 'y' || answer === 'yes' });
      if (answer !== 'y' && answer !== 'yes') { console.log('已拒绝。'); break; }
      continue;
    }
    if (!v.pairing.offer) { console.log('\n二维码已过期。重新运行 herdr-relay pair。'); break; }
  }
  rl.close();
}

async function devices() {
  if (args[0] === 'rm' || args[0] === 'remove') {
    if (!args[1]) throw new Error('用法：herdr-relay devices rm <id 前几位>');
    await controlCall(dataDir, 'devices.remove', { id: args[1] });
    console.log('已移除。这台设备要重新扫码才能连接。');
    return;
  }
  const v = await controlCall(dataDir, 'status');
  if (!v.devices.length) { console.log('还没有配对的设备。运行 herdr-relay pair。'); return; }
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
const installDir = join(home, '.local', 'share', 'herdr-relay');
const binPath = join(home, '.local', 'bin', 'herdr-relay');
const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = join(home, 'Library', 'Logs', 'herdr-relay.log');
const uid = process.getuid();

function install() {
  const self = fileURLToPath(import.meta.url);
  if (!/\.mjs$/.test(self) || !readFileSync(self, 'utf8').includes('herdr-relay bundle')) {
    throw new Error('install 要从打包好的文件运行：npm run build && node dist/herdr-relay.mjs install');
  }
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  const target = join(installDir, 'herdr-relay.mjs');
  copyFileSync(self, target);
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`);
  chmodSync(binPath, 0o755);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${target}</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>HERDR_RELAY_URL</key><string>${process.env.HERDR_RELAY_URL ?? DEFAULT_RELAY}</string></dict>
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
  console.log(`已安装：\n  程序   ${target}\n  命令   ${binPath}\n  自启动 ${plistPath}\n  日志   ${logPath}\n\n下一步：herdr-relay pair`);
}

function uninstall() {
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
  for (const p of [plistPath, binPath]) if (existsSync(p)) rmSync(p);
  rmSync(installDir, { recursive: true, force: true });
  console.log(`已停止并移除。密钥和已配对设备保留在 ${dataDir}（删除这个目录等于重置所有配对）。`);
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
    key = String(key ?? '').trim();
    if (!key) throw new Error('没有输入 Key');
    await saveKey(key);
    console.log('已存进钥匙串（herdr-relay.voice）。运行 herdr-relay voice test 试一次。');
    return;
  }
  if (sub === 'off') { await deleteKey(); console.log('已删除 API Key。手机上不再显示麦克风键（重开网页后生效）。'); return; }
  if (sub === 'test') {
    const key = await readKey();
    if (!key) throw new Error('还没有 Key：先运行 herdr-relay voice key');
    const text = args.slice(1).join(' ') || '帮我把 phones.js 里的重连逻辑改一下，然后跑一遍 npm test，失败了就告诉我';
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'herdr-voice-test-'));
    try {
      execFileSync('/usr/bin/say', ['-v', 'Tingting', '-o', join(dir, 'a.aiff'), text]);
      const wav = await toWav(await readFile(join(dir, 'a.aiff')));
      console.log(`朗读：${text}`);
      // As on the phone: the built-in words, voice-words.txt, and the folder of the terminal (here: phones.js's).
      const { hints, spell } = await voiceWords(dataDir, null);
      spell.push('phones.js'); hints.push('phones.js');
      const r = await recognize(wav, { key, words: hints, spell });
      console.log(`识别：${r.text || '（空）'}\n用时：${r.ms} ms`);
    } finally { await rm(dir, { recursive: true, force: true }); }
    return;
  }
  const key = await readKey();
  console.log(key ? `语音输入：已开启（Key 末 4 位 …${key.slice(-4)}）` : '语音输入：未开启。运行 herdr-relay voice key');
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

const commands = { serve, pair, devices, status, install, uninstall, voice: voiceCmd };
if (!commands[cmd]) {
  console.log(HELP);
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
Promise.resolve(commands[cmd]()).catch((error) => { console.error(error.message); process.exit(1); });
