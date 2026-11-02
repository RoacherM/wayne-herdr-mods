/**
 * herdr-relay end-to-end channel, shared by the Mac host (Node) and the phone PWA (browser).
 * The relay only ever sees the strings produced here.
 *
 * Keys
 *   desktop: box keypair D (X25519, static; its public key is in the pairing QR)
 *            sign keypair S (Ed25519; only proves the relay seat, desktopId = sha256(S.pub))
 *   phone:   box keypair P (X25519, static; registered on the desktop when paired)
 *
 * Handshake (plaintext JSON, then everything is encrypted)
 *   phone   → {type:'hello', v:1, p:P.pub, e:Ep.pub}
 *   desktop → {type:'welcome', v:1, e:Ed.pub}
 *   k = SHA-512("herdr-relay/v1" ‖ DH(Ep,D) ‖ DH(Ep,Ed) ‖ DH(P,Ed) ‖ P ‖ Ep ‖ D ‖ Ed)
 *   k[0:32] encrypts phone→desktop, k[32:64] desktop→phone (XSalsa20-Poly1305, counter nonces).
 *   - Only the real desktop can compute DH(Ep,D): the phone got D from the QR, so the relay cannot
 *     impersonate the desktop.
 *   - Only the holder of P can compute DH(P,Ed): the first encrypted frame proves the phone's key,
 *     and the desktop then checks P against its device registry (or a one-time pairing token).
 *   - Ephemeral-ephemeral DH gives forward secrecy.
 *   SAS (6 digits shown on both screens while pairing) = SHA-512("herdr-relay/sas" ‖ k)[0..4] mod 1e6.
 *
 * Encrypted frame: "E" + base64(secretbox(plaintext, nonce = 16 zero bytes ‖ u64 counter)).
 * Counters are implicit and strictly increasing per direction, so reordering/replay fails to decrypt.
 */
import nacl from 'tweetnacl';

export const PROTOCOL = 1;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (text) => unb64(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export const newBoxKeys = () => nacl.box.keyPair();
export const newSignKeys = () => nacl.sign.keyPair();
export const boxKeysFromSecret = (secretKey) => nacl.box.keyPair.fromSecretKey(secretKey);
export const signKeysFromSecret = (secretKey) => nacl.sign.keyPair.fromSecretKey(secretKey);
export const randomToken = (n = 16) => b64url(nacl.randomBytes(n));

/** desktopId = base64url(SHA-256(ed25519 pub))[0..22] — must match the relay's check. */
export async function desktopIdFor(signPublicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', signPublicKey));
  return b64url(digest).slice(0, 22);
}

/** Query string that proves the relay seat: pub, ts, sig over `herdr-relay:v1:<id>:<ts>`. */
export function relayAuthQuery(id, signKeys, now = Date.now()) {
  const sig = nacl.sign.detached(enc.encode(`herdr-relay:v1:${id}:${now}`), signKeys.secretKey);
  return `pub=${b64url(signKeys.publicKey)}&ts=${now}&sig=${b64url(sig)}`;
}

function deriveKeys({ dhEpD, dhEpEd, dhPEd, P, Ep, D, Ed }) {
  const k = nacl.hash(concat(enc.encode('herdr-relay/v1'), dhEpD, dhEpEd, dhPEd, P, Ep, D, Ed));
  const sasHash = nacl.hash(concat(enc.encode('herdr-relay/sas'), k));
  const sasNum = ((sasHash[0] << 24) | (sasHash[1] << 16) | (sasHash[2] << 8) | sasHash[3]) >>> 0;
  return { c2s: k.slice(0, 32), s2c: k.slice(32, 64), sas: String(sasNum % 1_000_000).padStart(6, '0') };
}

/**
 * X25519 with low-order point rejection. A low-order public key (all zeros being the simplest)
 * makes the shared secret all zeros, which an attacker who sent that key can reproduce — they
 * would decrypt everything and forge the first "proof of key" frame. Reject any all-zero result.
 * (nacl.scalarMult itself accepts these; RFC 7748 §6.1 says implementations MAY check, and for a
 * pairing protocol that registers the peer's static key we must.)
 */
const dh = (secretKey, publicKey) => {
  const out = nacl.scalarMult(secretKey, publicKey);
  let acc = 0;
  for (let i = 0; i < out.length; i++) acc |= out[i];
  if (acc === 0) throw new Error('invalid low-order public key');
  return out;
};

class Cipher {
  constructor(sendKey, recvKey) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendCounter = 0;
    this.recvCounter = 0;
  }
  static nonce(counter) {
    const n = new Uint8Array(24);
    let c = counter;
    for (let i = 23; i >= 16; i--) { n[i] = c % 256; c = Math.floor(c / 256); }
    return n;
  }
  seal(value) {
    const box = nacl.secretbox(enc.encode(JSON.stringify(value)), Cipher.nonce(this.sendCounter++), this.sendKey);
    return 'E' + b64(box);
  }
  open(frame) {
    if (typeof frame !== 'string' || frame[0] !== 'E') throw new Error('not an encrypted frame');
    const plain = nacl.secretbox.open(unb64(frame.slice(1)), Cipher.nonce(this.recvCounter), this.recvKey);
    if (!plain) throw new Error('decryption failed');
    this.recvCounter++;
    return JSON.parse(dec.decode(plain));
  }
}

