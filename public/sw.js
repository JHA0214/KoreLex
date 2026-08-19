const CACHE_NAME = 'korelex-v1';
const CORE_ASSETS = ['/', '/index.html', '/style.css', '/script.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // 검색 API 응답은 항상 최신 상태를 받아와야 하므로 캐시하지 않는다.
  if (event.request.url.includes('/api/')) return;

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
