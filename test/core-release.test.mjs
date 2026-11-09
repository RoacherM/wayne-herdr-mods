// Core.release() tells the core even for channels never `on()`'d (attach still in flight):
// the viewer must not stay in herdr-core. Late frames for a released channel are dropped
// until the id is free again (its CLOSE, or a channel-0 reply reusing the id).
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CLOSE, Core, DATA, encode } from '../host/hc.js';

async function fakeCore() {
  const inbound = new PassThrough(); // we (the "core") write → client reads
  const outbound = new PassThrough(); // client writes → we read
  const core = new Core({ readable: inbound, writable: outbound });
  const sent = []; // decoded frames the client sent us, after the hello line
  let helloSeen = false;
  let rest = Buffer.alloc(0);
  outbound.on('data', (d) => {
    if (!helloSeen) {
      const nl = d.indexOf(10);
      helloSeen = true;
      inbound.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ok: true } }) + '\n');
      rest = d.subarray(nl + 1);
    } else rest = Buffer.concat([rest, d]);
    while (rest.length >= 9) {
      const len = rest.readUInt32LE(5);
      if (rest.length < 9 + len) break;
      sent.push({ channel: rest.readUInt32LE(0), kind: rest[4], payload: rest.subarray(9, 9 + len) });
      rest = rest.subarray(9 + len);
    }
  });
  await core.ready;
  const closeFor = (channel) => inbound.write(encode(channel, CLOSE, JSON.stringify({ reason: 'gone' })));
  const dataFor = (channel, text = 'x') => inbound.write(encode(channel, DATA, Buffer.from(text)));
  const rpcReply = (id, result) => inbound.write(encode(0, DATA, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))));
  const closes = () => sent.filter((f) => f.kind === CLOSE);
  return { core, sent, closes, closeFor, dataFor, rpcReply };
}

test('release of a channel never `on()`d sends CLOSE and keeps nothing in early', async () => {
  const { core, closes } = await fakeCore();
  core.release(7);
  assert.equal(closes().length, 1);
  assert.equal(closes()[0].channel, 7);
  assert.equal(core.early.size, 0);
});

test('late DATA for a released channel is dropped, not parked in early', async () => {
  const { core, dataFor } = await fakeCore();
  core.release(7);
  dataFor(7);
  assert.equal(core.early.size, 0);
});

test('a core CLOSE for a released channel frees the id', async () => {
  const { core, dataFor, closeFor } = await fakeCore();
  core.release(7);
  closeFor(7);
  assert.ok(!core.released.has(7));
  dataFor(7);
  assert.equal(core.early.get(7)?.length, 1); // id is free again: frames behave as usual
});

test('an RPC reply naming a released channel frees the id before its frames', async () => {
  const { core, sent, dataFor, rpcReply } = await fakeCore();
  core.release(7);
  const call = core.call('events.subscribe', {});
  const id = JSON.parse(sent.find((f) => f.channel === 0).payload.toString()).id;
  rpcReply(id, { channel: 7 });
  await call;
  assert.ok(!core.released.has(7));
  dataFor(7);
  assert.equal(core.early.get(7)?.length, 1);
});

test('release when early already holds the core CLOSE sends nothing', async () => {
  const { core, closes, closeFor } = await fakeCore();
  closeFor(9); // core closed it before our attach reply arrived: the CLOSE sits in early
  assert.equal(core.early.get(9)?.[0]?.[0], CLOSE);
  core.release(9);
  assert.equal(closes().length, 0);
  assert.equal(core.early.size, 0);
});

test('release of a registered channel sends one CLOSE and drops late frames', async () => {
  const { core, closes, dataFor } = await fakeCore();
  const seen = [];
  core.on(5, { onData: (p) => seen.push(p.toString()) });
  dataFor(5, 'before');
  core.release(5);
  dataFor(5, 'after');
  assert.deepEqual(seen, ['before']);
  assert.equal(closes().filter((f) => f.channel === 5).length, 1);
  assert.equal(core.early.size, 0);
});

test('an RPC reply with a null result clears nothing and breaks nothing', async () => {
  const { core, sent, rpcReply } = await fakeCore();
  core.release(7);
  const call = core.call('doc.get', { name: 'x' });
  const id = JSON.parse(sent.find((f) => f.channel === 0).payload.toString()).id;
  rpcReply(id, null);
  await call;
  assert.ok(core.released.has(7), 'no channel named: the id stays released');
  assert.ok(!core.closed);
});
