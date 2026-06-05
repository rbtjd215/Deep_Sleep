const CACHE_NAME = 'deepsleep-cache-v3';
const urlsToCache = [
    '/',
    '/index.html',
    '/style.css?v=2',
    '/app.js?v=2',
    '/manifest.json',
    '/icon.svg'
];

// 설치 시점에 파일 캐싱
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
    // 즉시 활성화 (대기 없이)
    self.skipWaiting();
});

// Network-first 전략: 네트워크 우선, 실패 시 캐시 반환
self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // 성공하면 캐시도 갱신
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, clone);
                });
                return response;
            })
            .catch(() => {
                // 네트워크 실패 시 캐시에서 반환 (오프라인 지원)
                return caches.match(event.request);
            })
    );
});

// 오래된 캐시 삭제
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    // 모든 클라이언트에 즉시 적용
    self.clients.claim();
});
