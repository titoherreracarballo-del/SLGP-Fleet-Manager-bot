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

// --- VAPID KEYS (SAFE LOADING WITH SCRUBBER) ---
let publicVapidKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim().replace(/['"]+/g, '') : null;
let privateVapidKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim().replace(/['"]+/g, '') : null;

if (!publicVapidKey || !privateVapidKey) {
    console.log("⚠️ Keys Missing or Invalid. Generating FRESH Keys...");
    const vapidKeys = webpush.generateVAPIDKeys();
    publicVapidKey = vapidKeys.publicKey;
    privateVapidKey = vapidKeys.privateKey;
    console.log("VAPID_PUBLIC_KEY:", publicVapidKey);
    console.log("VAPID_PRIVATE_KEY:", privateVapidKey);
} else {
    console.log("✅ VAPID Keys Loaded & Cleaned Successfully.");
}

webpush.setVapidDetails(
    'mailto:slgpfleetmanager@gmail.com',
    publicVapidKey,
    privateVapidKey
);

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN).catch(err => console.log("Discord Login Fail:", err));
    
    client.once(Events.ClientReady, c => {
        console.log(`🤖 Fleet Bot is Ready! Logged in as ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot || message.channelId !== DISCORD_CHANNEL_ID) return;

        console.log(`Received Discord Alert: ${message.content}`);

        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            let subs = [];
            try {
                subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE));
            } catch (e) {
                console.error("Error reading subscriptions file", e);
            }

            const payload = JSON.stringify({ 
                title: "📢 FLEET ALERT", 
                body: message.content 
            });

            const activeSubs = [];
            let changed = false;

            const pushPromises = subs.map(async (sub) => {
                try {
                    await webpush.sendNotification(sub, payload);
                    activeSubs.push(sub); 
                } catch (error) {
                    changed = true; 
                    if (error.statusCode === 410 || error.statusCode === 404) {
                        console.warn("🧹 Scrubbing expired subscription.");
                    } else if (error.statusCode === 403) {
                        console.error("🚨 Scrubbing VAPID Mismatch (User needs to re-subscribe).");
                    } else {
                        console.error("❌ Unexpected Push Error:", error.message);
                        activeSubs.push(sub);
                    }
                }
            });

            await Promise.all(pushPromises);

            if (changed) {
                fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(activeSubs));
                console.log(`✅ Subscription list cleaned. ${activeSubs.length} active users remaining.`);
            }
            
            message.react('✅');
        } else {
            message.reply("No subscribers found yet!");
        }
    });
}

if (!fs.existsSync(UPLOAD_DIR)) {
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } 
    catch (e) { console.log("Using /tmp for uploads"); }
}
const upload = multer({ dest: UPLOAD_DIR });

app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.post('/log-gate-check', (req, res) => {
    const { name } = req.body;
    let logs = [];
    if (fs.existsSync(GATE_LOG_FILE)) {
        try { logs = JSON.parse(fs.readFileSync(GATE_LOG_FILE)); } catch(e) {}
    }
    logs.push({ name: name, timestamp: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) });
    fs.writeFileSync(GATE_LOG_FILE, JSON.stringify(logs, null, 2));
    res.json({ success: true });
});

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
    let subs = [];
    if (fs.existsSync(SUBSCRIPTION_FILE)) {
        try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)); } catch(e) {}
    }
    subs.push(subscription);
    const unique = subs.filter((v,i,a)=>a.findIndex(t=>(t.endpoint === v.endpoint))===i);
    fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(unique));
    res.status(201).json({});
});

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

app.post('/submit-report', async (req, res) => {
    const data = req.body;
    logReportLocally(data);

    if (client.isReady()) {
        try {
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            const title = data.reportType.includes('Accident') ? "🚨 **ACCIDENT REPORT**" : "⚠️ **ISSUE REPORT**";
            if (channel) channel.send(`${title}\n**Driver:** ${data.driverName}\n**VIN:** ${data.vinLast4}\n**Desc:** ${data.otherDescription || 'None'}`);
        } catch(e) { console.log("Discord Send Error", e); }
    }

    try {
        const auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });
        let targetFolderId = data.reportType.includes('Accident') ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;

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

    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

cron.schedule('30 23 * * *', async () => {
    try {
        let gateSummary = "\n--- DEPARTURE CHECKLIST LOGS ---\n";
        if (fs.existsSync(GATE_LOG_FILE)) {
            const gateLogs = JSON.parse(fs.readFileSync(GATE_LOG_FILE));
            gateLogs.forEach(log => gateSummary += `${log.timestamp}: ${log.name} confirmed all requirements.\n`);
            fs.writeFileSync(GATE_LOG_FILE, JSON.stringify([])); 
        }

        if (!fs.existsSync(DAILY_LOG_FILE)) return;
        const rawData = fs.readFileSync(DAILY_LOG_FILE);
        const allLogs = JSON.parse(rawData);
        if (allLogs.length === 0 && gateSummary.length < 40) return;

        if (client.isReady()) {
            const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
            if (channel) channel.send(`📋 **DAILY SUMMARY:** ${allLogs.length} reports submitted today.`);
        }

        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        page.drawRectangle({ x: 0, y: 720, width: 600, height: 80, color: rgb(0.1, 0.1, 0.1) });
        page.drawText('DAILY FLEET SUMMARY', { x: 30, y: 765, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`DATE: ${new Date().toLocaleDateString()}`, { x: 30, y: 745, size: 14, font: fontReg, color: rgb(0.9, 0.9, 0.9) });

        let y = 680;
        allLogs.forEach((log, index) => {
            if (y < 150) { page = doc.addPage([600, 800]); y = 750; }
            page.drawRectangle({ x: 30, y: y, width: 540, height: 25, color: rgb(0.9, 0.9, 0.9) });
            page.drawText(`REPORT #${index + 1} - ${log.reportType.toUpperCase()}`, { x: 40, y: y+8, size: 12, font: fontBold, color: rgb(0,0,0) });
            y -= 25;
            page.drawText(`DRIVER: ${log.driverName}    |    VIN: ${log.vinLast4}    |    TIME: ${log.time}`, { x: 30, y: y-15, size: 11, font: fontBold, color: rgb(0,0,0) });
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
            text: `Daily Summary Attached.\nTotal Reports: ${allLogs.length}\n${gateSummary}`,
            attachments: [{ filename: 'Daily_Summary.pdf', path: summaryPath }]
        });

        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
        fs.unlinkSync(summaryPath);
    } catch (e) { console.error("Cron Error:", e); }
}, { timezone: "America/New_York" });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
