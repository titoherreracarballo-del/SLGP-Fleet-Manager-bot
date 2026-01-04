const CACHE_NAME = 'slgp-v12';
const ASSETS = ['/', 'index.html', 'video.html', 'menu.html', 'Final-01.jpg', 'manifest.json'];

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});

// TRIGGERED BY THE 1.5-SECOND REDIRECT IN VIDEO.HTML
self.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'FORCE_SYNC') {
        event.waitUntil(uploadVideoFromDB());
    }
});

self.addEventListener('sync', (e) => {
    if (e.tag === 'video-upload') e.waitUntil(uploadVideoFromDB());
});

async function uploadVideoFromDB() {
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('FleetVideoDB', 1);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = () => reject("DB Error");
    });

    const tx = db.transaction('videos', 'readonly');
    const store = tx.objectStore('videos');
    const record = await new Promise(r => {
        store.get('currentVideo').onsuccess = e => r(e.target.result);
    });

    if (!record) return;

    const fd = new FormData();
    const videoFile = new File([record.file], 'inspection.mp4', { type: 'video/mp4' });
    fd.append('video', videoFile);
    fd.append('driverName', record.driver);
    fd.append('vin', record.vin);
    fd.append('inspectionType', record.type);

    try {
        const res = await fetch('/upload-to-google-drive', { 
            method: 'POST', 
            body: fd,
            keepalive: true 
        });

        if (res.ok) {
            const delTx = db.transaction('videos', 'readwrite');
            delTx.objectStore('videos').delete('currentVideo');
        }
    } catch (err) {
        throw err; // Forces retry when signal is better
    }
}
