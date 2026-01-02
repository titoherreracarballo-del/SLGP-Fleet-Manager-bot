const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- 1. PERSISTENT VOLUME CONFIGURATION ---
// Restoring connection to your Railway Volume for safe storage
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');

// Ensure the directory exists in the volume
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({ dest: UPLOAD_DIR });

// --- 2. MIDDLEWARE ---
// Explicitly serve static files like icons and images
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- 3. NAVIGATION ROUTES (Fixes code showing on screen) ---
// These routes tell the server EXACTLY which file to show
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'menu.html'));
});

app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

app.get('/report', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});

// --- 4. AUTHENTICATION (Using Railway Variables) ---
let auth;
try {
    auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GCP_SA_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) { 
    console.error("CRITICAL: Auth Failed. Check GCP_SA_KEY."); 
}

// =========================================================
// SECTION A: ORIGINAL VIDEO LOGIC (WORKING - SEPARATE)
// =========================================================
const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video file.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;

        // Create stream from file on Railway Volume
        await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Video Saved to Original Volume');
    } catch (error) {
        res.status(500).send(`Video Failure: ${error.message}`);
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
        
        // 1. Create unique folder in reporting destination
        const folder = await drive.files.create({
            resource: { 
                name: `${data.driverName} - ${data.priorityLevel.toUpperCase()}`, 
                mimeType: 'application/vnd.google-apps.folder', 
                parents: [REPORT_DRIVE_ID] 
            },
            fields: 'id'
        });
        const subFolderId = folder.data.id;

        // 2. Upload any photos included in the report
        const allPhotos = [...data.highPhotos, ...data.lowPhotos, ...data.edvPhotos, ...data.mphPhotos, ...data.accidentPhotos];
        for (let photo of allPhotos) {
            const buffer = Buffer.from(photo.data, 'base64');
            const bs = new stream.PassThrough();
            bs.end(buffer);
            await drive.files.create({
                resource: { name: photo.name, parents: [subFolderId] },
                media: { mimeType: 'image/jpeg', body: bs }
            });
        }

        // 3. Generate Summary PDF
        const doc = await PDFDocument.create();
        const page = doc.addPage([600, 800]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        page.drawText(`SLGP REPORT: ${data.priorityLevel.toUpperCase()}`, { x: 50, y: 750, size: 18, font });
        page.drawText(`Driver: ${data.driverName}`, { x: 50, y: 720, size: 12, font });

        const pdfPath = path.join(UPLOAD_DIR, `summary-${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        // 4. Send Routing Emails
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: (data.priorityLevel === 'accident') ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'] : ['slgpfleetmanager@gmail.com'],
            subject: `REPORT: ${data.priorityLevel.toUpperCase()} - ${data.driverName}`,
            text: `Files Link: https://drive.google.com/drive/folders/${subFolderId}`,
            attachments: [{ filename: 'Summary.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SYSTEMS ONLINE: Port ${PORT}`));
