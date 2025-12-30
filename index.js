const express = require('express');
const path = require('path');
const app = express();

// Use Railway's dynamic port
const PORT = process.env.PORT || 8080;

// Serve files from the root directory
app.use(express.static(__dirname));

// Ensure the root path sends your HTML file
app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Bind to 0.0.0.0 for external access
app.listen(PORT, '0.0.0.0', function() {
    console.log('FLEET HEALTH CHECK SERVER RUNNING ON PORT: ' + PORT);
});
