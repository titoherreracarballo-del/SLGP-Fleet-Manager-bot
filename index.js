const express = require('express');
const path = require('path');
const app = express();

// Use Railway's dynamic port, or 8080 for local testing
const PORT = process.env.PORT || 8080;

// Serve all static files (HTML, CSS, images) from the root folder
app.use(express.static(__dirname));

// Send the index.html file to visitors
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Bind to 0.0.0.0 for Railway compatibility
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is live on port ${PORT}`);
});
