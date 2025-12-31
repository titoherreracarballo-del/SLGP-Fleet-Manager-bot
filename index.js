const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// --- GOOGLE DRIVE CONFIGURATION ---
const FOLDER_ID = '1ldYUYV0BO2nEJ23GHKK5qN1o2';

let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
} catch (err) {
    console.error("CRITICAL: GCP_SA_KEY error. App will crash if this is missing.");
}

app.use(express.static(__dirname));

// Serve index.html explicitly to prevent 404s
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType, serviceType } = req.body;
        
        const fileMetadata = {
            name: `${vin}_${inspectionType.toUpperCase()}_${driverName}_${serviceType}.mp4`,
            parents: [FOLDER_ID],
        };

        const media = {
            mimeType: 'video/mp4',
            body: fs.createReadStream(req.file.path),
        };

        await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });

        fs.unlinkSync(req.file.path); 
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("Upload Error Detail:", error);
        res.status(500).send('Upload Failed');
    }
});

// CRITICAL FIX: Ensure port is correctly read from Railway environment
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`SLGP Server Active on Port ${PORT}`);
});
