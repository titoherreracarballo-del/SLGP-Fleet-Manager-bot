const express = require('express');
const fileUpload = require('express-fileupload');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// 1. Authenticate with Google Workspace
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-credentials.json'),
    scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth });

app.use(fileUpload({ useTempFiles: true, tempFileDir: '/tmp/' }));

// 2. Main SLGP Dashboard UI (v1.0.9)
app.get('/', (req, res) => {
    // [The HTML we built for your Fleet Health Check dashboard]
    res.send("<h1>SLGP Mesh Live: Ready for 25MB+ Uploads</h1>"); 
});

// 3. The Automatic Sync Logic
app.post('/upload', async (req, res) => {
    if (!req.files || !req.files.meshFile) return res.status(400).send('No file.');
    
    const file = req.files.meshFile;
    const fileMetadata = {
        'name': file.name,
        'parents': ['1ldYUYV0BO2nEJ23GHKK5qN1o2'] // Your confirmed Folder ID
    };

    try {
        const response = await drive.files.create({
            resource: fileMetadata,
            media: { mimeType: file.mimetype, body: fs.createReadStream(file.tempFilePath) },
            fields: 'id, webViewLink',
        });
        
        // Success: Link bypasses Discord's 25MB limit
        res.send({ status: "Sync Successful", link: response.data.webViewLink });
    } catch (err) {
        console.error(err);
        res.status(500).send("Upload failed. Verify folder permissions.");
    }
});

app.listen(port, '0.0.0.0', () => console.log(`SLGP Mesh active on port ${port}`));