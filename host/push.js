/**
 * Web Push to paired phones (the PWA's service worker). Payloads are encrypted to the phone's
 * subscription keys (RFC 8291), so Apple/Google only relay ciphertext. We still send summaries only.
 *
 * Endpoint allowlist: a paired phone controls the URL we POST to. Restrict it to known push
 * services so a malicious phone cannot use this Mac as a blind-SSRF proxy.
 */
import webpush from 'web-push';

const ALLOWED_PUSH_HOSTS = new Set([
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'wns2-par02p.notify.windows.com', // Microsoft WNS uses per-tenant subdomains of notify.windows.com
]);

function isAllowedEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (ALLOWED_PUSH_HOSTS.has(host)) return true;
    // WNS tenant subdomains: *.notify.windows.com
    return host.endsWith('.notify.windows.com');
  } catch { return false; }
}

export function createPush({ state, log = () => {}, isOnline = () => false }) {
  const vapid = state.vapid;
  const details = { subject: 'mailto:herdr-relay@localhost.invalid', publicKey: vapid.publicKey, privateKey: vapid.privateKey };

  async function sendTo(device, payload) {
    if (!device.push?.endpoint) return { sent: false, reason: 'no-subscription' };
    if (!isAllowedEndpoint(device.push.endpoint)) {
      log(`herdr-relay: 拒绝推送到未知服务「${device.push.endpoint.slice(0, 60)}…」`);
      return { sent: false, reason: 'unknown-push-service' };
    }
    try {
      await webpush.sendNotification(device.push, JSON.stringify(payload), {
        vapidDetails: details, TTL: 6 * 3600, urgency: payload.urgent ? 'high' : 'normal', topic: payload.topic,
      });
      return { sent: true };
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await state.updateDevice(device.id, { push: null });
        return { sent: false, reason: 'expired' };
      }
      log(`herdr-relay: 推送到「${device.name}」失败：${error.statusCode ?? ''} ${error.body ?? error.message}`);
      return { sent: false, reason: String(error.statusCode ?? error.message) };
    }
  }

  return {
    publicKey: vapid.publicKey,
    sendTo,
    /** Notify every paired device that is not connected right now (an open app sees the event live). */
    async notify(payload, { includeOnline = false } = {}) {
      const targets = state.devices().filter((device) => device.push && (includeOnline || !isOnline(device.id)));
      await Promise.all(targets.map((device) => sendTo(device, payload)));
    },
  };
}
