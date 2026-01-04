const CACHE_NAME = 'slgp-v3';
const ASSETS = [
  'index.html',
  'Final-01.jpg',
  'manifest.json'
];

// 1. FORCE UPDATE: Kicks out the old version immediately
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (event) => {
    // Take control of all tabs immediately
    event.waitUntil(self.clients.claim());
});

// 2. FETCH: Offline support for pages
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});

// 3. BACKGROUND SYNC: Handles the video upload when signal returns
self.addEventListener('sync', (event) => {
    if (event.tag === 'video-upload') {
        event.waitUntil(uploadVideoFromDB());
    }
});

async function uploadVideoFromDB() {
    const db = await new Promise((resolve) => {
        const req = indexedDB.open('FleetVideoDB', 1);
        req.onsuccess = e => resolve(e.target.result);
    });

    const tx = db.transaction('videos', 'readonly');
    const record = await new Promise((resolve) => {
        tx.objectStore('videos').get('currentVideo').onsuccess = e => resolve(e.target.result);
    });

    if (!record) return;

    const formData = new FormData();
    formData.append('video', record.file, 'inspection.mp4');
    formData.append('driverName', record.driver);
    formData.append('vin', record.vin);
    formData.append('inspectionType', record.type);

    try {
        const response = await fetch('/upload-to-google-drive', { 
            method: 'POST', 
            body: formData 
        });

        if (response.ok) {
            const delTx = db.transaction('videos', 'readwrite');
            delTx.objectStore('videos').delete('currentVideo');
            console.log("Sync Success");
        } else {
            throw new Error('Server Error');
        }
    } catch (error) {
        console.error("Sync Failed, Retrying later", error);
        throw error; 
    }
}
