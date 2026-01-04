const CACHE_NAME = 'slgp-v6';
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

// LISTENER FOR THE "FORCE NUDGE" FROM VIDEO.HTML
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'FORCE_SYNC') {
        console.log("Forced Sync Triggered");
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
    const record = await new Promise(r => {
        tx.objectStore('videos').get('currentVideo').onsuccess = e => r(e.target.result);
    });
    if (!record) return;

    const fd = new FormData();
    fd.append('video', record.file, 'inspection.mp4');
    fd.append('driverName', record.driver);
    fd.append('vin', record.vin);
    fd.append('inspectionType', record.type);

    try {
        const res = await fetch('/upload-to-google-drive', { method: 'POST', body: fd });
        if (res.ok) {
            const delTx = db.transaction('videos', 'readwrite');
            delTx.objectStore('videos').delete('currentVideo');
            console.log("Background Upload Complete");
        }
    } catch (err) { console.error("Sync failed, retrying later..."); throw err; }
}
