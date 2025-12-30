const express = require('express');
const path = require('path');
const app = express();

// Use the PORT provided by Railway, or default to 8080 locally
const PORT = process.env.PORT || 8080;

// Tell the server to serve files from the current folder
app.use(express.static(__dirname));

// Send your index.html file when someone visits your domain
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
