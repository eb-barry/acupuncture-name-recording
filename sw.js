// sw.js — 離線快取。更新程式碼後記得把 CACHE_NAME 的版本號往上加一，
// 否則使用者的瀏覽器會繼續用舊的快取版本。
const CACHE_NAME = 'acupuncture-recorder-v5';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/audio-recorder.js',
  './js/points-data.js',
  './js/storage.js',
  './vendor/lame.min.js',
  './data/points-data.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Cache-first：先看快取有沒有，沒有才去網路拿（拿到後也存進快取）
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // 忽略非 http/https 的請求（例如某些瀏覽器擴充功能會發出 chrome-extension:// 開頭的請求）。
  // Cache API 不支援這些協定，直接 put 會丟出 TypeError；不呼叫 respondWith 讓瀏覽器照正常方式處理就好。
  const url = new URL(event.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
