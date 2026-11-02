/**
 * herdr-relay relay: a zero-knowledge WebSocket matchmaker on Cloudflare Workers + Durable Objects.
 *
 *   desktop  ──wss /v1/desktop/<id>?pub&ts&sig──┐
 *                                                ├── Room DO (one per desktop id) ── forwards opaque frames
 *   phone(s) ──wss /v1/client/<id>──────────────┘
 *
 * - The desktop proves it owns <id>: id = base64url(sha256(ed25519 pub))[0..22], and it signs
 *   `herdr-relay:v1:<id>:<ts>` with that key. Nobody else can take its seat.
 * - Clients need no relay-level auth: everything they exchange with the desktop is end-to-end
 *   encrypted (see shared/e2e.js); the relay only sees ciphertext and connection ids.
 * - Wire format on the desktop socket (JSON text):
 *     relay → desktop: {t:'open',c} {t:'data',c,d} {t:'close',c}
 *     desktop → relay: {t:'data',c,d} {t:'close',c}
 *   Client sockets carry the raw `d` strings; the relay also tells clients {t:'online'|'offline'}
 *   in frames starting with "\u0000" so they never collide with payloads.
 * - Literal "ping" is answered "pong" by the runtime without waking the DO (hibernation).
 * - Dead sockets: a peer that vanished without a FIN or a close frame (a laptop asleep, a phone
 *   suspended by iOS, a changed network) stays in getWebSockets(), and a socket the relay closes
 *   stays there until the peer acknowledges, which a dead peer never does. So the relay never trusts
 *   list order: the newest desktop socket is the seat, and a socket counts as alive only while it
 *   pings (the runtime records each auto-answered ping). Desktops ping every 20 s, phones every
 *   20 s while open.
 * - Everything else is served from ./public (the PWA).
 */

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_CLIENTS = 8;
const MAX_FRAME = 4 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DESKTOP_STALE_MS = 70_000; // three missed desktop pings
const CLIENT_STALE_MS = 90_000; // background browser tabs may ping only once a minute
const CLIENT_AUTH_MS = 30_000; // a client that hasn't proven itself by then is dropped

const b64urlDecode = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const b64urlEncode = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function desktopIdFor(pub) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pub));
  return b64urlEncode(digest).slice(0, 22);
}

async function verifyDesktop(id, url) {
  const pubText = url.searchParams.get('pub');
  const ts = Number(url.searchParams.get('ts'));
  const sigText = url.searchParams.get('sig');
  if (!pubText || !sigText || !Number.isFinite(ts)) return 'missing pub/ts/sig';
  if (Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) return 'clock skew';
  let pub, sig;
  try { pub = b64urlDecode(pubText); sig = b64urlDecode(sigText); } catch { return 'bad encoding'; }
  if (pub.length !== 32 || sig.length !== 64) return 'bad key/signature length';
  if ((await desktopIdFor(pub)) !== id) return 'id does not match key';
  const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(`herdr-relay:v1:${id}:${ts}`));
  return ok ? null : 'bad signature';
}

const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\/v1\/(desktop|client|status)\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      if (url.pathname === '/v1/health') return text('ok');
      return env.ASSETS ? env.ASSETS.fetch(request) : text('not found', 404);
    }
    const [, role, id] = match;
    if (!ID_RE.test(id)) return text('bad id', 400);
    const room = env.ROOM.get(env.ROOM.idFromName(id));
    if (role === 'status') return room.fetch(new Request('https://room/status'));
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text('expected websocket', 426);
    if (role === 'desktop') {
      const problem = await verifyDesktop(id, url);
      if (problem) return text(`desktop auth failed: ${problem}`, 403);
    }
    return room.fetch(new Request(`https://room/${role}`, request));
  },
};

