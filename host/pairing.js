/**
 * One-time pairing offers and the desktop's confirmation step.
 *
 * An offer lives 10 minutes and admits one phone. The phone proves it saw the QR (the token is in
 * the link); the desktop user then confirms, comparing the 6-digit code both screens show.
 */
import { encodePairLink, randomToken } from '../shared/e2e.js';

const OFFER_MS = 10 * 60_000;

export function createPairing({ relayUrl, desktopId, boxKeys, desktopName, onChange = () => {} }) {
  let offer = null; // { token, link, expiresAt }
  let request = null; // { cid, name, sas, pub, resolve }
  let timer;

  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

  function start() {
    cancel();
    const token = randomToken(16);
    const expiresAt = Date.now() + OFFER_MS;
    const origin = relayUrl.replace(/^ws/, 'http').replace(/\/$/, '');
    const link = encodePairLink(origin, {
      v: 1, r: origin.replace(/^http/, 'ws'), i: desktopId, k: b64(boxKeys.publicKey), t: token, n: desktopName(), e: expiresAt,
    });
    offer = { token, link, expiresAt };
    // decide(false) here also resolves any pending confirmation request — the phone sees 'denied'.
    timer = setTimeout(() => { if (offer?.token === token) { offer = null; decide(false); onChange(); } }, OFFER_MS);
    onChange();
    return offer;
  }

  function cancel() {
    clearTimeout(timer);
    offer = null;
    decide(false);
    onChange();
  }

  /** A phone presented `token`: park it until the desktop user decides. Resolves true/false. */
  function ask({ cid, token, name, sas, pub }) {
    if (!offer || offer.token !== token || Date.now() > offer.expiresAt) return Promise.resolve('invalid');
    if (request) return Promise.resolve('busy');
    return new Promise((resolve) => {
      request = { cid, name: String(name || '设备').slice(0, 40), sas, pub, at: Date.now(), resolve };
      onChange();
    });
  }

  function decide(allow) {
    if (!request) return false;
    const { resolve } = request;
    request = null;
    if (allow) { clearTimeout(timer); offer = null; }
    resolve(allow ? 'allowed' : 'denied');
    onChange();
    return true;
  }

  /** The phone went away while waiting. */
  function dropped(cid) {
    if (request?.cid === cid) { request.resolve('denied'); request = null; onChange(); }
  }

  return {
    start, cancel, decide, ask, dropped,
    view: () => ({
      offer: offer ? { link: offer.link, expiresAt: offer.expiresAt } : null,
      request: request ? { name: request.name, sas: request.sas, at: request.at } : null,
    }),
  };
}
