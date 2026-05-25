const CACHE_NAME = 'dope-pwa-v1';
const PRECACHE = [
    '/pwa/',
    '/pwa/index.html',
    '/pwa/manifest.json',
    '/pwa/css/pwa.css',
    '/pwa/js/app.js',
    '/pwa/js/ballistics.js',
    '/pwa/js/canvas-sticker.js',
    '/pwa/js/niimbot.js',
    '/pwa/js/db.js',
    '/pwa/fonts/barlow-condensed-700.woff2',
    '/pwa/icons/icon-192.png',
    '/pwa/icons/icon-512.png',
    '/pwa/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Only intercept same-origin /pwa/ requests; let /api/ pass through
    if (!url.pathname.startsWith('/pwa/')) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (response && response.status === 200 && response.type !== 'opaque') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback for navigation requests
                if (event.request.mode === 'navigate') {
                    return caches.match('/pwa/');
                }
            });
        })
    );
});
