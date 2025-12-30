const express = require('express');
const path = require('path');
const app = express();

// Use the dynamic port provided by Railway
const PORT = process.env.PORT || 8080;

// Tell the server where to find your files
app.use(express.static(__dirname));

// Route to serve your website
app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start the server and bind to 0.0.0.0
app.listen(PORT, '0.0.0.0', function() {
    console.log('-----------------------------------');
    console.log('SERVER IS RUNNING ON PORT: ' + PORT);
    console.log('-----------------------------------');
});