export class Room {
  constructor(state, env = {}) {
    this.state = state;
    // Overridable for local tests only (wrangler dev --var DESKTOP_STALE_MS:3000 …).
    this.desktopStaleMs = Number(env.DESKTOP_STALE_MS) || DESKTOP_STALE_MS;
    this.clientStaleMs = Number(env.CLIENT_STALE_MS) || CLIENT_STALE_MS;
    this.clientAuthMs = Number(env.CLIENT_AUTH_MS) || CLIENT_AUTH_MS;
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** When this socket last proved it is alive: its last ping, or when it connected. */
  lastHeard(ws) {
    const since = ws.deserializeAttachment()?.since ?? 0;
    const pinged = this.state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(since, pinged);
  }

  alive(ws, staleMs) {
    return Date.now() - this.lastHeard(ws) <= staleMs;
  }

  /**
   * A client that has sent only auto-pongs and never a real frame might be an attacker holding
   * one of the MAX_CLIENTS slots open (the relay cannot read the E2E-encrypted handshake, so it
   * cannot check auth directly). Close any client that has not sent real data within CLIENT_AUTH_MS.
   */
  authenticate(ws) {
    const meta = ws.deserializeAttachment();
    if (meta?.role !== 'client' || meta.spoke) return;
    if (Date.now() - (meta.since ?? 0) > this.clientAuthMs) {
      try { ws.close(4003, 'client idle before first frame'); } catch {}
      return;
    }
    // Check again later; cheap enough, and the DO is already awake for this socket.
    setTimeout(() => { try { this.authenticate(ws); } catch {} }, this.clientAuthMs);
  }

  /** The seat: the newest desktop socket, if it is still pinging. Older ones are being replaced. */
  desktop(except) {
    let newest;
    for (const ws of this.state.getWebSockets('desktop')) {
      if (ws === except) continue;
      if (!newest || (ws.deserializeAttachment()?.since ?? 0) > (newest.deserializeAttachment()?.since ?? 0)) newest = ws;
    }
    return newest && this.alive(newest, this.desktopStaleMs) ? newest : undefined;
  }

  /** Phone sockets still pinging; dead ones linger in getWebSockets() until swept. */
  clients() {
    return this.state.getWebSockets('client').filter((ws) => this.alive(ws, this.clientStaleMs));
  }

  clientById(cid) {
    return this.state.getWebSockets(`c:${cid}`)[0];
  }

  /** Close sockets whose peers stopped pinging, so neither side keeps talking to them. */
  sweep() {
    const desktop = this.desktop();
    for (const ws of this.state.getWebSockets('desktop')) {
      if (ws !== desktop && !this.alive(ws, this.desktopStaleMs)) { try { ws.close(4002, 'no ping'); } catch {} }
    }
    for (const ws of this.state.getWebSockets('client')) {
      const meta = ws.deserializeAttachment();
      // A client that never sent a real frame and has been idle long enough is a slot-holder.
      const idleTooLong = meta && !meta.spoke && Date.now() - (meta.since ?? 0) > this.clientAuthMs;
      if (!idleTooLong && this.alive(ws, this.clientStaleMs)) continue;
      try { ws.close(idleTooLong ? 4003 : 4002, idleTooLong ? 'no first frame' : 'no ping'); } catch {}
      if (desktop) safeSend(desktop, JSON.stringify({ t: 'close', c: meta?.cid }));
    }
  }

  async fetch(request) {
    const role = new URL(request.url).pathname.slice(1);
    if (role === 'status') return Response.json({ online: Boolean(this.desktop()), clients: this.clients().length });

    this.sweep();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'desktop') {
      for (const old of this.state.getWebSockets('desktop')) {
        try { old.close(4000, 'replaced by a newer desktop connection'); } catch {}
      }
      this.state.acceptWebSocket(server, ['desktop']);
      server.serializeAttachment({ role: 'desktop', since: Date.now() });
      for (const ws of this.clients()) {
        const { cid } = ws.deserializeAttachment();
        server.send(JSON.stringify({ t: 'open', c: cid }));
        safeSend(ws, '\u0000online');
      }
    } else {
      if (this.clients().length >= MAX_CLIENTS) return text('too many clients', 429);
      const cid = crypto.randomUUID();
      this.state.acceptWebSocket(server, ['client', `c:${cid}`]);
      server.serializeAttachment({ role: 'client', cid, since: Date.now(), spoke: false });
      const desktop = this.desktop();
      if (desktop) {
        safeSend(desktop, JSON.stringify({ t: 'open', c: cid }));
        server.send('\u0000online');
      } else {
        server.send('\u0000offline');
      }
      // Drop the slot if it never sends real data (a pure slot-holder bypasses MAX_CLIENTS).
      setTimeout(() => { try { this.authenticate(server); } catch {} }, this.clientAuthMs);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') message = new TextDecoder().decode(message);
    if (message.length > MAX_FRAME) { ws.close(1009, 'frame too large'); return; }
    const meta = ws.deserializeAttachment();
    if (meta?.role === 'client') {
      // First real frame from this client marks it as legitimate (no longer a slot-holder).
      if (!meta.spoke) { meta.spoke = true; ws.serializeAttachment(meta); }
      const desktop = this.desktop();
      if (desktop) safeSend(desktop, JSON.stringify({ t: 'data', c: meta.cid, d: message }));
      else { safeSend(ws, '\u0000offline'); this.sweep(); }
      return;
    }
    if (ws !== this.desktop()) return; // a replaced desktop socket no longer speaks for the seat
    let frame;
    try { frame = JSON.parse(message); } catch { return; }
    const target = typeof frame?.c === 'string' ? this.clientById(frame.c) : undefined;
    if (frame.t === 'data' && target && typeof frame.d === 'string') safeSend(target, frame.d);
    else if (frame.t === 'close' && target) { try { target.close(4001, String(frame.reason ?? 'closed by desktop').slice(0, 100)); } catch {} }
    else if (frame.t === 'close' && typeof frame.c === 'string') safeSend(ws, JSON.stringify({ t: 'close', c: frame.c }));
  }

  async webSocketClose(ws, code, reason) {
    this.gone(ws);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch {}
  }

  async webSocketError(ws) {
    this.gone(ws);
  }

  gone(ws) {
    const meta = ws.deserializeAttachment();
    if (meta?.role === 'client') {
      const desktop = this.desktop();
      if (desktop) safeSend(desktop, JSON.stringify({ t: 'close', c: meta.cid }));
    } else if (meta?.role === 'desktop') {
      // Only announce offline when no live desktop socket took over.
      if (!this.desktop(ws)) for (const client of this.clients()) safeSend(client, '\u0000offline');
    }
  }
}

function safeSend(ws, data) {
  try { ws.send(data); } catch {}
}
