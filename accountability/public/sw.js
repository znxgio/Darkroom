// Service worker: lets the Home Screen app open fast / offline (app shell only).
// Data is never cached here — it always comes live from the server.
const CACHE = 'shell-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API calls go straight to network
  if (req.mode === 'navigate') {
    // Network first so updates show up; fall back to cached shell offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Hashed build files never change: cache first.
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});

// ---- Reminders (web push) ----
self.addEventListener('push', (e) => {
  let msg = { title: 'Daily', body: '' };
  try {
    msg = e.data ? e.data.json() : msg;
  } catch {
    msg.body = e.data ? e.data.text() : '';
  }
  const tasks = [
    self.registration.showNotification(msg.title || 'Daily', {
      body: msg.body || '',
      tag: msg.tag || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: msg.url || '/' },
    }),
  ];
  // Home Screen icon badge = things still open today (supported on iOS 16.4+ Home Screen apps).
  if (typeof msg.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    tasks.push(msg.badge > 0 ? self.navigator.setAppBadge(msg.badge) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(tasks).catch(() => {}));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.postMessage({ type: 'open', url });
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
