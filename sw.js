const CACHE_NAME = 'slgp-v' + Date.now(); // New cache every deploy

self.addEventListener('install', event => {
    console.log('SW: Installing and clearing ALL caches');
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(keys.map(key => caches.delete(key)));
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    console.log('SW: Activated');
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    // NEVER cache HTML files
    if (event.request.url.includes('.html') || event.request.url.endsWith('/')) {
        event.respondWith(
            fetch(event.request, { cache: 'no-store' })
        );
        return;
    }
    
    // For other files, network first
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});

self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : { title: 'Alert', body: 'New notification' };
    event.waitUntil(
        self.registration.showNotification(data.title, {
            body: data.body,
            icon: '/icon.jpg',
            badge: '/icon.jpg',
            vibrate: [200, 100, 200]
        })
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});
```

---

## 🚀 **Deploy Steps:**

1. Add the explicit `app.get('/')` route to index.js
2. Replace `sw.js` with the cache-nuking version above
3. Push to Railway
4. **On your phone:**
   - Go to `chrome://serviceworker-internals/` (Android Chrome)
   - Find `slgpmeshserver.com`
   - Click **"Unregister"**
   - Clear browser cache completely
   - **Restart your phone**
   - Visit the site fresh

---

## 🧪 **Test First on Desktop:**

Before touching your phone, open **Incognito Mode** on desktop and visit:
```
https://slgpmeshserver.com
