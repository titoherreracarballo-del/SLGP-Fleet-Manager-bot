// --- LOAD SYSTEM MODULES ---
const express = require('express');
const path = require('path');
const app = express();

// --- SERVER PORT CONFIGURATION ---
// Railway provides the PORT automatically. We use 8080 as a backup.
const PORT = process.env.PORT || 8080;

// --- STATIC FILE DELIVERY ---
// This tells the server to allow access to your images, CSS, and script files.
app.use(express.static(__dirname));

// --- PRIMARY ROUTE ---
// When someone visits slgpmeshserver.com, the server sends the index.html file.
app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- START LISTENING ---
// We bind to '0.0.0.0' so the public internet can reach the site.
app.listen(PORT, '0.0.0.0', function() {
    console.log('-------------------------------------------');
    console.log('FLEET HEALTH CHECK SERVER IS ONLINE');
    console.log('Current Port: ' + PORT);
    console.log('-------------------------------------------');
});
