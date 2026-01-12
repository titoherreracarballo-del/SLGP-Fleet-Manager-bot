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
const { Client, GatewayIntentBits, Events } = require('discord.js');

const app = express();

// --- 1. CONFIGURATION ---
const APP_VERSION = Date.now();
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');
const DAILY_LOG_FILE = path.join(VOLUME_PATH, 'daily_data.json');
const SUBSCRIPTION_FILE = path.join(VOLUME_PATH, 'subscriptions.json');
const GATE_LOG_FILE = path.join(VOLUME_PATH, 'gate_acknowledgments.json');
const ARRIVAL_LOG_FILE = path.join(VOLUME_PATH, 'arrival_acknowledgments.json');

// --- GOOGLE DRIVE IDS ---
const VIDEO_DRIVE_ID = '0AC1GE3XEm4K9Uk9PVA';
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA';

// --- DISCORD BOT SETUP ---
const DISCORD_BOT_TOKEN = process.env.FLEET_BOT_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- VAPID KEYS ---
let publicVapidKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim().replace(/['"]+/g, '') : null;
let privateVapidKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim().replace(/['"]+/g, '') : null;

if (!publicVapidKey || !privateVapidKey) {
    const vapidKeys = webpush.generateVAPIDKeys();
    publicVapidKey = vapidKeys.publicKey;
    privateVapidKey = vapidKeys.privateKey;
}

webpush.setVapidDetails('mailto:slgpfleetmanager@gmail.com', publicVapidKey, privateVapidKey);

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN).catch(err => console.log("Discord Login Fail:", err));
    
    client.once(Events.ClientReady, c => {
        console.log(`🤖 Fleet Bot is Ready! Logged in as ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot || message.channelId !== DISCORD_CHANNEL_ID) return;
        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            let subs = [];
            try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)); } catch (e) {}
            const payload = JSON.stringify({ title: "📢 FLEET ALERT", body: message.content });
            const pushPromises = subs.map(async (sub) => {
                try { await webpush.sendNotification(sub, payload); } catch (e) {}
            });
            await Promise.all(pushPromises);
        }
    });
}

if (!fs.existsSync(UPLOAD_DIR)) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {} }
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(__dirname));
app.use(express.json({ limit: '150mb' })); // Increased limit for photos
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

// --- HELPER: DEDUPING ---
function isDuplicate(file, name) {
    if (!fs.existsSync(file)) return false;
    try {
        const logs = JSON.parse(fs.readFileSync(file));
        if (logs.length === 0) return false;
        const lastLog = logs[logs.length - 1];
        const lastTime = new Date(lastLog.rawTimestamp || Date.now()).getTime();
        return (lastLog.name === name && (Date.now() - lastTime < 60000));
    } catch (e) { return false; }
}

// --- HELPER: TEXT WRAPPING ---
function wrapText(text, font, size, maxWidth) {
    if (!text) return [];
    const words = text.split(' ');
    let lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        const width = font.widthOfTextAtSize(currentLine + " " + words[i], size);
        if (width < maxWidth) {
            currentLine += " " + words[i];
        } else {
            lines.push(currentLine);
            currentLine = words[i];
        }
    }
    lines.push(currentLine);
    return lines;
}

// --- ROUTE: GATE CHECK ---
app.post('/log-gate-check', async (req, res) => {
    const { name } = req.body;
    if (isDuplicate(GATE_LOG_FILE, name)) return res.json({ success: true });
    
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    let logs = [];
    if (fs.existsSync(GATE_LOG_FILE)) { try { logs = JSON.parse(fs.readFileSync(GATE_LOG_FILE)); } catch(e) {} }
    logs.push({ name, timestamp, rawTimestamp: now.getTime() });
    fs.writeFileSync(GATE_LOG_FILE, JSON.stringify(logs, null, 2));

    try {
        const doc = await PDFDocument.create();
        const page = doc.addPage([400, 750]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        page.drawRectangle({ x: 0, y: 0, width: 400, height: 750, color: rgb(0.05, 0.08, 0.12) });
        page.drawText('!', { x: 190, y: 690, size: 50, font: fontBold, color: rgb(1, 0.6, 0) });
        page.drawText('DEPARTURE REQUIREMENTS', { x: 70, y: 650, size: 16, font: fontBold, color: rgb(1, 0.6, 0) });

        const items = ["Device functional.", "Van bag tools.", "Phone mount.", "Health video.", "Flex DVIC."];
        let yPos = 600;
        items.forEach(text => {
            page.drawRectangle({ x: 40, y: yPos, width: 14, height: 14, color: rgb(1, 1, 1) });
            page.drawText('X', { x: 43, y: yPos + 2, size: 11, font: fontBold, color: rgb(1, 0.6, 0) });
            page.drawText(text, { x: 65, y: yPos + 2, size: 11, font: fontReg, color: rgb(1, 1, 1) });
            yPos -= 30;
        });

        page.drawRectangle({ x: 35, y: yPos - 110, width: 330, height: 100, color: rgb(0.12, 0.15, 0.2) });
        page.drawRectangle({ x: 35, y: 220, width: 4, height: 100, color: rgb(1, 0.6, 0) });
        page.drawText('Report needs before wave time.', { x: 45, y: 320, size: 9, font: fontBold, color: rgb(0.8, 0.8, 0.8) });

        page.drawText('DA ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(1, 0.6, 0) });
        page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });

        const pdfBytes = await doc.save();
        const snapshotPath = path.join(UPLOAD_DIR, `Gate_${Date.now()}.pdf`);
        fs.writeFileSync(snapshotPath, pdfBytes);

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `CHECKLIST ALERT: ${name}`,
            text: `Receipt attached for DA ${name}.`,
            attachments: [{ filename: `Receipt_${name}.pdf`, path: snapshotPath }]
        });
        fs.unlinkSync(snapshotPath);
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- ROUTE: ARRIVAL CHECK ---
app.post('/log-arrival-check', async (req, res) => {
    const { name } = req.body;
    if (isDuplicate(ARRIVAL_LOG_FILE, name)) return res.json({ success: true });

    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    let logs = [];
    if (fs.existsSync(ARRIVAL_LOG_FILE)) { try { logs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE)); } catch(e) {} }
    logs.push({ name, timestamp, rawTimestamp: now.getTime() });
    fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify(logs, null, 2));

    try {
        const doc = await PDFDocument.create();
        const page = doc.addPage([400, 850]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        page.drawRectangle({ x: 0, y: 0, width: 400, height: 850, color: rgb(0.05, 0.08, 0.12) });
        page.drawText('!', { x: 190, y: 790, size: 50, font: fontBold, color: rgb(0, 0.66, 0.88) }); 
        page.drawText('ARRIVAL REQUIREMENTS', { x: 80, y: 750, size: 16, font: fontBold, color: rgb(0, 0.66, 0.88) });

        const items = ["Remove trash & belongings.", "Keys/Power Bank returned.", "Post-trip DVIC complete.", "Video uploaded.", "Lights off.", "No packages left."];
        let yPos = 700;
        items.forEach(text => {
            page.drawRectangle({ x: 40, y: yPos, width: 14, height: 14, color: rgb(1, 1, 1) });
            page.drawText('X', { x: 43, y: yPos + 2, size: 11, font: fontBold, color: rgb(0, 0.66, 0.88) });
            page.drawText(text, { x: 65, y: yPos + 2, size: 10, font: fontReg, color: rgb(1, 1, 1) });
            yPos -= 30;
        });

        page.drawRectangle({ x: 35, y: 220, width: 330, height: 150, color: rgb(0.12, 0.15, 0.2) });
        page.drawRectangle({ x: 35, y: 220, width: 4, height: 150, color: rgb(0, 0.66, 0.88) });
        page.drawText('Ensure vehicle is locked and plugged in (EDV).', { x: 45, y: 340, size: 9, font: fontBold, color: rgb(0.8, 0.8, 0.8) });

        page.drawText('ARRIVAL ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
        page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });

        const pdfBytes = await doc.save();
        const snapshotPath = path.join(UPLOAD_DIR, `Arrival_${Date.now()}.pdf`);
        fs.writeFileSync(snapshotPath, pdfBytes);

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `ARRIVAL COMPLETED: ${name}`,
            text: `Arrival receipt attached for DA ${name}.`,
            attachments: [{ filename: `Arrival_Receipt_${name}.pdf`, path: snapshotPath }]
        });
        fs.unlinkSync(snapshotPath);
        res.status(200).json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// --- ROUTE: ISSUE/ACCIDENT REPORT ---
app.post('/submit-report', async (req, res) => {
    // Extend timeout for large uploads (5 mins)
    req.setTimeout(300000);
    
    const data = req.body;
    // Deduping
    if (isDuplicate(DAILY_LOG_FILE, (data.vinLast4 || '') + (data.reportType || ''))) { return res.json({ success: true }); }

    let currentLogs = [];
    if (fs.existsSync(DAILY_LOG_FILE)) { try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {} }
    data.timestamp = new Date();
    data.rawTimestamp = Date.now(); 
    data.name = (data.vinLast4 || '') + (data.reportType || ''); 
    currentLogs.push(data);
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));

    // Discord Alert
    if (client.isReady()) {
        try {
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            const title = data.reportType.includes('ACCIDENT') ? "🚨 **ACCIDENT REPORT FILED**" : "⚠️ **ISSUE REPORT**";
            if (channel) channel.send(`${title}\n**Driver:** ${data.driverName}\n**VIN:** ${data.vinLast4}\n**Desc:** ${data.statement || data.otherDescription || 'None'}`);
        } catch(e) {}
    }

    try {
        const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GCP_SA_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
        const drive = google.drive({ version: 'v3', auth });
        let targetFolderId = data.reportType.includes('ACCIDENT') ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
        const folder = await drive.files.create({ resource: { name: `${data.driverName} - ${data.reportType}`, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] }, fields: 'id', supportsAllDrives: true });
        const folderId = folder.data.id;

        // Upload Photos to Drive (Backup)
        if (data.photos && data.photos.length) {
            for (let i = 0; i < data.photos.length; i++) {
                const buffer = Buffer.from(data.photos[i].data, 'base64');
                const bs = new stream.PassThrough(); bs.end(buffer);
                await drive.files.create({ resource: { name: `Photo_${i+1}.jpg`, parents: [folderId] }, media: { mimeType: 'image/jpeg', body: bs }, supportsAllDrives: true });
            }
        }

        const doc = await PDFDocument.create();
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        // --- SPECIFIC PDF GENERATION FOR ACCIDENTS ---
        if (data.reportType === 'ACCIDENT_REPORT') {
            let page = doc.addPage([600, 800]);
            
            // Header (Red for Accident)
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.9, 0.2, 0.2) });
            page.drawText('ACCIDENT REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText('OFFICIAL INCIDENT DOCUMENTATION', { x: 30, y: 740, size: 10, font: fontReg, color: rgb(1, 1, 1) });

            let y = 650;
            const drawLabel = (txt, val) => {
                page.drawText(txt, { x: 30, y, size: 9, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                page.drawText(val || 'N/A', { x: 150, y, size: 11, font: fontReg, color: rgb(0,0,0) });
                y -= 25;
            };

            drawLabel('DRIVER NAME', data.driverName);
            drawLabel('VIN', data.vinLast4);
            drawLabel('DATE/TIME', `${data.date} ${data.time}`);
            drawLabel('INCIDENT TYPE', data.incidentType);
            drawLabel('POLICE REPORT #', data.policeReport);
            drawLabel('LMET CASE #', data.lmetCase);
            
            y -= 10;
            page.drawLine({ start: { x: 30, y }, end: { x: 570, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
            y -= 25;

            // Address & Weather
            page.drawText('LOCATION DETAILS', { x: 30, y, size: 12, font: fontBold, color: rgb(0.9, 0.2, 0.2) });
            y -= 20;
            const loc = data.locationData || {};
            drawLabel('ADDRESS', `${loc.street || ''}, ${loc.city || ''}, ${loc.state || ''} ${loc.zip || ''}`);
            drawLabel('GPS COORDS', `${loc.gpsLat || ''}, ${loc.gpsLng || ''}`);
            drawLabel('WEATHER', data.weather || 'Unknown');

            y -= 20;
            // Statement
            page.drawText('DRIVER STATEMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0.9, 0.2, 0.2) });
            y -= 20;
            const stateLines = wrapText(data.statement || '', fontReg, 10, 540);
            stateLines.forEach(line => {
                page.drawText(line, { x: 30, y, size: 10, font: fontReg });
                y -= 14;
            });

            y -= 30;
            // Checklist & Affidavit
            page.drawText('AFFIDAVIT & ACKNOWLEDGMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0.9, 0.2, 0.2) });
            y -= 20;
            
            if (data.checklist && Array.isArray(data.checklist)) {
                data.checklist.forEach(item => {
                    page.drawText('[X] ' + item, { x: 30, y, size: 9, font: fontReg });
                    y -= 12;
                });
            }
            y -= 10;
            const affLines = wrapText(data.affidavit || '', fontReg, 9, 540);
            affLines.forEach(line => {
                page.drawText(line, { x: 30, y, size: 9, font: fontReg, color: rgb(0.3, 0.3, 0.3) });
                y -= 11;
            });

            // Signature
            y -= 20;
            page.drawText('SIGNED:', { x: 30, y, size: 10, font: fontBold });
            if (data.signature) {
                try {
                    const sigImage = await doc.embedPng(data.signature); // Base64 is PNG
                    const dims = sigImage.scale(0.5);
                    page.drawImage(sigImage, { x: 80, y: y - 40, width: dims.width, height: dims.height });
                } catch(e) { page.drawText('(Signature Error)', { x: 80, y }); }
            }

            // Photo Pages
            if (data.photos && data.photos.length > 0) {
                for (let i = 0; i < data.photos.length; i++) {
                    const photoPage = doc.addPage([600, 800]);
                    photoPage.drawText(`EVIDENCE PHOTO ${i + 1}`, { x: 30, y: 750, size: 16, font: fontBold });
                    try {
                        const imgBytes = Buffer.from(data.photos[i].data, 'base64');
                        const jpgImage = await doc.embedJpg(imgBytes);
                        const jpgDims = jpgImage.scaleToFit(540, 700);
                        photoPage.drawImage(jpgImage, {
                            x: 30,
                            y: 700 - jpgDims.height,
                            width: jpgDims.width,
                            height: jpgDims.height
                        });
                    } catch(e) { photoPage.drawText('(Image Error)', { x: 30, y: 700 }); }
                }
            }

            const pdfPath = path.join(UPLOAD_DIR, `Accident_${data.driverName}_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());

            // Email to Specific Recipients
            const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com', 'slgpfleetmanager@gmail.com'],
                subject: `URGENT: ACCIDENT REPORT - ${data.driverName} - ${data.vinLast4}`,
                text: `An Accident Report has been filed.\n\nDriver: ${data.driverName}\nVIN: ${data.vinLast4}\n\nSee attached PDF for full official report including statement, signature, and photos.\n\nGoogle Drive Folder: https://drive.google.com/drive/folders/${folderId}`,
                attachments: [{ filename: 'Official_Accident_Report.pdf', path: pdfPath }]
            });

            fs.unlinkSync(pdfPath);
            return res.json({ success: true });
        }

        // --- STANDARD REPORT LOGIC (FOR ISSUES) ---
        let page = doc.addPage([600, 800]);
        // Header
        page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.145, 0.388, 0.922) });
        page.drawText('VEHICLE REPORT ISSUE', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText('SLGP FLEET MANAGEMENT', { x: 30, y: 740, size: 10, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        // Logo
        try {
            const logoPath = path.join(__dirname, 'logo.png');
            if (fs.existsSync(logoPath)) {
                const logoBytes = fs.readFileSync(logoPath);
                const logoImage = await doc.embedPng(logoBytes);
                page.drawRectangle({ x: 380, y: 715, width: 200, height: 70, color: rgb(1,1,1) });
                const logoDims = logoImage.scaleToFit(180, 60);
                page.drawImage(logoImage, { x: 390 + (180 - logoDims.width) / 2, y: 720 + (60 - logoDims.height) / 2, width: logoDims.width, height: logoDims.height });
            }
        } catch(e) {}

        // Data Table
        let y = 650;
        const drawRow = (label, value) => {
            page.drawText(label, { x: 30, y, size: 9, font: fontBold, color: rgb(0.6, 0.6, 0.6) });
            const safeValue = value ? String(value) : 'N/A';
            page.drawText(safeValue, { x: 180, y, size: 11, font: fontReg, color: rgb(0,0,0) });
            page.drawLine({ start: { x: 30, y: y - 15 }, end: { x: 570, y: y - 15 }, thickness: 0.5, color: rgb(0.9, 0.9, 0.9) });
            y -= 40;
        };

        drawRow('REPORT CATEGORY', (data.reportType || 'N/A').toUpperCase());
        drawRow('DRIVER NAME', data.driverName || 'N/A');
        drawRow('VIN (LAST 4)', data.vinLast4 || 'N/A');
        drawRow('VEHICLE TYPE', data.vehicleType || 'N/A');
        drawRow('DATE & TIME', `${data.date || 'N/A'} at ${data.time || 'N/A'}`);
        
        let issuesText = (data.tags && data.tags.length) ? data.tags.join(', ') : 'None';
        if (data.reportType.includes('Road')) issuesText = `Location: ${data.addressStreet || ''}, ${data.addressCity || ''}`;
        drawRow('ISSUES SELECTED', issuesText);
        
        y -= 20;
        page.drawText('DETAILED DESCRIPTION / NOTES', { x: 30, y, size: 9, font: fontBold, color: rgb(0.6, 0.6, 0.6) });
        y -= 25;
        
        const notes = data.otherDescription || "No additional notes provided.";
        const noteLines = wrapText(notes, fontReg, 11, 540);
        noteLines.forEach(line => {
            page.drawText(line, { x: 30, y, size: 11, font: fontReg });
            y -= 15;
        });

        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `REPORT: ${data.vinLast4} - ${data.reportType}`,
            text: `Driver: ${data.driverName}\nVIN: ${data.vinLast4}\nCategory: ${data.reportType}\n\nPDF Attached.\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`,
            attachments: [{ filename: 'Vehicle_Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) { console.error(error); res.status(500).json({ success: false, error: error.message }); }
});

// --- BASIC ROUTES ---
app.get('/', (req, res) => { if (fs.existsSync(path.join(__dirname, 'menu.html'))) res.sendFile(path.join(__dirname, 'menu.html')); else res.sendFile(path.join(__dirname, 'index.html')); });
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
app.get('/vapid-key', (req, res) => res.json({ publicKey: publicVapidKey }));
app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    let subs = fs.existsSync(SUBSCRIPTION_FILE) ? JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)) : [];
    subs.push(subscription);
    fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(subs));
    res.status(201).json({});
});

