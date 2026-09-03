/* EScout service worker — caches the app shell so it installs and opens instantly like a
   native app. Live data (land cover, elevation, wind, parcels, geocoding, map tiles) is
   never cached here — those requests always go straight to the network so Scout AI keeps
   reading real, current data. */
const CACHE_NAME = 'escout-shell-v48c08d81';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './base.css',
  './app.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // Bypass any HTTP/CDN cache when pre-warming the shell so a fresh SW version
        // never bakes in stale app.js/style.css from an earlier deploy.
        Promise.all(
          SHELL_FILES.map((url) => fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res)))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isShellFile = isSameOrigin && SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '/')) || (f === './' && url.pathname === '/'));

  if (!isSameOrigin || !isShellFile) {
    // Everything else — map tiles, NLCD/USGS/Open-Meteo/Nominatim/parcel lookups, CDN
    // scripts — goes straight to the network. Real terrain/weather data must never be
    // served stale from a cache.
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
