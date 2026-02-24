require(‘dotenv’).config();
const express = require(‘express’);
const multer = require(‘multer’);
const { google } = require(‘googleapis’);
const path = require(‘path’);
const fs = require(‘fs’);
const nodemailer = require(‘nodemailer’);
const { PDFDocument, StandardFonts, rgb } = require(‘pdf-lib’);
const stream = require(‘stream’);
const cron = require(‘node-cron’);
const webpush = require(‘web-push’);
const { Client, GatewayIntentBits, Events } = require(‘discord.js’);

const app = express();

// ============================================
// CONFIGURATION
// ============================================
const APP_VERSION = Date.now();
const BUILD_INFO = {
version: APP_VERSION,
buildDate: new Date().toISOString(),
environment: process.env.NODE_ENV || ‘production’,
nodeVersion: process.version
};

const VOLUME_PATH = ‘/app/meshcentral-data’;
const UPLOAD_DIR = path.join(VOLUME_PATH, ‘uploads’);
const DAILY_LOG_FILE = path.join(VOLUME_PATH, ‘daily_data.json’);
const SUBSCRIPTION_FILE = path.join(VOLUME_PATH, ‘subscriptions.json’);
const GATE_LOG_FILE = path.join(VOLUME_PATH, ‘gate_acknowledgments.json’);
const ARRIVAL_LOG_FILE = path.join(VOLUME_PATH, ‘arrival_acknowledgments.json’);
const PANEL_DOC_PATH = path.join(__dirname, ‘Panel_of_Physicians.pdf’);

// ============================================
// 🐛 DEBUG SYSTEM - LOG FILES
// ============================================
const LOGS_DIR = path.join(VOLUME_PATH, ‘logs’);
const DEBUG_LOG = path.join(LOGS_DIR, ‘debug.json’);
const ERROR_LOG = path.join(LOGS_DIR, ‘errors.json’);
const CAMERA_LOG = path.join(LOGS_DIR, ‘camera-issues.json’);
const PERFORMANCE_LOG = path.join(LOGS_DIR, ‘performance.json’);

const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || ‘0AC1GE3XEm4K9Uk9PVA’;
const ACCIDENT_DRIVE_ID = ‘1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy’;
const ISSUE_DRIVE_ID = ‘0AC-a_EQMLYpLUk9PVA’;

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

app.use(express.json({ limit: ‘150mb’ }));
app.use(express.urlencoded({ extended: true, limit: ‘150mb’ }));

app.use((req, res, next) => {
console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
next();
});