// --- ROUTE: VIDEO UPLOAD ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    console.log("🎥 Video Upload Started...");
    try {
        const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GCP_SA_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
        const drive = google.drive({ version: 'v3', auth });
        
        const { driverName, vin, inspectionType } = req.body;
        console.log(`Video Details: ${driverName} - ${vin} - ${inspectionType}`);

        // Upload Video to the Video Folder
        await drive.files.create({
            resource: { name: `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });

        // Cleanup local file
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        console.log("✅ Video Upload Successful");
        res.status(200).send('Upload Complete');
    } catch (error) { 
        console.error("❌ Video Upload Failed:", error);
        res.status(500).send(`Error: ${error.message}`); 
    }
});

// --- CRON JOB: DAILY SUMMARY ---
cron.schedule('30 23 * * *', async () => {
    try {
        let summaryText = "\n--- DEPARTURE LOGS ---\n";
        if (fs.existsSync(GATE_LOG_FILE)) {
            const gateLogs = JSON.parse(fs.readFileSync(GATE_LOG_FILE));
            gateLogs.forEach(log => summaryText += `${log.timestamp}: ${log.name}\n`);
            fs.writeFileSync(GATE_LOG_FILE, JSON.stringify([])); 
        }
        summaryText += "\n--- ARRIVAL LOGS ---\n";
        if (fs.existsSync(ARRIVAL_LOG_FILE)) {
            const arrLogs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE));
            arrLogs.forEach(log => summaryText += `${log.timestamp}: ${log.name}\n`);
            fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify([]));
        }
        if (!fs.existsSync(DAILY_LOG_FILE)) return;
        const rawData = fs.readFileSync(DAILY_LOG_FILE);
        const allLogs = JSON.parse(rawData);
        if (allLogs.length === 0 && summaryText.length < 40) return;
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: ['slgpfleetmanager@gmail.com'], subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()}`, text: `Daily Summary Attached.\nTotal Reports: ${allLogs.length}\n${summaryText}` });
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
    } catch (e) { console.error("Cron Error:", e); }
}, { timezone: "America/New_York" });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
