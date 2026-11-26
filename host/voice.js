/**
 * Voice input: the phone records, the audio comes over the E2E channel in chunks, the Mac turns it
 * into text via `gemini-api transcribe` (default model: gemini-3.5-transcribe).
 *
 * The Gemini API key lives in the macOS keychain (service wayne-herdr-mods.voice, account gemini)
 * and is passed to `gemini-api` through GEMINI_API_KEY in env (never CLI args). It never reaches
 * the phone, the relay, state.json or the log. WAYNE_HERDR_MODS_GEMINI_KEY overrides it (tests).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const KEYCHAIN = { service: 'wayne-herdr-mods.voice', account: 'gemini' };
export const MODEL = process.env.WAYNE_HERDR_MODS_GEMINI_MODEL ?? 'gemini-3.5-transcribe';
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_SECONDS = 120;
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
const GEMINI_BINS = () => [
  process.env.WAYNE_HERDR_MODS_GEMINI_BIN,
  join(homedir(), '.local', 'bin', 'gemini-api'),
  '/opt/homebrew/bin/gemini-api',
  '/usr/local/bin/gemini-api',
  'gemini-api',
].filter(Boolean);

// A failure names the tool and what it said, never its arguments: Node's own error carries the whole
// command line (`Command failed: …`, `cmd`, `spawnargs`), and arguments can hold a key or a sentence.
export const run = (bin, args, input, opts = {}) => new Promise((resolve, reject) => {
  const child = execFile(bin, args, { maxBuffer: 16 << 20, encoding: 'buffer', ...opts }, (error, stdout, stderr) => {
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
  if (process.env.WAYNE_HERDR_MODS_GEMINI_KEY) return process.env.WAYNE_HERDR_MODS_GEMINI_KEY;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const out = await run('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w']);
    return out.toString().trim() || null;
  } catch { return null; }
}
/** An API key: printable ASCII, no spaces (it goes to `security` as one line). */
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
  await run('/usr/bin/security', ['add-generic-password', '-U', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-l', 'wayne-herdr-mods Gemini 语音识别', '-w'], `${key}\n${key}\n`);
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
  const dir = await mkdtemp(join(tmpdir(), 'herdr-voice-test-'));
  try {
    await run('/usr/bin/say', ['-v', 'Tingting', '-o', join(dir, 'a.aiff'), '--', text]);
    const wav = await toWav(await readFile(join(dir, 'a.aiff')));
    return await recognize(wav, { key, words, spell, ...(timeoutMs ? { timeoutMs } : {}) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ audio -------
async function findBin(candidates, probeArgs) {
  for (const bin of candidates) { try { await run(bin, probeArgs); return bin; } catch {} }
  return null;
}

/** Whatever the phone recorded (mp4/AAC on iOS, webm/Opus in Chrome) → 16 kHz mono 16-bit wav. */
export async function toWav(bytes, { ffmpeg } = {}) {
  const bin = ffmpeg ?? await findBin(FFMPEG, ['-version']);
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

// ------------------------------------------------------------------ Gemini CLI --
/**
 * One recognition via `gemini-api transcribe`. Returns { text, ms }.
 * `geminiBin` and `runImpl` are injection points for unit tests.
 */
export async function recognize(wav, { key, words = [], spell = words, model = MODEL, geminiBin, runImpl = run, timeoutMs = 60_000 } = {}) {
  if (!key) throw Object.assign(new Error('还没配置语音识别的 Gemini API Key：在 Mac 上运行 wayne-herdr-mods voice key'), { kind: 'no_key' });
  const bin = geminiBin ?? await findBin(GEMINI_BINS(), ['version']);
  if (!bin) throw Object.assign(new Error('Mac 上没有 gemini-api（安装：curl -fsSL https://raw.githubusercontent.com/google-gemini/gemini-api-cli/main/scripts/install.sh | bash）'), { kind: 'no_bin' });
  const dir = await mkdtemp(join(tmpdir(), 'herdr-voice-gemini-'));
  const started = Date.now();
  try {
    const src = join(dir, 'in.wav');
    const out = join(dir, 'out.txt');
    await writeFile(src, wav);
    const args = [
      'transcribe',
      '-i', src,
      '--format', 'text',
      '--no-speakers',
      '--no-timestamps',
      '--out', out,
      '--no-interactive',
      '--timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
      ...(model ? ['-m', model] : []),
    ];
    try {
      await runImpl(bin, args, undefined, {
        env: { ...process.env, GEMINI_API_KEY: key, GEMINI_NO_KEYRING: '1' },
        timeout: timeoutMs + 5_000,
      });
    } catch (error) {
      const msg = error.stderr || error.message || '';
      const auth = error.code === 3 || /401|403|api[_ ]?key|unauthenticated|permission|quota|auth/i.test(msg);
      throw Object.assign(
        new Error(auth ? `Gemini API Key 无效或权限/额度不足：${msg.slice(0, 200)}` : `语音识别失败：${msg.slice(0, 200) || error.message}`),
        { kind: auth ? 'auth' : 'asr', code: error.code },
      );
    }
    const raw = (await readFile(out, 'utf8')).trim();
    return { text: raw ? fixWords(raw, spell) : '', ms: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
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
