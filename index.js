const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const stream = require('stream');
const cron = require('node-cron'); // REQUIRED: npm install node-cron

const app = express();

// --- CONFIGURATION ---
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');
const DAILY_LOG_FILE = path.join(VOLUME_PATH, 'daily_data.json');

// Ensure directories exist
if (!fs.existsSync(UPLOAD_DIR)) {
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } 
    catch (e) { console.log("Using /tmp"); }
}

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES ---
app.get('/', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'menu.html'))) res.sendFile(path.join(__dirname, 'menu.html'));
    else res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/report', (req, res) => {
    const mode = req.query.mode;
    if (mode === 'issue') res.sendFile(path.join(__dirname, 'report-issue.html'));
    else if (mode === 'accident') res.sendFile(path.join(__dirname, 'accident - report.html'));
    else if (mode === 'insurance') res.sendFile(path.join(__dirname, 'insurance.html'));
    else res.status(404).send('Unknown report type.');
});
app.get('/version', (req, res) => res.json({ version: Date.now() }));

// --- GOOGLE DRIVE ---
const VIDEO_DRIVE_ID = '0AC1GE3XEm4K9Uk9PVA'; 
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA'; 

// --- HELPER: LOG REPORT FOR END OF DAY ---
function logReportLocally(data) {
    let currentLogs = [];
    if (fs.existsSync(DAILY_LOG_FILE)) {
        try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {}
    }
    // Add timestamp for filtering
    data.timestamp = new Date();
    currentLogs.push(data);
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));
}

