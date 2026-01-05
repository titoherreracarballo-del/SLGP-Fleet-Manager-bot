/* SERVICE WORKER (sw.js)
   Handles background Push Notifications even when the app is closed.
*/

self.addEventListener('push', function(event) {
    console.log('[Service Worker] Push Received.');

    // Default data in case the server sends nothing
    let data = { 
        title: 'Fleet Alert', 
        body: 'New notification received.' 
    };

    // Try to parse the data sent from the server
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            // If it's just text, use it as the body
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: 'icon.jpg',    // The icon you have in your manifest
        badge: 'icon.jpg',   // Small icon for the Android status bar
        vibrate: [200, 100, 200], // Vibration pattern: Vibrate-Pause-Vibrate
        tag: 'fleet-alert',  // grouping notifications
        renotify: true       // Vibrate again even if an old alert is still visible
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    console.log('[Service Worker] Notification click received.');

    event.notification.close(); // Close the notification

    // Open the app or focus the window if it's already open
    event.waitUntil(
        clients.matchAll({type: 'window'}).then(function(clientList) {
            // 1. Look for an open window to focus
            for (var i = 0; i < clientList.length; i++) {
                var client = clientList[i];
                // Check if your app is open (root URL '/')
                if (client.url.includes('/') && 'focus' in client) {
                    return client.focus();
                }
            }
            // 2. If no window is open, open a new one
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});
