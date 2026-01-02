const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();

// --- 1. CONFIGURATION ---
// Using the mount path from your Railway Connection settings
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');

// Ensure the directory exists in the volume
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOAD_DIR });

// --- 2. MIDDLEWARE & STATIC FILES ---
// This allows icons and CSS to load correctly
app.use(express.static(__dirname)); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 3. NAVIGATION ROUTES (Fixes "Cannot GET" Errors) ---
// Sends menu.html when visiting the root domain
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'menu.html'));
});

// Sends video.html when visiting /video
app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

// Sends report.html when visiting /report
app.get('/report', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});

// --- 4. AUTHENTICATION & VIDEO UPLOAD ---
// Uses your existing Railway GCP_SA_KEY variable
let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY invalid or missing.");
}

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video received.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;

        await drive.files.create({
            resource: { name: finalFileName, parents: [process.env.GDRIVE_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');
    } catch (error) {
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on ${PORT}`));
