// Service worker: makes the Home Screen app open fast and keeps the on-device
// detection models cached (they're ~25 MB, downloaded once).
// Your data and photos are never cached here.
const SHELL = 'shell-v1';
const MODELS = 'models-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== MODELS).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

const cacheFirst = (cacheName, req) =>
  caches.open(cacheName).then((c) =>
    c.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        }),
    ),
  );

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/')) {
    e.respondWith(cacheFirst(MODELS, req));
    return;
  }
  if (url.origin !== self.location.origin) return; // database + AI calls go straight to the network
  if (url.pathname.startsWith('/mediapipe/')) {
    e.respondWith(cacheFirst(MODELS, req));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(cacheFirst(SHELL, req));
  }
});
