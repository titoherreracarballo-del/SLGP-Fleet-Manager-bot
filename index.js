/**
 * SLGP FLEET PORTAL - MASTER SERVER v8.0 (MERGED)
 * -----------------------------------------------
 * 1. Video Uploads (Adapted to match your working HTML exactly)
 * 2. Daily Cron Reports (Pre/Post check logs)
 * 3. PDF Incident Reports (Accidents/Maintenance)
 * 4. Smart Email Routing
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron'); // REQUIRED: Add "node-cron": "^3.0.0" to package.json
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- CONFIGURATION ---
const PARENT_FOLDER_ID = '0AC1GE3XEm4K9Uk9PVA'; // Updated to the ID from your old code
const EMAIL_USER = 'strategiclogisticsgroupllc@gmail.com'; // Using your main email
const EMAIL_PASS = 'wnSx-72@!'; // REPLACE WITH REAL APP PASSWORD
const EMAIL_TO_FLEET = 'slgpfleetmanager@gmail.com';
const LOG_FILE = path.join(__dirname, 'submission_log.json');
const KEY_FILE_PATH = path.join(__dirname, 'credentials.json');

// --- UPLOAD STORAGE (Temp folder for Railway) ---
const upload = multer({ 
    dest: '/tmp/', 
    limits: { fileSize: 1024 * 1024 * 1024 } // 1GB Limit
});

// --- MIDDLEWARE ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- LOGGING SYSTEM (From Old Code) ---
function loadLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
    } catch (e) { console.error("Log Read Error:", e); }
    return [];
}

function saveLog(entry) {
    const logs = loadLogs();
    logs.push(entry);
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) { console.error("Log Write Error:", e); }
}

// --- HELPER: GOOGLE AUTH ---
function getDriveClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_FILE_PATH,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    return google.drive({ version: 'v3', auth });
}

// =========================================================
// 1. PAGE ROUTES
// =========================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html'))); // Your specific video HTML
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));


// =========================================================
// 2. VIDEO UPLOAD (MATCHING YOUR WORKING HTML)
// =========================================================
// Route changed to '/upload-to-google-drive' to match your XHR request
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    console.log("Received Video Upload Request...");

    if (!req.file) {
        return res.status(400).send('No file received.');
    }

    const { driverName, vin, inspectionType, serviceType } = req.body;

    try {
        const drive = getDriveClient();
        
        // Time formatting (From your old code)
        const now = new Date();
        const timeStringFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const timeStringLog = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        const dateStringLog = now.toISOString().split('T')[0];

        const finalFileName = `${driverName}_${vin}_${inspectionType}_${timeStringFile}.mp4`;

        // Upload to Drive
        const response = await drive.files.create({
            resource: { name: finalFileName, parents: [PARENT_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id, webViewLink'
        });

        console.log(`SYNC SUCCESS: ${finalFileName}`);

        // 1. Save to Log (For the Cron Job)
        saveLog({ 
            date: dateStringLog, 
            time: timeStringLog, 
            driverName, 
            vin, 
            inspectionType, 
            fileName: finalFileName 
        });

        // 2. Send Immediate Email (Combined Feature)
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        await transporter.sendMail({
            from: EMAIL_USER,
            to: EMAIL_TO_FLEET,
            subject: `🎥 Video: ${driverName} (${inspectionType})`,
            text: `Driver: ${driverName}\nVIN: ${vin}\nType: ${inspectionType}\n\nVideo Link: ${response.data.webViewLink}`
        });

        // Cleanup
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        res.status(200).send('Upload Successful');

    } catch (error) {
        console.error("UPLOAD ERROR DETAILS:", error.message);
        // Cleanup on error
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});


// =========================================================
// 3. DAILY REPORTS (CRON JOBS - RESTORED)
// =========================================================
async function generateDailyReport(typeFilter, reportTitle) {
    console.log(`Generating ${reportTitle}...`);
    const logs = loadLogs();
    const todayStr = new Date().toISOString().split('T')[0];
    
    const relevantLogs = logs.filter(entry => {
        return entry.date === todayStr && 
               entry.inspectionType && 
               entry.inspectionType.toLowerCase().includes(typeFilter);
    });

    if (relevantLogs.length === 0) return;

    let reportContent = `FLEET REPORT: ${reportTitle}\nDATE: ${todayStr}\n-----------------------------------\n\n`;
    relevantLogs.forEach((log, index) => {
        reportContent += `${index + 1}. Driver: ${log.driverName}\n   VIN: ${log.vin}\n   Time: ${log.time}\n   File: ${log.fileName}\n\n`;
    });

    const reportPath = path.join(__dirname, `${reportTitle}_${todayStr}.txt`);
    fs.writeFileSync(reportPath, reportContent);

    // Upload Report to Drive
    try {
        const drive = getDriveClient();
        await drive.files.create({
            resource: { name: `${reportTitle}_${todayStr}.txt`, parents: [PARENT_FOLDER_ID] },
            media: { mimeType: 'text/plain', body: fs.createReadStream(reportPath) }
        });
    } catch (e) { console.error("Report Upload Error:", e); }

    // Email Report
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: EMAIL_TO_FLEET,
            subject: `${reportTitle} - ${todayStr}`,
            text: "Daily report attached.",
            attachments: [{ path: reportPath }]
        });
    } catch (e) { console.error("Report Email Error:", e); }
}

// 12:00 PM Scheduler
cron.schedule('0 12 * * *', () => { generateDailyReport('pre', 'DAILY_PRECHECK_REPORT'); }, { timezone: "America/New_York" });
// 11:30 PM Scheduler
cron.schedule('30 23 * * *', () => { generateDailyReport('post', 'DAILY_POSTCHECK_REPORT'); }, { timezone: "America/New_York" });


// =========================================================
// 4. INCIDENT / MAINTENANCE REPORTING (PDF)
// =========================================================
app.post('/submit-report', async (req, res) => {
    console.log("Received Incident Report...");
    const data = req.body;

    try {
        const drive = getDriveClient();

        // Create Subfolder
        const folderName = `${data.driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [PARENT_FOLDER_ID] },
            fields: 'id'
        });
        const reportFolderId = folder.data.id;

        // Upload Photos
        let photoLinks = [];
        const uploadImage = async (imgObj, type) => {
            if (!imgObj || !imgObj.data) return;
            const buffer = Buffer.from(imgObj.data, 'base64');
            const bs = new stream.PassThrough();
            bs.end(buffer);
            const photo = await drive.files.create({
                resource: { name: `${type}_${imgObj.name}`, parents: [reportFolderId] },
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
        let recipients = [];
        if (data.priorityLevel === 'accident') {
            recipients = ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'];
        } else {
            recipients = [EMAIL_TO_FLEET];
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        await transporter.sendMail({
            from: EMAIL_USER,
            to: recipients,
            subject: `🚨 Report: ${data.priorityLevel.toUpperCase()} - ${data.driverName}`,
            text: `New Report from ${data.driverName}.\nType: ${data.priorityLevel}\nFolder: https://drive.google.com/drive/folders/${reportFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("Report Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PDF Helper (Simplified for brevity, includes all main logic)
async function generatePDF(data, photoLinks) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    
    let y = 750;
    const drawText = (text) => {
        page.drawText(text, { x: 50, y, size: 12, font, color: rgb(0, 0, 0) });
        y -= 20;
    };

    drawText(`SLGP REPORT - ${data.priorityLevel.toUpperCase()}`);
    drawText(`Date: ${new Date().toLocaleString()}`);
    drawText(`Driver: ${data.driverName}`);
    if(data.vinLast4) drawText(`VIN: ${data.vinLast4}`);
    y -= 20;

    if (data.priorityLevel === 'accident') {
        drawText(`Statement: ${data.accidentStatement}`);
        drawText(`Police Report: ${data.policeReportNumber}`);
        drawText(`Case #: ${data.lmetCaseNumber}`);
        if(data.affidavitSignature) {
            y -= 40;
            const sig = await doc.embedPng(Buffer.from(data.affidavitSignature, 'base64'));
            const dims = sig.scale(0.5);
            page.drawImage(sig, { x: 50, y, width: dims.width, height: dims.height });
        }
    } else {
        if(data.highIssues) drawText(`Issue: ${data.highIssues}`);
        if(data.lowIssues) drawText(`Issue: ${data.lowIssues}`);
    }

    y -= 20;
    drawText("Photos Attached (See Drive Folder)");
    photoLinks.forEach(p => drawText(`- ${p.name}`));

    const filePath = path.join(__dirname, `report-${Date.now()}.pdf`);
    const pdfBytes = await doc.save();
    fs.writeFileSync(filePath, pdfBytes);
    return filePath;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => { console.log(`SLGP SERVER v8.0 LIVE ON PORT: ${PORT}`); });
