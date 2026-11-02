// Direct links (host/rtc-link.js), with werift as the phone too: offer → answer → channel → pieces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection } from 'werift';
import { createRtcLink } from '../host/rtc-link.js';
import { joiner, pieces, PIECE } from '../shared/pieces.js';

test('pieces: long messages split under 16 KB and join again; short ones stay whole', () => {
  assert.deepEqual(pieces('abc'), ['abc']);
  const long = 'x'.repeat(PIECE * 2 + 5);
  const parts = pieces(long);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= PIECE + 1));
  const join = joiner();
  assert.deepEqual(parts.map(join), [null, null, long]);
  assert.equal(join('next'), 'next');
  assert.throws(() => { const j = joiner(10); j('\u0001'.concat('y'.repeat(20))); });
});

const until = async (fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
};

test('a phone offer opens a connection; messages both ways, in pieces; ping is answered; closing tells', async () => {
  const seen = [];
  const host = createRtcLink({
    iceServers: [], // this machine only: no STUN in a test
    onOpen: (cid) => seen.push(['open', cid]),
    onData: (cid, text) => { seen.push(['data', cid, text.length]); host.send(cid, `echo:${text}`); },
    onClose: (cid) => seen.push(['close', cid]),
  });
  const phone = new RTCPeerConnection({ iceServers: [] });
  const dc = phone.createDataChannel('herdr');
  const got = [];
  const join = joiner();
  dc.onMessage.subscribe((m) => { const w = join(String(m)); if (w !== null) got.push(w); });
  await phone.setLocalDescription(await phone.createOffer());
  await until(() => phone.iceGatheringState === 'complete');
  await assert.rejects(host.answer('not sdp'));
  const { sdp } = await host.answer(phone.localDescription.sdp);
  assert.match(sdp, /a=candidate:/);
  await phone.setRemoteDescription({ type: 'answer', sdp });
  await until(() => dc.readyState === 'open' && seen.some(([k]) => k === 'open'));
  const cid = seen.find(([k]) => k === 'open')[1];
  assert.match(cid, /^rtc:\d+$/);
  assert.equal(host.count(), 1);

  dc.send('ping');
  await until(() => got.includes('pong'));
  const big = 'z'.repeat(100_000);
  for (const p of pieces(big)) dc.send(p);
  await until(() => got.some((g) => g.length === big.length + 5));
  assert.deepEqual(seen.filter(([k]) => k === 'data').map(([, , n]) => n), [100_000]); // whole, once; ping never reached the phones

  host.close(cid);
  assert.deepEqual(seen.at(-1), ['close', cid]);
  assert.equal(host.count(), 0);
  host.send(cid, 'after close'); // ignored
  host.dispose();
  await phone.close();
});
