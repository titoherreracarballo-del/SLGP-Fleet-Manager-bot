const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument } = require('pdf-lib');

const app = express();

// --- VOLUME CONFIGURATION ---
// Explicitly using the mount path from your Railway settings
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');

// Ensure the directory exists in the volume
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer configured to use the Volume for storage
const upload = multer({ dest: UPLOAD_DIR });

// --- MIDDLEWARE & STATIC FILES ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- NAVIGATION ROUTES (Fixes "Cannot GET" Errors) ---
// This serves your menu when visiting the main domain
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'menu.html'));
});

app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

app.get('/report', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});

// --- AUTHENTICATION ---
let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY missing.");
}

// =========================================================
// SECTION A: ORIGINAL VIDEO LOGIC (SEPARATE)
// =========================================================
const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video received.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;

        // Create stream from the file stored in the Railway Volume
        await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("VIDEO ERROR:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

// =========================================================
// SECTION B: NEW REPORT LOGIC (SEPARATE)
// =========================================================
const REPORT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';

app.post('/submit-report', async (req, res) => {
    const data = req.body;
    try {
        const drive = google.drive({ version: 'v3', auth });
        const folderName = `${data.driverName} - ${new Date().toLocaleDateString()}`;
        
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_DRIVE_ID] },
            fields: 'id'
        });

        const doc = await PDFDocument.create();
        const page = doc.addPage([600, 800]);
        page.drawText(`SLGP INCIDENT REPORT: ${data.driverName}`, { x: 50, y: 750, size: 20 });
        
        const pdfBytes = await doc.save();
        const pdfPath = path.join(UPLOAD_DIR, `report-${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, pdfBytes);

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: (data.priorityLevel === 'accident') ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'] : ['slgpfleetmanager@gmail.com'],
            subject: `New Report: ${data.driverName}`,
            text: `Files: https://drive.google.com/drive/folders/${folder.data.id}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server LIVE`));