/** Phone side. `phoneKeys` is the static box keypair; `desktopPublicKey` comes from the QR. */
export function phoneHandshake(phoneKeys, desktopPublicKey) {
  const eph = nacl.box.keyPair();
  return {
    hello: JSON.stringify({ type: 'hello', v: PROTOCOL, p: b64(phoneKeys.publicKey), e: b64(eph.publicKey) }),
    /** Feed the desktop's plaintext welcome; returns { cipher, sas }. */
    finish(welcomeText) {
      const welcome = JSON.parse(welcomeText);
      if (welcome?.type !== 'welcome' || welcome.v !== PROTOCOL) throw new Error(welcome?.error ?? 'unexpected handshake reply');
      const Ed = unb64(welcome.e);
      const keys = deriveKeys({
        dhEpD: dh(eph.secretKey, desktopPublicKey),
        dhEpEd: dh(eph.secretKey, Ed),
        dhPEd: dh(phoneKeys.secretKey, Ed),
        P: phoneKeys.publicKey, Ep: eph.publicKey, D: desktopPublicKey, Ed,
      });
      return { cipher: new Cipher(keys.c2s, keys.s2c), sas: keys.sas };
    },
  };
}

/** Desktop side: answer one hello. Returns { welcome, cipher, sas, phonePublicKey }. */
export function desktopAccept(desktopKeys, helloText) {
  const hello = JSON.parse(helloText);
  if (hello?.type !== 'hello') throw new Error('expected hello');
  if (hello.v !== PROTOCOL) throw new Error(`unsupported protocol ${hello.v}`);
  const P = unb64(hello.p);
  const Ep = unb64(hello.e);
  if (P.length !== 32 || Ep.length !== 32) throw new Error('bad key length');
  const eph = nacl.box.keyPair();
  const keys = deriveKeys({
    dhEpD: dh(desktopKeys.secretKey, Ep),
    dhEpEd: dh(eph.secretKey, Ep),
    dhPEd: dh(eph.secretKey, P),
    P, Ep, D: desktopKeys.publicKey, Ed: eph.publicKey,
  });
  return {
    welcome: JSON.stringify({ type: 'welcome', v: PROTOCOL, e: b64(eph.publicKey) }),
    cipher: new Cipher(keys.s2c, keys.c2s),
    sas: keys.sas,
    phonePublicKey: b64(P),
  };
}

/** Pairing link carried by the QR: https://<relay host>/#p=<base64url(JSON)> */
export function encodePairLink(origin, offer) {
  return `${origin.replace(/\/$/, '')}/#p=${b64url(enc.encode(JSON.stringify(offer)))}`;
}
export function decodePairLink(link) {
  const hash = link.includes('#') ? link.slice(link.indexOf('#') + 1) : link;
  const p = new URLSearchParams(hash).get('p');
  if (!p) throw new Error('not a pairing link');
  const offer = JSON.parse(dec.decode(unb64url(p)));
  if (offer?.v !== PROTOCOL || !offer.i || !offer.k || !offer.r) throw new Error('unsupported pairing link');
  return offer;
}
