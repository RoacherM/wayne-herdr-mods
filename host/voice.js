/**
 * Voice input: the phone records, the audio comes over the E2E channel in chunks, the Mac turns it
 * into text with Volcengine 豆包语音「录音文件识别 2.0 标准版」(submit, then poll query).
 *
 * The API key lives in the macOS keychain (service wayne-herdr-mods.voice). It never reaches the phone,
 * the relay, state.json or the log. WAYNE_HERDR_MODS_VOLC_KEY overrides it (tests).
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KEYCHAIN = { service: 'wayne-herdr-mods.voice', account: 'volcengine' };
const API = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel';
export const RESOURCE = process.env.WAYNE_HERDR_MODS_VOLC_RESOURCE ?? 'volc.seedasr.auc'; // 2.0 标准版
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_SECONDS = 120;
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];

// A failure names the tool and what it said, never its arguments: Node's own error carries the whole
// command line (`Command failed: …`, `cmd`, `spawnargs`), and arguments can hold a key or a sentence.
export const run = (bin, args, input) => new Promise((resolve, reject) => {
  const child = execFile(bin, args, { maxBuffer: 16 << 20, encoding: 'buffer' }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const said = stderr?.toString().trim() ?? '';
    const name = bin.split('/').pop();
    const why = error.code === 'ENOENT' ? '没有这个程序' : typeof error.code === 'number' ? `退出码 ${error.code}` : String(error.code ?? error.signal ?? '');
    reject(Object.assign(new Error(`${name} 失败（${why}）${said ? `：${said.slice(0, 300)}` : ''}`), { code: error.code, stderr: said }));
  });
  if (input !== undefined) child.stdin.end(input);
});

// ------------------------------------------------------------------ key ---------
export async function readKey() {
  if (process.env.WAYNE_HERDR_MODS_VOLC_KEY) return process.env.WAYNE_HERDR_MODS_VOLC_KEY;
  try {
    const out = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w']);
    return out.toString().trim() || null;
  } catch { return null; }
}
/** A key as Volcengine gives it: printable ASCII, no spaces (it goes to `security` as one line). */
export function checkKey(key) {
  key = String(key ?? '').trim();
  if (!key) throw new Error('没有输入 Key');
  if (!/^[\x21-\x7e]+$/.test(key)) throw new Error('Key 里有空格或别的字符，检查一下是不是复制多了');
  return key;
}
export async function saveKey(key) {
  key = checkKey(key);
  // -U updates an existing item. A bare -w last makes security ask for the password, twice, on stdin
  // (macOS 27.0, 2026-11-06), so the key is never on its argv, where `ps` would show it.
  await run('/usr/bin/security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-l', 'wayne-herdr-mods 火山语音识别', '-w'], `${key}\n${key}\n`);
}
export async function deleteKey() {
  await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account]).catch(() => {});
}

/** The key store the service uses; tests pass their own, so they never touch the keychain. */
export const KEYCHAIN_KEYS = { read: readKey, save: saveKey, remove: deleteKey };
/** What a screen may show of a key: its last 4 characters. */
export const keyTail = (key) => (!key ? null : key.length > 8 ? `…${key.slice(-4)}` : '…');

