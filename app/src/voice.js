/**
 * Hold-to-talk recorder. The phone only records; the Mac recognizes (DESIGN.md「语音输入」).
 * iOS Safari records audio/mp4 (AAC), Chrome audio/webm (Opus); the Mac converts either.
 */
import { b64 } from '../../shared/e2e.js';

export const MAX_MS = 120_000;
const CHUNK = 48 * 1024;

export const voiceSupported = () => typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

function pickMime() {
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return '';
}

/** Start recording. Returns { stop(): Promise<Blob>, cancel(), level(): 0..1 }. */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : undefined);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
  let analyser;
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(analyser);
  } catch {}
  const buf = new Uint8Array(128);
  const release = () => { stream.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); };
  const done = new Promise((resolve) => { rec.onstop = () => { release(); resolve(new Blob(parts, { type: rec.mimeType || mime || 'audio/mp4' })); }; });
  rec.start(250);
  const started = Date.now();
  return {
    started,
    stop() { if (rec.state !== 'inactive') rec.stop(); return done; },
    cancel() { parts.length = 0; if (rec.state !== 'inactive') rec.stop(); },
    level() {
      if (!analyser) return 0.3;
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 64);
    },
  };
}

/** Send a blob to the Mac in chunks over the E2E link. Returns the upload id. */
export async function upload(link, blob, onProgress = () => {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let id = null;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const r = await link.rpc('upload.put', { id, offset, total: bytes.length, mime: blob.type, data: b64(bytes.subarray(offset, offset + CHUNK)) });
    id = r.id;
    onProgress(r.received / bytes.length);
  }
  return id;
}

/** Upload, then ask the Mac to recognize. Returns { text, ms }. */
export async function transcribe(link, blob, { address } = {}) {
  return link.rpc('voice.done', { id: await upload(link, blob), address }, 70_000);
}

/** A picked photo → JPEG at most `max` px on the long side (screenshots stay PNG when small). */
export async function shrinkImage(file, max = 2048) {
  if (file.type === 'image/png' && file.size < 1.5e6) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.85));
}
