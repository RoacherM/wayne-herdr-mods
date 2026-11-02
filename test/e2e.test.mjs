import test from 'node:test';
import assert from 'node:assert/strict';
import { newBoxKeys, newSignKeys, phoneHandshake, desktopAccept, desktopIdFor, encodePairLink, decodePairLink, relayAuthQuery, b64 } from '../shared/e2e.js';

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
