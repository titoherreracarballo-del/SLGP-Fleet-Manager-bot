const CACHE_NAME = 'slgp-v7';
const ASSETS = ['/', 'index.html', 'video.html', 'menu.html', 'Final-01.jpg', 'manifest.json'];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});

// TRIGGERED BY THE 2-SECOND REDIRECT
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'FORCE_SYNC') {
        event.waitUntil(uploadVideoFromDB());
    }
});

self.addEventListener('sync', (e) => {
    if (e.tag === 'video-upload') e.waitUntil(uploadVideoFromDB());
});

async function uploadVideoFromDB() {
    const db = await new Promise(r => {
        const req = indexedDB.open('FleetVideoDB', 1);
        req.onsuccess = e => r(e.target.result);
    });

    const tx = db.transaction('videos', 'readonly');
    const store = tx.objectStore('videos');
    const record = await new Promise(r => {
        store.get('currentVideo').onsuccess = e => r(e.target.result);
    });

    if (!record) return;

    const fd = new FormData();
    // Re-wrap the file to ensure it's not "stale"
    const videoFile = new File([record.file], 'inspection.mp4', { type: 'video/mp4' });
    fd.append('video', videoFile);
    fd.append('driverName', record.driver);
    fd.append('vin', record.vin);
    fd.append('inspectionType', record.type);

    try {
        console.log("Background Upload: Starting fetch...");
        const res = await fetch('/upload-to-google-drive', { 
            method: 'POST', 
            body: fd,
            // CRITICAL: Tells the browser to keep this fetch alive even if the user leaves
            keepalive: true 
        });

        if (res.ok) {
            console.log("Background Upload: SUCCESS. Clearing DB.");
            const delTx = db.transaction('videos', 'readwrite');
            delTx.objectStore('videos').delete('currentVideo');
        } else {
            console.error("Server returned error:", res.status);
        }
    } catch (err) {
        console.error("Background Upload: Failed (will retry)", err);
        throw err; // Forces the browser to try again when signal is better
    }
}
