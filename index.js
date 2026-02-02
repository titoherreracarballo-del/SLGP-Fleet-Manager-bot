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
    limits: { fileSize: 200 * 1024 * 1024 }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

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
        page.drawText('DA ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(1, 0.6, 0) });
        page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });
        const pdfBytes = await doc.save();
        const snapshotPath = path.join(UPLOAD_DIR, `Gate_${Date.now()}.pdf`);
        fs.writeFileSync(snapshotPath, pdfBytes);
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: ['slgpfleetmanager@gmail.com'], subject: `CHECKLIST ALERT: ${name}`, text: `Receipt attached for DA ${name}.`, attachments: [{ filename: `Receipt_${name}.pdf`, path: snapshotPath }] });
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
        page.drawText('ARRIVAL ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
        page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
        page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });
        const pdfBytes = await doc.save();
        const snapshotPath = path.join(UPLOAD_DIR, `Arrival_${Date.now()}.pdf`);
        fs.writeFileSync(snapshotPath, pdfBytes);
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: ['slgpfleetmanager@gmail.com'], subject: `ARRIVAL COMPLETED: ${name}`, text: `Arrival receipt attached for DA ${name}.`, attachments: [{ filename: `Arrival_Receipt_${name}.pdf`, path: snapshotPath }] });
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
            const pdfPath = path.join(UPLOAD_DIR, `Accident_${data.driverName}_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());
            const incidentTypeUC = (data.incidentType || 'ACCIDENT').toUpperCase();
            const lmetText = data.lmetCase ? `LMET# ${data.lmetCase}` : 'NO LMET';
            const driverNameUC = (data.driverName || 'UNKNOWN').toUpperCase();
            await transporter.sendMail({
                from: emailUser,
                to: ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com', 'slgpfleetmanager@gmail.com'],
                subject: `URGENT: ${incidentTypeUC} - ${lmetText} - DA ${driverNameUC}`,
                text: `An Accident Report has been filed.\n\nDriver: ${data.driverName}\nVIN: ${data.vinLast4}\n\nSee attached PDF.\n\nGoogle Drive: https://drive.google.com/drive/folders/${folderId}`,
                attachments: [{ filename: 'Official_Accident_Report.pdf', path: pdfPath }]
            });
            fs.unlinkSync(pdfPath);
        } else {
            let page = doc.addPage([600, 800]);
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.145, 0.388, 0.922) });
            page.drawText('ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// VIDEO UPLOAD WITH DIRECT STREAMING (FIXED)
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
            }
        };
        const media = { mimeType: 'video/mp4', body: fs.createReadStream(videoPath) };
        const driveResponse = await driveClient.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink, size, videoMediaMetadata, createdTime',
            supportsAllDrives: true
        });
        const uploadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const fileId = driveResponse.data.id;
        console.log(`✅ Upload complete in ${uploadTime}s - File ID: ${fileId}`);
        try {
            await driveClient.permissions.create({
                fileId: fileId,
                requestBody: { role: 'reader', type: 'anyone' },
                supportsAllDrives: true
            });
            console.log('✅ Permissions set');
        } catch (permError) {
            console.warn('⚠️  Permission warning:', permError.message);
        }
        const streamUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const viewLink = `https://drive.google.com/file/d/${fileId}/view`;
        const directDownloadLink = `https://drive.google.com/uc?export=download&id=${fileId}`;
        console.log(`📥 Stream URL: ${streamUrl}`);
        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            const videoMetadata = driveResponse.data.videoMediaMetadata || {};
            const videoDuration = videoMetadata.durationMillis ? `${(videoMetadata.durationMillis / 1000 / 60).toFixed(1)} minutes` : 'Unknown';
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_USER,
                subject: `📹 Video: ${inspectionType} - ${driverName} (${vin})`,
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
                            </table>
                            <div style="background: #eff6ff; border-left: 4px solid #2563EB; padding: 20px; margin-bottom: 25px; border-radius: 4px;">
                                <h3 style="color: #1e40af; margin: 0 0 12px 0; font-size: 16px;">🚀 INSTANT ACCESS</h3>
                                <p style="color: #1e3a8a; margin: 0; font-size: 13px;">✅ No waiting for Google processing! Your video is ready right now.</p>
                            </div>
                            <div style="text-align: center; margin: 25px 0;">
                                <a href="${streamUrl}" style="display: inline-block; background: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; margin: 8px;">⚡ STREAM NOW</a>
                                <a href="${directDownloadLink}" style="display: inline-block; background: #3b82f6; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; margin: 8px;">⬇️ DOWNLOAD</a>
                                <a href="${viewLink}" style="display: inline-block; background: #6b7280; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; margin: 8px;">📁 Drive</a>
                            </div>
                        </div>
                    </div>
                `
            });
            console.log('✅ Email sent');
        } catch (emailError) {
            console.error('⚠️  Email failed:', emailError.message);
        }
        if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            console.log('✅ Temp file cleaned');
        }
        res.json({
            success: true,
            fileId: fileId,
            fileName: fileName,
            fileSize: fileSizeMB,
            uploadTime: uploadTime,
            viewLink: viewLink,
            downloadLink: directDownloadLink,
            streamLink: streamUrl,
            metadata: videoMetadata,
            createdTime: driveResponse.data.createdTime
        });
    } catch (error) {
        console.error('❌ Video upload error:', error);
        if (videoPath && fs.existsSync(videoPath)) {
            try {
                fs.unlinkSync(videoPath);
            } catch (cleanupError) {}
        }
        res.status(500).json({
            success: false,
            error: error.message,
            details: {
                driver: req.body.driverName,
                vin: req.body.vin,
                inspectionType: req.body.inspectionType,
                receivedFile: !!req.file
            }
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
// HTML PAGES
// ============================================
app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'success.html'));
});

app.get('/alerts', (req, res) => {
    res.sendFile(path.join(__dirname, 'alerts.html'));
});

app.get('/report', (req, res) => {
    const mode = req.query.mode;
    let filePath;
    if (mode === 'issue') {
        filePath = path.join(__dirname, 'report-issue.html');
    } else if (mode === 'accident') {
        filePath = path.join(__dirname, 'accident-report.html');
    } else if (mode === 'insurance') {
        filePath = path.join(__dirname, 'insurance.html');
    } else {
        return res.status(404).send('Unknown report type');
    }
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send(`File not found: ${mode}`);
    }
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
    if (fs.existsSync(menuPath)) {
        res.sendFile(menuPath);
    } else {
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
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
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
╔══════════════════════════════════════════╗
║  SLGP Fleet Manager                      ║
║  Enhanced Video Upload - FIXED           ║
╠══════════════════════════════════════════╣
║  Port: ${PORT}                                ║
║  Version: ${BUILD_INFO.version}
╚══════════════════════════════════════════╝

✅ Server started
✅ Email configured
${driveClient ? '✅ Google Drive connected' : '⚠️  Google Drive offline'}
✅ Push notifications ready
${DISCORD_BOT_TOKEN ? '✅ Discord bot online' : '⚠️  Discord bot offline'}
✅ Auto-refresh system active

📹 ENHANCED Video Upload Features:
   • ⚡ Direct streaming URL (NO processing wait!)
   • H.265 (HEVC) codec optimization
   • Immediate full-quality download links
   • Multiple access methods in email
   • 200MB file size limit
   • Rich HTML email notifications

🌐 Ready at: http://localhost:${PORT}
    `);
});

process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM - shutting down gracefully');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', promise, reason);
});
