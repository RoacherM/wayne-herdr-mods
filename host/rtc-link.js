/**
 * Direct phone ↔ Mac links over WebRTC. The relay only introduces the two sides: a phone that is
 * already connected and authenticated through it sends an offer (`rtc.offer`, phones.js), the
 * answer goes back the same way, and from then on the bytes go point to point.
 *
 * A data channel is a second connection, not a shortcut: phones.js runs the same E2E handshake and
 * device auth on it as on a relay connection (connection id `rtc:<n>`). Nothing here sees
 * plaintext; WebRTC's own encryption (DTLS) is a second layer.
 *
 * On the channel: "ping" is answered here with "pong" (the relay does the same); long messages
 * come in pieces (shared/pieces.js).
 */
import { RTCPeerConnection } from 'werift';
import { joiner, pieces } from '../shared/pieces.js';

export const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const MAX_LINKS = 6;          // all phones together; a new one closes the oldest
const MAX_SDP = 20_000;
const GATHER_MS = 3_000;      // wait this long for our network addresses, then answer with what we have
const OPEN_MS = 15_000;       // the channel must open by then
const SILENT_MS = 45_000;     // nothing heard (the phone pings every few seconds): it is gone

export function createRtcLink({ onOpen, onData, onClose, log = () => {}, iceServers = STUN }) {
  const links = new Map(); // cid → { pc, dc, open, heard, join }
  let next = 1;

  const sweep = setInterval(() => {
    for (const [cid, l] of links) if (l.open && Date.now() - l.heard > SILENT_MS) close(cid, 'silent');
  }, 5_000);
  sweep.unref?.();

  function close(cid) {
    const l = links.get(cid);
    if (!l) return;
    links.delete(cid);
    clearTimeout(l.timer);
    try { l.dc?.close(); } catch {}
    Promise.resolve().then(() => l.pc.close()).catch(() => {});
    if (l.open) onClose(cid);
  }

  function receive(cid, l, data) {
    l.heard = Date.now();
    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (text === 'ping') { try { l.dc.send('pong'); } catch {} return; }
    let whole;
    try { whole = l.join(text); } catch { close(cid); return; }
    if (whole !== null && l.open) onData(cid, whole);
  }

  /** The phone's offer → our answer (with all our addresses in it: no trickling). */
  async function answer(sdp) {
    if (typeof sdp !== 'string' || sdp.length > MAX_SDP || !/^m=application /m.test(sdp)) throw new Error('无效的 offer');
    while (links.size >= MAX_LINKS) close(links.keys().next().value);
    const cid = `rtc:${next++}`;
    const pc = new RTCPeerConnection({ iceServers });
    const l = { pc, dc: null, open: false, heard: Date.now(), join: joiner(), timer: 0 };
    links.set(cid, l);
    l.timer = setTimeout(() => { if (!l.open) close(cid); }, OPEN_MS);
    pc.onDataChannel.subscribe((dc) => {
      if (l.dc || !links.has(cid)) { try { dc.close(); } catch {} return; } // one channel per link
      l.dc = dc;
      const opened = () => {
        if (l.open || !links.has(cid)) return;
        l.open = true;
        clearTimeout(l.timer);
        onOpen(cid);
      };
      dc.stateChanged.subscribe((s) => { if (s === 'open') opened(); else if (s === 'closed') close(cid); });
      dc.onMessage.subscribe((m) => receive(cid, l, m));
      if (dc.readyState === 'open') opened();
    });
    pc.connectionStateChange.subscribe((s) => { if (s === 'failed' || s === 'closed') close(cid); });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, GATHER_MS);
          pc.iceGatheringStateChange.subscribe((s) => { if (s === 'complete') { clearTimeout(t); resolve(); } });
        });
      }
      return { sdp: pc.localDescription.sdp };
    } catch (error) {
      close(cid);
      log(`herdr-relay: 直连失败：${error.message}`);
      throw new Error('直连失败');
    }
  }

  return {
    answer,
    count: () => [...links.values()].filter((l) => l.open).length,
    send(cid, text) {
      const l = links.get(cid);
      if (!l?.open || l.dc?.readyState !== 'open') return;
      try { for (const p of pieces(text)) l.dc.send(p); } catch { close(cid); }
    },
    close: (cid) => close(cid),
    dispose() { clearInterval(sweep); for (const cid of [...links.keys()]) close(cid); },
  };
}
