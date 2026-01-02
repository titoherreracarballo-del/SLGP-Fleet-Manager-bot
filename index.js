/**
 * SLGP FLEET PORTAL - FINAL PRODUCTION SERVER
 * -------------------------------------------
 * 1. Video Uploads -> Uses Old Logic & Folder
 * 2. Reports -> Uses New Logic & Folder
 * 3. Auth -> Checks Railway Variables first, then File
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- 1. STORAGE CONFIGURATION ---
// We use /tmp/ because it is the only writable folder on Railway
const upload = multer({ 
    dest: '/tmp/', 
    limits: { fileSize: 1024 * 1024 * 1024 } // 1GB Limit
});

// --- 2. CONFIGURATION (HARDCODED SAFEGUARDS) ---
// We force these IDs to ensure no variables are missing
const VIDEO_FOLDER_ID = '0AC1GE3XEm4K9Uk9PVA'; 
const REPORT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';

const EMAIL_USER = process.env.EMAIL_USER || 'strategiclogisticsgroupllc@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'wnSx-72@!'; 
const EMAIL_FLEET = 'slgpfleetmanager@gmail.com';
const LOG_FILE = path.join(__dirname, 'submission_log.json');

// --- 3. AUTHENTICATION ---
function getGoogleAuth() {
    // Attempt 1: Railway Variable
    if (process.env.GCP_SA_KEY) {
        try {
            // Check if key is valid JSON
            const creds = JSON.parse(process.env.GCP_SA_KEY);
            return new google.auth.GoogleAuth({
                credentials: creds,
                scopes: ['https://www.googleapis.com/auth/drive.file'],
            });
        } catch (e) { console.error("AUTH WARNING: GCP_SA_KEY found but invalid.", e.message); }
    }
    
    // Attempt 2: Local File
    const keyPath = path.join(__dirname, 'credentials.json');
    if (fs.existsSync(keyPath)) {
        return new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
    }
    
    return null;
}

// --- 4. LOGGING ---
function loadLogs() {
    try { if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) {}
    return [];
}
function saveLog(entry) {
    const logs = loadLogs();
    logs.push(entry);
    try { fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2)); } catch (e) {}
}

// --- MIDDLEWARE ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));


// ============================================================================
// SYSTEM A: VIDEO UPLOADS (ORIGINAL LOGIC)
// ============================================================================
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    console.log("\n>>> VIDEO UPLOAD STARTED");

    // 1. Check File
    if (!req.file) {
        console.error("❌ ERROR: No file received.");
        return res.status(400).send('No file received.');
    }
    console.log(`File Received: ${req.file.originalname} | Size: ${req.file.size}`);

    // 2. Check Auth
    const auth = getGoogleAuth();
    if (!auth) {
        console.error("❌ ERROR: Google Auth Failed. Check GCP_SA_KEY.");
        return res.status(500).send('Server Error: Google Auth Missing');
    }

    const { driverName, vin, inspectionType } = req.body;

    try {
        const drive = google.drive({ version: 'v3', auth });
        
        // Generate Name
        const now = new Date();
        const timeStringFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const timeStringLog = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        const dateStringLog = now.toISOString().split('T')[0];
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${timeStringFile}.mp4`;

        console.log(`Uploading to Folder: ${VIDEO_FOLDER_ID}`);

        // Upload
        const response = await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'webViewLink'
        });

        console.log(`✅ SUCCESS: ${finalFileName}`);
        
        // Log & Email
        saveLog({ date: dateStringLog, time: timeStringLog, driverName, vin, inspectionType, fileName: finalFileName });

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: EMAIL_FLEET,
            subject: `🎥 Video: ${driverName} (${inspectionType})`,
            text: `Driver: ${driverName}\nVIN: ${vin}\nType: ${inspectionType}\n\nLink: ${response.data.webViewLink}`
        });

        // Cleanup
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');

    } catch (error) {
        console.error("❌ UPLOAD FAILED:", error.message);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});


// ============================================================================
// SYSTEM B: INCIDENT REPORTS (NEW LOGIC)
// ============================================================================
app.post('/submit-report', async (req, res) => {
    console.log("\n>>> REPORT SUBMISSION STARTED");
    const data = req.body;

    const auth = getGoogleAuth();
    if (!auth) return res.status(500).json({ success: false, error: "Auth Missing" });

    try {
        const drive = google.drive({ version: 'v3', auth });
        
        // Create Folder
        const folderName = `${data.driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_FOLDER_ID] },
            fields: 'id'
        });
        const subFolderId = folder.data.id;

        // Upload Helper
        let photoLinks = [];
        const uploadImage = async (imgObj, type) => {
            if (!imgObj || !imgObj.data) return;
            const buffer = Buffer.from(imgObj.data, 'base64');
            const bs = new stream.PassThrough();
            bs.end(buffer);
            const photo = await drive.files.create({
                resource: { name: `${type}_${imgObj.name}`, parents: [subFolderId] },
                media: { mimeType: 'image/jpeg', body: bs },
                fields: 'webViewLink'
            });
            photoLinks.push({ name: `${type}_${imgObj.name}`, link: photo.data.webViewLink });
        };

        if (data.highPhotos) await uploadImage(data.highPhotos, 'HighPriority');
        if (data.lowPhotos) await uploadImage(data.lowPhotos, 'LowPriority');
        if (data.edvPhotos) await uploadImage(data.edvPhotos, 'EDV');
        if (data.mphPhotos) await uploadImage(data.mphPhotos, 'MPH');
        if (data.accidentPhotos) await uploadImage(data.accidentPhotos, 'Accident');

        // PDF Generation
        const doc = await PDFDocument.create();
        const page = doc.addPage([600, 800]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const bold = await doc.embedFont(StandardFonts.HelveticaBold);
        let y = 750;
        const drawText = (text, f=font) => { page.drawText(text, { x: 50, y, size: 12, font: f }); y -= 20; };
        
        drawText(`SLGP REPORT: ${data.priorityLevel.toUpperCase()}`, bold);
        drawText(`Driver: ${data.driverName}`);
        y -= 20;
        
        if (data.priorityLevel === 'accident') {
            drawText(`Statement: ${data.accidentStatement}`);
            drawText(`Police Report: ${data.policeReportNumber}`);
        } else if (data.highIssues) {
            drawText(`Issue: ${data.highIssues}`);
        }
        
        y -= 20;
        drawText("Photos Attached:", bold);
        photoLinks.forEach(p => drawText(`- ${p.name}`));

        const pdfPath = path.join(__dirname, `report-${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        // Email
        const recipients = (data.priorityLevel === 'accident') 
            ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'] 
            : ['slgpfleetmanager@gmail.com'];
        
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: recipients,
            subject: `Report: ${data.priorityLevel} - ${data.driverName}`,
            text: `Folder: https://drive.google.com/drive/folders/${subFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("❌ REPORT FAILED:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ============================================================================
// SYSTEM C: CRON JOBS (DAILY REPORTS)
// ============================================================================
async function generateDailyReport(typeFilter, reportTitle) {
    const logs = loadLogs();
    const todayStr = new Date().toISOString().split('T')[0];
    const relevantLogs = logs.filter(e => e.date === todayStr && e.inspectionType && e.inspectionType.toLowerCase().includes(typeFilter));

    if (relevantLogs.length === 0) return;

    let content = `DAILY REPORT: ${reportTitle}\nDATE: ${todayStr}\n\n`;
    relevantLogs.forEach((log, i) => content += `${i+1}. ${log.driverName} (${log.vin}) - ${log.time}\n`);
    const reportPath = path.join(__dirname, `${reportTitle}_${todayStr}.txt`);
    fs.writeFileSync(reportPath, content);

    try {
        const auth = getGoogleAuth();
        if (auth) {
            const drive = google.drive({ version: 'v3', auth });
            await drive.files.create({
                resource: { name: `${reportTitle}_${todayStr}.txt`, parents: [VIDEO_FOLDER_ID] },
                media: { mimeType: 'text/plain', body: fs.createReadStream(reportPath) }
            });
        }
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER, to: EMAIL_FLEET, subject: `${reportTitle}`, attachments: [{ path: reportPath }]
        });
    } catch (e) { console.error("Cron Error:", e); }
}

cron.schedule('0 12 * * *', () => generateDailyReport('pre', 'DAILY_PRECHECK_REPORT'), { timezone: "America/New_York" });
cron.schedule('30 23 * * *', () => generateDailyReport('post', 'DAILY_POSTCHECK_REPORT'), { timezone: "America/New_York" });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SLGP SERVER v2.0 LIVE ON PORT ${PORT}`));
