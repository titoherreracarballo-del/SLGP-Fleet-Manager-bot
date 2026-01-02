/**
 * SLGP FLEET PORTAL - UNIFIED SERVER
 * ----------------------------------
 * SECTION A: OLD WORKING VIDEO LOGIC (Strictly preserved)
 * SECTION B: NEW INCIDENT REPORT LOGIC (Added separately)
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

// --- SHARED CONFIGURATION ---
// We use /tmp/ because Railway allows writing there without crashing
const upload = multer({ 
    dest: '/tmp/', 
    limits: { fileSize: 1024 * 1024 * 1024 } // 1GB Limit
});

const EMAIL_USER = process.env.EMAIL_USER || 'strategiclogisticsgroupllc@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'wnSx-72@!'; // Check your App Password!

// --- AUTHENTICATION HELPER (Works for BOTH) ---
// This prioritizes your OLD method (Environment Variable) but keeps a fallback.
function getDriveClient() {
    let auth;
    // 1. Try the OLD WAY (Railway Variable)
    if (process.env.GCP_SA_KEY) {
        try {
            const credentials = JSON.parse(process.env.GCP_SA_KEY);
            auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/drive.file'],
            });
        } catch (e) { console.error("GCP_SA_KEY Error:", e); }
    }
    // 2. Try the NEW WAY (File)
    if (!auth && fs.existsSync(path.join(__dirname, 'credentials.json'))) {
        auth = new google.auth.GoogleAuth({
            keyFile: path.join(__dirname, 'credentials.json'),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
    }
    
    if (!auth) {
        console.error("CRITICAL: No Google Auth found. Check GCP_SA_KEY or credentials.json");
        return null;
    }
    return google.drive({ version: 'v3', auth });
}

// --- MIDDLEWARE ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES (MENU) ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));


// ============================================================================
// SECTION A: OLD WORKING VIDEO LOGIC (PRESERVED)
// ============================================================================

// 1. Config specific to Old Logic
const VIDEO_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
const LOG_FILE = path.join(__dirname, 'submission_log.json');

// 2. Logging Helpers (From Old Code)
function loadLogs() {
    try { if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) {}
    return [];
}
function saveLog(entry) {
    const logs = loadLogs();
    logs.push(entry);
    try { fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2)); } catch (e) {}
}

// 3. The Route (Matches your HTML exactly)
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    console.log("OLD LOGIC: Received Video Upload...");
    
    if (!req.file) return res.status(400).send('No file received.');
    const { driverName, vin, inspectionType } = req.body;

    try {
        const drive = getDriveClient();
        if (!drive) throw new Error("Auth Failed");

        const now = new Date();
        const timeStringFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const timeStringLog = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        const dateStringLog = now.toISOString().split('T')[0];
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${timeStringFile}.mp4`;

        // Upload to Old Folder
        const response = await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id, webViewLink'
        });

        console.log(`SYNC SUCCESS: ${finalFileName}`);
        saveLog({ date: dateStringLog, time: timeStringLog, driverName, vin, inspectionType, fileName: finalFileName });

        // Email Fleet Manager
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: 'slgpfleetmanager@gmail.com',
            subject: `🎥 Video: ${driverName} (${inspectionType})`,
            text: `Driver: ${driverName}\nVIN: ${vin}\nType: ${inspectionType}\n\nLink: ${response.data.webViewLink}`
        });

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');

    } catch (error) {
        console.error("Video Upload Error:", error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

// 4. Cron Jobs (From Old Code)
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
        const drive = getDriveClient();
        await drive.files.create({
            resource: { name: `${reportTitle}_${todayStr}.txt`, parents: [VIDEO_FOLDER_ID] },
            media: { mimeType: 'text/plain', body: fs.createReadStream(reportPath) }
        });
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER, to: 'slgpfleetmanager@gmail.com', subject: `${reportTitle}`, attachments: [{ path: reportPath }]
        });
    } catch (e) { console.error("Cron Error:", e); }
}

cron.schedule('0 12 * * *', () => generateDailyReport('pre', 'DAILY_PRECHECK_REPORT'), { timezone: "America/New_York" });
cron.schedule('30 23 * * *', () => generateDailyReport('post', 'DAILY_POSTCHECK_REPORT'), { timezone: "America/New_York" });


// ============================================================================
// SECTION B: NEW INCIDENT REPORT LOGIC (ADDED SEPARATELY)
// ============================================================================

// 1. Config specific to New Logic
const REPORT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy'; // The new folder you shared
const EMAIL_FLEET = 'slgpfleetmanager@gmail.com';
const EMAIL_ACCIDENT = ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'];

// 2. The Route (Used by report.html)
app.post('/submit-report', async (req, res) => {
    console.log("NEW LOGIC: Received Incident Report...");
    const data = req.body;

    try {
        const drive = getDriveClient();
        if (!drive) throw new Error("Auth Failed");

        // Create Subfolder in NEW Drive Folder
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

        // Generate PDF
        const pdfPath = await generatePDF(data, photoLinks);

        // Smart Routing
        let recipients = (data.priorityLevel === 'accident') ? EMAIL_ACCIDENT : [EMAIL_FLEET];
        let subject = (data.priorityLevel === 'accident') ? `🚨 ACCIDENT: ${data.driverName}` : `🛠️ Maintenance: ${data.driverName}`;

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: recipients,
            subject: subject,
            text: `Report Type: ${data.priorityLevel}\nFiles: https://drive.google.com/drive/folders/${subFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("Report Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. PDF Helper (New Logic)
async function generatePDF(data, photoLinks) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let y = 750;
    const drawText = (text, f=font) => { page.drawText(text, { x: 50, y, size: 12, font: f }); y -= 20; };

    drawText(`SLGP REPORT: ${data.priorityLevel.toUpperCase()}`, bold);
    y -= 10;
    drawText(`Driver: ${data.driverName}`);
    if(data.vinLast4) drawText(`VIN: ${data.vinLast4}`);
    y -= 20;

    if (data.priorityLevel === 'accident') {
        drawText(`Statement: ${data.accidentStatement}`);
        drawText(`Police Report: ${data.policeReportNumber}`);
        drawText(`Case: ${data.lmetCaseNumber}`);
        if(data.affidavitSignature) {
            y -= 40;
            const sig = await doc.embedPng(Buffer.from(data.affidavitSignature, 'base64'));
            const dims = sig.scale(0.5);
            page.drawImage(sig, { x: 50, y, width: dims.width, height: dims.height });
        }
    } else {
        if(data.highIssues) drawText(`Issue: ${data.highIssues}`);
        if(data.lowIssues) drawText(`Issue: ${data.lowIssues}`);
        if(data.edvIssues) drawText(`Issue: ${data.edvIssues}`);
    }

    y -= 20;
    drawText("Attached Photos:", bold);
    photoLinks.forEach(p => drawText(`- ${p.name}`));

    const filePath = path.join(__dirname, `report-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, await doc.save());
    return filePath;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SLGP UNIFIED SERVER LIVE ON PORT ${PORT}`));
