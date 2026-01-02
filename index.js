/**
 * SLGP FLEET PORTAL - MASTER SERVER v7.1
 * --------------------------------------
 * 1. Video Uploads -> Fleet Manager
 * 2. Maintenance Reports -> Fleet Manager
 * 3. Accident Reports -> Incident Reporting + Strategic Logistics
 * 4. PDF Generation (Full Detail)
 * 5. Google Drive Integration
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

// Configure Multer: 'memory' for photos, 'disk' for large videos
const upload = multer({ 
    dest: 'uploads/',
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB Limit
});

// =========================================================
// 1. CONFIGURATION
// =========================================================

// Google Drive Folder ID
const PARENT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy'; 

// Email Settings (Sender)
const EMAIL_USER = 'strategiclogisticsgroupllc@gmail.com'; 
const EMAIL_PASS = 'wnSx-72@!'; // REPLACE WITH REAL APP PASSWORD

// --- EMAIL ROUTING ---
// Maintenance (High, Low, EDV, MPH) & Videos -> Fleet Manager
const MAIL_FLEET_MGR = ['slgpfleetmanager@gmail.com'];

// Accidents -> Incident Reporting + Main Office
const MAIL_ACCIDENT = ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'];

// Service Account Credentials
const KEY_FILE_PATH = path.join(__dirname, 'credentials.json');


// =========================================================
// 2. MIDDLEWARE
// =========================================================
app.use(express.static(__dirname)); 
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true }));


// =========================================================
// 3. PAGE ROUTES
// =========================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'menu.html')));
app.get('/video', (req, res) => res.sendFile(path.join(__dirname, 'video.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));


// =========================================================
// 4. VIDEO SUBMISSION HANDLER
// =========================================================
app.post('/submit-video', upload.single('videoFile'), async (req, res) => {
    console.log("Received Video Submission...");
    const { driverName, vanNumber, checkType, mileage } = req.body;
    const file = req.file;

    if (!file) {
        return res.status(400).json({ success: false, error: "No video file received." });
    }

    try {
        // A. Auth Drive
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_FILE_PATH,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        // B. Create Folder Name
        const folderName = `VIDEO - ${driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        
        // C. Create Folder
        const folderReq = await drive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [PARENT_FOLDER_ID]
            },
            fields: 'id'
        });
        const folderId = folderReq.data.id;

        // D. Upload Video
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

        // E. Send Email (To Fleet Manager)
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
        console.log("Video Email Sent.");

        // Cleanup
        fs.unlinkSync(file.path);
        res.json({ success: true });

    } catch (error) {
        console.error("Video Upload Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// =========================================================
// 5. REPORT SUBMISSION HANDLER
// =========================================================
app.post('/submit-report', async (req, res) => {
    console.log("Received Report Submission...");
    const data = req.body;

    try {
        // A. Auth Drive
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_FILE_PATH,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        // B. Create Folder
        const folderName = `${data.driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const folderReq = await drive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [PARENT_FOLDER_ID]
            },
            fields: 'id'
        });
        const reportFolderId = folderReq.data.id;

        // C. Upload Photos
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

        // D. Generate PDF (Full Detail)
        const pdfPath = await generatePDF(data, photoLinks);
        
        // E. SMART ROUTING LOGIC
        let targetRecipients = [];
        let subjectPrefix = "";

        if (data.priorityLevel === 'accident') {
            // Accident -> Incident Reporting AND Strategic Logistics
            targetRecipients = MAIL_ACCIDENT;
            subjectPrefix = "🚨 URGENT: ACCIDENT REPORT";
        } else {
            // Maintenance (High, Low, EDV, MPH) -> Fleet Manager
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
        console.log(`Report Email Sent to: ${targetRecipients.join(', ')}`);

        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("Report Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// =========================================================
// 6. PDF GENERATOR (FULL DETAILS RESTORED)
// =========================================================
async function generatePDF(data, photoLinks) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const { width, height } = page.getSize();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    let y = height - 50;
    const drawText = (text, f = font, s = 12) => {
        page.drawText(text, { x: 50, y, size: s, font: f, color: rgb(0, 0, 0) });
        y -= 20;
    };

    drawText("SLGP REPORT", bold, 18);
    y -= 10;
    drawText(`Date: ${new Date().toLocaleString()}`);
    drawText(`Driver: ${data.driverName}`);
    
    // Show VIN only if present (Always present for Accident)
    if (data.vinLast4) {
        drawText(`VIN (Last 4): ${data.vinLast4}`);
    }
    y -= 20;

    drawText(`Report Type: ${data.priorityLevel.toUpperCase()}`, bold, 14);
    y -= 10;

    // --- DETAILED FIELDS (Restored) ---
    if (data.priorityLevel === 'high') {
        drawText(`Issue: ${data.highIssues}`);
        if(data.highNotes) drawText(`Notes: ${data.highNotes}`);
    }
    else if (data.priorityLevel === 'low') {
        drawText(`Issue: ${data.lowIssues}`);
        if(data.lowNotes) drawText(`Notes: ${data.lowNotes}`);
    }
    else if (data.priorityLevel === 'edv') {
        drawText(`Issue: ${data.edvIssues}`);
        if(data.edvNotes) drawText(`Notes: ${data.edvNotes}`);
    }
    else if (data.priorityLevel === 'mph') {
        drawText(`Street: ${data.mphRoadName}`);
        drawText(`Location: ${data.mphCity}, ${data.mphState}`);
        if(data.gpsLat) drawText(`GPS: ${data.gpsLat}, ${data.gpsLng}`);
    }
    else if (data.priorityLevel === 'accident') {
        drawText(`Statement: ${data.accidentStatement}`);
        drawText(`Police Report #: ${data.policeReportNumber}`);
        drawText(`Case #: ${data.lmetCaseNumber}`);
        if(data.gpsLat) drawText(`GPS: ${data.gpsLat}, ${data.gpsLng}`);
        
        // Add Signature
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

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
