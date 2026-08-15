/* Minimal service worker so the browser demo installs as a PWA (Android home
   screen / desktop) and runs offline. Caches the same-origin app shell; lets
   cross-origin calls (LRCLIB, Google Fonts) hit the network normally.

   NETWORK-FIRST, not cache-first. The old version served from cache first and
   only fell back to the network on a cache miss — since the cache is filled
   once and CACHE below never had a reason to change, a returning visitor was
   stuck on whatever the site looked like on their FIRST visit, forever, with
   no way for a new deploy to ever reach them. Bumped v1 -> v2 as a one-time
   clean break for anyone already stuck; going forward the network-first
   strategy means this class of bug can't recur even if CACHE never changes
   again — being current is a bug, not an edge case, when almost everyone is
   online. Offline just falls back to whatever was last successfully cached. */
const CACHE = 'lyric-overlay-v2';
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
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./demo.html')))
  );
});
