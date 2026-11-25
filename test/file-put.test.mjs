// General file upload (`file.put`) + filename sanitization + host whitelist check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhones, sanitizeUploadName } from '../host/phones.js';
import { newBoxKeys, phoneHandshake } from '../shared/e2e.js';

test('sanitizeUploadName strips path traversal, dotfiles, and unsafe chars while keeping valid extensions', () => {
  assert.equal(sanitizeUploadName('report.PDF'), 'report.pdf');
  assert.equal(sanitizeUploadName('产品方案 (终版).docx'), '产品方案-终版.docx');
  assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeUploadName('a\\b\\..\\secret.txt'), 'secret.txt');
  assert.equal(sanitizeUploadName('.env'), 'env');
  assert.equal(sanitizeUploadName('..env'), 'env');
  assert.equal(sanitizeUploadName('.env.local'), 'env.local');
  assert.equal(sanitizeUploadName('...'), 'file');
  assert.equal(sanitizeUploadName(''), 'file');
  assert.equal(sanitizeUploadName('../'), 'file');
  assert.equal(sanitizeUploadName('-rf.txt'), 'rf.txt');
  assert.equal(sanitizeUploadName('archive.tar.gz'), 'archive-tar.gz');
  assert.equal(sanitizeUploadName('bad\x00name.sh;rm'), 'badname-sh-rm');
});

test('file.put reassembles chunks, sanitizes filename, and forwards bytes to herdr-core terminal.put', async () => {
  const hostKeys = newBoxKeys();
  const phoneKeys = newBoxKeys();
  const device = { id: 'dev-up', name: 'Upload iPhone', pub: Buffer.from(phoneKeys.publicKey).toString('base64') };
  const putCalls = [];
  const sent = [];

  const phones = createPhones({
    state: {
      boxKeys: hostKeys,
      desktopName: 'UpMac',
      deviceByKey: (pub) => (pub === device.pub ? device : null),
      deviceById: () => device,
      updateDevice: async () => {},
    },
    pairing: { dropped() {} },
    push: { publicKey: '' },
    terminals: {
      core: () => ({
        call: async (method, params) => {
          putCalls.push({ method, params });
          return { path: `/tmp/herdr/t1/${params.name}`, bytes: Buffer.from(params.data, 'base64').length };
        },
      }),
      get: (addr) => (addr === 't1' ? { address: 't1', state: 'live', cols: 80, rows: 24 } : null),
      state: () => 'online',
      list: () => [],
      layout: () => [],
    },
    link: () => ({
      send: (_cid, frame) => sent.push(frame),
      close() {},
    }),
  });

  phones.open('c1');
  const hs = phoneHandshake(phoneKeys, hostKeys.publicKey);
  await phones.data('c1', hs.hello);
  const { cipher } = hs.finish(sent.shift());
  assert.equal(cipher.open(sent.shift()).type, 'ready');
  await phones.data('c1', cipher.seal({ type: 'auth', mode: 'resume' }));

  const payload = Buffer.from('hello pdf bytes 1234567890');
  const half = 10;
  await phones.data('c1', cipher.seal({
    id: 1, m: 'upload.put',
    p: { id: null, offset: 0, total: payload.length, mime: 'application/pdf', data: payload.subarray(0, half).toString('base64') },
  }));
  const r1 = cipher.open(sent.pop());
  assert.equal(r1.ok, true);
  const uploadId = r1.r.id;

  await phones.data('c1', cipher.seal({
    id: 2, m: 'upload.put',
    p: { id: uploadId, offset: half, total: payload.length, mime: 'application/pdf', data: payload.subarray(half).toString('base64') },
  }));
  assert.equal(cipher.open(sent.pop()).ok, true);

  await phones.data('c1', cipher.seal({
    id: 3, m: 'file.put',
    p: { id: uploadId, address: 't1', name: '../../季度 报告.PDF' },
  }));
  const r3 = cipher.open(sent.pop());
  assert.equal(r3.ok, true);
  assert.equal(r3.r.path, '/tmp/herdr/t1/季度-报告.pdf');
  assert.equal(r3.r.bytes, payload.length);
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].method, 'terminal.put');
  assert.equal(Buffer.from(putCalls[0].params.data, 'base64').toString('utf8'), payload.toString('utf8'));
});
