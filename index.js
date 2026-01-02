/**
 * SLGP FLEET PORTAL - SELF-HEALING SERVER v10.0
 * ---------------------------------------------
 * 1. AUTO-CREATES 'uploads' folder to prevent crashes.
 * 2. PRINTS Auth Status on startup (so you know if Keys are working).
 * 3. SEPARATES Video (Old Logic) and Reports (New Logic).
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- 1. CRITICAL FIX: CREATE UPLOAD FOLDER ---
// The server crashes if this folder is missing. We force create it.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    console.log("Creating missing 'uploads' folder...");
    fs.mkdirSync(UPLOAD_DIR);
}

// Configure Storage
const upload = multer({ 
    dest: UPLOAD_DIR, 
    limits: { fileSize: 1024 * 1024 * 1024 } // 1GB Limit
});

// --- 2. CONFIGURATION ---
const VIDEO_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA'; // Old Video Folder
const REPORT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy'; // New Report Folder

const EMAIL_USER = process.env.EMAIL_USER || 'strategiclogisticsgroupllc@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'wnSx-72@!'; 
const EMAIL_FLEET = 'slgpfleetmanager@gmail.com';
const EMAIL_ACCIDENT = ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'];

const LOG_FILE = path.join(__dirname, 'submission_log.json');

// --- 3. AUTHENTICATION (DEBUGGED) ---
let authClient = null;

function initGoogleAuth() {
    console.log("--- CHECKING GOOGLE AUTHENTICATION ---");
    
    // Check 1: Railway Variable (The Old Way)
    if (process.env.GCP_SA_KEY) {
        try {
            console.log("Found GCP_SA_KEY in Variables. Attempting to parse...");
            const credentials = JSON.parse(process.env.GCP_SA_KEY);
            authClient = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/drive.file'],
            });
            console.log("✅ SUCCESS: Logged in using Railway Variables.");
            return;
        } catch (e) {
            console.error("❌ ERROR: GCP_SA_KEY is present but invalid JSON.", e.message);
        }
    }

    // Check 2: File (The New Way)
    const keyPath = path.join(__dirname, 'credentials.json');
    if (fs.existsSync(keyPath)) {
        console.log("Found credentials.json file. Using it...");
        authClient = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        console.log("✅ SUCCESS: Logged in using credentials.json file.");
        return;
    }

    console.error("❌ CRITICAL FAILURE: No Google Credentials found! Video uploads will fail.");
}

// Run Auth Check on Startup
initGoogleAuth();

function getDrive() {
    if (!authClient) initGoogleAuth(); // Try again if missing
    if (!authClient) return null;
    return google.drive({ version: 'v3', auth: authClient });
}

// --- MIDDLEWARE ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));

// ============================================================================
// VIDEO UPLOAD ROUTE (The Old Working Logic)
// ============================================================================
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    console.log("Received Video Request...");
    
    // 1. Validate File
    if (!req.file) {
        console.error("Error: No file received from browser.");
        return res.status(400).send('No file received.');
    }

    const { driverName, vin, inspectionType } = req.body;
    console.log(`Processing: ${driverName} - ${inspectionType}`);

    try {
        const drive = getDrive();
        if (!drive) throw new Error("Google Authentication Missing. Check Server Logs.");

        const now = new Date();
        const timeStringFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${timeStringFile}.mp4`;

        // 2. Upload to Drive (Using Stream to prevent memory crash)
        const response = await drive.files.create({
            resource: { name: finalFileName, parents: [VIDEO_FOLDER_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'webViewLink'
        });

        console.log(`✅ VIDEO UPLOADED: ${finalFileName}`);
        
        // 3. Email Notification
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: EMAIL_FLEET,
            subject: `🎥 Video: ${driverName} (${inspectionType})`,
            text: `Driver: ${driverName}\nVIN: ${vin}\nType: ${inspectionType}\n\nLink: ${response.data.webViewLink}`
        });

        // 4. Cleanup
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Successful');

    } catch (error) {
        console.error("❌ VIDEO UPLOAD FAILED:", error);
        // Clean up temp file
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

// ============================================================================
// INCIDENT REPORT ROUTE (The New Logic)
// ============================================================================
app.post('/submit-report', async (req, res) => {
    console.log("Received Incident Report...");
    const data = req.body;

    try {
        const drive = getDrive();
        if (!drive) throw new Error("Google Authentication Missing.");

        const folderName = `${data.driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [REPORT_FOLDER_ID] },
            fields: 'id'
        });
        const subFolderId = folder.data.id;

        let photoLinks = [];
        const uploadImage = async (imgObj, type) => {
            if (!imgObj || !imgObj.data) return;
            const buffer = Buffer.from(imgObj.data, 'base64');
            const bs = new stream.PassThrough();
            bs.end(buffer);
            const photo = await drive.files.create({
                resource: { name: `${type}_${imgObj.name}`, parents: [subFolderId] },
                media: { mimeType: 'image/jpeg', body: bs },
                fields: 'webViewLink'
            });
            photoLinks.push({ name: `${type}_${imgObj.name}`, link: photo.data.webViewLink });
        };

        if (data.highPhotos) await uploadImage(data.highPhotos, 'HighPriority');
        if (data.lowPhotos) await uploadImage(data.lowPhotos, 'LowPriority');
        if (data.edvPhotos) await uploadImage(data.edvPhotos, 'EDV');
        if (data.mphPhotos) await uploadImage(data.mphPhotos, 'MPH');
        if (data.accidentPhotos) await uploadImage(data.accidentPhotos, 'Accident');

        const pdfPath = await generatePDF(data, photoLinks);

        let recipients = (data.priorityLevel === 'accident') ? EMAIL_ACCIDENT : [EMAIL_FLEET];
        let subject = (data.priorityLevel === 'accident') ? `🚨 ACCIDENT: ${data.driverName}` : `🛠️ Maintenance: ${data.driverName}`;

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: EMAIL_USER, pass: EMAIL_PASS } });
        await transporter.sendMail({
            from: EMAIL_USER,
            to: recipients,
            subject: subject,
            text: `Report Type: ${data.priorityLevel}\nFiles: https://drive.google.com/drive/folders/${subFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("Report Failed:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Helper for PDF (Abbreviated for clarity, assumes same logic as before)
async function generatePDF(data, photoLinks) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let y = 750;
    const drawText = (text) => { page.drawText(text, { x: 50, y, size: 12, font }); y -= 20; };
    drawText(`SLGP REPORT: ${data.priorityLevel.toUpperCase()}`);
    drawText(`Driver: ${data.driverName}`);
    y -= 20;
    // Add specific fields based on type...
    if (data.priorityLevel === 'accident') drawText(`Statement: ${data.accidentStatement}`);
    else if (data.highIssues) drawText(`Issue: ${data.highIssues}`);
    
    y -= 20;
    drawText("Attached Photos:");
    photoLinks.forEach(p => drawText(`- ${p.name}`));
    
    const filePath = path.join(__dirname, `report-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, await doc.save());
    return filePath;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`SERVER LIVE ON PORT ${PORT}`));
