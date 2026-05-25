/*
 * Copyright (C) 2026 Jason M. Schwefel
 *
 * This file is part of DOPE Sticker Calculator.
 *
 * DOPE Sticker Calculator is free software: you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * DOPE Sticker Calculator is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with DOPE Sticker Calculator.  If not, see <https://www.gnu.org/licenses/>.
 */

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
