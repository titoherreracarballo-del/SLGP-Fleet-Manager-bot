// ============================================
// SERVICE WORKER - SLGP FLEET MANAGER
// Hybrid Approach: Always fresh HTML + Cached static assets
// ============================================

const CACHE_NAME = 'slgp-fleet-v2';
const RUNTIME_CACHE = 'slgp-runtime-v2';

// Static assets to cache (NOT HTML)
const STATIC_ASSETS = [
    '/icon.jpg',
    '/manifest.json'
];

// ============================================
// INSTALL - Cache only static assets
// ============================================
self.addEventListener('install', event => {
    console.log('🔧 SW: Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('📦 SW: Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('✅ SW: Installed');
                return self.skipWaiting();
            })
            .catch(err => {
                console.error('❌ SW: Install failed:', err);
            })
    );
});

// ============================================
// ACTIVATE - Clean up old caches
// ============================================
self.addEventListener('activate', event => {
    console.log('🔄 SW: Activating...');
    event.waitUntil(
        caches.keys()
            .then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => {
                        if (cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE) {
                            console.log('🗑️  SW: Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                console.log('✅ SW: Activated');
                return self.clients.claim();
            })
    );
});

// ============================================
// FETCH - Network-first for HTML, cache for static
// ============================================
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    
    // Skip cross-origin requests
    if (url.origin !== location.origin) {
        return;
    }
    
    // NEVER cache HTML files or API endpoints - always fresh from network
    if (event.request.url.includes('.html') || 
        event.request.url.endsWith('/') ||
        event.request.url.includes('/version') ||
        event.request.url.includes('/log-gate-check') ||
        event.request.url.includes('/log-arrival-check') ||
        event.request.url.includes('/upload-to-google-drive') ||
        event.request.url.includes('/submit-report') ||
        event.request.url.includes('/vapid-key') ||
        event.request.url.includes('/subscribe')) {
        
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
                .catch(err => {
                    console.error('SW: Network failed for:', url.pathname);
                    
                    // If offline and requesting HTML, try to serve cached menu as fallback
                    if (event.request.url.includes('.html') || event.request.url.endsWith('/')) {
                        return caches.match('/menu.html').then(response => {
                            if (response) {
                                console.log('📦 SW: Serving cached menu.html (offline mode)');
                                return response;
                            }
                            return new Response('Offline - Please check your connection', {
                                status: 503,
                                statusText: 'Service Unavailable',
                                headers: { 'Content-Type': 'text/plain' }
                            });
                        });
                    }
                    
                    // For API endpoints, return error response
                    return new Response(JSON.stringify({ 
                        success: false, 
                        error: 'Network unavailable' 
                    }), {
                        status: 503,
                        statusText: 'Service Unavailable',
                        headers: { 'Content-Type': 'application/json' }
                    });
                })
        );
        return;
    }
    
    // For static assets (images, manifest, etc) - cache with network-first strategy
    if (event.request.method === 'GET') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Cache successful responses
                    if (response && response.status === 200) {
                        const responseClone = response.clone();
                        caches.open(RUNTIME_CACHE).then(cache => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Network failed, try cache
                    return caches.match(event.request).then(cachedResponse => {
                        if (cachedResponse) {
                            console.log('📦 SW: Serving cached:', url.pathname);
                            return cachedResponse;
                        }
                        console.error('SW: Cache miss for:', url.pathname);
                        throw new Error('Network and cache both unavailable');
                    });
                })
        );
    }
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================
self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : { title: 'Fleet Alert', body: 'New notification' };
    console.log('📬 SW: Push notification received:', data.title);
    
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/icon.jpg',
            badge: '/icon.jpg',
            vibrate: [200, 100, 200],
            tag: 'fleet-notification',
            requireInteraction: false
        })
    );
});

self.addEventListener('notificationclick', event => {
    console.log('👆 SW: Notification clicked');
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});

// ============================================
// MESSAGE - Handle commands from pages
// ============================================
self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        console.log('⚡ SW: Skipping waiting...');
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'CLEAR_CACHE') {
        console.log('🗑️  SW: Clearing all caches...');
        event.waitUntil(
            caches.keys().then(cacheNames => {
                return Promise.all(
                    cacheNames.map(cacheName => caches.delete(cacheName))
                );
            })
        );
    }
});

console.log('🚀 SW: Loaded and ready');
