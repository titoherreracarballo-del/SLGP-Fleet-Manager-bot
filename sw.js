const CACHE_NAME = 'slgp-fleet-v3.0.0'; // NEW VERSION
const urlsToCache = [
    '/',
    '/menu.html',
    '/report-issue.html',
    '/accident.html',
    '/video.html',
    '/insurance.html',
    '/success.html',
    '/alerts.html',
    '/Final-01.jpg',
    '/icon.jpg',
    '/fleet.jpg',
    '/issue.jpg',
    '/accident.jpg',
    '/insurance.jpg'
];

// Install Event - Force immediate activation
self.addEventListener('install', event => {
    console.log('🔄 Service Worker v3.0.0: Installing & Clearing Old Cache');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            // Delete ALL old caches immediately
            return Promise.all(
                cacheNames.map(cacheName => {
                    console.log('Deleting cache:', cacheName);
                    return caches.delete(cacheName);
                })
            );
        }).then(() => {
            // Create fresh cache
            return caches.open(CACHE_NAME).then(cache => {
                console.log('Creating fresh cache');
                return cache.addAll(urlsToCache);
            });
        })
    );
    self.skipWaiting(); // Activate immediately
});

// Activate Event
self.addEventListener('activate', event => {
    console.log('✅ Service Worker v3.0.0: Activated');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    return self.clients.claim(); // Take control of all pages immediately
});

// Fetch Event - Network first
self.addEventListener('fetch', event => {
    if (!event.request.url.startsWith('http')) {
        return;
    }
    
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (!response || response.status !== 200) {
                    return response;
                }
                
                const responseToCache = response.clone();
                caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseToCache);
                });
                
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});

// Push Notification Handler
self.addEventListener('push', event => {
    const data = event.data.json();
    const options = {
        body: data.body,
        icon: data.icon || '/icon.jpg',
        badge: data.badge || '/icon.jpg',
        vibrate: [200, 100, 200],
        data: { dateOfArrival: Date.now(), primaryKey: 1 },
        actions: [
            { action: 'open', title: 'Open Portal' },
            { action: 'close', title: 'Dismiss' }
        ]
    };
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Notification Click Handler
self.addEventListener('notificationclick', event => {
    event.notification.close();
    if (event.action === 'open') {
        event.waitUntil(clients.openWindow('/'));
    }
});
