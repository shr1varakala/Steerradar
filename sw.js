/**
 * ============================================================================
 * STEERADAR SERVICE WORKER (v1.0)
 * ============================================================================
 * Provides offline support and asset caching for the PWA.
 * 
 * STRATEGY:
 * - App Shell: Cache-first (instant loads)
 * - API calls: Network-only (never cache sensitive data)
 * - Images: Cache-first with background update
 * ============================================================================
 */

const CACHE_NAME = 'steeradar-v13.0.0';
const RUNTIME_CACHE = 'steeradar-runtime-v13.0.0';

// Files to cache immediately on install (App Shell)
const PRECACHE_URLS = [
    './',
    './index.html',
    './config.js',
    './manifest.json',
    './css/style.css',
    './js/app.js',
    './js/api.js',
    './js/map.js',
    './steeradar-logo.png'
];

// ============================ INSTALL ============================
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Pre-caching app shell');
                // Use individual add() so one 404 doesn't break everything
                return Promise.all(
                    PRECACHE_URLS.map(url => 
                        cache.add(url).catch(err => 
                            console.warn(`[SW] Failed to cache ${url}:`, err.message)
                        )
                    )
                );
            })
            .then(() => self.skipWaiting())
    );
});

// ============================ ACTIVATE ============================
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // Delete old caches
                    if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// ============================ FETCH ============================
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') return;

    // Skip Google Apps Script API calls (never cache)
    if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
        return;
    }

    // Skip chrome extensions and other non-http requests
    if (!url.protocol.startsWith('http')) return;

    // Handle navigation requests (HTML pages)
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    // Handle images and static assets - Cache First with Background Update
    if (request.destination === 'image' || 
        url.pathname.endsWith('.css') || 
        url.pathname.endsWith('.js') ||
        url.pathname.endsWith('.png') ||
        url.pathname.endsWith('.svg') ||
        url.pathname.endsWith('.woff2')) {
        
        event.respondWith(
            caches.match(request).then(cachedResponse => {
                if (cachedResponse) {
                    // Serve from cache, update in background
                    fetch(request)
                        .then(networkResponse => {
                            if (networkResponse.ok) {
                                caches.open(RUNTIME_CACHE)
                                    .then(cache => cache.put(request, networkResponse.clone()));
                            }
                        })
                        .catch(() => {});
                    return cachedResponse;
                }
                
                // Not cached - fetch and cache
                return fetch(request).then(networkResponse => {
                    if (!networkResponse.ok) return networkResponse;
                    
                    const responseClone = networkResponse.clone();
                    caches.open(RUNTIME_CACHE)
                        .then(cache => cache.put(request, responseClone));
                    return networkResponse;
                });
            })
        );
        return;
    }

    // Default: Network first, fallback to cache
    event.respondWith(
        fetch(request)
            .then(response => {
                // Cache successful responses
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(RUNTIME_CACHE)
                        .then(cache => cache.put(request, responseClone));
                }
                return response;
            })
            .catch(() => caches.match(request))
    );
});

// ============================ MESSAGE ============================
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        caches.keys().then(names => 
            Promise.all(names.map(name => caches.delete(name)))
        );
    }
});

// ============================ PUSH NOTIFICATIONS (Future) ============================
self.addEventListener('push', (event) => {
    if (!event.data) return;
    
    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = { title: 'SteerRadar', body: event.data.text() };
    }

    const options = {
        body: data.body || 'New notification',
        icon: './icons/icon-192.png',
        badge: './icons/icon-96.png',
        vibrate: [200, 100, 200],
        data: data.url || './',
        actions: data.actions || []
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'SteerRadar', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data || './')
    );
});