/* Minimal service worker so the browser demo installs as a PWA (Android home
   screen / desktop) and runs offline. Caches the same-origin app shell; lets
   cross-origin calls (LRCLIB, Google Fonts) hit the network normally. */
const CACHE = 'lyric-overlay-v1';
const ASSETS = [
  './', './index.html', './demo.html', './demo.js', './privacy.html',
  './assets/butterchurn.min.js', './assets/butterchurnPresets.min.js',
  './assets/icon-192.png', './assets/icon-512.png', './assets/icon.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./demo.html')))
  );
});
