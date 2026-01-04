// --- 1. CONFIGURATION & CACHING ---
const CACHE_NAME = 'slgp-v4'; // Incremented version to trigger update
const ASSETS = [
  '/',
  'index.html',
  'video.html',
  'menu.html',
  'Final-01.jpg',
  'manifest.json'
];

// --- 2. AUTO-UPDATE & TAKEOVER LOGIC ---
// These listeners ensure the new code kills the old code immediately
self.addEventListener('install', (event) => {
    self.skipWaiting(); // Force the new service worker to become active
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('Caching assets for offline use');
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('activate', (event) => {
    // Force the new worker to take control of all open tabs immediately
    event.waitUntil(self.clients.claim());
    
    // Cleanup old caches
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            );
        })
    );
});

// --- 3. OFFLINE SUPPORT (FETCH) ---
self.addEventListener('fetch', (event) => {
    // Ignore non-GET requests (like uploads) so they don't break
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then(cachedResponse => {
            return cachedResponse || fetch(event.request);
        })
    );
});

// --- 4. BACKGROUND SYNC (The "Samsung Fix") ---
self.addEventListener('sync', (event) => {
    if (event.tag === 'video-upload') {
        console.log("Internet detected! Starting background upload...");
        event.waitUntil(uploadVideoFromDB());
    }
});

async function uploadVideoFromDB() {
    // A. Open Database
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('FleetVideoDB', 1);
        request.onsuccess = e => resolve(e.target.result);
        request.onerror = e => reject("Could not open DB in background");
    });

    // B. Retrieve Video Record
    const tx = db.transaction('videos', 'readonly');
    const store = tx.objectStore('videos');
    const record = await new Promise((resolve) => {
        const getReq = store.get('currentVideo');
        getReq.onsuccess = () => resolve(getReq.result);
    });

    if (!record) {
        console.log("No pending video found in database.");
        return;
    }

    // C. Prepare Form Data (Matches your index.js)
    const formData = new FormData();
    formData.append('video', record.file, 'inspection.mp4');
    formData.append('driverName', record.driver);
    formData.append('vin', record.vin);
    formData.append('inspectionType', record.type);

    // D. The Upload
    try {
        const response = await fetch('/upload-to-google-drive', {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            console.log("Background upload to Google Drive SUCCESSFUL.");
            // Delete from phone memory now that it's safe in Drive
            const delTx = db.transaction('videos', 'readwrite');
            delTx.objectStore('videos').delete('currentVideo');
        } else {
            console.error("Server error during background sync:", response.status);
            throw new Error("Server error"); // This triggers a retry later
        }
    } catch (error) {
        console.error("Background sync failed (will retry when signal improves):", error);
        throw error; // Essential: tells the phone to try again later
    }
}
