const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument } = require('pdf-lib');

const app = express();

// --- 1. THE TRAFFIC CONTROLLER ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// FIXES "Cannot GET /" - Routes users to the main menu
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));

// --- 2. THE SHARED KEY (Railway Variable) ---
let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: Authenticated via GCP_SA_KEY.");
} catch (err) {
    console.error("CRITICAL AUTH ERROR: Check your Railway Variables.");
}

// --- 3. THE VOLUME STORAGE (For Videos and PDF temporary work) ---
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'temp_storage');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

// =========================================================
// SECTION A: INDEPENDENT VIDEO LOGIC (Original Destination)
// =========================================================
const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    console.log(">>> Processing Video for Folder:", VIDEO_DRIVE_ID);
    try {
        if (!req.file) return res.status(400).send('No video received.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;

        await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Video Saved to Original Folder');
    } catch (error) {
        res.status(500).send(`Video Failure: ${error.message}`);
    }
});

// =========================================================
// SECTION B: INDEPENDENT REPORT LOGIC (New Destination)
// =========================================================
const REPORT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';

app.post('/submit-report', async (req, res) => {
    console.log(">>> Processing Report for Folder:", REPORT_DRIVE_ID);
    const data = req.body;
    try {
        const drive = google.drive({ version: 'v3', auth });
        
        // 1. Create Folder specifically in the Reporting destination
        const folder = await drive.files.create({
            resource: { name: `${data.driverName} - Report`, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_DRIVE_ID] },
            fields: 'id'
        });

        // 2. Build PDF in the Volume
        const doc = await PDFDocument.create();
        doc.addPage([600, 800]).drawText(`SLGP REPORT: ${data.driverName}`, { x: 50, y: 750 });
        const pdfPath = path.join(UPLOAD_DIR, `report-${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        // 3. Email to Fleet Manager
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: (data.priorityLevel === 'accident') ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'] : ['slgpfleetmanager@gmail.com'],
            subject: `New Report: ${data.driverName}`,
            text: `Report Link: https://drive.google.com/drive/folders/${folder.data.id}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SYSTEMS ONLINE PORT ${PORT}`));
