const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();
// Using /tmp/ ensures Railway doesn't block the file write
const upload = multer({ dest: '/tmp/' });

// --- SECTION 1: YOUR ORIGINAL WORKING CONFIG ---
const DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = 'slgpfleetmanager@gmail.com';
// Fallback for the log file if the meshcentral path doesn't exist in the new environment
const LOG_FILE = fs.existsSync('/app/meshcentral-data/') 
    ? '/app/meshcentral-data/submission_log.json' 
    : path.join(__dirname, 'submission_log.json');

// --- SECTION 2: ORIGINAL AUTH LOGIC ---
let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY parsing failed. Make sure the Railway Variable is set.");
}

// --- SECTION 3: ORIGINAL HELPERS ---
function loadLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } catch (e) { console.error("Error reading log file:", e); }
    return [];
}

function saveLog(entry) {
    const logs = loadLogs();
    logs.push(entry);
    try { fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2)); } catch (e) { }
}

async function sendEmailReport(subject, textContent, attachmentPath) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });
    const mailOptions = {
        from: `"SLGP Fleet Bot" <${EMAIL_USER}>`,
        to: EMAIL_TO,
        subject: subject,
        text: textContent,
        attachments: attachmentPath ? [{ path: attachmentPath }] : []
    };
    await transporter.sendMail(mailOptions);
}

// --- SECTION 4: ORIGINAL VIDEO ROUTE (UNCHANGED) ---
app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'menu.html')); });
app.get('/video', (req, res) => { res.sendFile(path.join(__dirname, 'video.html')); });
app.get('/report', (req, res) => { res.sendFile(path.join(__dirname, 'report.html')); });

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file received.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        const now = new Date();
        const timeStringFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const timeStringLog = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        const dateStringLog = now.toISOString().split('T')[0];

        const finalFileName = `${driverName}_${vin}_${inspectionType}_${timeStringFile}.mp4`;

        await drive.files.create({
            resource: { name: finalFileName, parents: [DRIVE_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true, supportsTeamDrives: true
        });

        saveLog({ date: dateStringLog, time: timeStringLog, driverName, vin, inspectionType, fileName: finalFileName });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("UPLOAD ERROR:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

// --- SECTION 5: NEW REPORT LOGIC (DEDICATED ROUTE) ---
app.post('/submit-report', async (req, res) => {
    const data = req.body;
    const REPORT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
    try {
        const drive = google.drive({ version: 'v3', auth });
        const folderName = `${data.driverName} - ${new Date().toLocaleDateString()}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_DRIVE_ID] },
            fields: 'id'
        });
        
        // PDF Generation Logic (Internal to this route only)
        const doc = await PDFDocument.create();
        const page = doc.addPage([600, 800]);
        page.drawText(`SLGP Incident Report: ${data.driverName}`, { x: 50, y: 750, size: 20 });
        const pdfBytes = await doc.save();
        const pdfPath = path.join('/tmp', `report-${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, pdfBytes);

        await sendEmailReport(`New Report: ${data.driverName}`, `Report attached.`, pdfPath);
        fs.unlinkSync(pdfPath);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- SECTION 6: ORIGINAL SCHEDULER ---
cron.schedule('0 12 * * *', () => { /* generateReport logic */ }, { timezone: "America/New_York" });
cron.schedule('30 23 * * *', () => { /* generateReport logic */ }, { timezone: "America/New_York" });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => { console.log(`SLGP SERVER LIVE ON PORT: ${PORT}`); });