/** One try of the whole path: the Mac reads `text` aloud (`say`), and the recognizer writes it back. */
export async function sayAndRecognize(text, { key, words = [], spell = words, timeoutMs } = {}) {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'herdr-voice-test-'));
  try {
    await run('/usr/bin/say', ['-v', 'Tingting', '-o', join(dir, 'a.aiff'), '--', text]);
    const wav = await toWav(await readFile(join(dir, 'a.aiff')));
    return await recognize(wav, { key, words, spell, ...(timeoutMs ? { timeoutMs } : {}) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ audio -------
async function ffmpegBin() {
  for (const bin of FFMPEG) { try { await run(bin, ['-version']); return bin; } catch {} }
  return null;
}

/** Whatever the phone recorded (mp4/AAC on iOS, webm/Opus in Chrome) → 16 kHz mono 16-bit wav. */
export async function toWav(bytes, { ffmpeg } = {}) {
  const bin = ffmpeg ?? await ffmpegBin();
  if (!bin) throw new Error('Mac 上没有 ffmpeg（brew install ffmpeg）');
  const dir = await mkdtemp(join(tmpdir(), 'herdr-voice-'));
  try {
    const src = join(dir, 'in');
    const dst = join(dir, 'out.wav');
    await writeFile(src, bytes);
    await run(bin, ['-loglevel', 'error', '-y', '-i', src, '-t', String(MAX_SECONDS), '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', dst]);
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ Volcengine --
const hotwords = (words) => (words?.length ? { corpus: { context: JSON.stringify({ hotwords: words.slice(0, 200).map((word) => ({ word })) }) } } : {});

/**
 * One recognition. Returns { text, ms }. `fetchImpl` and `sleep` are for tests.
 * The audio goes inline as base64 (audio.data); `url` is the documented field, `data` is what the
 * flash API takes and what we try first.
 */
export async function recognize(wav, { key, words = [], spell = words, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 60_000 } = {}) {
  if (!key) throw Object.assign(new Error('还没配置语音识别的 API Key：在 Mac 上运行 wayne-herdr-mods voice key'), { kind: 'no_key' });
  const id = randomUUID();
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': RESOURCE, 'X-Api-Request-Id': id };
  const started = Date.now();
  const body = {
    user: { uid: 'wayne-herdr-mods' },
    audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1, data: Buffer.from(wav).toString('base64') },
    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, ...hotwords(words) },
  };
  const submit = await fetchImpl(`${API}/submit`, { method: 'POST', headers: { ...headers, 'X-Api-Sequence': '-1' }, body: JSON.stringify(body) });
  check(submit, await submit.text(), 'submit');
  for (let wait = 300; ; wait = Math.min(wait * 1.5, 1500)) {
    if (Date.now() - started > timeoutMs) throw new Error('语音识别超时');
    await sleep(wait);
    const q = await fetchImpl(`${API}/query`, { method: 'POST', headers, body: '{}' });
    const text = await q.text();
    const code = q.headers.get('x-api-status-code');
    if (code === '20000001' || code === '20000002') continue; // processing / queued
    if (code === '20000003') return { text: '', ms: Date.now() - started };
    check(q, text, 'query');
    const json = JSON.parse(text);
    return { text: fixWords((json.result?.text ?? '').trim(), spell), ms: Date.now() - started };
  }
}

/**
 * Put hotwords back in their own spelling: the recognizer hears them but writes "NPM Test" for
 * "npm test" and "phones js" for "phones.js". Only ASCII words, matched whole, ignoring case, and
 * letting a space stand for the word's own . - _ /.
 */
export function fixWords(text, words = []) {
  const list = [...new Set(words)].filter((w) => /^[\x21-\x7e ]{2,40}$/.test(w)).sort((a, b) => b.length - a.length);
  for (const word of list) {
    const pattern = word.split('').map((c) => (/[.\-_/]/.test(c) ? `[${c === '-' ? '\\-' : c} ]?` : /\s/.test(c) ? '\\s+' : c.replace(/[\\^$*+?()[\]{}|]/g, '\\$&'))).join('');
    text = text.replace(new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'gi'), word);
  }
  return text;
}

function check(res, text, step) {
  const code = res.headers.get('x-api-status-code');
  if (res.ok && (code === '20000000' || code === null)) return;
  const message = res.headers.get('x-api-message') ?? text.slice(0, 200);
  const known = { 45000001: '请求参数不对', 45000002: '录音是空的', 45000151: '音频格式不对', 55000031: '识别服务忙' };
  const auth = res.status === 401 || res.status === 403 || /auth|key|permission|grant/i.test(message);
  throw Object.assign(new Error(`语音识别失败（${step} ${res.status} ${code ?? ''}）：${known[code] ?? (auth ? 'API Key 无效或没开通这个服务' : message)}`), {
    kind: auth ? 'auth' : 'asr', code, logid: res.headers.get('x-tt-logid'), detail: message,
  });
}

