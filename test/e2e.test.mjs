import test from 'node:test';
import assert from 'node:assert/strict';
import { newBoxKeys, newSignKeys, phoneHandshake, desktopAccept, desktopIdFor, encodePairLink, decodePairLink, relayAuthQuery, b64 } from '../shared/e2e.js';
import { createPhones } from '../host/phones.js';

test('handshake agrees, encrypts both ways, rejects replay', () => {
  const D = newBoxKeys(), P = newBoxKeys();
  const phone = phoneHandshake(P, D.publicKey);
  const desk = desktopAccept(D, phone.hello);
  const { cipher: pc, sas } = phone.finish(desk.welcome);
  assert.equal(sas, desk.sas);
  const f1 = pc.seal({ hi: 1 });
  assert.deepEqual(desk.cipher.open(f1), { hi: 1 });
  assert.throws(() => desk.cipher.open(f1), /decryption failed/);
  assert.deepEqual(pc.open(desk.cipher.seal({ ok: 'yes' })), { ok: 'yes' });
});

test('wrong desktop key (relay MITM) cannot finish', () => {
  const D = newBoxKeys(), fake = newBoxKeys(), P = newBoxKeys();
  const phone = phoneHandshake(P, D.publicKey);
  const mitm = desktopAccept(fake, phone.hello);
  const { cipher } = phone.finish(mitm.welcome);
  assert.throws(() => mitm.cipher.open(cipher.seal({ x: 1 })), /decryption failed/);
});

test('low-order public keys are rejected (all-zero shared secret attack)', () => {
  const D = newBoxKeys(), P = newBoxKeys();
  const zero = b64(new Uint8Array(32));
  // A phone that sends all-zero P and Ep: every DH result is zero, so the attacker can
  // recompute the "shared" key from public fields alone. Must be refused on the desktop.
  const badHello = JSON.stringify({ type: 'hello', v: 1, p: zero, e: zero });
  assert.throws(() => desktopAccept(D, badHello), /low-order/);
  // And on the phone: a malicious "desktop" sending an all-zero ephemeral in welcome.
  const phone = phoneHandshake(P, D.publicKey);
  const badWelcome = JSON.stringify({ type: 'welcome', v: 1, e: zero });
  assert.throws(() => phone.finish(badWelcome), /low-order/);
});

test('pair link roundtrip and desktop id', async () => {
  const S = newSignKeys();
  const id = await desktopIdFor(S.publicKey);
  assert.equal(id.length, 22);
  const link = encodePairLink('https://relay.example.com', { v: 1, r: 'wss://relay.example.com', i: id, k: 'abc', t: 'tok', n: 'Mac' });
  assert.equal(decodePairLink(link).i, id);
  assert.match(relayAuthQuery(id, S), /^pub=.+&ts=\d+&sig=.+$/);
});

test('phone hub tolerates stale pre-handshake frames and re-handshake on same cid without bad-frame kick', async () => {
  const D = newBoxKeys(), P = newBoxKeys();
  const device = { id: 'dev1', name: 'iPhone', pub: b64(P.publicKey) };
  const sent = [];
  const closed = [];
  const phones = createPhones({
    state: {
      boxKeys: D,
      desktopName: 'Mac',
      deviceByKey: (pub) => (pub === device.pub ? device : null),
      updateDevice: async () => {},
    },
    pairing: { dropped: () => {} },
    push: { publicKey: 'vapid' },
    terminals: { list: async () => ({ core: 'online', terminals: [], spaces: [] }) },
    link: () => ({
      send: (cid, text) => sent.push({ cid, text }),
      close: (cid, code) => closed.push({ cid, code }),
    }),
  });

  phones.open('c1');
  // 1) A stale encrypted frame from the previous session arrives before the new hello: must be ignored, not kick.
  await phones.data('c1', 'E_stale_frame_from_previous_cipher');
  assert.equal(sent.length, 0);

  // 2) Normal hello + auth brings the peer to ready.
  const hs1 = phoneHandshake(P, D.publicKey);
  await phones.data('c1', hs1.hello);
  assert.equal(sent.length, 2); // welcome + early ready
  const { cipher: c1 } = hs1.finish(sent[0].text);
  assert.equal(c1.open(sent[1].text).type, 'ready');
  await phones.data('c1', c1.seal({ type: 'auth', mode: 'resume' }));

  // 3) Phone receives `\u0000online` and starts a fresh hello on the same cid: must re-handshake, not kick with bad-frame.
  sent.length = 0;
  const hs2 = phoneHandshake(P, D.publicKey);
  await phones.data('c1', hs2.hello);
  assert.equal(sent.length, 2);
  const { cipher: c2 } = hs2.finish(sent[0].text);
  assert.equal(c2.open(sent[1].text).type, 'ready');
  assert.equal(closed.length, 0);
});
