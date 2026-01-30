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
const BUILD_INFO = {
    version: APP_VERSION,
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

const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA';

// Create upload directory
if (!fs.existsSync(UPLOAD_DIR)) {
    try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        console.log('✅ Upload directory created');
    } catch (e) {
        console.error('❌ Failed to create upload directory:', e.message);
    }
}

const upload = multer({ 
    dest: UPLOAD_DIR,
    limits: {
        fileSize: 200 * 1024 * 1024 // 200MB limit
    }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

// Request logging for debugging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} - ${req.method} ${req.path}`);
    next();
});

// ============================================
// DISCORD BOT SETUP
// ============================================
const DISCORD_BOT_TOKEN = process.env.FLEET_BOT_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
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
            const pushPromises = subs.map(async (sub) => {
                try { await webpush.sendNotification(sub, payload); } catch (e) {}
            });
            await Promise.all(pushPromises);
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
    console.log('⚠️  VAPID keys generated (set env vars for production)');
}

webpush.setVapidDetails(
    'mailto:' + (process.env.EMAIL_USER || 'slgpfleetmanager@gmail.com'),
    publicVapidKey,
    privateVapidKey
);

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
// API ROUTES - GATE CHECKS
// ============================================

app.post('/log-gate-check', async (req, res) => {
    try {
        const { name } = req.body;
        if (isDuplicate(GATE_LOG_FILE, name)) return res.json({ success: true });
        
        const now = new Date();
        const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        let logs = [];
        if (fs.existsSync(GATE_LOG_FILE)) {
            try { logs = JSON.parse(fs.readFileSync(GATE_LOG_FILE)); } catch(e) {}
        }
        logs.push({ name, timestamp, rawTimestamp: now.getTime() });
        fs.writeFileSync(GATE_LOG_FILE, JSON.stringify(logs, null, 2));

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

        page.drawText('DA ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(1, 0.6, 0) });
        page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });

        const pdfBytes = await doc.save();
        const snapshotPath = path.join(UPLOAD_DIR, `Gate_${Date.now()}.pdf`);
        fs.writeFileSync(snapshotPath, pdfBytes);

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `CHECKLIST ALERT: ${name}`,
            text: `Receipt attached for DA ${name}.`,
            attachments: [{ filename: `Receipt_${name}.pdf`, path: snapshotPath }]
        });
        
        fs.unlinkSync(snapshotPath);
        res.json({ success: true });
    } catch (e) {
        console.error('Gate check error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/log-arrival-check', async (req, res) => {
    try {
        const { name } = req.body;
        if (isDuplicate(ARRIVAL_LOG_FILE, name)) return res.json({ success: true });

        const now = new Date();
        const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        let logs = [];
        if (fs.existsSync(ARRIVAL_LOG_FILE)) {
            try { logs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE)); } catch(e) {}
        }
        logs.push({ name, timestamp, rawTimestamp: now.getTime() });
        fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify(logs, null, 2));

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

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `ARRIVAL COMPLETED: ${name}`,
            text: `Arrival receipt attached for DA ${name}.`,
            attachments: [{ filename: `Arrival_Receipt_${name}.pdf`, path: snapshotPath }]
        });
        
        fs.unlinkSync(snapshotPath);
        res.json({ success: true });
    } catch (e) {
        console.error('Arrival check error:', e);
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
            } catch(e) {
                console.error('Discord notification failed:', e.message);
            }
        }

        let folderId = null;
        if (driveClient) {
            try {
                let targetFolderId = data.reportType === 'ACCIDENT_REPORT' ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
                
                const folder = await driveClient.files.create({
                    resource: {
                        name: `${data.driverName} - ${data.reportType} - ${new Date().toLocaleDateString()}`,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [targetFolderId]
                    },
                    fields: 'id',
                    supportsAllDrives: true
                });
                
                folderId = folder.data.id;

                if (data.photos && data.photos.length) {
                    for (let i = 0; i < data.photos.length; i++) {
                        const buffer = Buffer.from(data.photos[i].data, 'base64');
                        const bs = new stream.PassThrough();
                        bs.end(buffer);
                        
                        await driveClient.files.create({
                            resource: {
                                name: `Photo_${i+1}.jpg`,
                                parents: [folderId]
                            },
                            media: {
                                mimeType: 'image/jpeg',
                                body: bs
                            },
                            supportsAllDrives: true
                        });
                    }
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
            
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.9, 0.2, 0.2) });
            page.drawText('ACCIDENT REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText('OFFICIAL INCIDENT DOCUMENTATION', { x: 30, y: 740, size: 10, font: fontReg, color: rgb(1, 1, 1) });

            let y = 650;
            const drawLabel = (txt, val) => {
                page.drawText(txt, { x: 30, y, size: 9, font: fontBold, color: rgb(0.5, 0.5, 0.5) });
                page.drawText(sanitizeText(val || 'N/A'), { x: 150, y, size: 11, font: fontReg, color: rgb(0,0,0) });
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

            page.drawText('LOCATION DETAILS', { x: 30, y, size: 12, font: fontBold, color: rgb(0.9, 0.2, 0.2) });
            y -= 20;
            const loc = data.locationData || {};
            drawLabel('ADDRESS', `${loc.street || ''}, ${loc.city || ''}, ${loc.state || ''} ${loc.zip || ''}`);
            drawLabel('GPS COORDS', `${loc.gpsLat || ''}, ${loc.gpsLng || ''}`);
            drawLabel('WEATHER', data.weather || 'Unknown');

            y -= 20;
            page.drawText('DRIVER STATEMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0.9, 0.2, 0.2) });
            y -= 20;
            const stateLines = wrapText(data.statement || '', fontReg, 10, 540);
            stateLines.forEach(line => {
                page.drawText(line, { x: 30, y, size: 10, font: fontReg });
                y -= 14;
            });

            y -= 30;
            page.drawText('AFFIDAVIT & ACKNOWLEDGMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0.9, 0.2, 0.2) });
            y -= 20;
            
            if (data.checklist && Array.isArray(data.checklist)) {
                data.checklist.forEach(item => {
                    page.drawText('[X] ' + sanitizeText(item), { x: 30, y, size: 9, font: fontReg });
                    y -= 12;
                });
            }
            y -= 10;
            const affLines = wrapText(data.affidavit || '', fontReg, 9, 540);
            affLines.forEach(line => {
                page.drawText(line, { x: 30, y, size: 9, font: fontReg, color: rgb(0.3, 0.3, 0.3) });
                y -= 11;
            });

            y -= 20;
            page.drawText('SIGNED:', { x: 30, y, size: 10, font: fontBold });
            if (data.signature) {
                try {
                    const sigImage = await doc.embedPng(data.signature);
                    const dims = sigImage.scale(0.5);
                    page.drawImage(sigImage, { x: 80, y: y - 40, width: dims.width, height: dims.height });
                } catch(e) {
                    page.drawText('(Signature Error)', { x: 80, y });
                }
            }

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
                    } catch(e) {
                        photoPage.drawText('(Image Error)', { x: 30, y: 700 });
                    }
                }
            }

            const pdfPath = path.join(UPLOAD_DIR, `Accident_${data.driverName}_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());

            const incidentTypeUC = (data.incidentType || 'ACCIDENT').toUpperCase();
            const lmetText = data.lmetCase ? `LMET# ${data.lmetCase}` : 'NO LMET';
            const driverNameUC = (data.driverName || 'UNKNOWN').toUpperCase();

            await transporter.sendMail({
                from: emailUser,
                to: ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com', 'slgpfleetmanager@gmail.com'],
                subject: `URGENT: ${incidentTypeUC} - ${lmetText} - DA ${driverNameUC}`,
                text: `An Accident Report has been filed.\n\nDriver: ${data.driverName}\nVIN: ${data.vinLast4}\n\nSee attached PDF for full official report.\n\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`,
                attachments: [{ filename: 'Official_Accident_Report.pdf', path: pdfPath }]
            });

            if (data.driverEmail && data.driverEmail.includes('@')) {
                const driverAttachments = [];
                if (fs.existsSync(PANEL_DOC_PATH)) {
                    driverAttachments.push({ filename: 'Panel_of_Physicians.pdf', path: PANEL_DOC_PATH });
                }

                await transporter.sendMail({
                    from: emailUser,
                    to: data.driverEmail,
                    subject: 'SLGP Accident Protocol - Panel of Physicians',
                    text: `Hello ${data.driverName},\n\nWe have received your accident report. Per company policy, please review the attached Panel of Physicians document.\n\nThank you,\nSLGP Fleet Management`,
                    attachments: driverAttachments
                });
            }

            fs.unlinkSync(pdfPath);
            
        } else {
            let page = doc.addPage([600, 800]);
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.145, 0.388, 0.922) });
            page.drawText('ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText('SLGP FLEET MANAGEMENT', { x: 30, y: 740, size: 10, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

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

            await transporter.sendMail({
                from: emailUser,
                to: ['slgpfleetmanager@gmail.com'],
                subject: `REPORT: ${data.vinLast4} - ${data.reportType}`,
                text: `Driver: ${data.driverName}\nVIN: ${data.vinLast4}\nCategory: ${data.reportType}\n\nPDF Attached.\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`,
                attachments: [{ filename: 'Vehicle_Report.pdf', path: pdfPath }]
            });

            fs.unlinkSync(pdfPath);
        }

        res.json({ success: true });
        
    } catch (error) {
        console.error('Report submission error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API ROUTES - ENHANCED VIDEO UPLOAD
// ============================================

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    const startTime = Date.now();
    let videoPath = null;
    
    try {
        console.log('📹 Video upload initiated');
        
        if (!driveClient) {
            throw new Error('Google Drive not initialized');
        }

        if (!req.file) {
            throw new Error('No video file received');
        }

        videoPath = req.file.path;
        const { driverName, vin, inspectionType } = req.body;

        if (!driverName || !vin || !inspectionType) {
            throw new Error('Missing required fields');
        }

        const fileStats = fs.statSync(videoPath);
        const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
        
        console.log(`📹 Upload details:`);
        console.log(`   Driver: ${driverName}`);
        console.log(`   VIN: ${vin}`);
        console.log(`   Type: ${inspectionType}`);
        console.log(`   Size: ${fileSizeMB}MB`);

        const fileName = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;
        
        console.log('☁️  Starting Google Drive upload...');
        
        const driveResponse = await driveClient.files.create({
            resource: {
                name: fileName,
                parents: [VIDEO_DRIVE_ID]
            },
            media: {
                mimeType: 'video/mp4',
                body: fs.createReadStream(videoPath)
            },
            fields: 'id, name, webViewLink, size',
            supportsAllDrives: true
        });

        const uploadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ Google Drive upload complete in ${uploadTime}s`);
        console.log(`   File ID: ${driveResponse.data.id}`);
        console.log(`   Link: ${driveResponse.data.webViewLink}`);

        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });
            
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER,
                subject: `📹 Video Inspection: ${inspectionType} - ${driverName}`,
                html: `
                    <h2>Video Inspection Uploaded</h2>
                    <p><strong>Driver:</strong> ${driverName}</p>
                    <p><strong>VIN:</strong> ${vin}</p>
                    <p><strong>Type:</strong> ${inspectionType}</p>
                    <p><strong>File:</strong> ${fileName}</p>
                    <p><strong>Size:</strong> ${fileSizeMB}MB</p>
                    <p><strong>Upload Time:</strong> ${uploadTime}s</p>
                    <p><a href="${driveResponse.data.webViewLink}">View Video</a></p>
                `
            });
            console.log('✅ Email notification sent');
        } catch (emailError) {
            console.error('⚠️  Email notification failed:', emailError.message);
        }

        if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            console.log('✅ Temporary file cleaned up');
        }

        res.json({
            success: true,
            fileId: driveResponse.data.id,
            fileName: driveResponse.data.name,
            fileSize: fileSizeMB,
            uploadTime: uploadTime,
            viewLink: driveResponse.data.webViewLink
        });
        
    } catch (error) {
        console.error('❌ Video upload error:', error);
        
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
});

// ============================================
// API ROUTES - PUSH NOTIFICATIONS
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
// API ROUTES - VERSION (AUTO-REFRESH SYSTEM)
// ============================================

app.get('/version', (req, res) => {
    res.json(BUILD_INFO);
});

// ============================================
// HTML PAGE ROUTES
// ============================================

app.get('/video', (req, res) => {
    console.log('📍 GET /video');
    res.sendFile(path.join(__dirname, 'video.html'));
});

app.get('/success', (req, res) => {
    console.log('📍 GET /success');
    res.sendFile(path.join(__dirname, 'success.html'));
});

app.get('/alerts', (req, res) => {
    console.log('📍 GET /alerts');
    res.sendFile(path.join(__dirname, 'alerts.html'));
});

app.get('/report', (req, res) => {
    const mode = req.query.mode;
    console.log(`📍 GET /report?mode=${mode}`);
    
    let filePath;
    
    if (mode === 'issue') {
        filePath = path.join(__dirname, 'report-issue.html');
    } else if (mode === 'accident') {
        filePath = path.join(__dirname, 'accident-report.html');
    } else if (mode === 'insurance') {
        filePath = path.join(__dirname, 'insurance.html');
    } else {
        console.error('❌ Unknown report mode:', mode);
        return res.status(404).send('Unknown report type');
    }
    
    if (fs.existsSync(filePath)) {
        console.log('✅ Serving:', filePath);
        res.sendFile(filePath);
    } else {
        console.error('❌ File not found:', filePath);
        res.status(404).send(`File not found: ${mode}`);
    }
});

// ============================================
// STATIC FILES
// ============================================

app.use(express.static(__dirname, {
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ============================================
// ROOT ROUTE
// ============================================

app.get('/', (req, res) => {
    console.log('📍 GET / - Serving menu.html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const menuPath = path.join(__dirname, 'menu.html');
    
    if (fs.existsSync(menuPath)) {
        console.log('✅ Serving menu.html from:', menuPath);
        res.sendFile(menuPath);
    } else {
        console.error('❌ menu.html not found at:', menuPath);
        res.status(404).send('menu.html not found');
    }
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
        
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });
        
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()}`,
            text: `Daily Summary\nTotal Reports: ${allLogs.length}\n${summaryText}`
        });
        
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
        console.log('✅ Daily summary sent');
    } catch (e) {
        console.error('❌ Cron job error:', e);
    }
}, { timezone: "America/New_York" });

