const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const stream = require('stream');

const app = express();

// INCREASE LIMIT: Allows large photo reports (50MB)
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const upload = multer({ dest: 'uploads/' });

// --- CONFIGURATION ---
const VIDEO_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
const REPORT_FOLDER_ID = '1_x9yb_L78PrbCMqKUE4JVaF5auY4ZsmK'; 
const LOG_FILE = '/app/meshcentral-data/submission_log.json';

// --- EMAIL CREDENTIALS ---
const EMAIL_USER = process.env.FLEET_EMAIL_USER || 'slgpfleetmanager@gmail.com';
const EMAIL_PASS = process.env.Report_Email_Pass; // Looks for your specific variable
const EMAIL_MAIN = 'slgpfleetmanager@gmail.com';
const EMAIL_ACCIDENT = 'strategiclogisticsgroupllc@gmail.com';

// --- GOOGLE AUTHENTICATION ---
let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY parsing failed.");
}

// --- HELPER: SEND EMAIL ---
async function sendEmail(recipients, subject, htmlBody, attachments = []) {
    if (!EMAIL_PASS) { console.error("EMAIL ERROR: Missing Password."); return; }
    
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });

    try {
        await transporter.sendMail({
            from: `"SLGP Fleet Bot" <${EMAIL_USER}>`,
            to: recipients,
            subject: subject,
            html: htmlBody,
            attachments: attachments
        });
        console.log(`EMAIL SENT to: ${recipients}`);
    } catch (error) {
        console.error("EMAIL FAILED:", error);
    }
}

// --- PAGE ROUTING ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'menu.html')); });
app.get('/video', (req, res) => { res.sendFile(path.join(__dirname, 'video.html')); });
app.get('/report', (req, res) => { res.sendFile(path.join(__dirname, 'report.html')); });

// --- API: HANDLE VIDEO UPLOAD ---
app.post('/upload-video', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file.');
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        const now = new Date();
        const timeFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const finalName = `${driverName}_${vin}_${inspectionType}_${timeFile}.mp4`;

        await drive.files.create({
            resource: { name: finalName, parents: [VIDEO_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', supportsAllDrives: true, supportsTeamDrives: true
        });

        // Log it
        const logEntry = { 
            date: now.toISOString().split('T')[0], 
            time: now.toLocaleTimeString('en-US', { timeZone: 'America/New_York' }), 
            driverName, vin, inspectionType, fileName: finalName 
        };
        let logs = [];
        try { if(fs.existsSync(LOG_FILE)) logs = JSON.parse(fs.readFileSync(LOG_FILE)); } catch(e){}
        logs.push(logEntry);
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("VIDEO UPLOAD ERROR:", error.message);
        res.status(500).send(error.message);
    }
});

// --- API: HANDLE REPORT SUBMISSION ---
app.post('/submit-report', async (req, res) => {
    try {
        const data = req.body;
        const drive = google.drive({ version: 'v3', auth });
        console.log(`PROCESSING REPORT: ${data.priorityLevel} by ${data.driverName}`);

        // 1. Create Sub-Folder
        const folderName = `${new Date().toISOString().split('T')[0]} - ${data.driverName}`;
        const folderRes = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_FOLDER_ID] },
            fields: 'id', supportsAllDrives: true, supportsTeamDrives: true
        });
        const folderId = folderRes.data.id;

        // 2. Build Email & Upload Photos
        let emailHtml = `<h2>SLGP Report: ${data.priorityLevel.toUpperCase()}</h2>
                         <p><b>Driver:</b> ${data.driverName}<br><b>VIN:</b> ${data.vinLast4}<br>
                         <b>Date:</b> ${data.signatureTimestamp}</p><hr>`;

        const processImages = async (list, title) => {
            if (!list || list.length === 0) return;
            emailHtml += `<h3>${title} Photos</h3>`;
            for (const img of list) {
                const buf = Buffer.from(img.data, 'base64');
                const bs = new stream.PassThrough(); bs.end(buf);
                const fileRes = await drive.files.create({
                    resource: { name: img.name, parents: [folderId] },
                    media: { mimeType: 'image/jpeg', body: bs },
                    fields: 'webViewLink', supportsAllDrives: true, supportsTeamDrives: true
                });
                emailHtml += `<p><a href="${fileRes.data.webViewLink}">View ${img.name}</a></p>`;
            }
        };

        if (data.priorityLevel === 'high') {
            emailHtml += `<p style="color:red; font-weight:bold;">HIGH PRIORITY</p><p>Issues: ${data.highIssues.join(', ')}</p><p>Notes: ${data.highNotes}</p>`;
            await processImages(data.highPhotos, "High Priority");
        }
        if (data.priorityLevel === 'low') {
            emailHtml += `<p>Low Priority</p><p>Issues: ${data.lowIssues.join(', ')}</p><p>Notes: ${data.lowNotes}</p>`;
            await processImages(data.lowPhotos, "Low Priority");
        }
        if (data.priorityLevel === 'edv') {
            emailHtml += `<p>EDV Issue</p><p>Issues: ${data.edvIssues.join(', ')}</p><p>Notes: ${data.edvNotes}</p>`;
            await processImages(data.edvPhotos, "EDV");
        }
        if (data.priorityLevel === 'mph') {
            emailHtml += `<p>MPH Error</p><p>Loc: ${data.mphRoadName}, ${data.mphCity}</p>`;
            await processImages(data.mphPhotos, "MPH Sign");
        }
        if (data.priorityLevel === 'accident') {
            emailHtml += `<p style="color:red; font-weight:bold;">ACCIDENT / INCIDENT</p>
                          <p>Type: ${data.accidentType}</p><p>Statement: ${data.accidentStatement}</p>
                          <p>Police #: ${data.policeReportNumber}</p>
                          <p>GPS: <a href="http://maps.google.com/maps?q=${data.gpsLat},${data.gpsLng}">Open Map</a></p>`;
            await processImages(data.accidentPhotos, "Accident");
        }

        // 3. Signature
        if (data.affidavitSignature) {
            const buf = Buffer.from(data.affidavitSignature, 'base64');
            const bs = new stream.PassThrough(); bs.end(buf);
            const sigRes = await drive.files.create({
                resource: { name: 'signature.png', parents: [folderId] },
                media: { mimeType: 'image/png', body: bs },
                fields: 'webViewLink', supportsAllDrives: true, supportsTeamDrives: true
            });
            emailHtml += `<hr><p>Signed:</p><img src="${sigRes.data.webViewLink}" width="200">`;
        }

        // 4. Send Email
        let recipients = [EMAIL_MAIN];
        if (data.priorityLevel === 'accident') recipients.push(EMAIL_ACCIDENT);
        
        await sendEmail(recipients, `SLGP Report: ${data.priorityLevel.toUpperCase()} - ${data.driverName}`, emailHtml);
        res.json({ success: true });

    } catch (error) {
        console.error("REPORT ERROR:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => { console.log(`SLGP SERVER v5.0 LIVE ON PORT: ${PORT}`); });
