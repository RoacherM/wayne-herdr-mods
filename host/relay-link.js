/**
 * The desktop's one outbound WebSocket to the relay. Reconnects with backoff, keeps the socket
 * warm with "ping" (answered by the relay without waking the Durable Object), and demultiplexes
 * relay frames into per-client callbacks. Nothing here sees plaintext: payloads are opaque strings.
 */
import { relayAuthQuery } from '../shared/e2e.js';

const PING_MS = 20_000;
const DEAD_MS = 65_000;
const CONNECT_MS = 15_000;

function closeSocket(socket, code, reason) {
  try { socket?.close(code, reason); } catch { /* socket may already be closed */ }
}

function decodeWsData(data) {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

function retryDelayMs(attempt) {
  return Math.min(30_000, 1000 * 2 ** attempt) * (0.6 + Math.random() * 0.4);
}

function isAuthError(event) {
  return event.code === 1008 || /auth failed/.test(event.reason ?? '');
}

function routeRelayFrame(text, clients, { onOpen, onData, onClose }) {
  let frame;
  try { frame = JSON.parse(text); } catch { return; }
  const { t, c, d } = frame;
  if (t === 'open' && typeof c === 'string') {
    if (clients.has(c)) onClose(c);
    clients.add(c);
    onOpen(c);
  } else if (t === 'data' && clients.has(c) && typeof d === 'string') {
    onData(c, d);
  } else if (t === 'close' && clients.has(c)) {
    clients.delete(c);
    onClose(c);
  }
}

function logRelayOnline(log, t0, attempt) {
  log(`wayne-herdr-mods: [relay] online ms=${Date.now() - t0} attempt=${attempt}`);
}

function logRelayOffline(log, openedAt, event) {
  const up = openedAt ? ` upMs=${Date.now() - openedAt}` : '';
  const reason = event.reason ? ` reason=${JSON.stringify(event.reason)}` : '';
  log(`wayne-herdr-mods: [relay] offline code=${event.code}${reason}${up}`);
}

function createLinkRuntime({ relayUrl, desktopId, signKeys, log, handlers, onStatus }) {
  const base = relayUrl.replace(/^http/, 'ws').replace(/\/$/, '');
  const state = { ws: null, stopped: false, attempt: 0, retryTimer: null, connectTimer: null, pingTimer: null, lastHeard: 0, status: 'connecting' };
  const clients = new Set();

  const setStatus = (next, detail) => {
    if (state.status === next) return;
    state.status = next;
    onStatus(next, detail);
  };

  const dropClients = () => {
    for (const cid of clients) handlers.onClose(cid);
    clients.clear();
  };

  const detachCurrent = (reason) => {
    const prev = state.ws;
    state.ws = null;
    clearTimeout(state.connectTimer);
    clearInterval(state.pingTimer);
    if (prev) closeSocket(prev, 1000, reason);
  };

  const schedule = () => {
    if (state.stopped) return;
    clearTimeout(state.retryTimer);
    const delay = retryDelayMs(state.attempt);
    state.attempt = Math.min(state.attempt + 1, 6);
    state.retryTimer = setTimeout(connect, delay);
  };

  const startHeartbeat = (socket) => {
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => {
      if (state.ws !== socket) return;
      if (Date.now() - state.lastHeard > DEAD_MS) { closeSocket(socket, 4002, 'heartbeat timeout'); return; }
      try { socket.send('ping'); } catch { /* next heartbeat or onclose will recover */ }
    }, PING_MS);
  };

  const onConnectTimeout = (socket) => {
    if (state.ws !== socket) return;
    state.ws = null;
    clearInterval(state.pingTimer);
    closeSocket(socket, 4002, 'connect timeout');
    logRelayOffline(log, 0, { code: 4002, reason: 'connect timeout' });
    setStatus(state.stopped ? 'stopped' : 'offline', 'connect timeout');
    schedule();
  };

  const attachSocket = (socket, t0) => {
    let openedAt = 0;
    state.connectTimer = setTimeout(() => onConnectTimeout(socket), CONNECT_MS);
    socket.onopen = () => {
      if (state.ws !== socket) { closeSocket(socket, 1000, 'superseded'); return; }
      clearTimeout(state.connectTimer);
      openedAt = state.lastHeard = Date.now();
      logRelayOnline(log, t0, state.attempt);
      setStatus('online');
      // Don't reset the backoff immediately: a relay that accepts then instantly closes
      // (auth failed, replaced, rate limited) would otherwise spin at ~1s forever.
      const stableTimer = setTimeout(() => { state.attempt = 0; }, 30_000);
      socket.addEventListener('close', () => clearTimeout(stableTimer), { once: true });
      startHeartbeat(socket);
    };
    socket.onmessage = (message) => {
      if (state.ws !== socket) return;
      state.lastHeard = Date.now();
      const text = decodeWsData(message.data);
      if (text !== 'pong') routeRelayFrame(text, clients, handlers);
    };
    socket.onclose = (event) => {
      if (state.ws !== socket) return;
      clearTimeout(state.connectTimer);
      clearInterval(state.pingTimer);
      dropClients();
      logRelayOffline(log, openedAt, event);
      if (isAuthError(event)) log(`wayne-herdr-mods: 中继拒绝了连接：${event.reason}`);
      // Code 4000: another desktop socket with the same key replaced us — stay down until kicked.
      if (event.code === 4000) {
        log(`wayne-herdr-mods: 另一个桌面实例接管了中继连接，本实例不再自动重连`);
        setStatus('offline', event.reason ?? 'replaced');
        return;
      }
      setStatus(state.stopped ? 'stopped' : 'offline', event.reason);
      schedule();
    };
    socket.onerror = () => {};
  };

  function connect() {
    if (state.stopped) return;
    detachCurrent('reconnecting');
    setStatus('connecting');
    const t0 = Date.now();
    const url = `${base}/v1/desktop/${desktopId}?${relayAuthQuery(desktopId, signKeys)}`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      log(`wayne-herdr-mods: 无法连接中继：${error.message}`);
      schedule();
      return;
    }
    state.ws = socket;
    attachSocket(socket, t0);
  }

  return { state, clients, connect, dropClients, detachCurrent, setStatus };
}

export function createRelayLink({ relayUrl, desktopId, signKeys, log = () => {}, onOpen, onData, onClose, onStatus = () => {} }) {
  const rt = createLinkRuntime({ relayUrl, desktopId, signKeys, log, handlers: { onOpen, onData, onClose }, onStatus });
  rt.connect();
  return {
    status: () => rt.state.status,
    send(cid, data) {
      if (rt.state.ws?.readyState === 1 && rt.clients.has(cid)) rt.state.ws.send(JSON.stringify({ t: 'data', c: cid, d: data }));
    },
    close(cid, reason = 'closed') {
      if (!rt.clients.delete(cid)) return;
      if (rt.state.ws?.readyState === 1) rt.state.ws.send(JSON.stringify({ t: 'close', c: cid, reason }));
      onClose(cid);
    },
    /** Reconnect now (e.g. after the machine woke up). */
    kick() {
      if (rt.state.stopped || rt.state.status === 'online') return;
      rt.state.attempt = 0;
      clearTimeout(rt.state.retryTimer);
      rt.connect();
    },
    dispose() {
      rt.state.stopped = true;
      clearTimeout(rt.state.retryTimer);
      rt.dropClients();
      rt.detachCurrent('desktop stopping');
      rt.setStatus('stopped');
    },
  };
}
