const CACHE_NAME = 'slgp-v2'; // Bumped version to ensure update
const ASSETS = ['/', 'index.html', 'video.html', 'menu.html', 'Final-01.jpg', 'manifest.json'];

// --- 1. EXISTING CACHING LOGIC (Keep this) ---
self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    // Only cache GET requests, ignore POST (like report submissions)
    if (e.request.method !== 'GET') return;
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});

// --- 2. NEW PUSH NOTIFICATION LOGIC (Add this) ---

self.addEventListener('push', function(event) {
    let data = { title: "New Alert", body: "Check the portal." };
    
    if (event.data) {
        data = event.data.json();
    }

    const options = {
        body: data.body,
        icon: '/icon.jpg', // Ensure you have this file
        badge: '/icon.jpg',
        vibrate: [100, 50, 100],
        data: {
            dateOfArrival: Date.now()
        },
        actions: [
            {action: 'explore', title: 'View Alert'}
        ]
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    // This opens the portal when they click the notification
    event.waitUntil(
        clients.openWindow('/')
    );
});
