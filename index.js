/**
 * SLGP FLEET PORTAL - MASTER SERVER v7.3 (STABILITY FIX)
 * ------------------------------------------------------
 * 1. Fixed "Upload Failed" by using /tmp/ storage (Railway Standard).
 * 2. Added detailed error logging to find the exact cause.
 * 3. Keeps all Incident/Maintenance/Video routing intact.
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const stream = require('stream');

const app = express();

// --- CONFIGURATION ---
const PARENT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy'; 
const EMAIL_USER = 'strategiclogisticsgroupllc@gmail.com'; 
const EMAIL_PASS = 'wnSx-72@!'; // REPLACE WITH YOUR REAL APP PASSWORD
const KEY_FILE_PATH = path.join(__dirname, 'credentials.json');

// Email Routing
const MAIL_FLEET_MGR = ['slgpfleetmanager@gmail.com'];
const MAIL_ACCIDENT = ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'];

// --- UPLOAD SETTINGS (FIXED) ---
// We use '/tmp/' because Cloud Servers (Railway) allow writing there reliably.
const upload = multer({ 
    dest: '/tmp/', 
    limits: { 
        fileSize: 1024 * 1024 * 1024, // 1 GB limit
        fieldSize: 50 * 1024 * 1024   // 50 MB for text fields
    }
});

// --- MIDDLEWARE ---
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));

// =========================================================
// 1. VIDEO SUBMISSION (DEBUG MODE)
// =========================================================
app.post('/submit-video', upload.any(), async (req, res) => {
    console.log("Received Video Submission Request...");

    // 1. Check if Credentials Exist
    if (!fs.existsSync(KEY_FILE_PATH)) {
        console.error("CRITICAL ERROR: credentials.json is missing!");
        return res.status(500).json({ success: false, error: "Server Error: Credentials file missing." });
    }
    
    // 2. Find the video file
    const file = req.files && req.files.length > 0 ? req.files[0] : null;
    const { driverName, vanNumber, checkType, mileage } = req.body;

    if (!file) {
        console.error("Error: No file received. Check HTML form enctype.");
        return res.status(400).json({ success: false, error: "No video file found. Make sure your form has enctype='multipart/form-data'." });
    }

    try {
        console.log(`Processing File: ${file.originalname} | Size: ${file.size} bytes`);

        // 3. Auth Drive
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_FILE_PATH,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        // 4. Create Folder
        const folderName = `VIDEO - ${driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const folderReq = await drive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [PARENT_FOLDER_ID]
            },
            fields: 'id'
        });
        const folderId = folderReq.data.id;
        console.log(`Folder Created: ${folderName} (${folderId})`);

        // 5. Upload Video to Drive
        const fileMetadata = {
            name: `${checkType}_${vanNumber}_${driverName}.mp4`,
            parents: [folderId]
        };
        const media = {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path)
        };

        const videoUpload = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'webViewLink'
        });
        console.log("Video Uploaded to Drive Successfully.");

        // 6. Send Email
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        const mailOptions = {
            from: EMAIL_USER,
            to: MAIL_FLEET_MGR,
            subject: `🎥 Video Check: ${driverName} (Van ${vanNumber})`,
            text: `A new ${checkType} video check has been uploaded.\n\nDriver: ${driverName}\nVan: ${vanNumber}\nMileage: ${mileage}\n\nWatch Video: ${videoUpload.data.webViewLink}\nFolder: https://drive.google.com/drive/folders/${folderId}`
        };

        await transporter.sendMail(mailOptions);
        console.log("Email Notification Sent.");

        // Cleanup
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.json({ success: true });

    } catch (error) {
        console.error("VIDEO UPLOAD ERROR:", error);
        // Clean up temp file
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// 2. REPORT SUBMISSION (MAINTENANCE & ACCIDENTS)
// =========================================================
app.post('/submit-report', async (req, res) => {
    console.log("Received Report Submission...");
    const data = req.body;

    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_FILE_PATH,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        const folderName = `${data.driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const folderReq = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [PARENT_FOLDER_ID] },
            fields: 'id'
        });
        const reportFolderId = folderReq.data.id;

        let photoLinks = [];
        const uploadImage = async (imgObj, type) => {
            if (!imgObj || !imgObj.data) return;
            const buffer = Buffer.from(imgObj.data, 'base64');
            const bs = new stream.PassThrough();
            bs.end(buffer);

            const photoFile = await drive.files.create({
                resource: { name: `${type}_${imgObj.name}`, parents: [reportFolderId] },
                media: { mimeType: 'image/jpeg', body: bs },
                fields: 'webViewLink'
            });
            photoLinks.push({ name: `${type}_${imgObj.name}`, link: photoFile.data.webViewLink });
        };

        if (data.highPhotos) await uploadImage(data.highPhotos, 'HighPriority');
        if (data.lowPhotos) await uploadImage(data.lowPhotos, 'LowPriority');
        if (data.edvPhotos) await uploadImage(data.edvPhotos, 'EDV');
        if (data.mphPhotos) await uploadImage(data.mphPhotos, 'MPH');
        if (data.accidentPhotos) await uploadImage(data.accidentPhotos, 'Accident');

        const pdfPath = await generatePDF(data, photoLinks);
        
        let targetRecipients = [];
        let subjectPrefix = "";

        if (data.priorityLevel === 'accident') {
            targetRecipients = MAIL_ACCIDENT;
            subjectPrefix = "🚨 URGENT: ACCIDENT REPORT";
        } else {
            targetRecipients = MAIL_FLEET_MGR;
            subjectPrefix = `🛠️ Maintenance: ${data.priorityLevel.toUpperCase()}`;
        }

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        const mailOptions = {
            from: EMAIL_USER,
            to: targetRecipients,
            subject: `${subjectPrefix} - ${data.driverName}`,
            text: `Report Submitted by ${data.driverName}.\nType: ${data.priorityLevel.toUpperCase()}\n\nView Photos & Files: https://drive.google.com/drive/folders/${reportFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
        console.log("Report Email Sent.");

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("Report System Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- HELPER: PDF GENERATOR ---
async function generatePDF(data, photoLinks) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    let y = 750;
    const drawText = (text, f = font, s = 12) => {
        page.drawText(text, { x: 50, y, size: s, font: f, color: rgb(0, 0, 0) });
        y -= 20;
    };

    drawText("SLGP REPORT", bold, 18);
    y -= 10;
    drawText(`Date: ${new Date().toLocaleString()}`);
    drawText(`Driver: ${data.driverName}`);
    if (data.vinLast4) drawText(`VIN (Last 4): ${data.vinLast4}`);
    y -= 20;

    drawText(`Report Type: ${data.priorityLevel.toUpperCase()}`, bold, 14);
    y -= 10;

    if (data.priorityLevel === 'high') {
        drawText(`Issue: ${data.highIssues}`);
        if(data.highNotes) drawText(`Notes: ${data.highNotes}`);
    } else if (data.priorityLevel === 'low') {
        drawText(`Issue: ${data.lowIssues}`);
        if(data.lowNotes) drawText(`Notes: ${data.lowNotes}`);
    } else if (data.priorityLevel === 'edv') {
        drawText(`Issue: ${data.edvIssues}`);
        if(data.edvNotes) drawText(`Notes: ${data.edvNotes}`);
    } else if (data.priorityLevel === 'mph') {
        drawText(`Street: ${data.mphRoadName}`);
        drawText(`Location: ${data.mphCity}, ${data.mphState}`);
        if(data.gpsLat) drawText(`GPS: ${data.gpsLat}, ${data.gpsLng}`);
    } else if (data.priorityLevel === 'accident') {
        drawText(`Statement: ${data.accidentStatement}`);
        drawText(`Police #: ${data.policeReportNumber}`);
        drawText(`Case #: ${data.lmetCaseNumber}`);
        if(data.gpsLat) drawText(`GPS: ${data.gpsLat}, ${data.gpsLng}`);
        
        if (data.affidavitSignature) {
            y -= 40;
            const sigImage = await doc.embedPng(Buffer.from(data.affidavitSignature, 'base64'));
            const sigDims = sigImage.scale(0.5);
            page.drawImage(sigImage, { x: 50, y: y - sigDims.height, width: sigDims.width, height: sigDims.height });
            drawText("Signed Affidavit", bold, 10);
            y -= 100;
        }
    }

    y -= 20;
    drawText("Attached Photos:", bold, 14);
    photoLinks.forEach(p => {
        drawText(`- ${p.name}`);
    });

    const pdfBytes = await doc.save();
    const filePath = path.join(__dirname, `report-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, pdfBytes);
    return filePath;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
