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

// --- CRITICAL FIX: DRIVE IDS MOVED TO TOP ---
// (This fixes the ReferenceError crashing your server)
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
    client.once(Events.ClientReady, c => console.log(`🤖 Fleet Bot Ready!`));
    client.on(Events.MessageCreate, async message => {
        if (message.author.bot || message.channelId !== DISCORD_CHANNEL_ID) return;
        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            let subs = [];
            try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)); } catch (e) {}
            const payload = JSON.stringify({ title: "📢 FLEET ALERT", body: message.content });
            const activeSubs = [];
            let changed = false;
            const pushPromises = subs.map(async (sub) => {
                try { await webpush.sendNotification(sub, payload); activeSubs.push(sub); } 
                catch (error) { changed = true; if (error.statusCode !== 410 && error.statusCode !== 404) activeSubs.push(sub); }
            });
            await Promise.all(pushPromises);
            if (changed) fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(activeSubs));
            message.react('✅');
        }
    });
}

if (!fs.existsSync(UPLOAD_DIR)) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {} }
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

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

// --- GATE ROUTES ---
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
        page.drawRectangle({ x: 35, y: yPos - 110, width: 4, height: 100, color: rgb(1, 0.6, 0) });
        page.drawText('Report needs before wave time.', { x: 45, y: yPos - 30, size: 9, font: fontBold, color: rgb(0.8, 0.8, 0.8) });

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

// --- REPORT ISSUE ROUTE (FIXED EMAIL & ID ERROR) ---
app.post('/submit-report', async (req, res) => {
    const data = req.body;
    
    // SERVER DEDUPING
    if (isDuplicate(DAILY_LOG_FILE, (data.vinLast4 || '') + (data.reportType || ''))) {
        return res.json({ success: true });
    }

    let currentLogs = [];
    if (fs.existsSync(DAILY_LOG_FILE)) { try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {} }
    data.timestamp = new Date();
    data.rawTimestamp = Date.now(); 
    data.name = (data.vinLast4 || '') + (data.reportType || ''); // For deduping
    currentLogs.push(data);
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));

    if (client.isReady()) {
        try {
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            const title = data.reportType.includes('Accident') ? "🚨 **ACCIDENT REPORT**" : "⚠️ **ISSUE REPORT**";
            if (channel) channel.send(`${title}\n**Driver:** ${data.driverName}\n**VIN:** ${data.vinLast4}\n**Desc:** ${data.otherDescription || 'None'}`);
        } catch(e) {}
    }

    try {
        const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GCP_SA_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
        const drive = google.drive({ version: 'v3', auth });
        let targetFolderId = data.reportType.includes('Accident') ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
        const folder = await drive.files.create({ resource: { name: `${data.driverName} - ${data.reportType}`, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] }, fields: 'id', supportsAllDrives: true });
        const folderId = folder.data.id;

        const photoBuffers = [];
        if (data.photos && data.photos.length) {
            for (let i = 0; i < data.photos.length; i++) {
                const buffer = Buffer.from(data.photos[i].data, 'base64');
                photoBuffers.push(buffer);
                const bs = new stream.PassThrough(); bs.end(buffer);
                await drive.files.create({ resource: { name: `Photo_${i+1}.jpg`, parents: [folderId] }, media: { mimeType: 'image/jpeg', body: bs }, supportsAllDrives: true });
            }
        }

        // --- PDF GENERATION WITH SAFETY CHECKS ---
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);
        
        page.drawRectangle({ x: 0, y: 720, width: 600, height: 80, color: rgb(0.14, 0.38, 0.92) });
        page.drawText('VEHICLE REPORT ISSUE', { x: 30, y: 765, size: 22, font: fontBold, color: rgb(1,1,1) });
        page.drawText('SLGP FLEET MANAGEMENT', { x: 30, y: 745, size: 10, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        let y = 680;
        const drawField = (title, value) => {
            page.drawText(title, { x: 30, y, size: 9, font: fontBold, color: rgb(0.5,0.5,0.5) });
            // Safety: Ensure value is a string and fallback to 'N/A'
            const safeValue = value ? String(value) : 'N/A';
            page.drawText(safeValue, { x: 150, y, size: 11, font: fontReg, color: rgb(0,0,0) });
            y -= 35;
        };

        drawField('REPORT CATEGORY', (data.reportType || 'N/A').toUpperCase());
        drawField('DRIVER NAME', data.driverName || 'N/A');
        drawField('VIN (LAST 4)', data.vinLast4 || 'N/A');
        drawField('VEHICLE TYPE', data.vehicleType || 'N/A');
        drawField('DATE & TIME', `${data.date || 'N/A'} at ${data.time || 'N/A'}`);
        
        if (data.reportType.includes('Road')) drawField('LOCATION', `${data.addressStreet || ''}, ${data.addressCity || ''}`);
        else drawField('ISSUES SELECTED', (data.tags && data.tags.length) ? data.tags.join(', ') : 'None');
        
        y -= 20;
        page.drawText('NOTES / DESCRIPTION', { x: 30, y, size: 9, font: fontBold, color: rgb(0.5,0.5,0.5) });
        y -= 20;
        const notes = data.otherDescription || "No additional notes provided.";
        const words = notes.split(' ');
        let line = '';
        for (const word of words) {
            if ((line + word).length > 80) {
                page.drawText(line, { x: 30, y, size: 11, font: fontReg });
                y -= 15; line = ''; 
            }
            line += word + ' ';
        }
        page.drawText(line, { x: 30, y, size: 11, font: fontReg });

        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        const recipients = data.reportType.includes('Accident') ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'] : ['slgpfleetmanager@gmail.com'];

        // --- FIXED SUBJECT LINE & BODY ---
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipients,
            subject: `REPORT: ${data.vinLast4} - ${data.reportType}`, // Matches request
            text: `Driver: ${data.driverName}\nVIN: ${data.vinLast4}\nCategory: ${data.reportType}\n\nPDF Attached.\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`, // Matches request
            attachments: [{ filename: 'Vehicle_Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) { console.error(error); res.status(500).json({ success: false, error: error.message }); }
});

// --- ROUTES ---
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

// --- GOOGLE DRIVE UPLOAD ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GCP_SA_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        await drive.files.create({
            resource: { name: `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true
        });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        if (client.isReady()) {
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            if (channel) channel.send(`🎥 **Video Uploaded:** ${driverName} (${inspectionType})`);
        }
        res.status(200).send('Upload Complete');
    } catch (error) { res.status(500).send(`Error: ${error.message}`); }
});

// --- CRON JOB ---
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