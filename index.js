const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- CONFIGURATION ---
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.log("Warning: Could not create upload directory. Using /tmp instead.");
    }
}
const upload = multer({ dest: UPLOAD_DIR });

// --- MIDDLEWARE ---
app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES ---

// 1. Home Menu
app.get('/', (req, res) => {
    // We look for 'menu.html' first, if not found, we try 'index.html'
    if (fs.existsSync(path.join(__dirname, 'menu.html'))) {
        res.sendFile(path.join(__dirname, 'menu.html'));
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// 2. Video Page
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));

// 3. Report Routing (Fixes "Not Found" and "Insurance" errors)
app.get('/report', (req, res) => {
    const mode = req.query.mode;
    
    if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    } 
    else if (mode === 'accident') {
        res.sendFile(path.join(__dirname, 'accident-report.html'));
    } 
    else if (mode === 'insurance') {
        // Placeholder for Insurance to prevent crash
        res.send(`
            <body style="background:#0F1115; color:white; font-family:sans-serif; text-align:center; padding:40px;">
                <h1 style="color:#3B82F6;">INSURANCE UPLOAD</h1>
                <p>This feature is coming soon.</p>
                <a href="/" style="color:#4ade80; text-decoration:none; font-weight:bold;">&larr; Back to Menu</a>
            </body>
        `);
    } 
    else {
        res.status(404).send('Error: Unknown report type.');
    }
});

// --- GOOGLE AUTH ---
let auth;
try {
    if (process.env.GCP_SA_KEY) {
        auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
    }
} catch (err) { console.error("Auth Error:", err.message); }

// --- VIDEO UPLOAD ENGINE ---
const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video file.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        const filename = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;
        
        await drive.files.create({
            resource: { name: filename, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });
        
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Complete');
    } catch (error) { res.status(500).send(`Error: ${error.message}`); }
});

// --- REPORT SUBMISSION ENGINE ---
const REPORT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
app.post('/submit-report', async (req, res) => {
    const data = req.body;
    try {
        const drive = google.drive({ version: 'v3', auth });
        
        // Create Folder
        const folderName = `${data.driverName} - ${data.reportType}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_DRIVE_ID] },
            fields: 'id'
        });
        const folderId = folder.data.id;

        // Upload Photos
        if (data.photos && data.photos.length) {
            for (let i = 0; i < data.photos.length; i++) {
                const buffer = Buffer.from(data.photos[i].data, 'base64');
                const bs = new stream.PassThrough(); 
                bs.end(buffer);
                await drive.files.create({
                    resource: { name: `Photo_${i+1}.jpg`, parents: [folderId] },
                    media: { mimeType: 'image/jpeg', body: bs }
                });
            }
        }

        // Generate PDF
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        let y = 750;
        
        const write = (text) => {
            if (y < 50) { page = doc.addPage([600, 800]); y = 750; }
            page.drawText(text || '', { x: 50, y, size: 12, font });
            y -= 20;
        };

        write(`REPORT: ${data.reportType}`);
        write(`Driver: ${data.driverName}`);
        write(`Date: ${new Date().toLocaleString()}`);
        write('--------------------------------');
        
        if (data.reportType === 'Accident / Incident') {
             write(`Incident: ${data.subType || 'N/A'}`);
             write(`Statement: ${data.statement || 'N/A'}`);
        } else {
             if (data.tags) data.tags.forEach(t => write(`[x] ${t}`));
             write(`Notes: ${data.otherDescription || ''}`);
        }

        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        // Email Routing
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        // Send to different emails based on report type
        const recipients = data.reportType.includes('Accident') 
            ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com']
            : ['slgpfleetmanager@gmail.com'];

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipients,
            subject: `NEW REPORT: ${data.driverName}`,
            text: `Type: ${data.reportType}\n\nFiles: https://drive.google.com/drive/folders/${folderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