// ============================================
// ERROR HANDLER
// ============================================

app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║  SLGP Fleet Manager                  ║
║  Enhanced with Auto-Refresh          ║
╠══════════════════════════════════════╣
║  Port: ${PORT}                            ║
║  Version: ${BUILD_INFO.version}
║  Built: ${BUILD_INFO.buildDate}
║  Node: ${BUILD_INFO.nodeVersion}
╚══════════════════════════════════════╝

✅ Server started
✅ Email configured
${driveClient ? '✅ Google Drive connected' : '⚠️  Google Drive offline'}
✅ Push notifications ready
${DISCORD_BOT_TOKEN ? '✅ Discord bot online' : '⚠️  Discord bot offline'}
✅ Auto-refresh system active
⚠️  NO AUTHENTICATION - Direct access enabled

📹 Video upload features:
   • 200MB file size limit
   • Detailed progress tracking
   • Automatic retry on failure
   • Email notifications with metrics
   • Comprehensive error logging

🔄 Auto-refresh features:
   • Version checking every 30s
   • Automatic client refresh on new deploy
   • Build info tracking

🌐 Ready at: http://localhost:${PORT}

📍 Routes configured:
   GET  /                → menu.html
   GET  /video          → video.html
   GET  /success        → success.html
   GET  /alerts         → alerts.html
   GET  /report?mode=   → accident/issue/insurance
   GET  /version        → Build info (auto-refresh)
   POST /log-gate-check
   POST /log-arrival-check
   POST /submit-report
   POST /upload-to-google-drive (ENHANCED)
    `);
});

process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received - shutting down gracefully');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
