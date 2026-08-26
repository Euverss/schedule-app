/* =========================================================
   Service Worker - 让应用离线可用
   首次访问后会把所有文件缓存到手机本地，
   之后即使没有网络也能正常打开使用。
   ========================================================= */

const CACHE_NAME = 'schedule-app-v10';
// 需要缓存的文件（相对路径）
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './records-db.js',
  './sync.js',
  './seed-august.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// 安装：把资源写入缓存
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  // 新版本安装后立即接管
  self.skipWaiting();
});

// 激活：清理旧版本缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// 请求拦截：优先用缓存，取不到再联网
self.addEventListener('fetch', (event) => {
  // 只处理同源的 GET 请求
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached; // 命中缓存直接返回（离线也能用）
      return fetch(event.request).then((response) => {
        // 联网成功时把新资源加入缓存，下次离线可用
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
