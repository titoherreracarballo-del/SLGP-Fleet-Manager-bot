const CACHE_NAME = 'slgp-fleet-v2.0.0';
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

// Install Event
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
    );
    self.skipWaiting();
});

// Fetch Event (Network First, Cache Fallback)
self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Clone the response
                const responseToCache = response.clone();
                
                caches.open(CACHE_NAME)
                    .then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});

// Activate Event (Clean Old Caches)
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    return self.clients.claim();
});

// Push Notification Handler
self.addEventListener('push', event => {
    const data = event.data.json();
    
    const options = {
        body: data.body,
        icon: data.icon || '/icon.jpg',
        badge: data.badge || '/icon.jpg',
        vibrate: [200, 100, 200],
        data: {
            dateOfArrival: Date.now(),
            primaryKey: 1
        },
        actions: [
            {
                action: 'open',
                title: 'Open Portal'
            },
            {
                action: 'close',
                title: 'Dismiss'
            }
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
        event.waitUntil(
            clients.openWindow('/')
        );
    }
});
