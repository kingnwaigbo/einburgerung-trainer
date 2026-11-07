const CACHE_NAME = 'einbuergerung-v1.0.0';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './questions.json',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.tailwindcss.com'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(e.request).catch(() => caches.match('./index.html'));
    })
  );
});