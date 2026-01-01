const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Folder ID for "Daily Fleet Health Checks"
const DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';

// Email Configuration
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = 'slgpfleetmanager@gmail.com';

// Persistent Log File
const LOG_FILE = '/app/meshcentral-data/submission_log.json';

// --- HELPER: Load Logs ---
function loadLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Error reading log file:", e);
    }
    return [];
}

// --- HELPER: Save Log ---
function saveLog(entry) {
    const logs = loadLogs();
    logs.push(entry);
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) {
        console.error("Error writing to log file:", e);
    }
}

let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY parsing failed.");
}

// --- HELPER: Send Email ---
async function sendEmailReport(subject, textContent, attachmentPath) {
    if (!EMAIL_USER || !EMAIL_PASS) {
        console.error("EMAIL ERROR: Missing variables. Cannot send email.");
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });

    const mailOptions = {
        from: `"SLGP Fleet Bot" <${EMAIL_USER}>`,
        to: EMAIL_TO,
        subject: subject,
        text: textContent,
        attachments: [{ path: attachmentPath }]
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`EMAIL SENT: ${subject}`);
    } catch (error) {
        console.error("EMAIL FAILED:", error);
    }
}

// --- HELPER: Generate Report & Email It ---
async function generateReport(typeFilter, reportTitle) {
    console.log(`Generating ${reportTitle}...`);
    const logs = loadLogs();
    const todayStr = new Date().toISOString().split('T')[0];
    
    const relevantLogs = logs.filter(entry => {
        return entry.date === todayStr && 
               entry.inspectionType.toLowerCase().includes(typeFilter);
    });

    if (relevantLogs.length === 0) {
        console.log(`No entries found for ${reportTitle}. Skipping.`);
        return;
    }

    let reportContent = `FLEET REPORT: ${reportTitle}\nDATE: ${todayStr}\n-----------------------------------\n\n`;
    relevantLogs.forEach((log, index) => {
        reportContent += `${index + 1}. Driver: ${log.driverName}\n   VIN: ${log.vin}\n   Time: ${log.time}\n   File: ${log.fileName}\n\n`;
    });

    const reportPath = path.join(__dirname, `${reportTitle}_${todayStr}.txt`);
    fs.writeFileSync(reportPath, reportContent);

    // Upload to Google Drive
    try {
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.create({
            resource: { name: `${reportTitle}_${todayStr}.txt`, parents: [DRIVE_FOLDER_ID] },
            media: { mimeType: 'text/plain', body: fs.createReadStream(reportPath) },
            fields: 'id', supportsAllDrives: true, supportsTeamDrives: true
        });
        console.log(`REPORT UPLOADED TO DRIVE: ${reportTitle}`);
    } catch (error) {
        console.error(`FAILED to upload report to Drive: ${error.message}`);
    }

    // Send Email
    await sendEmailReport(`${reportTitle} - ${todayStr}`, `Daily report attached.`, reportPath);
}

// --- SCHEDULER: 12:00 PM (Pre-checks) ---
cron.schedule('0 12 * * *', () => { generateReport('pre', 'DAILY_PRECHECK_REPORT'); }, { timezone: "America/New_York" });

// --- SCHEDULER: 11:00 PM (Post-checks) ---
cron.schedule('0 23 * * *', () => { generateReport('post', 'DAILY_POSTCHECK_REPORT'); }, { timezone: "America/New_York" });

app.use(express.static(__dirname));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

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

        const response = await drive.files.create({
            resource: { name: finalFileName, parents: [DRIVE_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true, supportsTeamDrives: true
        });

        console.log(`SYNC SUCCESS: ${finalFileName}`);
        saveLog({ date: dateStringLog, time: timeStringLog, driverName, vin, inspectionType, fileName: finalFileName });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("UPLOAD ERROR DETAILS:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => { console.log(`SLGP SERVER v1.4.0 LIVE ON PORT: ${PORT}`); });
