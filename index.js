const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const app = express();

// Use Railway's assigned port or default to 3000 for local testing
const port = process.env.PORT || 3000;

app.use(fileUpload());
app.use('/files', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send('<h2>SLGP Mesh Uploader</h2><form action="/upload" method="POST" enctype="multipart/form-data"><input type="file" name="meshFile" /><button type="submit">Upload</button></form>');
});

app.post('/upload', (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) return res.status(400).send('No files selected.');
  let meshFile = req.files.meshFile;
  meshFile.mv(path.join(__dirname, 'public', meshFile.name), (err) => {
    if (err) return res.status(500).send(err);
    res.send(`File uploaded! https://slgpmeshserver.com/files/${meshFile.name}`);
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
});