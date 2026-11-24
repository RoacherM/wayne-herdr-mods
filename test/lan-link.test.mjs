// LAN direct WebSocket server (host/lan-link.js) + E2E auth through createPhones + RFC 6455 framing.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { createLanLink, decodeWsFrame, encodeWsFrame, lanAddresses } from '../host/lan-link.js';
import { createPhones } from '../host/phones.js';
import { newBoxKeys, phoneHandshake } from '../shared/e2e.js';

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.q = [];
    ws.w = [];
    ws.onmessage = (m) => (ws.w.length ? ws.w.shift()(m.data) : ws.q.push(m.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
  });
}

const nextMsg = (ws, ms = 5000) => (
  ws.q.length
    ? Promise.resolve(ws.q.shift())
    : new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        ws.w.push((d) => { clearTimeout(t); resolve(d); });
      })
);

function maskClientFrame(payload, { opcode = 0x1, fin = true, mask = Buffer.from([1, 2, 3, 4]) } = {}) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length;
  let head;
  const b0 = (fin ? 0x80 : 0) | opcode;
  if (len < 126) {
    head = Buffer.from([b0, 0x80 | len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = b0;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = b0;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

test('lanAddresses picks usable private IPv4s, en0 first, skipping loopback and .0/.255', () => {
  const addrs = lanAddresses({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    bridge100: [{ address: '192.168.194.0', family: 'IPv4', internal: false }],
    utun3: [{ address: '10.0.0.2', family: 'IPv4', internal: false }],
    en5: [{ address: '169.254.10.20', family: 'IPv4', internal: false }],
    en1: [{ address: '172.20.10.4', family: 'IPv4', internal: false }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.139.3', family: 'IPv4', internal: false },
      { address: '192.168.139.255', family: 'IPv4', internal: false },
    ],
  });
  assert.deepEqual(addrs, ['192.168.139.3', '172.20.10.4', '10.0.0.2']);
});

test('decodeWsFrame enforces masking, length tiers, partial reads, and >4MiB limit', () => {
  const unmasked = encodeWsFrame('hello', 0x1);
  assert.deepEqual(decodeWsFrame(unmasked), { error: 'unmasked client frame' });
  assert.equal(decodeWsFrame(Buffer.from([0x81])), null);

  // Small (<126), medium (126 / 16-bit), large (127 / 64-bit) masked frames roundtrip cleanly
  for (const size of [5, 300, 70_000]) {
    const raw = 'a'.repeat(size);
    const frame = maskClientFrame(raw);
    assert.equal(decodeWsFrame(frame.subarray(0, frame.length - 1)), null);
    const decoded = decodeWsFrame(Buffer.concat([frame, Buffer.from('tail')]));
    assert.equal(decoded.fin, true);
    assert.equal(decoded.opcode, 0x1);
    assert.equal(decoded.payload.toString('utf8'), raw);
    assert.equal(decoded.rest.toString('utf8'), 'tail');
  }

  // > 4 MiB frame, reserved bits, bad opcode, and oversized control frame rejected right from header
  const hugeHead = Buffer.alloc(10);
  hugeHead[0] = 0x81;
  hugeHead[1] = 0x80 | 127;
  hugeHead.writeBigUInt64BE(BigInt(5 * 1024 * 1024), 2);
  assert.deepEqual(decodeWsFrame(hugeHead), { error: 'frame too large' });
  assert.deepEqual(decodeWsFrame(Buffer.from([0xc1, 0x80])), { error: 'reserved bits' });
  assert.deepEqual(decodeWsFrame(Buffer.from([0x83, 0x80])), { error: 'bad opcode' });
  assert.deepEqual(decodeWsFrame(Buffer.from([0x89, 0xfe, 0x00, 0x80])), { error: 'bad control frame' });
});

test('createLanLink serves full E2E auth, ping/pong, >70KB frames, rejects unknown devices, and protects authed peers', async (t) => {
  const hostKeys = newBoxKeys();
  const phoneKeys = newBoxKeys();
  const rogueKeys = newBoxKeys();
  const device = { id: 'dev-lan', name: 'LAN iPhone', pub: Buffer.from(phoneKeys.publicKey).toString('base64') };
  const bigMsg = 'X'.repeat(72 * 1024);

  let phones;
  const lan = await createLanLink({
    host: '127.0.0.1',
    port: 0,
    onOpen: (cid) => phones?.open(cid),
    onData: (cid, text) => { phones?.data(cid, text); },
    onClose: (cid) => phones?.close(cid),
    isAuthed: (cid) => phones?.isReady(cid) ?? false,
  });
  t.after(() => lan.dispose());

  phones = createPhones({
    state: {
      boxKeys: hostKeys,
      desktopName: 'LanMac',
      deviceByKey: (pub) => (pub === device.pub ? device : null),
      deviceById: () => device,
      updateDevice: async () => {},
    },
    pairing: { dropped() {} },
    push: { publicKey: '' },
    terminals: {
      core: () => null,
      get: () => null,
      state: () => 'online',
      list: () => [{ address: 't1', cols: 80, rows: 24, msg: bigMsg }],
      layout: () => [],
    },
    link: () => lan,
    lan,
  });

  const url = `ws://127.0.0.1:${lan.port}/v1/lan`;
  const ws = await wsOpen(url);
  t.after(() => ws.close());

  // Literal ping -> pong directly in lan-link
  ws.send('ping');
  assert.equal(await nextMsg(ws), 'pong');

  // Full E2E handshake + early ready (with `lan` endpoints) + auth + 72KB RPC payload
  const hs = phoneHandshake(phoneKeys, hostKeys.publicKey);
  ws.send(hs.hello);
  const { cipher } = hs.finish(await nextMsg(ws));
  const ready = cipher.open(await nextMsg(ws));
  assert.equal(ready.type, 'ready');
  assert.ok(Array.isArray(ready.lan));

  ws.send(cipher.seal({ type: 'auth', mode: 'resume' }));
  ws.send(cipher.seal({ id: 1, m: 'terminals.list', p: {} }));
  const reply = cipher.open(await nextMsg(ws));
  assert.equal(reply.id, 1);
  assert.equal(reply.ok, true);
  assert.equal(reply.r.terminals[0].msg.length, bigMsg.length);

  // Unknown device on LAN is kicked cleanly with unknown-device
  const rogue = await wsOpen(url);
  t.after(() => rogue.close());
  const rhs = phoneHandshake(rogueKeys, hostKeys.publicKey);
  rogue.send(rhs.hello);
  const { cipher: rc } = rhs.finish(await nextMsg(rogue));
  rogue.send(rc.seal({ type: 'auth', mode: 'resume' }));
  const errMsg = rc.open(await nextMsg(rogue));
  assert.equal(errMsg.type, 'error');
  assert.equal(errMsg.code, 'unknown-device');

  // Unauthenticated connection flood must never evict the authenticated phone
  const floods = [];
  for (let i = 0; i < 18; i++) floods.push(await wsOpen(url));
  t.after(() => { for (const f of floods) f.close(); });
  ws.send(cipher.seal({ id: 2, m: 'terminals.list', p: {} }));
  const stillAlive = cipher.open(await nextMsg(ws));
  assert.equal(stillAlive.id, 2);
  assert.equal(stillAlive.ok, true);

  // Non-upgrade HTTP request is rejected with 426
  const res = await fetch(`http://127.0.0.1:${lan.port}/v1/lan`);
  assert.equal(res.status, 426);

  // Wrong upgrade path is rejected with 400
  const rawStatus = await new Promise((resolve) => {
    const sock = net.connect(lan.port, '127.0.0.1', () => {
      sock.write('GET /wrong HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    sock.once('data', (d) => { sock.destroy(); resolve(d.toString().split('\r\n')[0]); });
  });
  assert.match(rawStatus, /400 Bad Request/);
});

test('createLanLink handles fragmented client messages and closes malformed control/interleaved frames', async (t) => {
  const received = [];
  const closed = [];
  const lan = await createLanLink({
    host: '127.0.0.1',
    port: 0,
    onOpen() {},
    onData: (cid, text) => received.push({ cid, text }),
    onClose: (cid) => closed.push(cid),
  });
  t.after(() => lan.dispose());

  const openRaw = () => new Promise((resolve) => {
    const sock = net.connect(lan.port, '127.0.0.1', () => {
      sock.write('GET /v1/lan HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    });
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (head.includes('\r\n\r\n')) {
        sock.off('data', onData);
        resolve(sock);
      }
    };
    sock.on('data', onData);
  });

  // Fragmented text frame with interleaved WebSocket ping control frame (0x9)
  const s1 = await openRaw();
  t.after(() => s1.destroy());
  const pongGot = new Promise((resolve) => s1.once('data', resolve));
  s1.write(Buffer.concat([
    maskClientFrame('hel', { opcode: 0x1, fin: false }),
    maskClientFrame('hi', { opcode: 0x9, fin: true }),
    maskClientFrame('lo!', { opcode: 0x0, fin: true }),
  ]));
  const pongFrame = await pongGot;
  assert.equal(pongFrame[0], 0x8a); // FIN + pong opcode
  assert.equal(pongFrame.subarray(2).toString('utf8'), 'hi');
  assert.equal(received.at(-1)?.text, 'hello!');

  // Fragmented control frame (FIN=0, opcode=0x9) must be rejected and closed
  const s2 = await openRaw();
  t.after(() => s2.destroy());
  const closed2 = new Promise((resolve) => s2.once('close', resolve));
  s2.write(maskClientFrame('bad', { opcode: 0x9, fin: false }));
  await closed2;
  assert.ok(closed.length >= 1);

  // Interleaved data frame mid-fragmentation must be rejected and closed
  const s3 = await openRaw();
  t.after(() => s3.destroy());
  const closed3 = new Promise((resolve) => s3.once('close', resolve));
  s3.write(Buffer.concat([
    maskClientFrame('part1', { opcode: 0x1, fin: false }),
    maskClientFrame('oops', { opcode: 0x1, fin: true }),
  ]));
  await closed3;
  assert.ok(closed.length >= 2);
});
