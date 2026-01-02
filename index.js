const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- 1. VOLUME CONFIGURATION ---
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR });

// --- 2. MIDDLEWARE ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- 3. NAVIGATION ---
// FIX: Pointing back to 'menu.html' as per your original setup
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html'))); 
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));

// ROUTE: Handle Issue & Accident Reports
app.get('/report', (req, res) => {
    const mode = req.query.mode;
    if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    } else if (mode === 'accident') {
        res.sendFile(path.join(__dirname, 'accident-report.html'));
    } else {
        // If the user goes to /report without a mode, try to show the old report.html if it exists, 
        // otherwise show an error.
        if (fs.existsSync(path.join(__dirname, 'report.html'))) {
             res.sendFile(path.join(__dirname, 'report.html'));
        } else {
             res.status(404).send('Error: Report type not specified.');
        }
    }
});

// --- 4. AUTHENTICATION ---
let auth;
try {
    auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GCP_SA_KEY),
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
} catch (err) { console.error("CRITICAL: Auth Error"); }

// =========================================================
// SECTION A: VIDEO ENGINE (LOCKED - DO NOT TOUCH)
// =========================================================
const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
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
        res.status(200).send('Video Upload Successful');
    } catch (error) { res.status(500).send(`Video Failure: ${error.message}`); }
});

// =========================================================
// SECTION B: REPORT ENGINE
// =========================================================
const REPORT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';

app.post('/submit-report', async (req, res) => {
    const data = req.body;
    try {
        const drive = google.drive({ version: 'v3', auth });
        
        // 1. Create Folder
        const folderName = `${data.driverName} - ${data.reportType}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_DRIVE_ID] },
            fields: 'id'
        });
        const subFolderId = folder.data.id;

        // 2. Upload Photos
        if (data.photos && data.photos.length > 0) {
            for (let i = 0; i < data.photos.length; i++) {
                const photo = data.photos[i];
                const bs = new stream.PassThrough();
                bs.end(Buffer.from(photo.data, 'base64'));
                await drive.files.create({
                    resource: { name: `Photo_${i+1}.jpg`, parents: [subFolderId] },
                    media: { mimeType: 'image/jpeg', body: bs }
                });
            }
        }

        // 3. Generate PDF
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
        let y = 750;

        const draw = (txt, size = 12, isBold = false) => { 
            if (y < 50) { page = doc.addPage([600, 800]); y = 750; }
            page.drawText(txt || '', { x: 50, y, size, font: isBold ? boldFont : font }); 
            y -= 20; 
        };

        // PDF Content
        draw('SLGP VEHICLE ASSISTANCE REPORT', 18, true);
        y -= 10;
        draw(`Type: ${data.reportType}`, 14, true);
        draw(`Driver: ${data.driverName}`);
        draw(`Date: ${data.date}   Time: ${data.time}`);
        draw(`VIN: ${data.vinLast4 || 'N/A'}`);
        draw(`GPS: ${data.gpsLat || 'N/A'}, ${data.gpsLng || 'N/A'}`);
        draw('------------------------------------------------------');
        y -= 10;

        if (data.reportType === 'Accident / Incident') {
            draw('INCIDENT DETAILS:', 14, true);
            draw(`Sub-Type: ${data.subType || 'N/A'}`);
            draw(`Weather: ${data.weather || 'N/A'}`);
            draw(`Police Report: ${data.policeReport || 'N/A'}`);
            draw(`LMET Case: ${data.lmetCase || 'N/A'}`);
            y -= 10;
            draw('STATEMENT:', 12, true);
            const words = (data.statement || '').split(' ');
            let line = '';
            for (let word of words) {
                if ((line + word).length > 80) { draw(line); line = ''; }
                line += word + ' ';
            }
            draw(line);
            y -= 20;
        } else {
            draw('REPORTED ISSUES:', 14, true);
            if (data.tags && data.tags.length > 0) {
                data.tags.forEach(tag => draw(`[x] ${tag}`));
            }
            if (data.otherDescription) draw(`Other Notes: ${data.otherDescription}`);
        }

        y -= 20;
        draw('------------------------------------------------------');
        if (data.signature) {
            try {
                const sigImg = await doc.embedPng(Buffer.from(data.signature, 'base64'));
                page.drawImage(sigImg, { x: 50, y: y - 80, width: 200, height: 60 });
                y -= 90;
            } catch (e) { console.log('Signature Error', e); }
        }
        draw(`Signed: ${data.driverName}`);
        draw(`Timestamp: ${new Date().toLocaleString()}`);

        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        // 4. Email
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const isIncident = ['Accident / Incident', 'Road MPH Error'].includes(data.reportType);
        const recipients = isIncident 
            ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'] 
            : ['slgpfleetmanager@gmail.com'];

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipients,
            subject: `REPORT: ${data.reportType} - ${data.driverName}`,
            text: `A new report has been submitted.\n\nType: ${data.reportType}\nDriver: ${data.driverName}\n\nFiles: https://drive.google.com/drive/folders/${subFolderId}`,
            attachments: [{ filename: 'Report_Summary.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("REPORT ERROR:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SYSTEMS ONLINE: Port ${PORT}`));