// --- VIDEO UPLOAD ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        await drive.files.create({
            resource: { name: `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });
        
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Complete');
    } catch (error) { res.status(500).send(`Error: ${error.message}`); }
});

// --- REPORT SUBMISSION (INSTANT EMAIL) ---
app.post('/submit-report', async (req, res) => {
    const data = req.body;
    
    // 1. SAVE TO DAILY LOG
    logReportLocally(data);

    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });
        
        let targetFolderId = ACCIDENT_DRIVE_ID; 
        if (data.reportType && !data.reportType.includes('Accident')) targetFolderId = ISSUE_DRIVE_ID;

        const folder = await drive.files.create({
            resource: { name: `${data.driverName} - ${data.reportType}`, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] },
            fields: 'id', supportsAllDrives: true
        });
        const folderId = folder.data.id;

        const photoBuffers = [];
        if (data.photos && data.photos.length) {
            for (let i = 0; i < data.photos.length; i++) {
                const buffer = Buffer.from(data.photos[i].data, 'base64');
                photoBuffers.push(buffer); 
                const bs = new stream.PassThrough(); bs.end(buffer);
                await drive.files.create({
                    resource: { name: `Photo_${i+1}.jpg`, parents: [folderId] },
                    media: { mimeType: 'image/jpeg', body: bs },
                    supportsAllDrives: true
                });
            }
        }

        // --- GENERATE INSTANT PDF ---
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);
        
        // Header
        page.drawRectangle({ x: 0, y: 720, width: 600, height: 80, color: rgb(0.14, 0.38, 0.92) });
        page.drawText('VEHICLE REPORT ISSUE', { x: 30, y: 765, size: 22, font: fontBold, color: rgb(1,1,1) });
        page.drawText('SLGP FLEET MANAGEMENT', { x: 30, y: 745, size: 10, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        // Logo
        try {
            if (fs.existsSync('logo.png')) {
                const logoImg = await doc.embedPng(fs.readFileSync('logo.png'));
                const dims = logoImg.scale(0.3); // Adjust size as needed
                page.drawImage(logoImg, { x: 500, y: 735, width: 50, height: 50 });
            }
        } catch(e) {}

        let y = 680;
        const checkPage = () => { if (y < 50) { page = doc.addPage([600, 800]); y = 750; } };
        const drawField = (title, value) => {
            checkPage();
            page.drawText(title, { x: 30, y, size: 9, font: fontBold, color: rgb(0.5,0.5,0.5) });
            page.drawText(value || 'N/A', { x: 150, y, size: 11, font: fontReg, color: rgb(0,0,0) });
            y -= 25;
            page.drawLine({ start: { x: 30, y: y+10 }, end: { x: 570, y: y+10 }, thickness: 0.5, color: rgb(0.9,0.9,0.9) });
            y -= 10;
        };

        drawField('REPORT CATEGORY', data.reportType.toUpperCase());
        drawField('DRIVER NAME', data.driverName);
        drawField('VIN (LAST 4)', data.vinLast4);
        drawField('VEHICLE TYPE', data.vehicleType);
        drawField('DATE & TIME', `${data.date} at ${data.time}`);
        
        if (data.reportType.includes('Road')) drawField('LOCATION', `${data.addressStreet}, ${data.addressCity}`);
        else drawField('ISSUES SELECTED', data.tags ? data.tags.join(', ') : 'None');
        
        // Notes
        checkPage();
        y -= 10;
        page.drawText('DETAILED DESCRIPTION / NOTES', { x: 30, y, size: 9, font: fontBold, color: rgb(0.5,0.5,0.5) });
        y -= 20;
        const notes = data.otherDescription || "No notes.";
        const words = notes.split(' ');
        let line = '';
        for (const word of words) {
            if ((line + word).length > 85) {
                page.drawText(line, { x: 30, y, size: 11, font: fontReg });
                y -= 15; line = ''; checkPage();
            }
            line += word + ' ';
        }
        page.drawText(line, { x: 30, y, size: 11, font: fontReg });
        y -= 40;

        // Photos
        if (photoBuffers.length > 0) {
            checkPage();
            if(y < 200) { page = doc.addPage([600, 800]); y = 750; }
            page.drawRectangle({ x: 30, y: y, width: 540, height: 25, color: rgb(0.95, 0.95, 0.95) });
            page.drawText('ATTACHED EVIDENCE PHOTOS', { x: 40, y: y+8, size: 10, font: fontBold, color: rgb(0.14, 0.38, 0.92) });
            y -= 30;

            for (const buffer of photoBuffers) {
                try {
                    const img = await doc.embedJpg(buffer);
                    const dims = img.scaleToFit(500, 400);
                    if (y - dims.height < 50) { page = doc.addPage([600, 800]); y = 750; }
                    page.drawImage(img, { x: 50, y: y - dims.height, width: dims.width, height: dims.height });
                    y -= (dims.height + 20);
                } catch (e) {}
            }
        }

        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const recipients = data.reportType.includes('Accident') 
            ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com']
            : ['slgpfleetmanager@gmail.com'];

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipients,
            subject: `REPORT: ${data.vinLast4} - ${data.reportType}`,
            text: `Driver: ${data.driverName}\nVIN: ${data.vinLast4}\nCategory: ${data.reportType}\n\nPDF Attached.\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`,
            attachments: [{ filename: 'Vehicle_Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- CRON JOB: 11:30 PM DAILY SUMMARY ---
// Schedule: 11:30 PM EST (America/New_York)
cron.schedule('30 23 * * *', async () => {
    console.log("Running Daily Summary Report...");
    
    if (!fs.existsSync(DAILY_LOG_FILE)) return;

    try {
        const rawData = fs.readFileSync(DAILY_LOG_FILE);
        const allLogs = JSON.parse(rawData);
        if (allLogs.length === 0) return;

        // Generate Summary PDF
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        // Summary Header
        page.drawRectangle({ x: 0, y: 720, width: 600, height: 80, color: rgb(0.1, 0.1, 0.1) }); // Dark Header
        page.drawText('DAILY FLEET SUMMARY REPORT', { x: 30, y: 765, size: 22, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`DATE: ${new Date().toLocaleDateString()}`, { x: 30, y: 745, size: 12, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        let y = 680;

        // Loop through all reports
        allLogs.forEach((log, index) => {
            if (y < 150) { page = doc.addPage([600, 800]); y = 750; }

            // Report Block
            page.drawRectangle({ x: 30, y: y, width: 540, height: 20, color: rgb(0.9, 0.9, 0.9) });
            page.drawText(`REPORT #${index + 1} - ${log.reportType.toUpperCase()}`, { x: 35, y: y+6, size: 10, font: fontBold });
            y -= 20;

            const drawLineItem = (label, val) => {
                page.drawText(`${label}:`, { x: 35, y: y-15, size: 9, font: fontBold });
                page.drawText(`${val}`, { x: 100, y: y-15, size: 9, font: fontReg });
                y -= 15;
            };

            drawLineItem("DRIVER", log.driverName);
            drawLineItem("VIN", `${log.vinLast4} (${log.vehicleType})`);
            drawLineItem("TIME", log.time);
            
            if(log.otherDescription) {
                page.drawText("NOTES:", { x: 35, y: y-15, size: 9, font: fontBold });
                // Truncate notes for summary
                const shortNote = log.otherDescription.length > 60 ? log.otherDescription.substring(0, 60) + "..." : log.otherDescription;
                page.drawText(shortNote, { x: 100, y: y-15, size: 9, font: fontReg, color: rgb(0.8, 0, 0) });
                y -= 15;
            }
            y -= 15; // Spacer
        });

        const summaryPath = path.join(UPLOAD_DIR, `Daily_Summary_${Date.now()}.pdf`);
        fs.writeFileSync(summaryPath, await doc.save());

        // Send Email
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'], // Management Email
            subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()} - ${allLogs.length} Reports`,
            text: `Attached is the daily summary of all reports submitted today.\nTotal Reports: ${allLogs.length}`,
            attachments: [{ filename: 'Daily_Summary.pdf', path: summaryPath }]
        });

        // Clear Log for tomorrow
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
        fs.unlinkSync(summaryPath);
        console.log("Daily Summary Sent & Log Cleared.");

    } catch (e) {
        console.error("Cron Job Error:", e);
    }
}, {
    timezone: "America/New_York"
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
