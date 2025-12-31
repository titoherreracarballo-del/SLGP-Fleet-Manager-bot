const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Folder ID for "Daily Fleet Health Checks" inside the Shared Drive
const DRIVE_FOLDER_ID = '1ldYUYV0BO2nEJ23GHKK5qN1o2';

let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY parsing failed.");
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file received.');

        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType, serviceType } = req.body;
        
        const fileMetadata = {
            name: `${vin}_${inspectionType.toUpperCase()}_${driverName}_${serviceType}.mp4`,
            parents: [DRIVE_FOLDER_ID],
        };

        const media = {
            mimeType: 'video/mp4',
            body: fs.createReadStream(req.file.path),
        };

        // --- SHARED DRIVE SUPPORT ACTIVATED ---
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
            // Mandatory for Shared Drives and Service Account fixes
            supportsAllDrives: true, 
            supportsTeamDrives: true
        });

        console.log(`SYNC SUCCESS: File ID ${response.data.id}`);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("UPLOAD ERROR DETAILS:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

// Port binding for Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`SLGP SERVER v1.2.5 LIVE ON PORT: ${PORT}`);
});
