/**
 * Local LAN WebSocket server for native iOS direct links (DESIGN.md「局域网直连」).
 *
 * Zero external dependencies: pure Node `http` + `crypto` RFC 6455 framing with TCP_NODELAY.
 * Every socket runs the exact same E2E handshake and paired-device auth in `host/phones.js`
 * (`lan:<n>`), so nothing on the LAN ever sees plaintext or bypasses the RPC whitelist.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_LINKS = 16;
const MAX_FRAME = 4 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const SILENT_MS = 45_000;
const PRIVATE_V4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function isUsablePrivateIPv4(addr) {
  if (typeof addr !== 'string' || !PRIVATE_V4.test(addr)) return false;
  const last = Number(addr.split('.')[3]);
  return Number.isInteger(last) && last > 0 && last < 255;
}

/** Private LAN IPv4 addresses of this Mac, Wi-Fi/Ethernet (`en*`) first. */
export function lanAddresses(ifaces = networkInterfaces()) {
  const scored = [];
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    if (!Array.isArray(list)) continue;
    const rank = /^en0$/.test(name) ? 0 : /^en\d+$/.test(name) ? 1 : 2;
    for (const info of list) {
      if (!info || info.internal || (info.family !== 'IPv4' && info.family !== 4)) continue;
      if (!isUsablePrivateIPv4(info.address)) continue;
      scored.push({ rank, address: info.address });
    }
  }
  scored.sort((a, b) => a.rank - b.rank);
  return [...new Set(scored.map((x) => x.address))];
}

/** Encode a single unmasked server→client RFC 6455 frame. */
export function encodeWsFrame(payload, opcode = 0x1) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = body.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, body]);
}

const WS_KEY_RE = /^[A-Za-z0-9+/]{22}==$/;
const VALID_OPCODES = new Set([0x0, 0x1, 0x2, 0x8, 0x9, 0xA]);

/**
 * Try decoding one masked client→server RFC 6455 frame from `buf`.
 * Returns `null` if incomplete, `{ error }` if invalid, or `{ fin, opcode, payload, rest }`.
 */
export function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  if (b0 & 0x70) return { error: 'reserved bits' };
  const fin = Boolean(b0 & 0x80);
  const opcode = b0 & 0x0f;
  if (!VALID_OPCODES.has(opcode)) return { error: 'bad opcode' };
  const masked = Boolean(b1 & 0x80);
  if (!masked) return { error: 'unmasked client frame' };

  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) return { error: 'frame too large' };
    len = Number(big);
    off = 10;
  }
  if (opcode >= 0x8 && (!fin || len > 125)) return { error: 'bad control frame' };
  if (len > MAX_FRAME) return { error: 'frame too large' };
  if (buf.length < off + 4 + len) return null;

  const mask = buf.subarray(off, off + 4);
  const data = Buffer.allocUnsafe(len);
  const start = off + 4;
  for (let i = 0; i < len; i++) data[i] = buf[start + i] ^ mask[i & 3];
  return { fin, opcode, payload: data, rest: buf.subarray(start + len) };
}

