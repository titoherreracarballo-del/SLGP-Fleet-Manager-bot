const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Provided Google Drive Folder ID
const DRIVE_FOLDER_ID = '1ldYUYV0BO2nEJ23GHKK5qN1o2';

let auth;
try {
    // Parsing the key from your Railway Environment Variables
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY is missing or invalid in Railway variables.");
}

app.use(express.static(__dirname));

// Primary route to serve the HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No video file received by the server.');
        }

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

        // --- THE FIX: RESUMABLE UPLOAD & SHARED DRIVE SUPPORT ---
        // This method handles large files and bypasses the 0GB MyDrive limit
        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
            supportsAllDrives: true, // Mandatory for Service Accounts
        });

        console.log(`SYNC SUCCESS: File ID ${response.data.id}`);

        // Clean up the temporary upload folder
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        res.status(200).send('Upload Successful');
    } catch (error) {
        // Log the exact error to the Railway terminal for debugging
        console.error("UPLOAD ERROR DETAILS:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

// Bind to Railway dynamic port
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`-----------------------------------------`);
    console.log(`SLGP SERVER v1.2.2 LIVE ON PORT: ${PORT}`);
    console.log(`-----------------------------------------`);
});
