const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const app = express();

// Use Railway's dynamic port to prevent "Application failed to respond"
const port = process.env.PORT || 3000;

// Ensure the 'public' directory exists for file storage
const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)){
    fs.mkdirSync(publicPath);
}

// Middleware
app.use(fileUpload());
app.use('/files', express.static(publicPath));

// Simple Upload Interface
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>SLGP Mesh Uploader</title></head>
      <body>
        <h2>SLGP Mesh Uploader</h2>
        <p>Use this to host files larger than 25MB for Discord.</p>
        <form action="/upload" method="POST" enctype="multipart/form-data">
          <input type="file" name="meshFile" required />
          <button type="submit">Upload to slgpmeshserver.com</button>
        </form>
      </body>
    </html>
  `);
});

// File Upload Logic
app.post('/upload', (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send('No files were uploaded.');
  }

  let meshFile = req.files.meshFile;
  let uploadPath = path.join(publicPath, meshFile.name);

  meshFile.mv(uploadPath, (err) => {
    if (err) return res.status(500).send(err);
    
    // Generates the link for you to paste into Discord
    const fileLink = `https://slgpmeshserver.com/files/${encodeURIComponent(meshFile.name)}`;
    res.send(`
      <h3>Upload Successful!</h3>
      <p>Discord Link: <a href="${fileLink}">${fileLink}</a></p>
      <button onclick="window.location.href='/'">Upload Another</button>
    `);
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Mesh server is live and listening on port ${port}`);
});