const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const stream = require('stream');
const cron = require('node-cron'); 
const webpush = require('web-push');

const app = express();

// --- 1. CONFIGURATION ---
const APP_VERSION = Date.now();
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');
const DAILY_LOG_FILE = path.join(VOLUME_PATH, 'daily_data.json');
const SUBSCRIPTION_FILE = path.join(VOLUME_PATH, 'subscriptions.json');

// --- DISCORD SETUP ---
// This automatically pulls the URL you save in Railway Variables
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 

// Helper: Send Discord Notification
async function sendDiscordAlert(title, description, fields, colorHex) {
    if (!DISCORD_WEBHOOK_URL) return;

    // Convert Hex to Decimal for Discord
    const colorDecimal = parseInt(colorHex.replace("#", ""), 16);

    const payload = {
        embeds: [{
            title: title,
            description: description,
            color: colorDecimal,
            fields: fields,
            footer: { text: "SLGP Fleet Portal • System v3.0" },
            timestamp: new Date().toISOString()
        }]
    };

    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error("Discord Webhook Error:", error);
    }
}

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } 
    catch (e) { console.log("Using /tmp for uploads"); }
}
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- VAPID KEYS (PUSH NOTIFICATIONS) ---
let publicVapidKey = process.env.VAPID_PUBLIC_KEY;
let privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    const vapidKeys = webpush.generateVAPIDKeys();
    publicVapidKey = vapidKeys.publicKey;
    privateVapidKey = vapidKeys.privateKey;
    console.log("---------------------------------------------------");
    console.log("⚠️  NO VAPID KEYS FOUND. GENERATED TEMPORARY KEYS:");
    console.log("PUBLIC KEY:", publicVapidKey);
    console.log("PRIVATE KEY:", privateVapidKey);
    console.log("SAVE THESE TO RAILWAY VARIABLES TO KEEP SUBSCRIPTIONS WORKING!");
    console.log("---------------------------------------------------");
}

webpush.setVapidDetails(
    'mailto:slgpfleetmanager@gmail.com',
    publicVapidKey,
    privateVapidKey
);

// --- 2. ROUTES ---
app.get('/', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'menu.html'))) res.sendFile(path.join(__dirname, 'menu.html'));
    else res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/version', (req, res) => res.json({ version: APP_VERSION }));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'success.html')));
app.get('/alerts', (req, res) => res.sendFile(path.join(__dirname, 'alerts.html')));

app.get('/report', (req, res) => {
    const mode = req.query.mode;
    if (mode === 'issue') res.sendFile(path.join(__dirname, 'report-issue.html'));
    else if (mode === 'accident') res.sendFile(path.join(__dirname, 'accident - report.html'));
    else if (mode === 'insurance') res.sendFile(path.join(__dirname, 'insurance.html'));
    else res.status(404).send('Unknown report type.');
});

// --- PUSH ROUTES ---
app.get('/vapid-key', (req, res) => res.json({ publicKey: publicVapidKey }));

app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    let subs = [];
    if (fs.existsSync(SUBSCRIPTION_FILE)) {
        try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)); } catch(e) {}
    }
    subs.push(subscription);
    // Remove duplicates
    const unique = subs.filter((v,i,a)=>a.findIndex(t=>(t.endpoint === v.endpoint))===i);
    fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(unique));
    res.status(201).json({});
});

app.post('/send-alert', async (req, res) => {
    const { title, message } = req.body;
    
    // 1. Send to Browser Push
    if (fs.existsSync(SUBSCRIPTION_FILE)) {
        const subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE));
        const payload = JSON.stringify({ title, body: message });
        subs.forEach(sub => webpush.sendNotification(sub, payload).catch(e => console.log(e)));
    }

    // 2. Send to Discord
    await sendDiscordAlert(
        `📢 ADMIN BROADCAST: ${title}`, 
        message, 
        [], 
        "#00f2ff" // Neon Blue
    );

    res.json({ success: true });
});

// --- GOOGLE AUTH & LOGGING ---
const VIDEO_DRIVE_ID = '0AC1GE3XEm4K9Uk9PVA'; 
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA'; 

