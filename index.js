// --- LOAD NECESSARY MODULES ---
const express = require('express');
const path = require('path');
const app = express();

// --- CONFIGURE THE SERVER PORT ---
// Use the PORT environment variable provided by Railway (typically 80)
// Defaults to 8080 if running locally for testing
const PORT = process.env.PORT || 8080;

// --- STATIC FILE SERVING ---
// This line tells Express to serve every file (HTML, CSS, images) 
// that is in your root directory to the browser.
app.use(express.static(__dirname));

// --- ROUTE HANDLER ---
// When a user visits your domain (slgpmeshserver.com), 
// the server explicitly sends the index.html file.
app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- START THE SERVER ---
// We bind to '0.0.0.0' to ensure the server is accessible 
// from outside the internal Railway network.
app.listen(PORT, '0.0.0.0', function() {
    console.log('-------------------------------------------');
    console.log('FLEET HEALTH CHECK SERVER IS NOW RUNNING');
    console.log('Listening on Port: ' + PORT);
    console.log('-------------------------------------------');
});
