const CACHE_NAME = 'slgp-v1';
const ASSETS = ['/', 'index.html', 'video.html', 'menu.html', 'Final-01.jpg', 'manifest.json'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
});
