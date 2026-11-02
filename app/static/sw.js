// herdr phone app service worker: app-shell cache + Web Push.
const CACHE = 'herdr-relay-__V__';
const SHELL = ['/', '/app.js?v=__V__', '/app.css?v=__V__', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/v1/')) return;
  // Network first (so updates land), cache as the offline fallback.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && (url.pathname === '/' || SHELL.includes(url.pathname + url.search))) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('/'))));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch { data = { title: 'herdr', body: e.data?.text() ?? '' }; }
  // The desktop now pushes even to devices it considers "online" (iOS suspends a backgrounded
  // PWA without dropping its socket, so the desktop cannot tell it apart from a live one).
  // Suppress the notification when the app is actually visible — it sees the event live.
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    if (clients.some((c) => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(data.title ?? 'herdr', {
      body: data.body ?? '', tag: data.tag, renotify: Boolean(data.urgent), icon: '/icon-192.png', badge: '/icon-192.png',
      data: { address: data.address },
    });
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { address } = e.notification.data ?? {};
  const target = address ? `/?t=${encodeURIComponent(address)}` : '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) { client.postMessage({ open: { address } }); return client.focus(); }
    }
    return self.clients.openWindow(target);
  }));
});
