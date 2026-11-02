import test from 'node:test';
import assert from 'node:assert/strict';
import { fixWords, recognize } from '../host/voice.js';
import { createUploads, MAX_UPLOAD_BYTES } from '../host/uploads.js';

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