function logReportLocally(data) {
    let currentLogs = [];
    if (fs.existsSync(DAILY_LOG_FILE)) {
        try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {}
    }
    data.timestamp = new Date();
    currentLogs.push(data);
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));
}

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        // Log to Discord
        await sendDiscordAlert(
            "🎥 Video Inspection Uploaded",
            `A new ${inspectionType} video has been uploaded.`,
            [
                { name: "Driver", value: driverName, inline: true },
                { name: "VIN", value: vin, inline: true }
            ],
            "#00ff88" // Green
        );

        await drive.files.create({
            resource: { name: `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Complete');
    } catch (error) { res.status(500).send(`Error: ${error.message}`); }
});

app.post('/submit-report', async (req, res) => {
    const data = req.body;
    logReportLocally(data);

    // --- DISCORD ALERT LOGIC ---
    const isAccident = data.reportType.includes('Accident');
    const discordColor = isAccident ? "#ff2a2a" : "#ffaa00"; 
    const discordTitle = isAccident ? "🚨 NEW ACCIDENT REPORTED" : "⚠️ NEW VEHICLE ISSUE";
    
    const discordFields = [
        { name: "Driver", value: data.driverName, inline: true },
        { name: "VIN (Last 4)", value: data.vinLast4, inline: true },
        { name: "Type", value: data.reportType, inline: true },
        { name: "Time", value: `${data.date} at ${data.time}`, inline: false }
    ];

    if(data.otherDescription) {
        discordFields.push({ name: "Notes", value: data.otherDescription.substring(0, 1024) });
    }

    // Fire Alert
    sendDiscordAlert(discordTitle, "A new report has been submitted via the portal.", discordFields, discordColor);

    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });
        let targetFolderId = ACCIDENT_DRIVE_ID; 
        if (!isAccident) targetFolderId = ISSUE_DRIVE_ID;

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

        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);
        
        page.drawRectangle({ x: 0, y: 720, width: 600, height: 80, color: rgb(0.14, 0.38, 0.92) });
        page.drawText('VEHICLE REPORT ISSUE', { x: 30, y: 765, size: 22, font: fontBold, color: rgb(1,1,1) });
        page.drawText('SLGP FLEET MANAGEMENT', { x: 30, y: 745, size: 10, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        try {
            const logoPath = path.join(__dirname, 'Final-01.jpg');
            if (fs.existsSync(logoPath)) {
                const logoImg = await doc.embedJpg(fs.readFileSync(logoPath));
                const dims = logoImg.scaleToFit(180, 70); 
                page.drawImage(logoImg, { x: 570 - dims.width, y: 760 - (dims.height/2), width: dims.width, height: dims.height });
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
        
        checkPage();
        y -= 10;
        page.drawText('DETAILED DESCRIPTION / NOTES', { x: 30, y, size: 9, font: fontBold, color: rgb(0.5,0.5,0.5) });
        y -= 20;
        const notes = data.otherDescription || "No notes.";
        const words = notes.split(' ');
        let line = '';
        for (const word of words) {
            if ((line + word).length > 85) { page.drawText(line, { x: 30, y, size: 11, font: fontReg }); y -= 15; line = ''; checkPage(); }
            line += word + ' ';
        }
        page.drawText(line, { x: 30, y, size: 11, font: fontReg });
        y -= 40;

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

        const recipients = isAccident
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

    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

cron.schedule('30 23 * * *', async () => {
    if (!fs.existsSync(DAILY_LOG_FILE)) return;
    try {
        const rawData = fs.readFileSync(DAILY_LOG_FILE);
        const allLogs = JSON.parse(rawData);
        if (allLogs.length === 0) return;

        // --- DISCORD SUMMARY LOG ---
        await sendDiscordAlert(
            "📋 DAILY FLEET SUMMARY",
            `A total of ${allLogs.length} reports were submitted today.`,
            [],
            "#00f2ff" // Neon Blue
        );

        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        page.drawRectangle({ x: 0, y: 720, width: 600, height: 80, color: rgb(0.1, 0.1, 0.1) });
        page.drawText('DAILY FLEET SUMMARY', { x: 30, y: 765, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`DATE: ${new Date().toLocaleDateString()}`, { x: 30, y: 745, size: 14, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        try {
            const logoPath = path.join(__dirname, 'Final-01.jpg');
            if (fs.existsSync(logoPath)) {
                const logoImg = await doc.embedJpg(fs.readFileSync(logoPath));
                const dims = logoImg.scaleToFit(180, 70); 
                page.drawImage(logoImg, { x: 570 - dims.width, y: 760 - (dims.height/2), width: dims.width, height: dims.height });
            }
        } catch(e) {}

        let y = 680;
        allLogs.forEach((log, index) => {
            if (y < 150) { page = doc.addPage([600, 800]); y = 750; }
            page.drawRectangle({ x: 30, y: y, width: 540, height: 25, color: rgb(0.9, 0.9, 0.9) });
            page.drawText(`REPORT #${index + 1} - ${log.reportType.toUpperCase()}`, { x: 40, y: y+8, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 25;
            page.drawText(`DRIVER: ${log.driverName}   |   VIN: ${log.vinLast4}   |   TIME: ${log.time}`, { x: 30, y: y-15, size: 11, font: fontBold, color: rgb(0,0,0) });
            y -= 20;
            if(log.tags && log.tags.length > 0) { page.drawText(`ISSUES: ${log.tags.join(', ')}`, { x: 30, y: y-15, size: 10, font: fontReg, color: rgb(0.2, 0.2, 0.2) }); y -= 15; }
            if(log.otherDescription) { 
                const short = log.otherDescription.length > 70 ? log.otherDescription.substring(0, 70) + "..." : log.otherDescription;
                page.drawText(`NOTE: ${short}`, { x: 30, y: y-15, size: 10, font: fontBold, color: rgb(0.8, 0, 0) }); y -= 15; 
            }
            page.drawLine({ start: { x: 30, y: y-10 }, end: { x: 570, y: y-10 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
            y -= 30; 
        });

        const summaryPath = path.join(UPLOAD_DIR, `Daily_Summary_${Date.now()}.pdf`);
        fs.writeFileSync(summaryPath, await doc.save());

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'], 
            subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()}`,
            text: `Daily Summary Attached.\nTotal Reports: ${allLogs.length}`,
            attachments: [{ filename: 'Daily_Summary.pdf', path: summaryPath }]
        });

        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
        fs.unlinkSync(summaryPath);
    } catch (e) { console.error("Cron Error:", e); }
}, { timezone: "America/New_York" });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
