require('dotenv').config();
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

// ============================================
// CONFIGURATION
// ============================================
const APP_VERSION = Date.now();
const VERSION_STRING = '4.6.3';
const BUILD_INFO = {
    version: APP_VERSION,
    versionString: VERSION_STRING,
    buildDate: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    nodeVersion: process.version
};

const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');
const DAILY_LOG_FILE = path.join(VOLUME_PATH, 'daily_data.json');
const SUBSCRIPTION_FILE = path.join(VOLUME_PATH, 'subscriptions.json');
const GATE_LOG_FILE = path.join(VOLUME_PATH, 'gate_acknowledgments.json');
const ARRIVAL_LOG_FILE = path.join(VOLUME_PATH, 'arrival_acknowledgments.json');
const PANEL_DOC_PATH = path.join(__dirname, 'Panel_of_Physicians.pdf');

// ============================================
// DEBUG SYSTEM - LOG FILES
// ============================================
const LOGS_DIR = path.join(VOLUME_PATH, 'logs');
const DEBUG_LOG = path.join(LOGS_DIR, 'debug.json');
const ERROR_LOG = path.join(LOGS_DIR, 'errors.json');
const CAMERA_LOG = path.join(LOGS_DIR, 'camera-issues.json');
const PERFORMANCE_LOG = path.join(LOGS_DIR, 'performance.json');

const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA';

// ============================================
// DIRECTORY INITIALIZATION
// ============================================
async function ensureDirectories() {
    const dirs = [UPLOAD_DIR, LOGS_DIR];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`✅ Created directory: ${dir}`);
            } catch (e) {
                console.error(`❌ Failed to create ${dir}:`, e.message);
            }
        }
    }
}

ensureDirectories();

const upload = multer({ 
    dest: UPLOAD_DIR,
    limits: { fileSize: 200 * 1024 * 1024 }
});

app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ============================================
// DEBUG SYSTEM - LOGGING UTILITIES
// ============================================
async function appendLog(logFile, entry) {
    try {
        let logs = [];
        try {
            const data = fs.readFileSync(logFile, 'utf8');
            logs = JSON.parse(data);
        } catch (err) {}

        logs.push({
            ...entry,
            timestamp: new Date().toISOString(),
            serverTime: Date.now()
        });

        if (logs.length > 1000) {
            logs = logs.slice(-1000);
        }

        fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
    } catch (err) {
        console.error('Failed to write log:', err);
    }
}

async function getRecentLogs(logFile, limit = 50) {
    try {
        const data = fs.readFileSync(logFile, 'utf8');
        const logs = JSON.parse(data);
        return logs.slice(-limit).reverse();
    } catch (err) {
        return [];
    }
}

