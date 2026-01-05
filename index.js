const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- 1. AUTO-REFRESH SYSTEM ---
const APP_VERSION = Date.now();

app.get('/version', (req, res) => {
    res.json({ version: APP_VERSION });
});

// --- CONFIGURATION ---
const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR = path.join(VOLUME_PATH, 'uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.log("Warning: Could not create upload directory. Using /tmp instead.");
    }
}
const upload = multer({ dest: UPLOAD_DIR });

// --- MIDDLEWARE ---
app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES ---

// Home Menu
app.get('/', (req, res) => {
    if (fs.existsSync(path.join(__dirname, 'menu.html'))) {
        res.sendFile(path.join(__dirname, 'menu.html'));
    } else {
        res.sendFile(path.join(__dirname, 'index.html'));
    }
});

// Video Page
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));

// Report Routing
app.get('/report', (req, res) => {
    const mode = req.query.mode;
    
    if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    } 
    else if (mode === 'accident') {
        res.sendFile(path.join(__dirname, 'accident - report.html'));
    } 
    else if (mode === 'insurance') {
        res.sendFile(path.join(__dirname, 'insurance.html'));
    } 
    else {
        res.status(404).send('Error: Unknown report type.');
    }
});

// --- GOOGLE AUTH ---
let auth;
try {
    if (process.env.GCP_SA_KEY) {
        auth = new google.auth.GoogleAuth({
            credentials: JSON.parse(process.env.GCP_SA_KEY),
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
    }
} catch (err) { console.error("Auth Error:", err.message); }

// --- VIDEO UPLOAD ENGINE (LOCKED) ---
const VIDEO_DRIVE_ID = '0AC1GE3XEm4K9Uk9PVA'; 

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video file.');
        
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        const filename = `${driverName}_${vin}_${inspectionType}_${Date.now()}.mp4`;
        
        await drive.files.create({
            resource: { name: filename, parents: [VIDEO_DRIVE_ID] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(req.file.path) },
            fields: 'id', 
            supportsAllDrives: true
        });
        
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(200).send('Upload Complete');
    } catch (error) { 
        res.status(500).send(`Error: ${error.message}`); 
    }
});

// --- REPORT SUBMISSION ENGINE ---

const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA'; 

app.post('/submit-report', async (req, res) => {
    const data = req.body;
    try {
        // 1. Google Drive Upload Logic
        const drive = google.drive({ version: 'v3', auth });
        
        let targetFolderId = ACCIDENT_DRIVE_ID; 
        if (data.reportType && data.reportType.toLowerCase().includes('issue')) {
            targetFolderId = ISSUE_DRIVE_ID;
        }

        const folderName = `${data.driverName} - ${data.reportType}`;
        const folder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] },
            fields: 'id', supportsAllDrives: true
        });
        const folderId = folder.data.id;

        const photoBuffers = [];
        if (data.photos && data.photos.length) {
            for (let i = 0; i < data.photos.length; i++) {
                const buffer = Buffer.from(data.photos[i].data, 'base64');
                photoBuffers.push(buffer); 
                
                const bs = new stream.PassThrough(); 
                bs.end(buffer);
                await drive.files.create({
                    resource: { name: `Photo_${i+1}.jpg`, parents: [folderId] },
                    media: { mimeType: 'image/jpeg', body: bs },
                    supportsAllDrives: true
                });
            }
        }

        // 2. Generate PDF
        const doc = await PDFDocument.create();
        let page = doc.addPage([600, 800]);
        const font = await doc.embedFont(StandardFonts.HelveticaBold);
        const textFont = await doc.embedFont(StandardFonts.Helvetica);
        
        page.drawRectangle({ x: 0, y: 740, width: 600, height: 60, color: rgb(0.1, 0.3, 0.7) });
        page.drawText('SLGP FLEET REPORT', { x: 20, y: 760, size: 24, font: font, color: rgb(1,1,1) });

        let y = 700;

        const checkPage = () => {
            if (y < 50) { page = doc.addPage([600, 800]); y = 750; }
        };

        const drawLabel = (label, value) => {
            checkPage();
            page.drawText(label, { x: 50, y, size: 10, font: font, color: rgb(0.5,0.5,0.5) });
            y -= 15;
            page.drawText(value || 'N/A', { x: 50, y, size: 14, font: textFont, color: rgb(0,0,0) });
            y -= 30;
        };

        drawLabel('REPORT TYPE', data.reportType);
        drawLabel('DRIVER NAME', data.driverName);
        drawLabel('DATE', new Date().toLocaleString());

        if (data.reportType === 'Accident / Incident') {
             drawLabel('INCIDENT TYPE', data.subType);
             drawLabel('STATEMENT', data.statement);
        } else {
             if (data.tags) drawLabel('TAGS', data.tags.join(', '));
             drawLabel('DESCRIPTION', data.otherDescription);
        }

        if (photoBuffers.length > 0) {
            checkPage();
            y -= 20;
            page.drawText('ATTACHED PHOTOS:', { x: 50, y, size: 12, font: font, color: rgb(0,0,0) });
            y -= 20;

            for (const buffer of photoBuffers) {
                try {
                    const img = await doc.embedJpg(buffer);
                    const imgDims = img.scale(0.5);
                    
                    if (y - imgDims.height < 50) { 
                        page = doc.addPage([600, 800]); 
                        y = 750; 
                    }
                    
                    page.drawImage(img, {
                        x: 50, y: y - imgDims.height,
                        width: imgDims.width, height: imgDims.height,
                    });
                    y -= (imgDims.height + 20);
                } catch (e) {
                    console.log("Photo embed skipped (format error)");
                }
            }
        }

        const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());

        // --- 3. EMAIL ROUTING (UPDATED TO USE RAILWAY VARIABLES) ---
        
        // This connects using the variables you set in Railway
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { 
                user: process.env.EMAIL_USER, // Will read 'slgpfleetmanager@gmail.com'
                pass: process.env.EMAIL_PASS  // Will read your 16-char App Password
            }
        });

        // Determine who gets the email
        const recipients = data.reportType.includes('Accident') 
            ? ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com']
            : ['slgpfleetmanager@gmail.com'];

        await transporter.sendMail({
            from: process.env.EMAIL_USER, // Send from the authenticated account
            to: recipients,
            subject: `REPORT: ${data.driverName} - ${data.reportType}`,
            text: `A new report has been submitted.\n\nType: ${data.reportType}\nDriver: ${data.driverName}\n\nSee PDF attached.\n\nFiles: https://drive.google.com/drive/folders/${folderId}`,
            attachments: [{ filename: 'Report_Snapshot.pdf', path: pdfPath }]
        });

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server Running on Port ${PORT}`));
