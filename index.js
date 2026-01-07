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

// --- HELPER: CHECK FOR DUPLICATES (60-SEC WINDOW) ---
function isDuplicate(file, name) {
    if (!fs.existsSync(file)) return false;
    try {
        const logs = JSON.parse(fs.readFileSync(file));
        if (logs.length === 0) return false;
        const lastLog = logs[logs.length - 1];
        const lastTime = new Date(lastLog.rawTimestamp || Date.now()).getTime();
        const now = Date.now();
        // If same name and less than 60 seconds ago -> Duplicate
        return (lastLog.name === name && (now - lastTime < 60000));
    } catch (e) { return false; }
}

// --- DEPARTURE GATE ROUTE ---
app.post('/log-gate-check', async (req, res) => {
    const { name } = req.body;
    
    // SERVER-SIDE DEDUPING CHECK
    if (isDuplicate(GATE_LOG_FILE, name)) {
        console.log(`Blocked duplicate departure for ${name}`);
        return res.json({ success: true }); // Return success silently
    }

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

        page.drawText('DA ACKNOWLEDGMENT', { x: 40, y: yPos - 130, size: 10, font: fontBold, color: rgb(1, 0.6, 0) });
        page.drawText(name.toUpperCase(), { x: 50, y: yPos - 155, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: yPos - 180, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });

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
    } catch (e) { console.error("PDF Fail:", e); res.status(500).json({ success: false }); }
});

// --- ARRIVAL GATE ROUTE ---
app.post('/log-arrival-check', async (req, res) => {
    const { name } = req.body;
    
    // SERVER-SIDE DEDUPING CHECK
    if (isDuplicate(ARRIVAL_LOG_FILE, name)) {
        console.log(`Blocked duplicate arrival for ${name}`);
        return res.json({ success: true });
    }

    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    
    let logs = [];
    if (fs.existsSync(ARRIVAL_LOG_FILE)) { try { logs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE)); } catch(e) {} }
    logs.push({ name, timestamp, rawTimestamp: now.getTime() });
    fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify(logs, null, 2));

    try {
        const doc = await PDFDocument.create();
        const page = doc.addPage([400, 800]); 
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        page.drawRectangle({ x: 0, y: 0, width: 400, height: 800, color: rgb(0.05, 0.08, 0.12) });
        page.drawText('!', { x: 190, y: 740, size: 50, font: fontBold, color: rgb(0, 0.66, 0.88) }); 
        page.drawText('ARRIVAL REQUIREMENTS', { x: 80, y: 700, size: 16, font: fontBold, color: rgb(0, 0.66, 0.88) });

        const items = ["Trash removed.", "Device plugged in.", "Van bag returned.", "Post-trip DVIC.", "Keys returned.", "Lights off."];
        let yPos = 650;
        items.forEach(text => {
            page.drawRectangle({ x: 40, y: yPos, width: 14, height: 14, color: rgb(1, 1, 1) });
            page.drawText('X', { x: 43, y: yPos + 2, size: 11, font: fontBold, color: rgb(0, 0.66, 0.88) });
            page.drawText(text, { x: 65, y: yPos + 2, size: 10, font: fontReg, color: rgb(1, 1, 1) });
            yPos -= 30;
        });

        // Arrival Disclaimer (Full Text)
        yPos -= 20;
        page.drawRectangle({ x: 35, y: yPos - 220, width: 330, height: 220, color: rgb(0.12, 0.15, 0.2) });
        page.drawRectangle({ x: 35, y: yPos - 220, width: 4, height: 220, color: rgb(0, 0.66, 0.88) });
        
        let dY = yPos - 20;
        const disclaimerLines = [
            "All SLGP vehicles must be returned fully fueled and",
            "free of unsanitary materials. Drivers must remove",
            "trash, waste, and personal items.",
            "SLGP is not responsible for lost items.",
            "---",
            "Do not leave headlights/hazards on. Confirm all",
            "lights are off before parking.",
            "Report all issues in Fleet Check app.",
            "---",
            "EDV OPERATORS:",
            "1. Plug in vehicle.",
            "2. Close all doors fully.",
            "3. Turn off dashboard lighting.",
            "---",
            "Failure to follow may result in corrective action."
        ];

        disclaimerLines.forEach(line => {
            page.drawText(line, { x: 45, y: dY, size: 9, font: line.includes("---") || line.includes("OPERATORS") ? fontBold : fontReg, color: rgb(0.9, 0.9, 0.9) });
            dY -= 14;
        });

        page.drawText('ARRIVAL ACKNOWLEDGMENT', { x: 40, y: yPos - 250, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
        page.drawText(name.toUpperCase(), { x: 50, y: yPos - 275, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: yPos - 300, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });

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
    } catch (e) { console.error("Arrival PDF Fail:", e); res.status(500).json({ success: false }); }
});

// --- ROUTES ---
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
app.get('/vapid-key', (req, res) => res.json({ publicKey: publicVapidKey }));
app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    let subs = fs.existsSync(SUBSCRIPTION_FILE) ? JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)) : [];
    subs.push(subscription);
    fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(subs));
    res.status(201).json({});
});

const VIDEO_DRIVE_ID = '0AC1GE3XEm4K9Uk9PVA'; 
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA'; 

function logReportLocally(data) {
    let currentLogs = fs.existsSync(DAILY_LOG_FILE) ? JSON.parse(fs.readFileSync(DAILY_LOG_FILE)) : [];
    data.timestamp = new Date();
    currentLogs.push(data);
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));
}

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
        res.status(200).send('Upload Complete');
    } catch (error) { res.status(500).send(error.message); }
});

app.post('/submit-report', async (req, res) => {
    const data = req.body;
    logReportLocally(data);
    try {
        const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GCP_SA_KEY), scopes: ['https://www.googleapis.com/auth/drive.file'] });
        const drive = google.drive({ version: 'v3', auth });
        let targetFolderId = data.reportType.includes('Accident') ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
        const folder = await drive.files.create({ resource: { name: `${data.driverName} - ${data.reportType}`, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] }, fields: 'id', supportsAllDrives: true });
        const folderId = folder.data.id;
        const photoBuffers = [];
        if (data.photos) {
            for (let i = 0; i < data.photos.length; i++) {
                const buffer = Buffer.from(data.photos[i].data, 'base64');
                const bs = new stream.PassThrough(); bs.end(buffer);
                await drive.files.create({ resource: { name: `Photo_${i+1}.jpg`, parents: [folderId] }, media: { mimeType: 'image/jpeg', body: bs }, supportsAllDrives: true });
            }
        }
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: ['slgpfleetmanager@gmail.com'], subject: `REPORT: ${data.vinLast4}`, attachments: [{ filename: 'Report.pdf', path: pdfPath }] });
        fs.unlinkSync(pdfPath);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

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
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: ['slgpfleetmanager@gmail.com'], subject: `DAILY SUMMARY`, text: `Processed.\n${summaryText}` });
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
    } catch (e) {}
}, { timezone: "America/New_York" });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