// ============================================
// DISCORD BOT SETUP
// ============================================
const DISCORD_BOT_TOKEN = process.env.FLEET_BOT_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN)
        .then(() => console.log('✅ Discord bot connected'))
        .catch(err => console.log('⚠️  Discord bot disabled:', err.message));
    
    client.once(Events.ClientReady, c => {
        console.log(`🤖 Fleet Bot Ready: ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot || message.channelId !== DISCORD_CHANNEL_ID) return;
        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            let subs = [];
            try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)); } catch (e) {}
            const payload = JSON.stringify({ title: "📢 FLEET ALERT", body: message.content });
            await Promise.all(subs.map(async (sub) => {
                try { await webpush.sendNotification(sub, payload); } catch (e) {}
            }));
        }
    });
}

// ============================================
// VAPID KEYS SETUP
// ============================================
let publicVapidKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim().replace(/['"]+/g, '') : null;
let privateVapidKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim().replace(/['"]+/g, '') : null;

if (!publicVapidKey || !privateVapidKey) {
    const vapidKeys = webpush.generateVAPIDKeys();
    publicVapidKey = vapidKeys.publicKey;
    privateVapidKey = vapidKeys.privateKey;
    console.log('⚠️  VAPID keys generated');
}

webpush.setVapidDetails('mailto:' + (process.env.EMAIL_USER || 'slgpfleetmanager@gmail.com'), publicVapidKey, privateVapidKey);

// ============================================
// GOOGLE DRIVE SETUP
// ============================================
let driveClient = null;

function initializeDrive() {
    try {
        if (!process.env.GCP_SA_KEY) {
            console.error('❌ GCP_SA_KEY not set - Google Drive disabled');
            return;
        }
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        driveClient = google.drive({ version: 'v3', auth });
        console.log('✅ Google Drive connected');
    } catch (error) {
        console.error('❌ Google Drive failed:', error.message);
    }
}

initializeDrive();

// ============================================
// HELPER FUNCTIONS
// ============================================
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

function sanitizeText(text) {
    if (!text) return "";
    return text.toString().replace(/(\r\n|\n|\r)/gm, " ").replace(/[^\x20-\x7E]/g, "");
}

function wrapText(text, font, size, maxWidth) {
    if (!text) return [];
    const cleanText = sanitizeText(text);
    const words = cleanText.split(' ');
    let lines = [];
    let currentLine = words[0] || '';
    for (let i = 1; i < words.length; i++) {
        const testLine = currentLine + " " + words[i];
        const width = font.widthOfTextAtSize(testLine, size);
        if (width < maxWidth) {
            currentLine = testLine;
        } else {
            lines.push(currentLine);
            currentLine = words[i];
        }
    }
    lines.push(currentLine);
    return lines;
}

// ============================================
// DEBUG SYSTEM - API ENDPOINTS
// ============================================
app.post('/api/log-error', async (req, res) => {
    const { message, stack, url, lineNo, colNo, userAgent, screen, viewport, context, severity } = req.body;
    const errorEntry = {
        type: 'client_error',
        severity: severity || 'error',
        message, stack, url, lineNo, colNo,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip, screen, viewport, context
    };
    await appendLog(ERROR_LOG, errorEntry);
    console.error('❌ Client Error:', message);
    res.json({ success: true, logged: true });
});

app.post('/api/log-camera-debug', async (req, res) => {
    const { event, cameras, selectedCamera, strategy, resolution, facingMode, rejected, reason, userAgent, deviceInfo } = req.body;
    const cameraEntry = {
        type: 'camera_debug',
        event, cameras: cameras || [], selectedCamera, strategy, resolution,
        facingMode, rejected, reason,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip, deviceInfo
    };
    await appendLog(CAMERA_LOG, cameraEntry);
    console.log('📹 Camera Debug:', event);
    res.json({ success: true, logged: true });
});

app.post('/api/log-performance', async (req, res) => {
    const { action, duration, success, fileSize, details, userAgent } = req.body;
    const perfEntry = {
        type: 'performance',
        action, duration, success, fileSize, details,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip
    };
    await appendLog(PERFORMANCE_LOG, perfEntry);
    res.json({ success: true, logged: true });
});

app.post('/api/log-debug', async (req, res) => {
    const { category, message, data, userAgent } = req.body;
    const debugEntry = {
        type: 'debug', category, message, data,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip
    };
    await appendLog(DEBUG_LOG, debugEntry);
    console.log('🐛 Debug:', category, '-', message);
    res.json({ success: true, logged: true });
});

// ============================================
// API ROUTES - GATE & ARRIVAL CHECKS
// ============================================
app.post('/log-gate-check', async (req, res) => {
    const perfStart = Date.now();
    try {
        const { name } = req.body;
        if (isDuplicate(GATE_LOG_FILE, name)) {
            return res.json({ success: true });
        }
        const now = new Date();
        const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        let logs = [];
        if (fs.existsSync(GATE_LOG_FILE)) {
            try { logs = JSON.parse(fs.readFileSync(GATE_LOG_FILE)); } catch(e) {}
        }
        logs.push({ name, timestamp, rawTimestamp: now.getTime() });
        fs.writeFileSync(GATE_LOG_FILE, JSON.stringify(logs, null, 2));
        res.json({ success: true });

        setImmediate(async () => {
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
                page.drawRectangle({ x: 35, y: 220, width: 330, height: 100, color: rgb(0.12, 0.15, 0.2) });
                page.drawRectangle({ x: 35, y: 220, width: 4, height: 100, color: rgb(1, 0.6, 0) });
                page.drawText('Report needs before wave time.', { x: 45, y: 320, size: 9, font: fontBold, color: rgb(0.8, 0.8, 0.8) });
                page.drawText('Missing items will delay departure.', { x: 45, y: 305, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Contact dispatch immediately for support.', { x: 45, y: 290, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Safety First: Never depart unprepared.', { x: 45, y: 250, size: 9, font: fontBold, color: rgb(1, 0.6, 0) });
                page.drawText('All equipment must be verified functional.', { x: 45, y: 235, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('DA ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(1, 0.6, 0) });
                page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
                page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });
                page.drawText('I confirm all departure requirements are met.', { x: 40, y: 75, size: 8, font: fontReg, color: rgb(0.6, 0.6, 0.6) });
                const pdfBytes = await doc.save();
                const snapshotPath = path.join(UPLOAD_DIR, `Gate_${Date.now()}.pdf`);
                fs.writeFileSync(snapshotPath, pdfBytes);
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: ['slgpfleetmanager@gmail.com'],
                    subject: `✅ DEPARTURE CHECKLIST: ${name}`,
                    text: `Receipt attached for DA ${name}.\n\nAll departure requirements confirmed at ${timestamp}.`,
                    attachments: [{ filename: `Departure_Receipt_${name}.pdf`, path: snapshotPath }]
                });
                fs.unlinkSync(snapshotPath);
                console.log(`✅ Gate check PDF emailed for ${name}`);
            } catch (e) {
                console.error('Gate check PDF/email error:', e);
                await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Gate PDF generation failed', stack: e.stack, source: 'log-gate-check' });
            }
        });
    } catch (e) {
        console.error('Gate check error:', e);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'critical', message: 'Gate check failed', stack: e.stack, source: 'log-gate-check' });
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/log-arrival-check', async (req, res) => {
    const perfStart = Date.now();
    try {
        const { name } = req.body;
        if (isDuplicate(ARRIVAL_LOG_FILE, name)) {
            return res.json({ success: true });
        }
        const now = new Date();
        const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        let logs = [];
        if (fs.existsSync(ARRIVAL_LOG_FILE)) {
            try { logs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE)); } catch(e) {}
        }
        logs.push({ name, timestamp, rawTimestamp: now.getTime() });
        fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify(logs, null, 2));
        res.json({ success: true });

        setImmediate(async () => {
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
                page.drawText('END OF SHIFT CHECKLIST', { x: 45, y: 350, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText('Ensure vehicle is locked and plugged in (EDV).', { x: 45, y: 330, size: 9, font: fontReg, color: rgb(0.8, 0.8, 0.8) });
                page.drawText('All equipment must be accounted for.', { x: 45, y: 315, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Report any damage or issues immediately.', { x: 45, y: 300, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Incomplete arrivals delay next shift.', { x: 45, y: 270, size: 9, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText('Double-check all items before leaving.', { x: 45, y: 255, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Missing packages = escalation to management.', { x: 45, y: 240, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('ARRIVAL ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
                page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });
                page.drawText('I confirm all arrival requirements are met.', { x: 40, y: 75, size: 8, font: fontReg, color: rgb(0.6, 0.6, 0.6) });
                page.drawText('Vehicle is secured and ready for next shift.', { x: 40, y: 60, size: 8, font: fontReg, color: rgb(0.6, 0.6, 0.6) });
                const pdfBytes = await doc.save();
                const snapshotPath = path.join(UPLOAD_DIR, `Arrival_${Date.now()}.pdf`);
                fs.writeFileSync(snapshotPath, pdfBytes);
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: ['slgpfleetmanager@gmail.com'],
                    subject: `✅ ARRIVAL COMPLETED: ${name}`,
                    text: `Arrival receipt attached for DA ${name}.\n\nAll arrival requirements confirmed at ${timestamp}.`,
                    attachments: [{ filename: `Arrival_Receipt_${name}.pdf`, path: snapshotPath }]
                });
                fs.unlinkSync(snapshotPath);
                console.log(`✅ Arrival check PDF emailed for ${name}`);
            } catch (e) {
                console.error('Arrival check PDF/email error:', e);
                await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Arrival PDF generation failed', stack: e.stack, source: 'log-arrival-check' });
            }
        });
    } catch (e) {
        console.error('Arrival check error:', e);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'critical', message: 'Arrival check failed', stack: e.stack, source: 'log-arrival-check' });
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================
// API ROUTES - REPORTS
// ============================================
app.post('/submit-report', async (req, res) => {
    try {
        const data = req.body;
        if (isDuplicate(DAILY_LOG_FILE, (data.vinLast4 || '') + (data.reportType || ''))) {
            return res.json({ success: true });
        }
        let currentLogs = [];
        if (fs.existsSync(DAILY_LOG_FILE)) {
            try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {}
        }
        data.timestamp = new Date();
        data.rawTimestamp = Date.now();
        data.name = (data.vinLast4 || '') + (data.reportType || '');
        currentLogs.push(data);
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));

        if (client.isReady()) {
            try {
                const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
                const title = data.reportType === 'ACCIDENT_REPORT' ? "🚨 **ACCIDENT REPORT FILED**" : "⚠️ **ISSUE REPORT**";
                if (channel) {
                    channel.send(`${title}\n**Driver:** ${data.driverName}\n**VIN:** ${data.vinLast4}\n**Desc:** ${data.statement || data.otherDescription || 'None'}`);
                }
            } catch(e) { console.error('Discord notification failed:', e.message); }
        }

        let folderId = null;
        if (driveClient) {
            try {
                let targetFolderId = data.reportType === 'ACCIDENT_REPORT' ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
                const folder = await driveClient.files.create({
                    resource: { name: `${data.driverName} - ${data.reportType} - ${new Date().toLocaleDateString()}`, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] },
                    fields: 'id', supportsAllDrives: true
                });
                folderId = folder.data.id;
                if (data.photos && data.photos.length) { console.log(`📸 Received ${data.photos.length} photos - will attach to email`); }
                else { console.warn('⚠️  No photos attached to accident report'); }
            } catch (driveError) { console.error("Drive upload failed:", driveError.message); }
        }

        const doc = await PDFDocument.create();
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        let emailUser = process.env.EMAIL_USER;
        let emailPass = process.env.EMAIL_PASS;
        if (data.reportType === 'ACCIDENT_REPORT' && process.env.INCIDENTS_EMAIL_USER) {
            emailUser = process.env.INCIDENTS_EMAIL_USER;
            emailPass = process.env.INCIDENTS_PASS;
        }

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });

        if (data.reportType === 'ACCIDENT_REPORT') {
            let page = doc.addPage([600, 800]);
            let y = 780;
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.9, 0.2, 0.2) });
            page.drawText('ACCIDENT REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText(`Filed: ${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}`, { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
            y = 680;
            page.drawText('DRIVER & VEHICLE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`Driver Name: ${data.driverName || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`VIN Last 4: ${data.vinLast4 || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`Incident Type: ${data.incidentType || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            page.drawText('LOCATION INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            if (data.locationData) {
                page.drawText(`Address: ${data.locationData.street || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                page.drawText(`City: ${data.locationData.city || 'N/A'}, State: ${data.locationData.state || 'N/A'}, Zip: ${data.locationData.zip || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                page.drawText(`GPS: ${data.locationData.gpsLat || 'N/A'}, ${data.locationData.gpsLng || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            }
            page.drawText(`Weather: ${data.weather || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            page.drawText('CASE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`Police Report #: ${data.policeReport || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`LMET Case #: ${data.lmetCase || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            page.drawText('DETAILED STATEMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            const statement = data.statement || 'No statement provided';
            const statementLines = wrapText(statement, fontReg, 10, 540);
            for (let line of statementLines) {
                if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
                page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            }
            y -= 10;
            if (data.photos && data.photos.length > 0) {
                page.drawText('PHOTO EVIDENCE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                page.drawText(`Total Photos: ${data.photos.length}`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) }); y -= 15;
                for (let i = 0; i < data.photos.length; i++) {
                    if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
                    page.drawText(`  • Photo ${i+1}.jpg - Attached to email`, { x: 40, y, size: 9, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                }
                page.drawText('All photos attached to this email', { x: 30, y, size: 9, font: fontReg, color: rgb(0.3,0.3,0.3) }); y -= 25;
            }
            if (data.signature) {
                page.drawText('DRIVER SIGNATURE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                try {
                    const sigImage = await doc.embedPng('data:image/png;base64,' + data.signature);
                    page.drawImage(sigImage, { x: 30, y: y - 60, width: 200, height: 60 }); y -= 70;
                } catch (sigErr) {
                    page.drawText('(Signature image error)', { x: 30, y, size: 10, font: fontReg, color: rgb(0.5,0,0) }); y -= 20;
                }
            }
            if (data.affidavit) {
                if (y < 150) { page = doc.addPage([600, 800]); y = 780; }
                page.drawText('AFFIDAVIT ACKNOWLEDGMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                const affLines = wrapText(data.affidavit, fontReg, 8, 540);
                for (let line of affLines.slice(0, 10)) {
                    page.drawText(line, { x: 30, y, size: 8, font: fontReg, color: rgb(0,0,0) }); y -= 12;
                }
            }
            const pdfPath = path.join(UPLOAD_DIR, `Accident_${data.driverName}_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());
            const incidentTypeUC = (data.incidentType || 'ACCIDENT').toUpperCase();
            const lmetText = data.lmetCase ? `LMET# ${data.lmetCase}` : 'NO LMET';
            const driverNameUC = (data.driverName || 'UNKNOWN').toUpperCase();
            const emailAttachments = [{ filename: 'Official_Accident_Report.pdf', path: pdfPath }];
            if (data.photos && data.photos.length) {
                console.log(`📧 Attaching ${data.photos.length} photos to email...`);
                for (let i = 0; i < data.photos.length; i++) {
                    try {
                        const photoBuffer = Buffer.from(data.photos[i].data, 'base64');
                        const photoPath = path.join(UPLOAD_DIR, `accident_photo_${Date.now()}_${i}.jpg`);
                        fs.writeFileSync(photoPath, photoBuffer);
                        emailAttachments.push({ filename: `Photo_${i+1}.jpg`, path: photoPath });
                        console.log(`✅ Photo ${i+1}/${data.photos.length} prepared for email`);
                    } catch (photoError) { console.error(`❌ Failed to prepare photo ${i+1}:`, photoError.message); }
                }
            }
            const photoCount = data.photos ? data.photos.length : 0;
            const photoText = photoCount > 0 ? `${photoCount} photos attached` : 'No photos';
            await transporter.sendMail({
                from: emailUser,
                to: ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com', 'slgpfleetmanager@gmail.com'],
                subject: `🚨 URGENT: ${incidentTypeUC} - ${lmetText} - DA ${driverNameUC}`,
                html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;"><div style="background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;"><h1 style="color: white; margin: 0; font-size: 28px;">🚨 URGENT: ACCIDENT REPORT</h1><p style="color: #fee2e2; margin: 10px 0 0 0; font-size: 14px;">Immediate attention required</p></div><div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;"><h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📋 Incident Details</h2><table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;"><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${data.driverName}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN Last 4:</td><td style="padding: 12px; color: #1f2937;">${data.vinLast4}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Incident Type:</td><td style="padding: 12px; color: #1f2937;">${data.incidentType || 'N/A'}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Police Report #:</td><td style="padding: 12px; color: #1f2937;">${data.policeReport || 'N/A'}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">LMET Case #:</td><td style="padding: 12px; color: #1f2937;">${data.lmetCase || 'N/A'}</td></tr></table><div style="background: #fef2f2; border-left: 4px solid #EF4444; padding: 20px; margin-bottom: 25px; border-radius: 4px;"><h3 style="color: #DC2626; margin: 0 0 12px 0; font-size: 16px;">📸 PHOTO EVIDENCE</h3><p style="color: #991b1b; margin: 0; font-size: 14px;"><strong>${photoText}</strong> to this email</p></div><div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;"><p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;"><strong>⚠️ ACTION REQUIRED:</strong><br>1. Review attached PDF report immediately<br>2. View all photo attachments in this email<br>3. Contact driver if additional information needed<br>4. Follow up on LMET case and police report</p></div></div></div>`,
                attachments: emailAttachments
            });
            if (data.photos && data.photos.length) {
                for (let i = 0; i < emailAttachments.length; i++) {
                    if (emailAttachments[i].filename.startsWith('Photo_')) {
                        try { fs.unlinkSync(emailAttachments[i].path); } catch (e) {}
                    }
                }
            }
            fs.unlinkSync(pdfPath);
        } else {
            let page = doc.addPage([600, 800]);
            let y = 780;
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.145, 0.388, 0.922) });
            page.drawText('ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText(`Filed: ${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}`, { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
            y = 680;
            page.drawText('DRIVER & VEHICLE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`Driver Name: ${data.driverName || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`VIN Last 4: ${data.vinLast4 || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`Report Type: ${data.reportType || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            if (data.otherDescription) {
                page.drawText('ISSUE DESCRIPTION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                const descLines = wrapText(data.otherDescription, fontReg, 10, 540);
                for (let line of descLines) {
                    if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
                    page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                }
                y -= 10;
            }
            if (data.photos && data.photos.length > 0) {
                page.drawText(`Photos Attached: ${data.photos.length} (uploaded to Google Drive)`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) }); y -= 25;
            }
            const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());
            await transporter.sendMail({
                from: emailUser,
                to: ['slgpfleetmanager@gmail.com'],
                subject: `REPORT: ${data.vinLast4} - ${data.reportType}`,
                text: `Driver: ${data.driverName}\nVIN: ${data.vinLast4}\n\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`,
                attachments: [{ filename: 'Vehicle_Report.pdf', path: pdfPath }]
            });
            fs.unlinkSync(pdfPath);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Report submission error:', error);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Report submission failed', stack: error.stack, source: 'submit-report' });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// LEARNING AI SYSTEM - DATABASES
// ============================================
const ISSUE_HISTORY_FILE = path.join(VOLUME_PATH, 'issue_history.json');
const KNOWLEDGE_BASE_FILE = path.join(VOLUME_PATH, 'fleet_knowledge_base.json');

function initializeLearningSystem() {
    if (!fs.existsSync(ISSUE_HISTORY_FILE)) {
        const initialHistory = { total_issues: 0, classifications: [], patterns: {}, last_updated: new Date().toISOString() };
        fs.writeFileSync(ISSUE_HISTORY_FILE, JSON.stringify(initialHistory, null, 2));
        console.log('✅ Issue history database initialized');
    }
    if (!fs.existsSync(KNOWLEDGE_BASE_FILE)) {
        const initialKnowledge = {
            common_issues: {
                brake_problems: { keywords: ["grinding", "squealing", "brake", "stopping", "shake", "vibration"], priority: "HIGH_PRIORITY", category: "Brakes Squealing / Grinding", typical_causes: ["worn brake pads", "warped rotors", "brake fluid low"], fleet_frequency: 0 },
                battery_issues: { keywords: ["won't start", "dead battery", "clicking", "no power"], priority: "HIGH_PRIORITY", category: "Flat Tire / Battery Dead", typical_causes: ["battery age", "alternator failure", "parasitic drain"], fleet_frequency: 0 },
                charging_issues: { keywords: ["not charging", "charge", "plug", "EDV", "electric"], priority: "EDV_ELECTRIC", category: "Vehicle Not Charging", typical_causes: ["charging port damage", "cable fault", "onboard charger"], fleet_frequency: 0 },
                cosmetic_damage: { keywords: ["scratch", "dent", "paint", "cosmetic", "minor damage"], priority: "LOW_PRIORITY", category: "Light Scratches", typical_causes: ["parking incidents", "debris", "normal wear"], fleet_frequency: 0 }
            },
            vehicle_specific: {
                rivian: { common_issues: ["charging port", "bulkhead door", "key fob battery"], priority_override: "EDV_ELECTRIC" },
                diesel: { common_issues: ["DEF system", "exhaust", "turbo"], watches: ["DEF light", "exhaust smoke", "power loss"] }
            },
            learned_patterns: {},
            last_updated: new Date().toISOString()
        };
        fs.writeFileSync(KNOWLEDGE_BASE_FILE, JSON.stringify(initialKnowledge, null, 2));
        console.log('✅ Fleet knowledge base initialized');
    }
}

initializeLearningSystem();

function loadLearningData() {
    try {
        const history = JSON.parse(fs.readFileSync(ISSUE_HISTORY_FILE, 'utf8'));
        const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
        return { history, knowledge };
    } catch (e) {
        console.error('Failed to load learning data:', e);
        return { history: { classifications: [] }, knowledge: { common_issues: {} } };
    }
}

function saveClassification(description, classification, vehicleType, vinLast4) {
    try {
        const history = JSON.parse(fs.readFileSync(ISSUE_HISTORY_FILE, 'utf8'));
        history.total_issues++;
        history.classifications.push({ timestamp: new Date().toISOString(), description, classification, vehicle_type: vehicleType, vin: vinLast4 });
        if (history.classifications.length > 500) { history.classifications = history.classifications.slice(-500); }
        const priorityKey = classification.priority;
        if (!history.patterns[priorityKey]) { history.patterns[priorityKey] = 0; }
        history.patterns[priorityKey]++;
        history.last_updated = new Date().toISOString();
        fs.writeFileSync(ISSUE_HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`📚 Classification saved to learning database (Total: ${history.total_issues})`);
    } catch (e) { console.error('Failed to save classification:', e); }
}

function updateKnowledgeBase(description, classification) {
    try {
        const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
        const words = description.toLowerCase().split(/\s+/);
        for (const [issueKey, issueData] of Object.entries(knowledge.common_issues)) {
            const matches = issueData.keywords.filter(keyword => words.some(word => word.includes(keyword) || keyword.includes(word)));
            if (matches.length > 0) { issueData.fleet_frequency++; console.log(`📊 Updated frequency for ${issueKey}: ${issueData.fleet_frequency}`); }
        }
        const categoryKey = classification.category.toLowerCase().replace(/\s+/g, '_');
        if (!knowledge.learned_patterns[categoryKey]) { knowledge.learned_patterns[categoryKey] = { count: 0, example_descriptions: [] }; }
        knowledge.learned_patterns[categoryKey].count++;
        if (knowledge.learned_patterns[categoryKey].example_descriptions.length < 5) {
            knowledge.learned_patterns[categoryKey].example_descriptions.push(description);
        }
        knowledge.last_updated = new Date().toISOString();
        fs.writeFileSync(KNOWLEDGE_BASE_FILE, JSON.stringify(knowledge, null, 2));
        console.log('🧠 Knowledge base updated with new patterns');
    } catch (e) { console.error('Failed to update knowledge base:', e); }
}

function buildLearningPrompt(description, vehicleType, vinLast4, learningData) {
    const { history, knowledge } = learningData;
    const recentSimilar = history.classifications.filter(c => {
        const descWords = description.toLowerCase().split(/\s+/);
        const histWords = c.description.toLowerCase().split(/\s+/);
        const overlap = descWords.filter(w => histWords.includes(w)).length;
        return overlap > 2;
    }).slice(-3);
    let historicalContext = '';
    if (recentSimilar.length > 0) {
        historicalContext = '\n\nRECENT SIMILAR ISSUES:\n';
        recentSimilar.forEach((item, idx) => { historicalContext += `${idx + 1}. "${item.description}" → ${item.classification.priority} (${item.classification.category})\n`; });
    }
    let fleetContext = '\n\nFLEET-SPECIFIC KNOWLEDGE:\n';
    if (vehicleType && vehicleType.toLowerCase().includes('rivian')) {
        fleetContext += '- Vehicle is Electric (Rivian EDV)\n- Common Rivian issues: charging port, bulkhead door, key fob battery\n- Prioritize as EDV_ELECTRIC for electric-specific issues\n';
    }
    if (vehicleType && vehicleType.toLowerCase().includes('diesel')) { fleetContext += '- Vehicle is Diesel\n- Watch for: DEF system, exhaust, turbo issues\n'; }
    const topIssues = Object.entries(knowledge.common_issues).sort((a, b) => b[1].fleet_frequency - a[1].fleet_frequency).slice(0, 3);
    if (topIssues.length > 0) {
        fleetContext += '\nMOST COMMON ISSUES IN THIS FLEET:\n';
        topIssues.forEach(([key, data]) => { fleetContext += `- ${data.category} (${data.fleet_frequency} occurrences)\n`; });
    }
    return `You are analyzing a vehicle issue for SLGP Fleet. Use your knowledge AND the historical data below to make an accurate classification.

CURRENT ISSUE: "${description}"
VEHICLE: ${vehicleType || 'Unknown'} (VIN: ${vinLast4})
${historicalContext}${fleetContext}

CLASSIFICATION RULES:
1. HIGH PRIORITY - Safety-critical issues requiring immediate attention:
   - Brakes squealing/grinding/failure, Tire blowout/extreme wear/flat tire
   - Steering problems/column loose, Vehicle won't start/dead battery
   - Burning smell/fluid leaks, Doors stuck (affects deliveries)
   - Lights out (safety hazard), Backup camera failure
   - Low DEF warning (diesel), Missing license plate/tag

2. EDV_ELECTRIC - Electric vehicle specific issues (Rivian fleet):
   - Key fob battery low, Vehicle not charging/charging issues
   - Electric system warning lights, Bulkhead door problems
   - Severe body damage, Broken mirror/glass

3. LOW_PRIORITY - Minor issues not affecting immediate safety/operation:
   - Light scratches/cosmetic damage, Interior cleanliness
   - Door sensor errors (non-critical), Seat adjustment problems
   - Radio/audio malfunctions, QR code faded/unreadable

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "priority": "HIGH_PRIORITY" or "EDV_ELECTRIC" or "LOW_PRIORITY",
  "category": "specific issue category from lists above",
  "confidence": 0.0 to 1.0,
  "reasoning": "brief explanation including any historical pattern matches"
}`;
}

// ============================================
// LEARNING AI ISSUE REPORT ENDPOINT
// ============================================
app.post('/submit-issue-ai', async (req, res) => {
    try {
        const { driverName, vinLast4, vehicleType, issueDescription, date, time, photos } = req.body;
        if (!driverName || !vinLast4 || !issueDescription) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        console.log(`\n🔍 Issue Report - Driver: ${driverName}, VIN: ${vinLast4}`);
        console.log(`📝 Description: "${issueDescription}"`);
        const learningData = loadLearningData();
        console.log(`🧠 Loaded ${learningData.history.total_issues} historical classifications`);
        const classificationPrompt = buildLearningPrompt(issueDescription, vehicleType, vinLast4, learningData);
        let aiResponse = null;
        try {
            const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: classificationPrompt }] })
            });
            if (!apiResponse.ok) { throw new Error(`Claude API error: ${apiResponse.status}`); }
            const apiData = await apiResponse.json();
            const responseText = apiData.content[0].text;
            aiResponse = JSON.parse(responseText);
            console.log(`🤖 Classification: ${aiResponse.priority} - ${aiResponse.category}`);
            console.log(`📊 Confidence: ${Math.round(aiResponse.confidence * 100)}%`);
            saveClassification(issueDescription, aiResponse, vehicleType, vinLast4);
            updateKnowledgeBase(issueDescription, aiResponse);
        } catch (aiError) {
            console.error('❌ AI Classification failed:', aiError.message);
            aiResponse = { priority: 'HIGH_PRIORITY', category: 'Other (See Notes)', confidence: 0.5, reasoning: 'AI unavailable - defaulting to high priority for safety' };
        }
        let reportType = 'General Issue';
        if (aiResponse.priority === 'HIGH_PRIORITY') reportType = 'High Priority Issue';
        else if (aiResponse.priority === 'EDV_ELECTRIC') reportType = 'Electric Vehicle Issue';
        else if (aiResponse.priority === 'LOW_PRIORITY') reportType = 'Low Priority Issue';
        const doc = await PDFDocument.create();
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);
        let page = doc.addPage([600, 800]);
        let y = 780;
        const headerColor = aiResponse.priority === 'HIGH_PRIORITY' ? rgb(0.9, 0.2, 0.2) : aiResponse.priority === 'EDV_ELECTRIC' ? rgb(0.145, 0.388, 0.922) : rgb(0.4, 0.6, 0.3);
        page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: headerColor });
        page.drawText('FLEET ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`Filed: ${date} ${time}`, { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
        page.drawText(`Priority: ${aiResponse.priority}`, { x: 30, y: 710, size: 12, font: fontBold, color: rgb(1,1,1) });
        y = 680;
        page.drawText('CLASSIFICATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0.2,0.2,0.2) }); y -= 20;
        page.drawText(`Category: ${aiResponse.category}`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) }); y -= 15;
        page.drawText(`Confidence: ${Math.round(aiResponse.confidence * 100)}%`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
        const reasoningLines = wrapText(aiResponse.reasoning, fontReg, 9, 540);
        for (let line of reasoningLines.slice(0, 3)) { page.drawText(line, { x: 30, y, size: 9, font: fontReg, color: rgb(0.3,0.3,0.3) }); y -= 12; }
        y -= 15;
        page.drawText('DRIVER & VEHICLE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
        page.drawText(`Driver: ${driverName}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
        page.drawText(`VIN: ${vinLast4} | Type: ${vehicleType || 'Unknown'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
        page.drawText('ISSUE DESCRIPTION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
        const descLines = wrapText(issueDescription, fontReg, 10, 540);
        for (let line of descLines) {
            if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
            page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
        }
        y -= 10;
        if (photos && photos.length > 0) {
            page.drawText('EVIDENCE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`${photos.length} file(s) attached to email`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) });
        }
        const pdfPath = path.join(UPLOAD_DIR, `Issue_${driverName}_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());
        const emailAttachments = [{ filename: 'Issue_Report.pdf', path: pdfPath }];
        if (photos && photos.length > 0) {
            console.log(`📧 Attaching ${photos.length} files...`);
            for (let i = 0; i < photos.length; i++) {
                try {
                    const fileBuffer = Buffer.from(photos[i].data, 'base64');
                    const ext = photos[i].name.includes('.mp4') || photos[i].name.includes('video') ? 'mp4' : 'jpg';
                    const filePath = path.join(UPLOAD_DIR, `evidence_${Date.now()}_${i}.${ext}`);
                    fs.writeFileSync(filePath, fileBuffer);
                    emailAttachments.push({ filename: `Evidence_${i+1}.${ext}`, path: filePath });
                } catch (e) { console.error(`❌ File ${i+1} attachment failed:`, e.message); }
            }
        }
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        const priorityEmoji = aiResponse.priority === 'HIGH_PRIORITY' ? '🚨' : aiResponse.priority === 'EDV_ELECTRIC' ? '⚡' : '📋';
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `${priorityEmoji} ${reportType}: ${aiResponse.category} - ${driverName.toUpperCase()} (VIN: ${vinLast4})`,
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;"><div style="background: linear-gradient(135deg, ${aiResponse.priority === 'HIGH_PRIORITY' ? '#EF4444 0%, #DC2626' : aiResponse.priority === 'EDV_ELECTRIC' ? '#2563EB 0%, #1d4ed8' : '#10b981 0%, #059669'} 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;"><h1 style="color: white; margin: 0; font-size: 28px;">${priorityEmoji} ${reportType}</h1><p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 14px;">${aiResponse.category}</p></div><div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;"><table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;"><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${driverName}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN:</td><td style="padding: 12px; color: #1f2937;">${vinLast4}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Vehicle:</td><td style="padding: 12px; color: #1f2937;">${vehicleType || 'Unknown'}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Priority:</td><td style="padding: 12px; color: #1f2937;">${reportType}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Confidence:</td><td style="padding: 12px; color: #1f2937;">${Math.round(aiResponse.confidence * 100)}%</td></tr></table><div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;"><h3 style="color: #92400e; margin: 0 0 10px 0; font-size: 14px;">Driver Description</h3><p style="margin: 0; color: #78350f; font-size: 13px; line-height: 1.6;">${issueDescription}</p></div>${photos && photos.length > 0 ? `<div style="background: #dbeafe; border-left: 4px solid #2563EB; padding: 15px; margin: 20px 0; border-radius: 4px;"><p style="margin: 0; color: #1e3a8a; font-size: 13px;"><strong>${photos.length} file(s) attached</strong></p></div>` : ''}</div></div>`,
            attachments: emailAttachments
        });
        console.log(`✅ Email sent with ${emailAttachments.length} attachments`);
        fs.unlinkSync(pdfPath);
        for (let i = 1; i < emailAttachments.length; i++) {
            try { fs.unlinkSync(emailAttachments[i].path); } catch (e) {}
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Issue submission error:', error);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Issue submission failed', stack: error.stack, source: 'submit-issue-ai' });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/knowledge-base', (req, res) => {
    const password = req.query.key;
    if (password !== 'slgp-admin-2026') { return res.status(401).json({ error: 'Unauthorized' }); }
    try {
        const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
        const history = JSON.parse(fs.readFileSync(ISSUE_HISTORY_FILE, 'utf8'));
        res.json({ knowledge_base: knowledge, issue_history: { total_issues: history.total_issues, patterns: history.patterns, recent_classifications: history.classifications.slice(-10) } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================
// USAGE TRACKING SYSTEM WITH EMAIL ALERTS
// ============================================
const USAGE_TRACKING_FILE = path.join(VOLUME_PATH, 'api_usage_tracking.json');
const DAILY_LIMIT = 2500;
const ALERT_THRESHOLDS = [0.80, 0.90, 0.95];

function initializeUsageTracking() {
    if (!fs.existsSync(USAGE_TRACKING_FILE)) {
        const initialTracking = { date: new Date().toDateString(), requests: 0, alerts_sent: [], last_reset: new Date().toISOString() };
        fs.writeFileSync(USAGE_TRACKING_FILE, JSON.stringify(initialTracking, null, 2));
        console.log('✅ Usage tracking initialized');
    }
}

initializeUsageTracking();

async function trackAPIRequest(apiName = 'TomTom') {
    try {
        let tracking = JSON.parse(fs.readFileSync(USAGE_TRACKING_FILE, 'utf8'));
        const today = new Date().toDateString();
        if (tracking.date !== today) {
            tracking = { date: today, requests: 0, alerts_sent: [], last_reset: new Date().toISOString() };
        }
        tracking.requests++;
        const usagePercent = tracking.requests / DAILY_LIMIT;
        for (const threshold of ALERT_THRESHOLDS) {
            const thresholdKey = `${(threshold * 100).toFixed(0)}%`;
            if (usagePercent >= threshold && !tracking.alerts_sent.includes(thresholdKey)) {
                tracking.alerts_sent.push(thresholdKey);
                await sendUsageAlert(tracking.requests, threshold);
            }
        }
        fs.writeFileSync(USAGE_TRACKING_FILE, JSON.stringify(tracking, null, 2));
        console.log(`📊 ${apiName} API Usage: ${tracking.requests}/${DAILY_LIMIT} (${(usagePercent * 100).toFixed(1)}%)`);
        if (tracking.requests >= DAILY_LIMIT) { throw new Error('Daily API limit reached. Using cached data only.'); }
        return tracking.requests;
    } catch (error) {
        if (error.message.includes('Daily API limit reached')) { throw error; }
        console.error('Usage tracking error:', error);
        return 0;
    }
}

async function sendUsageAlert(currentUsage, threshold) {
    try {
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        const percent = (threshold * 100).toFixed(0);
        const remaining = DAILY_LIMIT - currentUsage;
        let urgency = '⚠️ WARNING';
        let action = 'Monitor usage closely';
        if (threshold >= 0.95) { urgency = '🚨 CRITICAL'; action = 'IMMEDIATE ACTION REQUIRED - Consider enabling caching or wait until tomorrow'; }
        else if (threshold >= 0.90) { urgency = '🔴 URGENT'; action = 'Review usage and enable caching if not already active'; }
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: [process.env.EMAIL_USER, 'slgpfleetmanager@gmail.com'],
            subject: `${urgency}: TomTom API ${percent}% Limit Reached`,
            html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto; padding: 20px;"><div style="background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); padding: 20px; border-radius: 12px 12px 0 0; text-align: center;"><h1 style="color: white; margin: 0;">${urgency}</h1></div><div style="background: white; padding: 20px; border-radius: 0 0 12px 12px;"><table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;"><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold;">Current Usage:</td><td style="padding: 12px; color: #DC2626; font-weight: bold;">${currentUsage} / ${DAILY_LIMIT} requests</td></tr><tr><td style="padding: 12px; font-weight: bold;">Threshold:</td><td style="padding: 12px;">${percent}%</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold;">Remaining:</td><td style="padding: 12px;">${remaining} requests</td></tr></table><div style="background: #fef2f2; border-left: 4px solid #EF4444; padding: 15px; border-radius: 4px;"><h3 style="color: #DC2626; margin: 0 0 10px 0;">Action Required</h3><p style="margin: 0; color: #991b1b;">${action}</p></div></div></div>`
        });
        console.log(`📧 Usage alert sent: ${percent}% threshold reached`);
    } catch (error) { console.error('Failed to send usage alert:', error); }
}

// ============================================
// SPEED LIMIT DATABASE & CACHING
// ============================================
const SPEED_LIMIT_CACHE_FILE = path.join(VOLUME_PATH, 'speed_limit_cache.json');

const speedLimitDatabase = {
    "sr14_newnan_south": { speed_limit: 35, road_name: "SR-14 / Clark Street", city: "Newnan, GA", notes: "Downtown Newnan - Heavy enforcement", bounds: { lat_min: 33.375, lat_max: 33.390, lng_min: -84.805, lng_max: -84.790 } },
    "sr14_newnan_north": { speed_limit: 45, road_name: "SR-14 North", city: "Newnan, GA", notes: "North of downtown - Speed trap area", bounds: { lat_min: 33.390, lat_max: 33.420, lng_min: -84.805, lng_max: -84.775 } },
    "sr14_east": { speed_limit: 55, road_name: "SR-14 East", city: "Coweta County, GA", notes: "East of Newnan", bounds: { lat_min: 33.370, lat_max: 33.420, lng_min: -84.775, lng_max: -84.650 } },
    "sr16_newnan": { speed_limit: 35, road_name: "SR-16 / Bullsboro Drive", city: "Newnan, GA", notes: "Through downtown - School zone 25 MPH (7AM-4PM)", bounds: { lat_min: 33.373, lat_max: 33.387, lng_min: -84.810, lng_max: -84.790 } },
    "sr16_east": { speed_limit: 55, road_name: "SR-16 East", city: "Senoia/Sharpsburg, GA", notes: "East towards Senoia", bounds: { lat_min: 33.270, lat_max: 33.300, lng_min: -84.690, lng_max: -84.520 } },
    "sr16_senoia": { speed_limit: 45, road_name: "SR-16 Senoia", city: "Senoia, GA", notes: "Through Senoia - School zone areas", bounds: { lat_min: 33.295, lat_max: 33.315, lng_min: -84.565, lng_max: -84.545 } },
    "sr34_newnan_west": { speed_limit: 55, road_name: "SR-34 West", city: "Newnan, GA", notes: "West of Newnan", bounds: { lat_min: 33.370, lat_max: 33.390, lng_min: -84.850, lng_max: -84.805 } },
    "sr34_to_sr54": { speed_limit: 50, road_name: "SR-34 to SR-54", city: "Peachtree City, GA", notes: "⚠️ REDUCED FROM 55 MPH - HEAVY ENFORCEMENT!", bounds: { lat_min: 33.385, lat_max: 33.395, lng_min: -84.580, lng_max: -84.565 } },
    "sr34_bypass_newnan": { speed_limit: 50, road_name: "SR-34 Bypass", city: "Newnan, GA", notes: "Bypass around Newnan", bounds: { lat_min: 33.360, lat_max: 33.385, lng_min: -84.780, lng_max: -84.745 } },
    "sr54_sharpsburg": { speed_limit: 55, road_name: "SR-54 Sharpsburg", city: "Sharpsburg, GA", notes: "Through Sharpsburg", bounds: { lat_min: 33.310, lat_max: 33.330, lng_min: -84.685, lng_max: -84.655 } },
    "sr54_pre_fayette": { speed_limit: 55, road_name: "SR-54 East", city: "Coweta County, GA", notes: "East towards Fayette County", bounds: { lat_min: 33.380, lat_max: 33.395, lng_min: -84.600, lng_max: -84.545 } },
    "sr54_to_fayette": { speed_limit: 50, road_name: "SR-54 to Fayette Line", city: "Peachtree City border, GA", notes: "⚠️ REDUCED FROM 55 MPH - approaching Fayette County", bounds: { lat_min: 33.390, lat_max: 33.405, lng_min: -84.545, lng_max: -84.520 } },
    "sr54_trinity_school_zone_1": { speed_limit: 50, road_name: "SR-54 Trinity Christian School Zone", city: "Peachtree City, GA", notes: "⚠️ SCHOOL ZONE: 50 MPH (7:30-8:30 AM, 2:30-3:30 PM) - CAMERAS!", bounds: { lat_min: 33.381, lat_max: 33.385, lng_min: -84.570, lng_max: -84.565 } },
    "sr70_north": { speed_limit: 45, road_name: "SR-70 North", city: "Newnan, GA", notes: "North of Newnan", bounds: { lat_min: 33.385, lat_max: 33.430, lng_min: -84.700, lng_max: -84.670 } },
    "sr74_sr85_senoia": { speed_limit: 55, road_name: "SR-74 / SR-85 Senoia", city: "Senoia, GA", notes: "Through Senoia", bounds: { lat_min: 33.295, lat_max: 33.315, lng_min: -84.555, lng_max: -84.535 } },
    "sr74_sr85_north": { speed_limit: 55, road_name: "SR-74 / SR-85 North", city: "Peachtree City, GA", notes: "⚠️ ENFORCEMENT CAMERA - Drivers think 65 MPH!", bounds: { lat_min: 33.315, lat_max: 33.385, lng_min: -84.570, lng_max: -84.540 } },
    "sr154_sharpsburg": { speed_limit: 45, road_name: "SR-154 Sharpsburg", city: "Sharpsburg, GA", notes: "School zone 35 MPH (7:30-9 AM, 3:30-4:30 PM)", bounds: { lat_min: 33.310, lat_max: 33.325, lng_min: -84.670, lng_max: -84.650 } },
    "sr154_east": { speed_limit: 45, road_name: "SR-154 East", city: "Coweta County, GA", notes: "East towards Fulton County", bounds: { lat_min: 33.340, lat_max: 33.380, lng_min: -84.650, lng_max: -84.550 } },
    "lower_fayetteville_rd": { speed_limit: 45, road_name: "Lower Fayetteville Road", city: "Newnan, GA", notes: "Major delivery corridor - School zone 25 MPH near Newnan Crossing", bounds: { lat_min: 33.360, lat_max: 33.410, lng_min: -84.750, lng_max: -84.650 } },
    "fischer_road": { speed_limit: 45, road_name: "Fischer Road", city: "Peachtree City, GA", notes: "School zone 35 MPH near Northgate High (7:30-9 AM, 3-4 PM)", bounds: { lat_min: 33.360, lat_max: 33.420, lng_min: -84.620, lng_max: -84.540 } },
    "poplar_road": { speed_limit: 50, road_name: "Poplar Road", city: "Newnan, GA", notes: "School zone 35 MPH near Poplar Road Elementary", bounds: { lat_min: 33.350, lat_max: 33.410, lng_min: -84.760, lng_max: -84.710 } },
    "welcome_road": { speed_limit: 45, road_name: "Welcome Road", city: "Newnan, GA", notes: "School zone 25 MPH near Western Elementary", bounds: { lat_min: 33.325, lat_max: 33.375, lng_min: -84.850, lng_max: -84.775 } },
    "smokey_road": { speed_limit: 45, road_name: "Smokey Road", city: "Newnan, GA", notes: "School zone 35 MPH near Smokey Road Middle School", bounds: { lat_min: 33.340, lat_max: 33.390, lng_min: -84.820, lng_max: -84.760 } },
    "newnan_crossing_blvd": { speed_limit: 45, road_name: "Newnan Crossing Boulevard", city: "Newnan, GA", notes: "Major shopping area - Heavy traffic", bounds: { lat_min: 33.365, lat_max: 33.395, lng_min: -84.740, lng_max: -84.710 } },
    "gordon_road": { speed_limit: 55, road_name: "Gordon Road", city: "Coweta County, GA", notes: "Long rural road - Varies between 45-55 MPH", bounds: { lat_min: 33.270, lat_max: 33.365, lng_min: -84.680, lng_max: -84.520 } },
    "mcintosh_trail": { speed_limit: 45, road_name: "McIntosh Trail", city: "Peachtree City, GA", notes: "School zone 35 MPH near East Coweta High", bounds: { lat_min: 33.330, lat_max: 33.370, lng_min: -84.660, lng_max: -84.600 } },
    "lora_smith_road": { speed_limit: 35, road_name: "Lora Smith Road", city: "Newnan, GA", notes: "School zone 25 MPH near Arnall Middle & White Oak Elementary", bounds: { lat_min: 33.345, lat_max: 33.375, lng_min: -84.770, lng_max: -84.740 } },
    "country_club_road": { speed_limit: 45, road_name: "Country Club Road", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 35 MPH near Northside Elementary (7:30-9 AM, 2-3:30 PM)", bounds: { lat_min: 33.388, lat_max: 33.405, lng_min: -84.795, lng_max: -84.775 } },
    "dixon_road": { speed_limit: 45, road_name: "Dixon Road", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 25 MPH near Western Elementary (7:30-8:15 AM, 2-3 PM)", bounds: { lat_min: 33.345, lat_max: 33.365, lng_min: -84.825, lng_max: -84.805 } },
    "eastside_school_road": { speed_limit: 45, road_name: "Eastside School Road", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 35 MPH near Eastside Elementary (7-8:15 AM, 2-3 PM)", bounds: { lat_min: 33.345, lat_max: 33.370, lng_min: -84.720, lng_max: -84.690 } },
    "lagrange_street": { speed_limit: 25, road_name: "LaGrange Street", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 25 MPH near Newnan High School (7-9 AM, 3-4:30 PM)", bounds: { lat_min: 33.375, lat_max: 33.390, lng_min: -84.805, lng_max: -84.790 } },
    "jefferson_parkway": { speed_limit: 30, road_name: "Jefferson Parkway", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 25 MPH near Jefferson Parkway Elementary (7-9 AM, 2-4 PM)", bounds: { lat_min: 33.360, lat_max: 33.375, lng_min: -84.755, lng_max: -84.740 } },
    "atlanta_downtown_peachtree": { speed_limit: 35, road_name: "Peachtree Street Downtown", city: "Atlanta, GA", notes: "Downtown Atlanta - Heavy pedestrian traffic", bounds: { lat_min: 33.745, lat_max: 33.775, lng_min: -84.395, lng_max: -84.380 } },
    "atlanta_i75_i85_downtown": { speed_limit: 55, road_name: "I-75/I-85 Downtown Connector", city: "Atlanta, GA", notes: "Heavy enforcement, construction zones common", bounds: { lat_min: 33.730, lat_max: 33.780, lng_min: -84.400, lng_max: -84.385 } },
    "atlanta_midtown_peachtree": { speed_limit: 35, road_name: "Peachtree Street Midtown", city: "Atlanta, GA", notes: "Midtown - Georgia Tech area, heavy pedestrian", bounds: { lat_min: 33.775, lat_max: 33.795, lng_min: -84.395, lng_max: -84.380 } },
    "atlanta_spring_street": { speed_limit: 35, road_name: "Spring Street", city: "Atlanta, GA", notes: "Major north-south corridor through Midtown", bounds: { lat_min: 33.760, lat_max: 33.795, lng_min: -84.395, lng_max: -84.385 } },
    "atlanta_cascade_road": { speed_limit: 35, road_name: "Cascade Road", city: "Atlanta, GA", notes: "Southwest Atlanta - School zones in area", bounds: { lat_min: 33.710, lat_max: 33.740, lng_min: -84.480, lng_max: -84.450 } },
    "atlanta_campbellton_road": { speed_limit: 45, road_name: "Campbellton Road", city: "Atlanta, GA", notes: "Southwest delivery corridor", bounds: { lat_min: 33.675, lat_max: 33.715, lng_min: -84.520, lng_max: -84.470 } },
    "atlanta_airport_loop": { speed_limit: 45, road_name: "Airport Loop Road", city: "Atlanta, GA", notes: "Hartsfield-Jackson Airport area - Commercial zones", bounds: { lat_min: 33.630, lat_max: 33.650, lng_min: -84.450, lng_max: -84.420 } },
    "atlanta_virginia_avenue": { speed_limit: 35, road_name: "Virginia Avenue", city: "East Point/Atlanta, GA", notes: "Airport access road", bounds: { lat_min: 33.655, lat_max: 33.675, lng_min: -84.455, lng_max: -84.435 } },
    "jones_mill_road": { speed_limit: 45, road_name: "Jones Mill Road", city: "Alpharetta/Johns Creek, GA", notes: "North Atlanta delivery corridor", bounds: { lat_min: 33.940, lat_max: 33.975, lng_min: -84.365, lng_max: -84.335 } },
    "old_alabama_road": { speed_limit: 45, road_name: "Old Alabama Road", city: "Johns Creek, GA", notes: "Major north delivery route", bounds: { lat_min: 33.970, lat_max: 34.010, lng_min: -84.230, lng_max: -84.190 } },
    "state_bridge_road": { speed_limit: 55, road_name: "State Bridge Road", city: "Johns Creek/Duluth, GA", notes: "Main east-west corridor - varies 45-55 MPH by section", bounds: { lat_min: 33.980, lat_max: 34.010, lng_min: -84.220, lng_max: -84.110 } },
    "medlock_bridge_road": { speed_limit: 45, road_name: "Medlock Bridge Road", city: "Johns Creek, GA", notes: "North delivery route", bounds: { lat_min: 33.990, lat_max: 34.040, lng_min: -84.230, lng_max: -84.180 } },
    "fairburn_campbellton": { speed_limit: 45, road_name: "Campbellton Street", city: "Fairburn, GA", notes: "Main corridor through Fairburn", bounds: { lat_min: 33.555, lat_max: 33.575, lng_min: -84.595, lng_max: -84.570 } },
    "fairburn_downtown": { speed_limit: 35, road_name: "Downtown Fairburn", city: "Fairburn, GA", notes: "Historic downtown area", bounds: { lat_min: 33.558, lat_max: 33.568, lng_min: -84.585, lng_max: -84.575 } },
    "fairburn_senoia_road": { speed_limit: 45, road_name: "Senoia Road", city: "Fairburn, GA", notes: "South towards Senoia/Peachtree City", bounds: { lat_min: 33.500, lat_max: 33.560, lng_min: -84.600, lng_max: -84.570 } },
    "palmetto_main_street": { speed_limit: 35, road_name: "Main Street", city: "Palmetto, GA", notes: "Downtown Palmetto", bounds: { lat_min: 33.522, lat_max: 33.532, lng_min: -84.675, lng_max: -84.660 } },
    "palmetto_tyrone_road": { speed_limit: 45, road_name: "Palmetto Tyrone Road", city: "Palmetto, GA", notes: "Connects to Tyrone/Fayette County", bounds: { lat_min: 33.460, lat_max: 33.525, lng_min: -84.660, lng_max: -84.600 } },
    "palmetto_highway_154": { speed_limit: 45, road_name: "Highway 154", city: "Palmetto, GA", notes: "East-west through Palmetto", bounds: { lat_min: 33.515, lat_max: 33.535, lng_min: -84.700, lng_max: -84.650 } },
    "tyrone_senoia_road": { speed_limit: 45, road_name: "Senoia Road", city: "Tyrone, GA", notes: "Main corridor through Tyrone", bounds: { lat_min: 33.460, lat_max: 33.480, lng_min: -84.610, lng_max: -84.590 } },
    "tyrone_highway_74": { speed_limit: 55, road_name: "Highway 74", city: "Tyrone, GA", notes: "North-south through Tyrone", bounds: { lat_min: 33.455, lat_max: 33.485, lng_min: -84.615, lng_max: -84.595 } },
    "tyrone_dogwood_trail": { speed_limit: 35, road_name: "Dogwood Trail", city: "Tyrone, GA", notes: "Residential area - School zones nearby", bounds: { lat_min: 33.465, lat_max: 33.475, lng_min: -84.610, lng_max: -84.600 } },
    "concord_highway_29": { speed_limit: 55, road_name: "Highway 29", city: "Concord, GA", notes: "North-south through Concord area", bounds: { lat_min: 33.085, lat_max: 33.115, lng_min: -84.430, lng_max: -84.410 } },
    "concord_macedonia_road": { speed_limit: 45, road_name: "Macedonia Road", city: "Concord, GA", notes: "Local delivery road", bounds: { lat_min: 33.085, lat_max: 33.105, lng_min: -84.440, lng_max: -84.415 } },
    "woodbury_main_street": { speed_limit: 35, road_name: "Main Street", city: "Woodbury, GA", notes: "Downtown Woodbury - Small town, strict enforcement", bounds: { lat_min: 33.057, lat_max: 33.067, lng_min: -84.575, lng_max: -84.565 } },
    "woodbury_highway_85": { speed_limit: 45, road_name: "Highway 85", city: "Woodbury, GA", notes: "Through Woodbury area", bounds: { lat_min: 33.050, lat_max: 33.075, lng_min: -84.585, lng_max: -84.560 } },
    "fulton_south_fulton_parkway": { speed_limit: 45, road_name: "South Fulton Parkway", city: "South Fulton, GA", notes: "Major delivery corridor south of Atlanta", bounds: { lat_min: 33.630, lat_max: 33.680, lng_min: -84.580, lng_max: -84.540 } },
    "fulton_old_national_highway": { speed_limit: 45, road_name: "Old National Highway", city: "Fulton County, GA", notes: "Major commercial corridor - Heavy traffic", bounds: { lat_min: 33.600, lat_max: 33.670, lng_min: -84.480, lng_max: -84.440 } },
    "fulton_riverdale_road": { speed_limit: 45, road_name: "Riverdale Road", city: "Fulton County, GA", notes: "South Fulton delivery area", bounds: { lat_min: 33.560, lat_max: 33.605, lng_min: -84.460, lng_max: -84.420 } },
    "fulton_cascade_palmetto_hwy": { speed_limit: 45, road_name: "Cascade Palmetto Highway", city: "Fulton County, GA", notes: "Southwest corridor to Palmetto", bounds: { lat_min: 33.520, lat_max: 33.580, lng_min: -84.620, lng_max: -84.560 } }
};

function initializeSpeedLimitCache() {
    if (!fs.existsSync(SPEED_LIMIT_CACHE_FILE)) {
        fs.writeFileSync(SPEED_LIMIT_CACHE_FILE, JSON.stringify({}, null, 2));
        console.log('✅ Speed limit cache initialized');
    }
}

initializeSpeedLimitCache();

function checkLocalDatabase(lat, lng) {
    for (const [key, data] of Object.entries(speedLimitDatabase)) {
        if (lat >= data.bounds.lat_min && lat <= data.bounds.lat_max && lng >= data.bounds.lng_min && lng <= data.bounds.lng_max) {
            console.log(`✅ Speed limit found in local database: ${data.road_name}`);
            return { speedLimit: data.speed_limit, roadName: data.road_name, location: data.city, notes: data.notes, source: 'database' };
        }
    }
    return null;
}

function checkSpeedLimitCache(lat, lng) {
    try {
        const cache = JSON.parse(fs.readFileSync(SPEED_LIMIT_CACHE_FILE, 'utf8'));
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        if (cache[key]) {
            const age = Date.now() - cache[key].timestamp;
            const MAX_AGE = 24 * 60 * 60 * 1000;
            if (age < MAX_AGE) { console.log(`✅ Speed limit found in cache: ${cache[key].roadName}`); return cache[key]; }
        }
    } catch (e) { console.error('Cache read error:', e); }
    return null;
}

function saveToSpeedLimitCache(lat, lng, data) {
    try {
        const cache = JSON.parse(fs.readFileSync(SPEED_LIMIT_CACHE_FILE, 'utf8'));
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        cache[key] = { ...data, timestamp: Date.now() };
        const entries = Object.entries(cache);
        if (entries.length > 500) {
            const sorted = entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
            fs.writeFileSync(SPEED_LIMIT_CACHE_FILE, JSON.stringify(Object.fromEntries(sorted.slice(0, 500)), null, 2));
        } else { fs.writeFileSync(SPEED_LIMIT_CACHE_FILE, JSON.stringify(cache, null, 2)); }
    } catch (e) { console.error('Cache write error:', e); }
}

// ============================================
// SPEED LIMIT API ENDPOINT
// ============================================
app.get('/api/speed-limit', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        if (!lat || !lng) { return res.status(400).json({ success: false, error: 'Missing GPS coordinates' }); }
        const latitude = parseFloat(lat);
        const longitude = parseFloat(lng);
        console.log(`\n🚦 Speed limit request: ${latitude}, ${longitude}`);

        const localResult = checkLocalDatabase(latitude, longitude);
        if (localResult) { return res.json({ success: true, ...localResult }); }

        const cachedResult = checkSpeedLimitCache(latitude, longitude);
        if (cachedResult) { return res.json({ success: true, ...cachedResult }); }

        try {
            await trackAPIRequest('TomTom Speed Limit');
            const routingResponse = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${latitude},${longitude}:${latitude + 0.001},${longitude + 0.001}/json?key=${process.env.TOMTOM_API_KEY}&routeType=fastest&traffic=false`);
            if (routingResponse.ok) {
                const routingData = await routingResponse.json();
                const route = routingData.routes && routingData.routes[0];
                if (route && route.legs && route.legs[0] && route.legs[0].points) {
                    const firstPoint = route.legs[0].points[0];
                    let speedLimitKmh = firstPoint.speedLimit;
                    if (!speedLimitKmh && route.guidance && route.guidance.instructions && route.guidance.instructions[0]) {
                        speedLimitKmh = route.guidance.instructions[0].speedLimit;
                    }
                    if (speedLimitKmh) {
                        const result = { speedLimit: Math.round(speedLimitKmh * 0.621371), roadName: firstPoint.street || 'Current Road', location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, source: 'tomtom_routing' };
                        saveToSpeedLimitCache(latitude, longitude, result);
                        return res.json({ success: true, ...result });
                    }
                }
            }

            const trafficResponse = await fetch(`https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${latitude},${longitude}&key=${process.env.TOMTOM_API_KEY}`);
            if (trafficResponse.ok) {
                const trafficData = await trafficResponse.json();
                const flowSegment = trafficData.flowSegmentData;
                if (flowSegment && flowSegment.speedLimit) {
                    const result = { speedLimit: Math.round(flowSegment.speedLimit * 0.621371), roadName: flowSegment.roadName || 'Unknown Road', location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, source: 'tomtom_traffic' };
                    saveToSpeedLimitCache(latitude, longitude, result);
                    return res.json({ success: true, ...result });
                }
            }

            const geocodeResponse = await fetch(`https://api.tomtom.com/search/2/reverseGeocode/${latitude},${longitude}.json?key=${process.env.TOMTOM_API_KEY}`);
            if (geocodeResponse.ok) {
                const geocodeData = await geocodeResponse.json();
                const address = geocodeData.addresses && geocodeData.addresses[0];
                if (address) {
                    const roadName = address.address.street || address.address.streetName || address.address.freeformAddress || 'Unknown Road';
                    const city = address.address.municipality || address.address.countrySecondarySubdivision || address.address.countrySubdivision || 'GA';
                    let speedLimit = 45;
                    const roadType = address.address.roadType || '';
                    const street = address.address.street || '';
                    if (roadType.includes('highway') || roadType.includes('motorway') || street.includes('I-') || street.includes('Interstate')) { speedLimit = 65; }
                    else if (roadType.includes('arterial') || street.includes('Parkway') || street.includes('Boulevard')) { speedLimit = 45; }
                    else if (roadType.includes('local') || roadType.includes('residential')) { speedLimit = 35; }
                    const result = { speedLimit, roadName, location: city, source: 'tomtom_estimate', note: '⚠️ Estimated based on road type - VERIFY with posted signs!' };
                    saveToSpeedLimitCache(latitude, longitude, result);
                    return res.json({ success: true, ...result });
                }
            }
        } catch (apiError) {
            if (apiError.message.includes('Daily API limit reached')) {
                return res.status(429).json({ success: false, error: 'Daily API limit reached. Speed limit data unavailable until tomorrow.', useCache: true });
            }
            console.error('TomTom API error:', apiError);
        }

        res.json({ success: true, speedLimit: 45, roadName: 'Unknown Road', location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, source: 'default', note: 'Unable to determine speed limit. Using safe default. Verify with posted signs.' });
    } catch (error) {
        console.error('Speed limit API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// VIDEO UPLOAD WITH FFMPEG AUTO-DETECTION
// ============================================
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    const startTime = Date.now();
    let videoPath = null;
    try {
        console.log('📹 Video upload initiated');
        if (!driveClient) throw new Error('Google Drive not initialized');
        if (!req.file) throw new Error('No video file received');

        videoPath = req.file.path;
        const { driverName, vin, inspectionType } = req.body;
        if (!driverName || !vin || !inspectionType) throw new Error('Missing required fields');

        const fileStats = fs.statSync(videoPath);
        const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);

        console.log(`📹 Upload - Driver: ${driverName}, VIN: ${vin}, Type: ${inspectionType}, Size: ${fileSizeMB}MB`);

        const fileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;

        console.log('☁️  Starting Google Drive upload...');

        const fileMetadata = {
            name: fileName,
            parents: [VIDEO_DRIVE_ID],
            mimeType: 'video/mp4',
            properties: {
                driver: driverName,
                vin: vin,
                inspectionType: inspectionType,
                uploadDate: new Date().toISOString(),
                codec: 'H.265/HEVC',
                resolution: '1920x1080',
                downloadPreferred: 'true'
            },
            description: `Fleet Video Inspection - ${inspectionType} for VIN ${vin} by ${driverName}`
        };

        const media = { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) };

        const uploadType = fileStats.size > 5 * 1024 * 1024 ? 'resumable' : 'multipart';
        console.log(`📤 Using ${uploadType} upload method`);

        const driveResponse = await driveClient.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink, webContentLink, size, videoMediaMetadata, createdTime',
            supportsAllDrives: true
        });

        const uploadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const fileId = driveResponse.data.id;

        const videoMetadata = driveResponse.data.videoMediaMetadata || {};
        const videoDuration = videoMetadata.durationMillis ? `${(videoMetadata.durationMillis / 1000 / 60).toFixed(1)} minutes` : 'Unknown';

        console.log(`✅ Google Drive upload complete in ${uploadTime}s`);
        console.log(`   File ID: ${fileId}`);
        console.log(`   Size uploaded: ${fileSizeMB}MB`);

        await appendLog(PERFORMANCE_LOG, {
            type: 'performance',
            action: 'video_upload',
            duration: Date.now() - startTime,
            success: true,
            fileSize: fileStats.size,
            details: `${driverName} - ${vin} - ${inspectionType}`,
            userAgent: req.get('user-agent'),
            ip: req.ip
        });

        try {
            await driveClient.permissions.create({
                fileId: fileId,
                requestBody: { role: 'reader', type: 'anyone' },
                supportsAllDrives: true
            });
            console.log('✅ File permissions set (viewable via link)');
        } catch (permError) {
            console.warn('⚠️  Could not set permissions:', permError.message);
        }

        const viewLink = driveResponse.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        const directDownloadLink = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const embedLink = `https://drive.google.com/file/d/${fileId}/preview`;
        const thumbnailLink = `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;

        console.log('📥 Generated access links:');
        console.log(`   View Link: ${viewLink}`);

        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: ['slgpfleetmanager@gmail.com'],
                subject: `📹 Video Inspection Ready: ${inspectionType} - ${driverName} (VIN: ${vin})`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
                        <div style="background: linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;">
                            <h1 style="color: white; margin: 0; font-size: 28px;">✅ Video Inspection Ready</h1>
                            <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 14px;">Full quality video available for immediate viewing</p>
                        </div>
                        <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                            <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📋 Inspection Details</h2>
                            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${driverName}</td></tr>
                                <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN:</td><td style="padding: 12px; color: #1f2937;">${vin}</td></tr>
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Type:</td><td style="padding: 12px; color: #1f2937;">${inspectionType}</td></tr>
                                <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">File Size:</td><td style="padding: 12px; color: #1f2937;">${fileSizeMB} MB</td></tr>
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Duration:</td><td style="padding: 12px; color: #1f2937;">${videoDuration}</td></tr>
                                <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Upload Time:</td><td style="padding: 12px; color: #1f2937;">${uploadTime}s</td></tr>
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Quality:</td><td style="padding: 12px; color: #1f2937;">1920x1080 (H.265/HEVC)</td></tr>
                            </table>
                            <div style="background: #eff6ff; border-left: 4px solid #2563EB; padding: 20px; margin-bottom: 25px; border-radius: 4px;">
                                <h3 style="color: #1e40af; margin: 0 0 12px 0; font-size: 16px;">📹 FULL QUALITY 1080p VIDEO</h3>
                                <p style="color: #1e3a8a; margin: 0; font-size: 13px; line-height: 1.6;">
                                    <strong>✅ Video uploaded successfully!</strong><br>
                                    H.265/HEVC codec - Superior quality in smaller file size.<br>
                                    Choose your preferred viewing method below:
                                </p>
                            </div>
                            <div style="text-align: center; margin: 25px 0;">
                                <a href="${viewLink}" style="display: inline-block; background: #10b981; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);">
                                    📱 OPEN IN DRIVE
                                </a>
                                <a href="${directDownloadLink}" style="display: inline-block; background: #3b82f6; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px; box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);">
                                    ⬇️ DOWNLOAD 1080p
                                </a>
                            </div>
                            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
                                <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;">
                                    <strong>💡 BEST VIEWING:</strong> Click <strong>"OPEN IN DRIVE"</strong> to watch in the Google Drive app or browser. 
                                    For offline viewing or archiving, click <strong>"DOWNLOAD 1080p"</strong> to save the full quality file.
                                </p>
                            </div>
                        </div>
                    </div>
                `
            });
            console.log('✅ Email notification sent to slgpfleetmanager@gmail.com');
        } catch (emailError) {
            console.error('⚠️  Email notification failed:', emailError.message);
            await appendLog(ERROR_LOG, {
                type: 'server_error',
                severity: 'warning',
                message: 'Video notification email failed',
                stack: emailError.stack,
                source: 'upload-to-google-drive-email'
            });
        }

        if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            console.log('✅ Temporary file cleaned up');
        }

        res.json({
            success: true,
            fileId: fileId,
            fileName: fileName,
            fileSize: fileSizeMB,
            uploadTime: uploadTime,
            viewLink: viewLink,
            downloadLink: directDownloadLink,
            embedLink: embedLink,
            thumbnailLink: thumbnailLink,
            metadata: videoMetadata,
            createdTime: driveResponse.data.createdTime
        });
    } catch (error) {
        console.error('❌ Video upload error:', error);

        await appendLog(ERROR_LOG, {
            type: 'server_error',
            severity: 'error',
            message: 'Video upload failed',
            stack: error.stack,
            source: 'upload-to-google-drive'
        });

        await appendLog(PERFORMANCE_LOG, {
            type: 'performance',
            action: 'video_upload',
            duration: Date.now() - startTime,
            success: false,
            fileSize: req.file ? req.file.size : 0,
            details: error.message,
            userAgent: req.get('user-agent'),
            ip: req.ip
        });

        if (videoPath && fs.existsSync(videoPath)) {
            try {
                fs.unlinkSync(videoPath);
                console.log('✅ Cleaned up failed upload file');
            } catch (cleanupError) {
                console.error('⚠️  Failed to cleanup temp file:', cleanupError.message);
            }
        }
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================
app.get('/vapid-key', (req, res) => {
    res.json({ publicKey: publicVapidKey });
});

app.post('/subscribe', (req, res) => {
    try {
        const subscription = req.body;
        let subs = fs.existsSync(SUBSCRIPTION_FILE) ? JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)) : [];
        const exists = subs.some(s => JSON.stringify(s) === JSON.stringify(subscription));
        if (!exists) {
            subs.push(subscription);
            fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(subs));
            console.log('✅ Push subscription added');
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Subscription error:', e);
        res.status(500).json({ success: false });
    }
});

// ============================================
// VERSION ENDPOINT
// ============================================
app.get('/version', (req, res) => {
    res.json(BUILD_INFO);
});

// ============================================
// DEBUG DASHBOARD
// ============================================
app.get('/debug-dashboard', async (req, res) => {
    const password = req.query.key;
    if (password !== 'slgp-debug-2026') { return res.status(401).send('Unauthorized'); }
    const recentErrors = await getRecentLogs(ERROR_LOG, 50);
    const recentCamera = await getRecentLogs(CAMERA_LOG, 50);
    const recentPerf = await getRecentLogs(PERFORMANCE_LOG, 50);
    const recentDebug = await getRecentLogs(DEBUG_LOG, 50);
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>SLGP Debug Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: monospace; background: #0a0e17; color: #e5e7eb; padding: 20px; }
        .header { background: linear-gradient(135deg, #00A8E1, #0084b4); padding: 20px; border-radius: 8px; margin-bottom: 30px; }
        h1 { color: white; margin-bottom: 10px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .stat-card { background: #1a1f2e; padding: 15px; border-radius: 8px; border: 2px solid #00A8E1; }
        .stat-number { font-size: 32px; font-weight: bold; color: #00A8E1; }
        .stat-label { font-size: 12px; color: #a9b2bd; text-transform: uppercase; }
        .section { background: #1a1f2e; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #2d3748; }
        .section-title { font-size: 18px; color: #00A8E1; margin-bottom: 15px; border-bottom: 2px solid #00A8E1; padding-bottom: 10px; }
        .log-entry { background: #0d1117; padding: 15px; margin-bottom: 10px; border-radius: 6px; border-left: 4px solid #00A8E1; font-size: 12px; }
        .log-entry.error { border-left-color: #ff2a2a; }
        .log-time { color: #6b7280; font-size: 11px; margin-bottom: 5px; }
        .log-message { color: #e5e7eb; margin-bottom: 8px; }
        .refresh-btn { background: #00A8E1; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🐛 SLGP Debug Dashboard</h1>
        <p>Last updated: ${new Date().toLocaleString()}</p>
    </div>
    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
    <div class="stats">
        <div class="stat-card"><div class="stat-number">${recentErrors.length}</div><div class="stat-label">Errors</div></div>
        <div class="stat-card"><div class="stat-number">${recentCamera.length}</div><div class="stat-label">Camera</div></div>
        <div class="stat-card"><div class="stat-number">${recentPerf.length}</div><div class="stat-label">Performance</div></div>
        <div class="stat-card"><div class="stat-number">${recentDebug.length}</div><div class="stat-label">Debug</div></div>
    </div>
    <div class="section">
        <div class="section-title">❌ Recent Errors</div>
        ${recentErrors.map(log => `<div class="log-entry error"><div class="log-time">${new Date(log.timestamp).toLocaleString()}</div><div class="log-message"><strong>${log.message || 'No message'}</strong></div><div class="log-details">URL: ${log.url || 'N/A'}<br>User: ${log.userAgent || 'N/A'}</div></div>`).join('') || '<p>No errors</p>'}
    </div>
    <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`;
    res.send(html);
});

// ============================================
// HTML PAGES
// ============================================
app.get('/video', (req, res) => { res.sendFile(path.join(__dirname, 'video.html')); });
app.get('/weather', (req, res) => { res.sendFile(path.join(__dirname, 'weather.html')); });
app.get('/speed-limits', (req, res) => { res.sendFile(path.join(__dirname, 'speed-limits.html')); });
app.get('/success', (req, res) => { res.sendFile(path.join(__dirname, 'success.html')); });
app.get('/alerts', (req, res) => { res.sendFile(path.join(__dirname, 'alerts.html')); });
app.get('/build-notes', (req, res) => { res.sendFile(path.join(__dirname, 'build-notes.html')); });

app.get('/report', (req, res) => {
    const mode = req.query.mode;
    let filePath;
    if (mode === 'issue') { filePath = path.join(__dirname, 'report-issue.html'); }
    else if (mode === 'accident') { filePath = path.join(__dirname, 'accident-report.html'); }
    else if (mode === 'insurance') { filePath = path.join(__dirname, 'insurance.html'); }
    else { return res.status(404).send('Unknown report type'); }
    if (fs.existsSync(filePath)) { res.sendFile(filePath); }
    else { res.status(404).send(`File not found: ${mode}`); }
});

// ============================================
// STATIC FILES
// ============================================
app.use(express.static(__dirname, {
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ============================================
// ROOT ROUTE
// ============================================
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const menuPath = path.join(__dirname, 'menu.html');
    if (fs.existsSync(menuPath)) { res.sendFile(menuPath); }
    else { res.status(404).send('menu.html not found'); }
});

// ============================================
// CRON JOB - DAILY SUMMARY
// ============================================
cron.schedule('30 23 * * *', async () => {
    try {
        console.log('🕐 Running daily summary...');
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
        const allLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE));
        if (allLogs.length === 0 && summaryText.length < 40) return;
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()}`,
            text: `Daily Summary\nTotal Reports: ${allLogs.length}\n${summaryText}`
        });
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
        console.log('✅ Daily summary sent');
    } catch (e) { console.error('❌ Cron job error:', e); }
}, { timezone: "America/New_York" });

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);
    appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: err.message, stack: err.stack, source: 'express_error_handler' });
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════╗
║  SLGP Fleet Manager                      ║
║  v4.6.3 - SPEED LIMITS + FFMPEG FIX      ║
╠══════════════════════════════════════════╣
║  Port: ${PORT}                                ║
╚══════════════════════════════════════════╝

✅ Server started
✅ Email configured
${driveClient ? '✅ Google Drive connected' : '⚠️  Google Drive offline'}
✅ Push notifications ready
${DISCORD_BOT_TOKEN ? '✅ Discord bot online' : '⚠️  Discord bot offline'}
✅ Learning AI initialized
✅ Knowledge base loaded
✅ Speed limit system ready
✅ Usage tracking active
✅ FFmpeg auto-detection enabled

🌐 Ready at: http://localhost:${PORT}
    `);
});

process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received - shutting down gracefully');
    process.exit(0);
});