export async function createLanLink({ host = '0.0.0.0', port = 0, onOpen, onData, onClose, isAuthed = () => false, log = () => {} }) {
  const links = new Map(); // cid → { socket, open, openedAt, heard, buf, fragOp, frags, fragLen }
  let next = 1;

  function close(cid, reason = 'closed') {
    const l = links.get(cid);
    if (!l) return;
    links.delete(cid);
    try {
      const msg = Buffer.from(String(reason).slice(0, 100), 'utf8');
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000, 0);
      if (!l.socket.destroyed) l.socket.end(encodeWsFrame(Buffer.concat([code, msg]), 0x8));
    } catch {
      try { l.socket.destroy(); } catch {}
    }
    if (l.open) {
      l.open = false;
      onClose(cid);
    }
  }

  function deliver(cid, l, opcode, payload) {
    l.heard = Date.now();
    if (opcode === 0x8) { close(cid); return; }
    if (opcode === 0x9) { try { l.socket.write(encodeWsFrame(payload, 0xA)); } catch {} return; }
    if (opcode === 0xA) return;
    if (opcode !== 0x1 && opcode !== 0x2) return;
    const text = payload.toString('utf8');
    if (text === 'ping') {
      try { l.socket.write(encodeWsFrame('pong', 0x1)); } catch { close(cid); }
      return;
    }
    if (l.open) onData(cid, text);
  }

  function onChunk(cid, l, chunk) {
    l.buf = l.buf.length ? Buffer.concat([l.buf, chunk]) : chunk;
    for (;;) {
      const f = decodeWsFrame(l.buf);
      if (!f) break;
      if (f.error) { close(cid, f.error); return; }
      l.buf = f.rest;

      // Control frames (0x8..0xA) may arrive mid-fragmentation, must have FIN=1 and len <= 125.
      if (f.opcode >= 0x8) {
        if (!f.fin || f.payload.length > 125) { close(cid, 'bad control frame'); return; }
        deliver(cid, l, f.opcode, f.payload);
        if (!links.has(cid)) return;
        continue;
      }

      if (f.opcode !== 0) {
        if (l.fragOp) { close(cid, 'interleaved frame'); return; }
        if (f.fin) {
          deliver(cid, l, f.opcode, f.payload);
        } else {
          l.fragOp = f.opcode;
          l.frags = [f.payload];
          l.fragLen = f.payload.length;
        }
      } else {
        if (!l.fragOp) { close(cid, 'unexpected continuation'); return; }
        l.fragLen += f.payload.length;
        if (l.fragLen > MAX_FRAME) { close(cid, 'frame too large'); return; }
        l.frags.push(f.payload);
        if (f.fin) {
          const whole = Buffer.concat(l.frags, l.fragLen);
          const op = l.fragOp;
          l.fragOp = 0;
          l.frags = [];
          l.fragLen = 0;
          deliver(cid, l, op, whole);
        }
      }
      if (!links.has(cid)) return;
    }
  }

  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('expected websocket');
  });

  server.on('upgrade', (req, socket, head) => {
    const urlPath = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const connTokens = String(req.headers.connection || '').toLowerCase().split(',').map((s) => s.trim());
    const version = req.headers['sec-websocket-version'];
    if (
      req.method !== 'GET' || urlPath !== '/v1/lan' || upgrade !== 'websocket' ||
      !connTokens.includes('upgrade') || version !== '13' || typeof key !== 'string' || !WS_KEY_RE.test(key)
    ) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (links.size >= MAX_LINKS) {
      const victim = [...links.keys()].find((id) => !isAuthed(id));
      if (!victim) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      close(victim, 'replaced');
    }

    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.setNoDelay(true);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const cid = `lan:${next++}`;
    const now = Date.now();
    const l = { socket, open: true, openedAt: now, heard: now, buf: Buffer.alloc(0), fragOp: 0, frags: [], fragLen: 0 };
    links.set(cid, l);
    onOpen(cid);

    socket.on('data', (chunk) => onChunk(cid, l, chunk));
    socket.on('close', () => {
      if (!links.has(cid)) return;
      links.delete(cid);
      if (l.open) { l.open = false; onClose(cid); }
    });
    socket.on('error', () => close(cid));
    if (head?.length) onChunk(cid, l, head);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const boundPort = server.address().port;
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [cid, l] of links) {
      if (!isAuthed(cid) && now - l.openedAt > AUTH_TIMEOUT_MS) close(cid, 'auth_timeout');
      else if (now - l.heard > SILENT_MS) close(cid, 'silent');
    }
  }, 5_000);
  sweep.unref?.();

  log(`wayne-herdr-mods: [lan] listening port=${boundPort} addrs=${lanAddresses().join(',') || 'none'}`);

  return {
    port: boundPort,
    endpoints: () => lanAddresses().map((ip) => `ws://${ip}:${boundPort}/v1/lan`),
    count: () => links.size,
    send(cid, text) {
      const l = links.get(cid);
      if (!l?.open || l.socket.destroyed) return;
      try { l.socket.write(encodeWsFrame(text, 0x1)); } catch { close(cid); }
    },
    close,
    dispose() {
      clearInterval(sweep);
      for (const cid of [...links.keys()]) close(cid, 'shutdown');
      try { server.close(); } catch {}
    },
  };
}
