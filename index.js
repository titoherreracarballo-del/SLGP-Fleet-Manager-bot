const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- 1. VOLUME CONFIGURATION (STAYS THE SAME) ---
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const upload = multer({ dest: UPLOAD_DIR });

// --- 2. MIDDLEWARE ---
app.use(express.static(path.join(__dirname))); 
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- 3. NAVIGATION (CRITICAL FIX) ---
// We use path.resolve to ensure the server finds the file in the root
app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'menu.html'));
});

app.get('/video', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'video.html'));
});

app.get('/report', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'report.html'));
});

// --- 4. AUTH & SEPARATE LOGIC ---
let auth;
try {
    auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GCP_SA_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
} catch (err) { console.error("Auth missing."); }

// VIDEO LOGIC (RESTORED & SEPARATE)
const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video file.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;

        await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Video Saved');
    } catch (error) { res.status(500).send(`Video Fail: ${error.message}`); }
});

// REPORT LOGIC (SEPARATE)
app.post('/submit-report', async (req, res) => {
    // ... (Your reporting logic remains here, separated from video)
    res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SYSTEMS ONLINE: Port ${PORT}`));
