/**
 * Voice input: the phone records, the audio comes over the E2E channel in chunks, the Mac turns it
 * into text with Volcengine 豆包语音「录音文件识别 2.0 标准版」(submit, then poll query).
 *
 * The API key lives in the macOS keychain (service herdr-relay.voice). It never reaches the phone,
 * the relay, state.json or the log. HERDR_RELAY_VOLC_KEY overrides it (tests).
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEYCHAIN = { service: 'herdr-relay.voice', account: 'volcengine' };
const API = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel';
export const RESOURCE = process.env.HERDR_RELAY_VOLC_RESOURCE ?? 'volc.seedasr.auc'; // 2.0 标准版
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_SECONDS = 120;
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];

const run = (bin, args, input) => new Promise((resolve, reject) => {
  const child = execFile(bin, args, { maxBuffer: 16 << 20, encoding: 'buffer' }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stderr: stderr?.toString() })); else resolve(stdout);
  });
  if (input !== undefined) child.stdin.end(input);
});

// ------------------------------------------------------------------ key ---------
export async function readKey() {
  if (process.env.HERDR_RELAY_VOLC_KEY) return process.env.HERDR_RELAY_VOLC_KEY;
  try {
    const out = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w']);
    return out.toString().trim() || null;
  } catch { return null; }
}
export async function saveKey(key) {
  // -U updates an existing item. The key is on security's argv for the few ms it runs.
  await run('/usr/bin/security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-l', 'herdr-relay 火山语音识别', '-w', key]);
}
export async function deleteKey() {
  await run('/usr/bin/security', ['delete-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account]).catch(() => {});
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
  if (!key) throw Object.assign(new Error('还没配置语音识别的 API Key：在 Mac 上运行 herdr-relay voice key'), { kind: 'no_key' });
  const id = randomUUID();
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': RESOURCE, 'X-Api-Request-Id': id };
  const started = Date.now();
  const body = {
    user: { uid: 'herdr-relay' },
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

