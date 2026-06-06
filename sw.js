// SLGP Fleet Bot Service Worker v2
// Handles Background Fetch, push notifications, and offline retry

const CACHE_NAME = 'slgp-v2';

// ── Background Fetch success ──────────────────────────────────────────────────
// Fires when OS completes the upload — even if app was closed or phone restarted
self.addEventListener('backgroundfetchsuccess', (event) => {
    const bgFetch = event.registration;
    event.waitUntil(async function() {
        try {
            const records  = await bgFetch.matchAll();
            const response = await records[0].responseReady;

            if (response.ok) {
                const data = await response.json().catch(() => ({}));

                // Notify the app to clear pending entry
                const clients = await self.clients.matchAll({ type: 'window' });
                clients.forEach(c => c.postMessage({
                    type:    'BG_FETCH_COMPLETE',
                    id:      bgFetch.id,
                    success: true,
                    jobId:   data.jobId,
                }));

                // Push notification to driver
                await self.registration.showNotification('SLGP Fleet ✅', {
                    body:   'Walk-around video uploaded successfully!',
                    icon:   '/Final-01.jpg',
                    badge:  '/Final-01.jpg',
                    tag:    'slgp-upload-' + bgFetch.id,
                    silent: false,
                    data:   { jobId: data.jobId },
                });
            } else {
                throw new Error('Upload response not OK: ' + response.status);
            }
        } catch(e) {
            console.error('[SW] Background fetch success handler error:', e);
            // Move to retry queue
            const clients = await self.clients.matchAll({ type: 'window' });
            clients.forEach(c => c.postMessage({
                type:    'BG_FETCH_COMPLETE',
                id:      bgFetch.id,
                success: false,
                error:   e.message,
            }));
        }
    }());
});

// ── Background Fetch failure ───────────────────────────────────────────────────
// Fires when OS gave up — keep in IndexedDB retry queue
self.addEventListener('backgroundfetchfail', (event) => {
    const bgFetch = event.registration;
    event.waitUntil(async function() {
        console.warn('[SW] Background fetch failed:', bgFetch.id);

        // Notify app — it will retry from IndexedDB
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(c => c.postMessage({
            type:    'BG_FETCH_COMPLETE',
            id:      bgFetch.id,
            success: false,
            error:   'Background upload failed — will retry when signal returns',
        }));

        // Show notification so driver knows
        await self.registration.showNotification('SLGP Fleet ⏳', {
            body:   'Upload paused — will resume when connected',
            icon:   '/Final-01.jpg',
            tag:    'slgp-retry-' + bgFetch.id,
            silent: true,
        });
    }());
});

// ── Background Fetch abort ─────────────────────────────────────────────────────
self.addEventListener('backgroundfetchabort', (event) => {
    console.warn('[SW] Background fetch aborted:', event.registration.id);
});

// ── Push notification handler ─────────────────────────────────────────────────
self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : {};

    if (data.type === 'RETRY_UPLOAD') {
        event.waitUntil(
            self.registration.sync.register('retry-pending-uploads')
                .catch(() => {
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
                body:   data.body || 'Retrying video upload...',
                icon:   '/Final-01.jpg',
                badge:  '/Final-01.jpg',
                tag:    'slgp-retry',
                silent: true,
            })
        );
    }
});

// ── Background Sync handler ────────────────────────────────────────────────────
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

// ── Install / activate ─────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));
