// SLGP Fleet Bot Service Worker
// Handles push notifications for background upload retry
// and offline caching

const CACHE_NAME = 'slgp-v1';

// ── Push notification handler ─────────────────────────────────────────────────
// Server sends push when HR wants to trigger retry of a stuck upload
self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : {};
    
    if (data.type === 'RETRY_UPLOAD') {
        // Trigger background sync to retry pending uploads
        event.waitUntil(
            self.registration.sync.register('retry-pending-uploads')
                .catch(() => {
                    // Background sync not supported — send message to open tabs
                    return self.clients.matchAll({ type: 'window' })
                        .then(clients => clients.forEach(c => 
                            c.postMessage({ type: 'RETRY_UPLOADS' })
                        ));
                })
        );
    }
    
    if (data.showNotification) {
        event.waitUntil(
            self.registration.showNotification('SLGP Fleet', {
                body: data.body || 'Retrying video upload...',
                icon: '/Final-01.jpg',
                badge: '/Final-01.jpg',
                tag: 'slgp-retry',
                silent: true, // Don't make noise — driver might be driving
            })
        );
    }
});

// ── Background sync handler ────────────────────────────────────────────────────
self.addEventListener('sync', event => {
    if (event.tag === 'retry-pending-uploads') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window' })
                .then(clients => {
                    if (clients.length > 0) {
                        clients[0].postMessage({ type: 'RETRY_UPLOADS' });
                    }
                })
        );
    }
});

// ── Notification click ─────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then(clients => {
            if (clients.length > 0) return clients[0].focus();
            return self.clients.openWindow('/');
        })
    );
});

// ── Install/activate ───────────────────────────────────────────────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