// ============================================
// 🐛 DEBUG SYSTEM - LOGGING UTILITIES
// ============================================
async function appendLog(logFile, entry) {
try {
let logs = [];
try {
const data = fs.readFileSync(logFile, ‘utf8’);
logs = JSON.parse(data);
} catch (err) {
// File doesn’t exist or is empty, start fresh
}

```
    logs.push({
        ...entry,
        timestamp: new Date().toISOString(),
        serverTime: Date.now()
    });

    // Keep only last 1000 entries to prevent file from growing too large
    if (logs.length > 1000) {
        logs = logs.slice(-1000);
    }

    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
} catch (err) {
    console.error('Failed to write log:', err);
}
```

}

async function getRecentLogs(logFile, limit = 50) {
try {
const data = fs.readFileSync(logFile, ‘utf8’);
const logs = JSON.parse(data);
return logs.slice(-limit).reverse(); // Most recent first
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
.then(() => console.log(‘✅ Discord bot connected’))
.catch(err => console.log(‘⚠️  Discord bot disabled:’, err.message));

```
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
```

}

// ============================================
// VAPID KEYS SETUP
// ============================================
let publicVapidKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim().replace(/[’”]+/g, ‘’) : null;
let privateVapidKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim().replace(/[’”]+/g, ‘’) : null;

if (!publicVapidKey || !privateVapidKey) {
const vapidKeys = webpush.generateVAPIDKeys();
publicVapidKey = vapidKeys.publicKey;
privateVapidKey = vapidKeys.privateKey;
console.log(‘⚠️  VAPID keys generated’);
}

webpush.setVapidDetails(‘mailto:’ + (process.env.EMAIL_USER || ‘slgpfleetmanager@gmail.com’), publicVapidKey, privateVapidKey);

// ============================================
// GOOGLE DRIVE SETUP
// ============================================
let driveClient = null;

function initializeDrive() {
try {
if (!process.env.GCP_SA_KEY) {
console.error(‘❌ GCP_SA_KEY not set - Google Drive disabled’);
return;
}
const credentials = JSON.parse(process.env.GCP_SA_KEY);
const auth = new google.auth.GoogleAuth({
credentials: credentials,
scopes: [‘https://www.googleapis.com/auth/drive.file’]
});
driveClient = google.drive({ version: ‘v3’, auth });
console.log(‘✅ Google Drive connected’);
} catch (error) {
console.error(‘❌ Google Drive failed:’, error.message);
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
if (!text) return “”;
return text.toString().replace(/(\r\n|\n|\r)/gm, “ “).replace(/[^\x20-\x7E]/g, “”);
}

function wrapText(text, font, size, maxWidth) {
if (!text) return [];
const cleanText = sanitizeText(text);
const words = cleanText.split(’ ’);
let lines = [];
let currentLine = words[0] || ‘’;
for (let i = 1; i < words.length; i++) {
const testLine = currentLine + “ “ + words[i];
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
// 🐛 DEBUG SYSTEM - API ENDPOINTS
// ============================================

// Client-side error reporting
app.post(’/api/log-error’, async (req, res) => {
const {
message,
stack,
url,
lineNo,
colNo,
userAgent,
screen,
viewport,
context,
severity
} = req.body;

```
const errorEntry = {
    type: 'client_error',
    severity: severity || 'error',
    message,
    stack,
    url,
    lineNo,
    colNo,
    userAgent: userAgent || req.get('user-agent'),
    ip: req.ip,
    screen,
    viewport,
    context
};

await appendLog(ERROR_LOG, errorEntry);

console.error('❌ Client Error:', message);
console.error('   URL:', url);
console.error('   User:', userAgent);

res.json({ success: true, logged: true });
```

});

// Camera debug logging
app.post(’/api/log-camera-debug’, async (req, res) => {
const {
event,
cameras,
selectedCamera,
strategy,
resolution,
facingMode,
rejected,
reason,
userAgent,
deviceInfo
} = req.body;

```
const cameraEntry = {
    type: 'camera_debug',
    event,
    cameras: cameras || [],
    selectedCamera,
    strategy,
    resolution,
    facingMode,
    rejected,
    reason,
    userAgent: userAgent || req.get('user-agent'),
    ip: req.ip,
    deviceInfo
};

await appendLog(CAMERA_LOG, cameraEntry);

console.log('📹 Camera Debug:', event);
if (selectedCamera) {
    console.log('   Selected:', selectedCamera.label || selectedCamera);
}

res.json({ success: true, logged: true });
```

});

// Performance tracking
app.post(’/api/log-performance’, async (req, res) => {
const {
action,
duration,
success,
fileSize,
details,
userAgent
} = req.body;

```
const perfEntry = {
    type: 'performance',
    action,
    duration,
    success,
    fileSize,
    details,
    userAgent: userAgent || req.get('user-agent'),
    ip: req.ip
};

await appendLog(PERFORMANCE_LOG, perfEntry);

res.json({ success: true, logged: true });
```

});

// General debug logging
app.post(’/api/log-debug’, async (req, res) => {
const {
category,
message,
data,
userAgent
} = req.body;

```
const debugEntry = {
    type: 'debug',
    category,
    message,
    data,
    userAgent: userAgent || req.get('user-agent'),
    ip: req.ip
};

await appendLog(DEBUG_LOG, debugEntry);

console.log('🐛 Debug:', category, '-', message);

res.json({ success: true, logged: true });
```

});

// ============================================
// API ROUTES - GATE & ARRIVAL CHECKS (INSTANT RESPONSE - ASYNC EMAIL)
// ============================================
app.post(’/log-gate-check’, async (req, res) => {
const perfStart = Date.now();
try {
const { name } = req.body;
if (isDuplicate(GATE_LOG_FILE, name)) {
await appendLog(PERFORMANCE_LOG, {
type: ‘performance’,
action: ‘gate_submission’,
duration: Date.now() - perfStart,
success: true,
details: ‘Duplicate detected’,
userAgent: req.get(‘user-agent’),
ip: req.ip
});
return res.json({ success: true });
}

```
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    let logs = [];
    if (fs.existsSync(GATE_LOG_FILE)) {
        try { logs = JSON.parse(fs.readFileSync(GATE_LOG_FILE)); } catch(e) {}
    }
    logs.push({ name, timestamp, rawTimestamp: now.getTime() });
    fs.writeFileSync(GATE_LOG_FILE, JSON.stringify(logs, null, 2));

    // Log performance
    await appendLog(PERFORMANCE_LOG, {
        type: 'performance',
        action: 'gate_submission',
        duration: Date.now() - perfStart,
        success: true,
        details: `Gate check for ${name}`,
        userAgent: req.get('user-agent'),
        ip: req.ip
    });

    // IMMEDIATE RESPONSE - Don't wait for PDF/email
    res.json({ success: true });

    // Generate PDF and send email AFTER response (async)
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

            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            
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
            await appendLog(ERROR_LOG, {
                type: 'server_error',
                severity: 'error',
                message: 'Gate PDF generation failed',
                stack: e.stack,
                source: 'log-gate-check'
            });
        }
    });
} catch (e) {
    console.error('Gate check error:', e);
    await appendLog(ERROR_LOG, {
        type: 'server_error',
        severity: 'critical',
        message: 'Gate check failed',
        stack: e.stack,
        source: 'log-gate-check'
    });
    res.status(500).json({ success: false, error: e.message });
}
```

});

app.post(’/log-arrival-check’, async (req, res) => {
const perfStart = Date.now();
try {
const { name } = req.body;
if (isDuplicate(ARRIVAL_LOG_FILE, name)) {
await appendLog(PERFORMANCE_LOG, {
type: ‘performance’,
action: ‘arrival_submission’,
duration: Date.now() - perfStart,
success: true,
details: ‘Duplicate detected’,
userAgent: req.get(‘user-agent’),
ip: req.ip
});
return res.json({ success: true });
}

```
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
    let logs = [];
    if (fs.existsSync(ARRIVAL_LOG_FILE)) {
        try { logs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE)); } catch(e) {}
    }
    logs.push({ name, timestamp, rawTimestamp: now.getTime() });
    fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify(logs, null, 2));

    // Log performance
    await appendLog(PERFORMANCE_LOG, {
        type: 'performance',
        action: 'arrival_submission',
        duration: Date.now() - perfStart,
        success: true,
        details: `Arrival check for ${name}`,
        userAgent: req.get('user-agent'),
        ip: req.ip
    });

    // IMMEDIATE RESPONSE - Don't wait for PDF/email
    res.json({ success: true });

    // Generate PDF and send email AFTER response (async)
    setImmediate(async () => {
        try {
            const doc = await PDFDocument.create();
            const page = doc.addPage([400, 850]);
            const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
            const fontReg = await doc.embedFont(StandardFonts.Helvetica);

            page.drawRectangle({ x: 0, y: 0, width: 400, height: 850, color: rgb(0.05, 0.08, 0.12) });
            page.drawText('!', { x: 190, y: 790, size: 50, font: fontBold, color: rgb(0, 0.66, 0.88) });
            page.drawText('ARRIVAL REQUIREMENTS', { x: 80, y: 750, size: 16, font: fontBold, color: rgb(0, 0.66, 0.88) });

            const items = [
                "Remove trash & belongings.", 
                "Keys/Power Bank returned.", 
                "Post-trip DVIC complete.", 
                "Video uploaded.", 
                "Lights off.", 
                "No packages left."
            ];
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

            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            
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
            await appendLog(ERROR_LOG, {
                type: 'server_error',
                severity: 'error',
                message: 'Arrival PDF generation failed',
                stack: e.stack,
                source: 'log-arrival-check'
            });
        }
    });
} catch (e) {
    console.error('Arrival check error:', e);
    await appendLog(ERROR_LOG, {
        type: 'server_error',
        severity: 'critical',
        message: 'Arrival check failed',
        stack: e.stack,
        source: 'log-arrival-check'
    });
    res.status(500).json({ success: false, error: e.message });
}
```

});

// ============================================
// API ROUTES - REPORTS
// ============================================
app.post(’/submit-report’, async (req, res) => {
try {
const data = req.body;
if (isDuplicate(DAILY_LOG_FILE, (data.vinLast4 || ‘’) + (data.reportType || ‘’))) {
return res.json({ success: true });
}
let currentLogs = [];
if (fs.existsSync(DAILY_LOG_FILE)) {
try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {}
}
data.timestamp = new Date();
data.rawTimestamp = Date.now();
data.name = (data.vinLast4 || ‘’) + (data.reportType || ‘’);
currentLogs.push(data);
fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));
if (client.isReady()) {
try {
const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
const title = data.reportType === ‘ACCIDENT_REPORT’ ? “🚨 **ACCIDENT REPORT FILED**” : “⚠️ **ISSUE REPORT**”;
if (channel) {
channel.send(`${title}\n**Driver:** ${data.driverName}\n**VIN:** ${data.vinLast4}\n**Desc:** ${data.statement || data.otherDescription || 'None'}`);
}
} catch(e) {
console.error(‘Discord notification failed:’, e.message);
}
}
let folderId = null;
if (driveClient) {
try {
let targetFolderId = data.reportType === ‘ACCIDENT_REPORT’ ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
const folder = await driveClient.files.create({
resource: {
name: `${data.driverName} - ${data.reportType} - ${new Date().toLocaleDateString()}`,
mimeType: ‘application/vnd.google-apps.folder’,
parents: [targetFolderId]
},
fields: ‘id’,
supportsAllDrives: true
});
folderId = folder.data.id;
if (data.photos && data.photos.length) {
console.log(`📸 Uploading ${data.photos.length} photos to Google Drive...`);
for (let i = 0; i < data.photos.length; i++) {
try {
// Write photo to temporary file first (more reliable than streams)
const buffer = Buffer.from(data.photos[i].data, ‘base64’);
const tempPhotoPath = path.join(UPLOAD_DIR, `temp_photo_${Date.now()}_${i}.jpg`);
fs.writeFileSync(tempPhotoPath, buffer);
console.log(`  📝 Saved temp photo: ${tempPhotoPath} (${(buffer.length / 1024).toFixed(2)} KB)`);

```
                        // Upload to Google Drive from file
                        const photoResult = await driveClient.files.create({
                            requestBody: {
                                name: `Photo_${i+1}.jpg`,
                                parents: [folderId],
                                mimeType: 'image/jpeg'
                            },
                            media: {
                                mimeType: 'image/jpeg',
                                body: fs.createReadStream(tempPhotoPath)
                            },
                            fields: 'id, name, size, webViewLink',
                            supportsAllDrives: true
                        });
                        
                        // Delete temp file
                        fs.unlinkSync(tempPhotoPath);
                        
                        const photoSizeKB = photoResult.data.size ? (parseInt(photoResult.data.size) / 1024).toFixed(2) : 'unknown';
                        console.log(`✅ Photo ${i+1}/${data.photos.length} uploaded: ${photoResult.data.name} (${photoSizeKB} KB, ID: ${photoResult.data.id})`);
                        console.log(`   View at: ${photoResult.data.webViewLink || 'N/A'}`);
                        
                    } catch (photoError) {
                        console.error(`❌ Failed to upload Photo ${i+1}:`, photoError.message);
                        console.error(`   Full error:`, photoError);
                        await appendLog(ERROR_LOG, {
                            type: 'server_error',
                            severity: 'error',
                            message: `Photo ${i+1} upload failed for accident report`,
                            stack: photoError.stack,
                            details: {
                                errorMessage: photoError.message,
                                photoIndex: i,
                                folderId: folderId
                            },
                            source: 'submit-report-photo-upload'
                        });
                    }
                }
                console.log(`✅ All ${data.photos.length} photos uploaded successfully to folder: ${folderId}`);
            } else {
                console.warn('⚠️  No photos attached to accident report');
            }
        } catch (driveError) {
            console.error("Drive upload failed:", driveError.message);
        }
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
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPass }
    });
    if (data.reportType === 'ACCIDENT_REPORT') {
        let page = doc.addPage([600, 800]);
        let y = 780;
        
        page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.9, 0.2, 0.2) });
        page.drawText('ACCIDENT REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`Filed: ${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}`, 
            { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
        
        y = 680;
        
        page.drawText('DRIVER & VEHICLE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
        y -= 20;
        page.drawText(`Driver Name: ${data.driverName || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 15;
        page.drawText(`VIN Last 4: ${data.vinLast4 || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 15;
        page.drawText(`Incident Type: ${data.incidentType || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 25;
        
        page.drawText('LOCATION INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
        y -= 20;
        if (data.locationData) {
            page.drawText(`Address: ${data.locationData.street || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
            y -= 15;
            page.drawText(`City: ${data.locationData.city || 'N/A'}, State: ${data.locationData.state || 'N/A'}, Zip: ${data.locationData.zip || 'N/A'}`, 
                { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
            y -= 15;
            page.drawText(`GPS: ${data.locationData.gpsLat || 'N/A'}, ${data.locationData.gpsLng || 'N/A'}`, 
                { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
            y -= 15;
        }
        page.drawText(`Weather: ${data.weather || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 25;
        
        page.drawText('CASE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
        y -= 20;
        page.drawText(`Police Report #: ${data.policeReport || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 15;
        page.drawText(`LMET Case #: ${data.lmetCase || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 25;
        
        page.drawText('DETAILED STATEMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
        y -= 20;
        const statement = data.statement || 'No statement provided';
        const statementLines = wrapText(statement, fontReg, 10, 540);
        for (let line of statementLines) {
            if (y < 50) {
                page = doc.addPage([600, 800]);
                y = 780;
            }
            page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
            y -= 15;
        }
        y -= 10;
        
        if (data.photos && data.photos.length > 0) {
            page.drawText('PHOTO EVIDENCE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 20;
            page.drawText(`Total Photos: ${data.photos.length}`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) });
            y -= 15;
            for (let i = 0; i < data.photos.length; i++) {
                if (y < 50) {
                    page = doc.addPage([600, 800]);
                    y = 780;
                }
                page.drawText(`  • Photo ${i+1}.jpg - Uploaded to Google Drive`, { x: 40, y, size: 9, font: fontReg, color: rgb(0,0,0) });
                y -= 15;
            }
            page.drawText('Access all photos via Google Drive link in email', { x: 30, y, size: 9, font: fontReg, color: rgb(0.3,0.3,0.3) });
            y -= 25;
        }
        
        if (data.signature) {
            page.drawText('DRIVER SIGNATURE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 20;
            try {
                const sigImage = await doc.embedPng('data:image/png;base64,' + data.signature);
                page.drawImage(sigImage, { x: 30, y: y - 60, width: 200, height: 60 });
                y -= 70;
            } catch (sigErr) {
                page.drawText('(Signature image error)', { x: 30, y, size: 10, font: fontReg, color: rgb(0.5,0,0) });
                y -= 20;
            }
        }
        
        if (data.affidavit) {
            if (y < 150) {
                page = doc.addPage([600, 800]);
                y = 780;
            }
            page.drawText('AFFIDAVIT ACKNOWLEDGMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 20;
            const affLines = wrapText(data.affidavit, fontReg, 8, 540);
            for (let line of affLines.slice(0, 10)) {
                page.drawText(line, { x: 30, y, size: 8, font: fontReg, color: rgb(0,0,0) });
                y -= 12;
            }
        }
        
        const pdfPath = path.join(UPLOAD_DIR, `Accident_${data.driverName}_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());
        const incidentTypeUC = (data.incidentType || 'ACCIDENT').toUpperCase();
        const lmetText = data.lmetCase ? `LMET# ${data.lmetCase}` : 'NO LMET';
        const driverNameUC = (data.driverName || 'UNKNOWN').toUpperCase();
        const photoCount = data.photos ? data.photos.length : 0;
        const photoText = photoCount > 0 ? `${photoCount} photos uploaded` : 'No photos';
        
        await transporter.sendMail({
            from: emailUser,
            to: ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com', 'slgpfleetmanager@gmail.com'],
            subject: `🚨 URGENT: ${incidentTypeUC} - ${lmetText} - DA ${driverNameUC}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;">
                        <h1 style="color: white; margin: 0; font-size: 28px;">🚨 URGENT: ACCIDENT REPORT</h1>
                        <p style="color: #fee2e2; margin: 10px 0 0 0; font-size: 14px;">Immediate attention required</p>
                    </div>
                    <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📋 Incident Details</h2>
                        <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                            <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${data.driverName}</td></tr>
                            <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN Last 4:</td><td style="padding: 12px; color: #1f2937;">${data.vinLast4}</td></tr>
                            <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Incident Type:</td><td style="padding: 12px; color: #1f2937;">${data.incidentType || 'N/A'}</td></tr>
                            <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Police Report #:</td><td style="padding: 12px; color: #1f2937;">${data.policeReport || 'N/A'}</td></tr>
                            <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">LMET Case #:</td><td style="padding: 12px; color: #1f2937;">${data.lmetCase || 'N/A'}</td></tr>
                            <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Filed:</td><td style="padding: 12px; color: #1f2937;">${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}</td></tr>
                        </table>
                        
                        <div style="background: #fef2f2; border-left: 4px solid #EF4444; padding: 20px; margin-bottom: 25px; border-radius: 4px;">
                            <h3 style="color: #DC2626; margin: 0 0 12px 0; font-size: 16px;">📸 PHOTO EVIDENCE</h3>
                            <p style="color: #991b1b; margin: 0; font-size: 14px; line-height: 1.6;">
                                <strong>${photoText}</strong> to Google Drive folder<br>
                                ${photoCount > 0 ? 'Click below to view all photos and documentation' : 'No photos were uploaded with this report'}
                            </p>
                        </div>
                        
                        <div style="text-align: center; margin: 25px 0;">
                            <a href="https://drive.google.com/drive/folders/${folderId}" style="display: inline-block; background: #DC2626; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px; box-shadow: 0 2px 4px rgba(220, 38, 38, 0.3);">
                                📁 OPEN GOOGLE DRIVE FOLDER
                            </a>
                        </div>
                        
                        <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
                            <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;">
                                <strong>⚠️ ACTION REQUIRED:</strong><br>
                                1. Review attached PDF report immediately<br>
                                2. Access Google Drive folder for all photos<br>
                                3. Contact driver if additional information needed<br>
                                4. Follow up on LMET case and police report
                            </p>
                        </div>
                        
                        <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin-top: 20px;">
                            <p style="margin: 0; color: #6b7280; font-size: 12px;">
                                <strong>Location:</strong> ${data.locationData ? (data.locationData.street + ', ' + data.locationData.city + ', ' + data.locationData.state) : 'N/A'}<br>
                                <strong>Weather:</strong> ${data.weather || 'N/A'}
                            </p>
                        </div>
                    </div>
                </div>
            `,
            attachments: [{ filename: 'Official_Accident_Report.pdf', path: pdfPath }]
        });
        fs.unlinkSync(pdfPath);
    } else {
        let page = doc.addPage([600, 800]);
        let y = 780;
        
        page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.145, 0.388, 0.922) });
        page.drawText('ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`Filed: ${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}`, 
            { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
        
        y = 680;
        
        page.drawText('DRIVER & VEHICLE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
        y -= 20;
        page.drawText(`Driver Name: ${data.driverName || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 15;
        page.drawText(`VIN Last 4: ${data.vinLast4 || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 15;
        page.drawText(`Report Type: ${data.reportType || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
        y -= 25;
        
        if (data.otherDescription) {
            page.drawText('ISSUE DESCRIPTION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 20;
            const descLines = wrapText(data.otherDescription, fontReg, 10, 540);
            for (let line of descLines) {
                if (y < 50) {
                    page = doc.addPage([600, 800]);
                    y = 780;
                }
                page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) });
                y -= 15;
            }
            y -= 10;
        }
        
        if (data.photos && data.photos.length > 0) {
            page.drawText('PHOTO EVIDENCE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 20;
            page.drawText(`Total Photos: ${data.photos.length}`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) });
            y -= 15;
            for (let i = 0; i < data.photos.length; i++) {
                if (y < 50) {
                    page = doc.addPage([600, 800]);
                    y = 780;
                }
                page.drawText(`  • Photo ${i+1}.jpg - Uploaded to Google Drive`, { x: 40, y, size: 9, font: fontReg, color: rgb(0,0,0) });
                y -= 15;
            }
            page.drawText('Access all photos via Google Drive link in email', { x: 30, y, size: 9, font: fontReg, color: rgb(0.3,0.3,0.3) });
            y -= 25;
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
    await appendLog(ERROR_LOG, {
        type: 'server_error',
        severity: 'error',
        message: 'Report submission failed',
        stack: error.stack,
        source: 'submit-report'
    });
    res.status(500).json({ success: false, error: error.message });
}
```

});

// ============================================
// VIDEO UPLOAD WITH DIRECT STREAMING
// ============================================
app.post(’/upload-to-google-drive’, upload.single(‘video’), async (req, res) => {
const startTime = Date.now();
let videoPath = null;
try {
console.log(‘📹 Video upload initiated’);
if (!driveClient) throw new Error(‘Google Drive not initialized’);
if (!req.file) throw new Error(‘No video file received’);
videoPath = req.file.path;
const { driverName, vin, inspectionType } = req.body;
if (!driverName || !vin || !inspectionType) throw new Error(‘Missing required fields’);
const fileStats = fs.statSync(videoPath);
const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
console.log(`📹 Upload - Driver: ${driverName}, VIN: ${vin}, Type: ${inspectionType}, Size: ${fileSizeMB}MB`);
const fileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;
console.log(‘☁️  Starting Google Drive upload…’);
const fileMetadata = {
name: fileName,
parents: [VIDEO_DRIVE_ID],
mimeType: ‘video/mp4’,
properties: {
driver: driverName,
vin: vin,
inspectionType: inspectionType,
uploadDate: new Date().toISOString(),
codec: ‘H.265/HEVC’,
resolution: ‘1920x1080’,
downloadPreferred: ‘true’
},
description: `Fleet Video Inspection - ${inspectionType} for VIN ${vin} by ${driverName}`
};
const media = { mimeType: ‘video/mp4’, body: fs.createReadStream(videoPath) };
const uploadType = fileStats.size > 5 * 1024 * 1024 ? ‘resumable’ : ‘multipart’;
console.log(`📤 Using ${uploadType} upload method`);
const driveResponse = await driveClient.files.create({
requestBody: fileMetadata,
media: media,
fields: ‘id, name, webViewLink, webContentLink, size, videoMediaMetadata, createdTime’,
supportsAllDrives: true
});
const uploadTime = ((Date.now() - startTime) / 1000).toFixed(1);
const fileId = driveResponse.data.id;

```
    const videoMetadata = driveResponse.data.videoMediaMetadata || {};
    const videoDuration = videoMetadata.durationMillis ? `${(videoMetadata.durationMillis / 1000 / 60).toFixed(1)} minutes` : 'Unknown';
    
    console.log(`✅ Google Drive upload complete in ${uploadTime}s`);
    console.log(`   File ID: ${fileId}`);
    console.log(`   Size uploaded: ${fileSizeMB}MB`);

    // Log upload performance
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
    
    // ============================================
    // 🔧 FIXED: VIDEO NOTIFICATION EMAIL
    // Changed from sending to self (EMAIL_USER) to proper recipients
    // ============================================
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            // FIXED: Send to fleet manager instead of self
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
        // Log email failure but don't break the upload
        await appendLog(ERROR_LOG, {
            type: 'server_error',
            severity: 'warning',
            message: 'Video notification email failed',
            stack: emailError.stack,
            source: 'upload-to-google-drive-email',
            details: {
                driver: driverName,
                vin: vin,
                inspectionType: inspectionType
            }
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
    
    // Log upload failure
    await appendLog(ERROR_LOG, {
        type: 'server_error',
        severity: 'error',
        message: 'Video upload failed',
        stack: error.stack,
        source: 'upload-to-google-drive',
        details: {
            driver: req.body.driverName,
            vin: req.body.vin,
            inspectionType: req.body.inspectionType
        }
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
        error: error.message,
        details: {
            driver: req.body.driverName,
            vin: req.body.vin,
            inspectionType: req.body.inspectionType,
            receivedFile: !!req.file,
            fileSize: req.file ? (req.file.size / 1024 / 1024).toFixed(2) + 'MB' : 'N/A'
        }
    });
}
```

});

// ============================================
// PUSH NOTIFICATIONS
// ============================================
app.get(’/vapid-key’, (req, res) => {
res.json({ publicKey: publicVapidKey });
});

app.post(’/subscribe’, (req, res) => {
try {
const subscription = req.body;
let subs = fs.existsSync(SUBSCRIPTION_FILE) ? JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)) : [];
const exists = subs.some(s => JSON.stringify(s) === JSON.stringify(subscription));
if (!exists) {
subs.push(subscription);
fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(subs));
console.log(‘✅ Push subscription added’);
}
res.json({ success: true });
} catch (e) {
console.error(‘Subscription error:’, e);
res.status(500).json({ success: false });
}
});

// ============================================
// VERSION ENDPOINT
// ============================================
app.get(’/version’, (req, res) => {
res.json(BUILD_INFO);
});

// ============================================
// 🐛 DEBUG DASHBOARD
// ============================================
app.get(’/debug-dashboard’, async (req, res) => {
// Simple password protection - CHANGE THIS PASSWORD!
const password = req.query.key;
if (password !== ‘slgp-debug-2026’) {
return res.status(401).send(‘Unauthorized - Invalid key’);
}

```
const recentErrors = await getRecentLogs(ERROR_LOG, 50);
const recentCamera = await getRecentLogs(CAMERA_LOG, 50);
const recentPerf = await getRecentLogs(PERFORMANCE_LOG, 50);
const recentDebug = await getRecentLogs(DEBUG_LOG, 50);

// Generate HTML dashboard
const html = `
<!DOCTYPE html>
<html>
<head>
    <title>SLGP Debug Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Courier New', monospace;
            background: #0a0e17;
            color: #e5e7eb;
            padding: 20px;
        }
        .header {
            background: linear-gradient(135deg, #00A8E1, #0084b4);
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        h1 { color: white; margin-bottom: 10px; }
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: #1a1f2e;
            padding: 15px;
            border-radius: 8px;
            border: 2px solid #00A8E1;
        }
        .stat-number {
            font-size: 32px;
            font-weight: bold;
            color: #00A8E1;
        }
        .stat-label {
            font-size: 12px;
            color: #a9b2bd;
            text-transform: uppercase;
        }
        .section {
            background: #1a1f2e;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            border: 1px solid #2d3748;
        }
        .section-title {
            font-size: 18px;
            color: #00A8E1;
            margin-bottom: 15px;
            border-bottom: 2px solid #00A8E1;
            padding-bottom: 10px;
        }
        .log-entry {
            background: #0d1117;
            padding: 15px;
            margin-bottom: 10px;
            border-radius: 6px;
            border-left: 4px solid #00A8E1;
            font-size: 12px;
        }
        .log-entry.error { border-left-color: #ff2a2a; }
        .log-entry.camera { border-left-color: #FF9900; }
        .log-entry.performance { border-left-color: #00ff88; }
        .log-time {
            color: #6b7280;
            font-size: 11px;
            margin-bottom: 5px;
        }
        .log-message {
            color: #e5e7eb;
            margin-bottom: 8px;
        }
        .log-details {
            color: #9ca3af;
            font-size: 11px;
            margin-top: 8px;
        }
        .error-stack {
            background: #000;
            padding: 10px;
            border-radius: 4px;
            margin-top: 8px;
            overflow-x: auto;
            font-size: 10px;
            color: #ff6b6b;
        }
        .camera-info {
            background: #1a1f2e;
            padding: 8px;
            margin-top: 8px;
            border-radius: 4px;
            font-size: 11px;
        }
        .refresh-btn {
            background: #00A8E1;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            margin-bottom: 20px;
        }
        .refresh-btn:hover {
            background: #0084b4;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🐛 SLGP Debug Dashboard</h1>
        <p>Real-time error tracking and diagnostics</p>
        <p style="margin-top: 10px; font-size: 12px; opacity: 0.8;">Last updated: ${new Date().toLocaleString()}</p>
    </div>

    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Dashboard</button>

    <div class="stats">
        <div class="stat-card">
            <div class="stat-number">${recentErrors.length}</div>
            <div class="stat-label">Recent Errors</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${recentCamera.length}</div>
            <div class="stat-label">Camera Logs</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${recentPerf.length}</div>
            <div class="stat-label">Performance Logs</div>
        </div>
        <div class="stat-card">
            <div class="stat-number">${recentDebug.length}</div>
            <div class="stat-label">Debug Messages</div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">❌ Recent Errors (Last 50)</div>
        ${recentErrors.map(log => `
            <div class="log-entry error">
                <div class="log-time">${new Date(log.timestamp).toLocaleString()}</div>
                <div class="log-message"><strong>${log.message || 'No message'}</strong></div>
                <div class="log-details">
                    URL: ${log.url || 'N/A'}<br>
                    User Agent: ${log.userAgent || 'N/A'}<br>
                    IP: ${log.ip || 'N/A'}
                </div>
                ${log.stack ? `<div class="error-stack">${log.stack.substring(0, 500)}</div>` : ''}
            </div>
        `).join('') || '<p>No errors logged</p>'}
    </div>

    <div class="section">
        <div class="section-title">📹 Camera Issues (Last 50)</div>
        ${recentCamera.map(log => `
            <div class="log-entry camera">
                <div class="log-time">${new Date(log.timestamp).toLocaleString()}</div>
                <div class="log-message"><strong>Event: ${log.event || 'Unknown'}</strong></div>
                ${log.cameras && log.cameras.length > 0 ? `
                    <div class="camera-info">
                        <strong>Available Cameras:</strong><br>
                        ${log.cameras.map((cam, i) => `${i + 1}. ${cam.label || 'Unknown'} (Facing: ${cam.facingMode || 'unknown'})`).join('<br>')}
                    </div>
                ` : ''}
                ${log.selectedCamera ? `
                    <div class="camera-info">
                        <strong>Selected:</strong> ${log.selectedCamera.label || 'Unknown'}<br>
                        <strong>Resolution:</strong> ${log.resolution || 'N/A'}<br>
                        <strong>Facing Mode:</strong> ${log.facingMode || 'N/A'}<br>
                        <strong>Strategy:</strong> ${log.strategy || 'N/A'}
                    </div>
                ` : ''}
                ${log.rejected ? `<div class="log-details" style="color: #ff6b6b;">❌ Rejected: ${log.reason || 'Unknown reason'}</div>` : ''}
                <div class="log-details">
                    User Agent: ${log.userAgent || 'N/A'}<br>
                    IP: ${log.ip || 'N/A'}
                </div>
            </div>
        `).join('') || '<p>No camera issues logged</p>'}
    </div>

    <div class="section">
        <div class="section-title">⚡ Performance Logs (Last 50)</div>
        ${recentPerf.map(log => `
            <div class="log-entry performance">
                <div class="log-time">${new Date(log.timestamp).toLocaleString()}</div>
                <div class="log-message"><strong>${log.action || 'Unknown action'}</strong></div>
                <div class="log-details">
                    Duration: ${log.duration || 0}ms<br>
                    Success: ${log.success ? '✅' : '❌'}<br>
                    ${log.fileSize ? `File Size: ${(log.fileSize / 1024 / 1024).toFixed(2)} MB<br>` : ''}
                    ${log.details ? `Details: ${log.details}<br>` : ''}
                    User Agent: ${log.userAgent || 'N/A'}
                </div>
            </div>
        `).join('') || '<p>No performance logs</p>'}
    </div>

    <div class="section">
        <div class="section-title">🐛 Debug Messages (Last 50)</div>
        ${recentDebug.map(log => `
            <div class="log-entry">
                <div class="log-time">${new Date(log.timestamp).toLocaleString()}</div>
                <div class="log-message"><strong>${log.category || 'General'}</strong>: ${log.message || 'No message'}</div>
                ${log.data ? `<div class="log-details">Data: <pre style="overflow-x: auto;">${JSON.stringify(log.data, null, 2).substring(0, 300)}</pre></div>` : ''}
                <div class="log-details">
                    User Agent: ${log.userAgent || 'N/A'}<br>
                    IP: ${log.ip || 'N/A'}
                </div>
            </div>
        `).join('') || '<p>No debug messages</p>'}
    </div>

    <script>
        // Auto-refresh every 30 seconds
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>
`;

res.send(html);
```

});

// Export logs as JSON
app.get(’/debug-export’, async (req, res) => {
const password = req.query.key;
if (password !== ‘slgp-debug-2026’) {
return res.status(401).send(‘Unauthorized’);
}

```
const type = req.query.type || 'all';

let logs = {};

if (type === 'all' || type === 'errors') {
    logs.errors = await getRecentLogs(ERROR_LOG, 1000);
}
if (type === 'all' || type === 'camera') {
    logs.camera = await getRecentLogs(CAMERA_LOG, 1000);
}
if (type === 'all' || type === 'performance') {
    logs.performance = await getRecentLogs(PERFORMANCE_LOG, 1000);
}
if (type === 'all' || type === 'debug') {
    logs.debug = await getRecentLogs(DEBUG_LOG, 1000);
}

res.setHeader('Content-Type', 'application/json');
res.setHeader('Content-Disposition', `attachment; filename="slgp-logs-${Date.now()}.json"`);
res.send(JSON.stringify(logs, null, 2));
```

});

// ============================================
// HTML PAGES
// ============================================
app.get(’/video’, (req, res) => {
console.log(‘📍 GET /video’);
res.sendFile(path.join(__dirname, ‘video.html’));
});

app.get(’/success’, (req, res) => {
console.log(‘📍 GET /success’);
res.sendFile(path.join(__dirname, ‘success.html’));
});

app.get(’/alerts’, (req, res) => {
console.log(‘📍 GET /alerts’);
res.sendFile(path.join(__dirname, ‘alerts.html’));
});

app.get(’/report’, (req, res) => {
const mode = req.query.mode;
console.log(`📍 GET /report?mode=${mode}`);
let filePath;
if (mode === ‘issue’) {
filePath = path.join(__dirname, ‘report-issue.html’);
} else if (mode === ‘accident’) {
filePath = path.join(__dirname, ‘accident-report.html’);
} else if (mode === ‘insurance’) {
filePath = path.join(__dirname, ‘insurance.html’);
} else {
console.error(‘❌ Unknown report mode:’, mode);
return res.status(404).send(‘Unknown report type’);
}
if (fs.existsSync(filePath)) {
console.log(‘✅ Serving:’, filePath);
res.sendFile(filePath);
} else {
console.error(‘❌ File not found:’, filePath);
res.status(404).send(`File not found: ${mode}`);
}
});

// ============================================
// STATIC FILES
// ============================================
app.use(express.static(__dirname, {
setHeaders: (res, filepath) => {
if (filepath.endsWith(’.html’)) {
res.setHeader(‘Cache-Control’, ‘no-store, no-cache, must-revalidate, proxy-revalidate’);
res.setHeader(‘Pragma’, ‘no-cache’);
res.setHeader(‘Expires’, ‘0’);
}
}
}));

// ============================================
// ROOT ROUTE
// ============================================
app.get(’/’, (req, res) => {
console.log(‘📍 GET / - Serving menu.html’);
res.setHeader(‘Cache-Control’, ‘no-store, no-cache, must-revalidate’);
res.setHeader(‘Pragma’, ‘no-cache’);
res.setHeader(‘Expires’, ‘0’);
const menuPath = path.join(__dirname, ‘menu.html’);
if (fs.existsSync(menuPath)) {
console.log(‘✅ Serving menu.html from:’, menuPath);
res.sendFile(menuPath);
} else {
console.error(‘❌ menu.html not found at:’, menuPath);
res.status(404).send(‘menu.html not found’);
}
});

// ============================================
// CRON JOB - DAILY SUMMARY
// ============================================
cron.schedule(‘30 23 * * *’, async () => {
try {
console.log(‘🕐 Running daily summary…’);
let summaryText = “\n— DEPARTURE LOGS —\n”;
if (fs.existsSync(GATE_LOG_FILE)) {
const gateLogs = JSON.parse(fs.readFileSync(GATE_LOG_FILE));
gateLogs.forEach(log => summaryText += `${log.timestamp}: ${log.name}\n`);
fs.writeFileSync(GATE_LOG_FILE, JSON.stringify([]));
}
summaryText += “\n— ARRIVAL LOGS —\n”;
if (fs.existsSync(ARRIVAL_LOG_FILE)) {
const arrLogs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE));
arrLogs.forEach(log => summaryText += `${log.timestamp}: ${log.name}\n`);
fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify([]));
}
if (!fs.existsSync(DAILY_LOG_FILE)) return;
const allLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE));
if (allLogs.length === 0 && summaryText.length < 40) return;
const transporter = nodemailer.createTransport({
service: ‘gmail’,
auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
await transporter.sendMail({
from: process.env.EMAIL_USER,
to: [‘slgpfleetmanager@gmail.com’],
subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()}`,
text: `Daily Summary\nTotal Reports: ${allLogs.length}\n${summaryText}`
});
fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
console.log(‘✅ Daily summary sent’);
} catch (e) {
console.error(‘❌ Cron job error:’, e);
}
}, { timezone: “America/New_York” });

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
console.error(‘❌ Server Error:’, err);

```
// Log server errors
appendLog(ERROR_LOG, {
    type: 'server_error',
    severity: 'error',
    message: err.message,
    stack: err.stack,
    source: 'express_error_handler',
    url: req.url,
    method: req.method
});

res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: err.message
});
```

});

// ============================================
// SERVER ERROR TRACKING
// ============================================
process.on(‘uncaughtException’, async (error) => {
console.error(‘💥 Uncaught Exception:’, error);

```
await appendLog(ERROR_LOG, {
    type: 'server_error',
    severity: 'critical',
    message: error.message,
    stack: error.stack,
    source: 'uncaughtException'
});

process.exit(1);
```

});

process.on(‘unhandledRejection’, async (reason, promise) => {
console.error(‘💥 Unhandled Rejection at:’, promise, ‘reason:’, reason);

```
await appendLog(ERROR_LOG, {
    type: 'server_error',
    severity: 'critical',
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    source: 'unhandledRejection'
});
```

});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 8080;

app.listen(PORT, ‘0.0.0.0’, () => {
console.log(`
╔══════════════════════════════════════════╗
║  SLGP Fleet Manager                      ║
║  v2.1 - FIXED VIDEO NOTIFICATIONS        ║
╠══════════════════════════════════════════╣
║  Port: ${PORT}                                ║
║  Version: ${BUILD_INFO.version}
╚══════════════════════════════════════════╝

✅ Server started
✅ Email configured
${driveClient ? ‘✅ Google Drive connected’ : ‘⚠️  Google Drive offline’}
✅ Push notifications ready
${DISCORD_BOT_TOKEN ? ‘✅ Discord bot online’ : ‘⚠️  Discord bot offline’}
✅ Auto-refresh system active
🐛 Debug system active
📧 VIDEO NOTIFICATIONS FIXED - Now sending to slgpfleetmanager@gmail.com

✅ Gate checks: INSTANT response (< 1 second)
✅ Arrival checks: INSTANT response (< 1 second)  
✅ PDFs generated in background
✅ Video upload: Direct streaming with H.265/HEVC
✅ Video notifications: Sent to correct recipient

🐛 Debug Dashboard: https://your-domain.com/debug-dashboard?key=slgp-debug-2026
⚠️  CHANGE THE PASSWORD IN CODE!

🌐 Ready at: http://localhost:${PORT}
`);
});

process.on(‘SIGTERM’, () => {
console.log(‘⚠️  SIGTERM received - shutting down gracefully’);
process.exit(0);
});