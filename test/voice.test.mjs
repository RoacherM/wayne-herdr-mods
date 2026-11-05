import test from 'node:test';
import assert from 'node:assert/strict';
import { fixWords, recognize } from '../host/voice.js';
import { createUploads, MAX_UPLOAD_BYTES } from '../host/uploads.js';
import { startRecording } from '../app/src/voice.js';

const res = (status, code, body = '{}', extra = {}) => new Response(body, { status, headers: { 'x-api-status-code': code, 'x-tt-logid': 'L1', ...extra } });

test('submit then poll until done; key and hotwords in the request', async () => {
  const calls = [];
  const replies = [res(200, '20000000'), res(200, '20000001'), res(200, '20000002'), res(200, '20000000', JSON.stringify({ result: { text: ' 跑一遍 npm test ' } }))];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return replies.shift(); };
  const r = await recognize(Buffer.from('RIFF'), { key: 'K', words: ['npm', 'phones.js'], fetchImpl, sleep: async () => {} });
  assert.equal(r.text, '跑一遍 npm test');
  assert.match(calls[0].url, /\/submit$/);
  assert.equal(calls[0].init.headers['X-Api-Key'], 'K');
  assert.equal(calls[0].init.headers['X-Api-Resource-Id'], 'volc.seedasr.auc');
  assert.equal(calls[0].init.headers['X-Api-Sequence'], '-1');
  const ids = new Set(calls.map((c) => c.init.headers['X-Api-Request-Id']));
  assert.equal(ids.size, 1, 'submit and every query share one request id');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.audio.format, 'wav');
  assert.equal(body.audio.data, Buffer.from('RIFF').toString('base64'));
  assert.deepEqual(JSON.parse(body.request.corpus.context), { hotwords: [{ word: 'npm' }, { word: 'phones.js' }] });
  assert.equal(calls.length, 4);
});

test('silence is empty text; errors name the cause', async () => {
  const silent = [res(200, '20000000'), res(200, '20000003')];
  assert.equal((await recognize(Buffer.alloc(4), { key: 'K', fetchImpl: async () => silent.shift(), sleep: async () => {} })).text, '');
  await assert.rejects(recognize(Buffer.alloc(4), { key: 'K', fetchImpl: async () => res(401, '45000010', '', { 'x-api-message': 'invalid auth' }), sleep: async () => {} }), (e) => e.kind === 'auth' && /API Key/.test(e.message));
  await assert.rejects(recognize(Buffer.alloc(4), { key: null }), (e) => e.kind === 'no_key');
});

test('uploads reassemble in order, once, within size', () => {
  const u = createUploads();
  const data = Buffer.from('0123456789');
  let r = u.put({ id: null, offset: 0, total: 10, mime: 'audio/mp4', data: data.subarray(0, 4).toString('base64') });
  assert.throws(() => u.put({ id: r.id, offset: 8, total: 10, data: 'AA==' }), /顺序/);
  r = u.put({ id: r.id, offset: 4, total: 10, data: data.subarray(4).toString('base64') });
  assert.equal(r.received, 10);
  assert.deepEqual(u.take(r.id).bytes, data);
  assert.throws(() => u.take(r.id), /过期/);
  assert.throws(() => u.put({ id: null, offset: 0, total: MAX_UPLOAD_BYTES + 1, data: '' }), /太大/);
});

test('hotwords come back in their own spelling', () => {
  const words = ['npm', 'test', 'phones.js', 'pull request', 'Claude', 'README'];
  assert.equal(fixWords('帮我把 phones js 里的重连逻辑改一下，然后跑一遍 NPM Test，失败了就告诉我。', words),
    '帮我把 phones.js 里的重连逻辑改一下，然后跑一遍 npm test，失败了就告诉我。');
  assert.equal(fixWords('看一下 Phones.JS 和 readme，提个 Pull  Request 给 claude', words), '看一下 phones.js 和 README，提个 pull request 给 Claude');
  assert.equal(fixWords('testing npmjs contest', words), 'testing npmjs contest', 'whole words only');
});

test('startRecording reuses one live MediaStream across recordings and windows without re-prompting', async () => {
  let gumCalls = 0;
  let currentTrack = null;
  globalThis.window = {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          assert.deepEqual(constraints, { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
          gumCalls++;
          currentTrack = { readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; } };
          return { getTracks: () => [currentTrack] };
        },
      },
    },
  });
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/mp4'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['abc']) });
      this.onstop?.();
    }
  };

  // First press (e.g. cancelled when permission alert dismissed): acquires stream and mutes on release
  const r1 = await startRecording();
  assert.equal(gumCalls, 1);
  assert.equal(currentTrack.enabled, true);
  r1.cancel();
  assert.equal(currentTrack.enabled, false, 'muted after cancel, not stopped');
  assert.equal(currentTrack.readyState, 'live');

  // Second press in a new terminal window: reuses the warm stream without calling getUserMedia again
  const r2 = await startRecording();
  assert.equal(gumCalls, 1, 'must not call getUserMedia a second time while stream is live');
  assert.equal(currentTrack.enabled, true);
  const blob = await r2.stop();
  assert.equal(blob.size, 3);
  assert.equal(currentTrack.enabled, false, 'muted after stop');

  // If the OS ends the track (e.g. backgrounded), the next recording acquires a fresh stream
  currentTrack.readyState = 'ended';
  const r3 = await startRecording();
  assert.equal(gumCalls, 2);
  r3.cancel();
});

test('a muted stream (back from the background) is not reused; an empty recording is never uploaded', async () => {
  let gumCalls = 0, track = null;
  globalThis.window = {};
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { gumCalls++; track = { readyState: 'live', muted: false, enabled: true, stop() { this.readyState = 'ended'; } }; return { getTracks: () => [track] }; } } },
  });
  let give = 'abc'; // what the next recorder hands back
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/mp4'; track = stream.getTracks()[0]; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (give) this.ondataavailable?.({ data: new Blob([give]) }); this.onstop?.(); }
  };
  const { transcribe, NO_SOUND } = await import('../app/src/voice.js');

  const r1 = await startRecording();
  const calls0 = gumCalls;
  assert.equal((await r1.stop()).size, 3);

  // iOS interrupted the capture in the background: still `live`, but muted
  const old = track;
  old.muted = true;
  const r2 = await startRecording();
  assert.equal(gumCalls, calls0 + 1, 'a muted stream is replaced');
  assert.equal(old.readyState, 'ended', 'the muted one is let go');
  assert.equal(r2.muted, false);
  await r2.stop();

  // A recorder that gave nothing: no upload (it read as「上传已过期」), and the stream is not reused
  give = '';
  const r3 = await startRecording();
  const empty = await r3.stop();
  assert.equal(empty.size, 0);
  const rpcs = [];
  await assert.rejects(transcribe({ rpc: async (m) => { rpcs.push(m); return {}; } }, empty), (e) => e.message === NO_SOUND);
  assert.deepEqual(rpcs, []);
  give = 'abc';
  const before = gumCalls;
  (await startRecording()).cancel();
  assert.equal(gumCalls, before + 1, 'a new stream after an empty recording');
});
