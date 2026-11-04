/**
 * The desktop's one outbound WebSocket to the relay. Reconnects with backoff, keeps the socket
 * warm with "ping" (answered by the relay without waking the Durable Object), and demultiplexes
 * relay frames into per-client callbacks. Nothing here sees plaintext: payloads are opaque strings.
 */
import { relayAuthQuery } from '../shared/e2e.js';

const PING_MS = 20_000;
const DEAD_MS = 65_000;

export function createRelayLink({ relayUrl, desktopId, signKeys, log = () => {}, onOpen, onData, onClose, onStatus = () => {} }) {
  const base = relayUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  let ws;
  let stopped = false;
  let attempt = 0;
  let retryTimer;
  let pingTimer;
  let lastHeard = 0;
  let status = 'connecting';
  const clients = new Set();

  const setStatus = (next, detail) => {
    if (status === next) return;
    status = next;
    onStatus(next, detail);
  };

  function dropClients() {
    for (const cid of clients) onClose(cid);
    clients.clear();
  }

  function connect() {
    if (stopped) return;
    setStatus('connecting');
    const url = `${base}/v1/desktop/${desktopId}?${relayAuthQuery(desktopId, signKeys)}`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      log(`wayne-herdr-mods: 无法连接中继：${error.message}`);
      schedule();
      return;
    }
    ws = socket;
    socket.onopen = () => {
      lastHeard = Date.now();
      setStatus('online');
      // Don't reset the backoff immediately: a relay that accepts then instantly closes
      // (auth failed, replaced, rate limited) would otherwise spin at ~1s forever. Reset
      // only once the connection has been stable for a while.
      const stableTimer = setTimeout(() => { attempt = 0; }, 30_000);
      socket.addEventListener('close', () => clearTimeout(stableTimer), { once: true });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > DEAD_MS) { try { socket.close(4002, 'heartbeat timeout'); } catch {} return; }
        try { socket.send('ping'); } catch {}
      }, PING_MS);
    };
    socket.onmessage = (message) => {
      lastHeard = Date.now();
      const text = typeof message.data === 'string' ? message.data : new TextDecoder().decode(message.data);
      if (text === 'pong') return;
      let frame;
      try { frame = JSON.parse(text); } catch { return; }
      if (frame.t === 'open' && typeof frame.c === 'string') {
        if (clients.has(frame.c)) onClose(frame.c);
        clients.add(frame.c);
        onOpen(frame.c);
      } else if (frame.t === 'data' && clients.has(frame.c) && typeof frame.d === 'string') {
        onData(frame.c, frame.d);
      } else if (frame.t === 'close' && clients.has(frame.c)) {
        clients.delete(frame.c);
        onClose(frame.c);
      }
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      clearInterval(pingTimer);
      dropClients();
      if (event.code === 1008 || /auth failed/.test(event.reason ?? '')) log(`wayne-herdr-mods: 中继拒绝了连接：${event.reason}`);
      // Code 4000: the relay replaced us with a newer desktop socket holding the same key —
      // reconnecting would kick that one and ping-pong forever. Stay down until kicked
      // (e.g. after the other instance exits, the user reloads this plugin, or a wake-up).
      if (event.code === 4000) {
        log(`wayne-herdr-mods: 另一个桌面实例接管了中继连接，本实例不再自动重连`);
        setStatus('offline', event.reason ?? 'replaced');
        return;
      }
      setStatus(stopped ? 'stopped' : 'offline', event.reason);
      schedule();
    };
    socket.onerror = () => {};
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(retryTimer);
    const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.6 + Math.random() * 0.4);
    attempt = Math.min(attempt + 1, 6);
    retryTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    status: () => status,
    send(cid, data) {
      if (ws?.readyState === 1 && clients.has(cid)) ws.send(JSON.stringify({ t: 'data', c: cid, d: data }));
    },
    close(cid, reason = 'closed') {
      if (!clients.delete(cid)) return;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'close', c: cid, reason }));
      onClose(cid);
    },
    /** Reconnect now (e.g. after the machine woke up). */
    kick() {
      if (status === 'online') return;
      attempt = 0;
      clearTimeout(retryTimer);
      connect();
    },
    dispose() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      dropClients();
      try { ws?.close(1000, 'desktop stopping'); } catch {}
      setStatus('stopped');
    },
  };
}
