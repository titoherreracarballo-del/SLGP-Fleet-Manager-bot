// SLGP Fleet Bot Service Worker v3 — push-to-resume + background fetch
// Handles Background Fetch, push notifications, and offline retry

const CACHE_NAME = 'slgp-v3';

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
        event.waitUntil((async () => {
            // 1) If a window is open (app open or backgrounded), tell it to resume now.
            //    retryPendingUploads() reads the saved video from IndexedDB and, with
            //    resume support, uploads only the chunks the server doesn't already have.
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            if (windows.length > 0) {
                windows.forEach(c => c.postMessage({ type: 'RETRY_UPLOADS' }));
                // Also nudge Background Sync as a belt-and-suspenders retry
                try { await self.registration.sync.register('retry-pending-uploads'); } catch(_) {}
                return;
            }

            // 2) No window open — try Background Sync (Android wakes the SW on connectivity).
            let syncRegistered = false;
            try { await self.registration.sync.register('retry-pending-uploads'); syncRegistered = true; } catch(_) {}

            // 3) App fully closed: a silent push can't run the in-page upload and can't
            //    force the app open. Show a tappable notification so the driver's tap
            //    opens the app, which then auto-resumes from where it stopped. One tap,
            //    no other steps — and it resumes, not restarts.
            await self.registration.showNotification('SLGP Fleet — finish upload', {
                body:    'Tap to finish uploading your walk-around video.',
                icon:    '/Final-01.jpg',
                badge:   '/Final-01.jpg',
                tag:     'slgp-resume',
                silent:  false,
                requireInteraction: true,           // stays until tapped
                data:    { type: 'RESUME_ON_OPEN', submissionId: data.submissionId || null },
            });
        })());
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
    const isResume = event.notification.data?.type === 'RESUME_ON_OPEN';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // If a window exists, focus it and tell it to resume
            for (const c of clients) {
                if ('focus' in c) {
                    c.postMessage({ type: 'RETRY_UPLOADS' });
                    return c.focus();
                }
            }
            // Otherwise open the app; it auto-checks IndexedDB for pending uploads on
            // load (visibilitychange + load both call retryPendingUploads), so opening
            // is enough to resume. Land on the camera page so resume runs there.
            return self.clients.openWindow(isResume ? '/video.html' : '/');
        })
    );
});

// ── Install / activate ─────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));
