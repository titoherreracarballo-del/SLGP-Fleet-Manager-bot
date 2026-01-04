const CACHE_NAME = 'slgp-v2';
const ASSETS = [
  'index.html',
  'Final-01.jpg',
  'manifest.json'
];

// 1. INSTALL: Caches the website files so it works offline
self.addEventListener('install', (e) => {
  self.skipWaiting(); // Forces the new Service Worker to take over immediately
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

// 2. ACTIVATE: claims control immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// 3. FETCH: Loads the page from cache if there is no internet
self.addEventListener('fetch', (e) => {
    // Only cache GET requests (pages/images), ignore POST (uploads)
    if (e.request.method !== 'GET') return;
    
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});

// 4. SYNC: The "Magic" Background Upload for Samsung/Android
// This event fires when the internet connection returns
self.addEventListener('sync', (event) => {
    if (event.tag === 'video-upload') {
        event.waitUntil(uploadVideoFromDB());
    }
});

// --- HELPER FUNCTION: Handles the actual upload logic ---
async function uploadVideoFromDB() {
    // A. Open the internal phone database
    const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('FleetVideoDB', 1);
        req.onsuccess = e => resolve(e.target.result);
        req.onerror = reject;
    });

    // B. Check if there is a video waiting
    const tx = db.transaction('videos', 'readonly');
    const record = await new Promise((resolve) => {
        tx.objectStore('videos').get('currentVideo').onsuccess = e => resolve(e.target.result);
    });

    if (!record) return; // Nothing to upload

    // C. Prepare the data
    const formData = new FormData();
    formData.append('video', record.file, 'inspection.mp4');
    formData.append('driverName', record.driver);
    formData.append('vin', record.vin);
    formData.append('inspectionType', record.type);

    try {
        // D. Send to server
        // IMPORTANT: Ensure this path matches your Flask/PHP/Node route!
        const response = await fetch('/upload-to-google-drive', { 
            method: 'POST', 
            body: formData 
        });

        if (response.ok) {
            console.log("Background upload success!");
            // E. Delete from phone memory after success
            const delTx = db.transaction('videos', 'readwrite');
            delTx.objectStore('videos').delete('currentVideo');
        } else {
            // If server fails, throw error so Android tries again later
            throw new Error('Server upload failed');
        }
    } catch (error) {
        console.error("Upload failed, will retry:", error);
        throw error; // Triggers the 'retry' logic in Android
    }
}
