/**
 * SLGP FLEET PORTAL - MAIN SERVER v6.6
 * --------------------------------------
 * This single file handles BOTH the Video Checks and the Incident Reports.
 * It acts as the traffic controller for your entire application.
 */

const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const upload = multer({ dest: 'uploads/' });

// =========================================================
// 1. CONFIGURATION (KEYS & EMAILS)
// =========================================================

// Google Drive Folder ID (Shared Storage)
const PARENT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy'; 

// Email Settings (The Account SENDING the emails)
const EMAIL_USER = 'strategiclogisticsgroupllc@gmail.com'; 
const EMAIL_PASS = 'wnSx-72@!'; // REPLACE WITH YOUR REAL 16-CHAR APP PASSWORD

// --- SMART EMAIL ROUTING (RECIPIENTS) ---

// A. Maintenance Issues (High, Low, EDV, MPH) -> Fleet Manager Only
const MAIL_MAINTENANCE = ['slgpfleetmanager@gmail.com'];

// B. Accidents -> Incident Reporting AND Strategic Logistics
const MAIL_ACCIDENT = ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com'];


// Service Account Key Path
const KEY_FILE_PATH = path.join(__dirname, 'credentials.json');


// =========================================================
// 2. MIDDLEWARE (The Setup)
// =========================================================
app.use(express.static(__dirname)); // Serves html, jpg, css files
app.use(express.json({ limit: '50mb' })); // Allows large data (photos)


// =========================================================
// 3. PAGE ROUTES (The Menu)
// =========================================================

// Home / Menu
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'menu.html'));
});

// Video Check Page
// (This ensures your "Pre & Post Fleet Vids" button works)
app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

// Report / Insurance Page
app.get('/report', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});


// =========================================================
// 4. BACKEND LOGIC: REPORT SUBMISSION
// =========================================================

app.post('/submit-report', async (req, res) => {
    console.log("Received Report Submission...");
    const data = req.body;

    try {
        // --- STEP A: CONNECT TO GOOGLE DRIVE ---
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_FILE_PATH,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        // --- STEP B: CREATE A FOLDER FOR THIS REPORT ---
        const folderName = `${data.driverName} - ${new Date().toLocaleDateString().replace(/\//g, '-')}`;
        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [PARENT_FOLDER_ID]
        };
        
        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        const reportFolderId = folder.data.id;
        console.log(`Created Drive Folder: ${folderName} (${reportFolderId})`);

        // --- STEP C: UPLOAD PHOTOS ---
        let photoLinks = [];
        const uploadImage = async (imgObj, type) => {
            if (!imgObj || !imgObj.data) return;
            const buffer = Buffer.from(imgObj.data, 'base64');
            const stream = require('stream');
            const bs = new stream.PassThrough();
            bs.end(buffer);

            const photoName = `${type}_${imgObj.name}`;
            const photoFile = await drive.files.create({
                resource: { name: photoName, parents: [reportFolderId] },
                media: { mimeType: 'image/jpeg', body: bs },
                fields: 'webViewLink'
            });
            photoLinks.push({ name: photoName, link: photoFile.data.webViewLink });
        };

        if (data.highPhotos) await uploadImage(data.highPhotos, 'HighPriority');
        if (data.lowPhotos) await uploadImage(data.lowPhotos, 'LowPriority');
        if (data.edvPhotos) await uploadImage(data.edvPhotos, 'EDV');
        if (data.mphPhotos) await uploadImage(data.mphPhotos, 'MPH');
        if (data.accidentPhotos) await uploadImage(data.accidentPhotos, 'Accident');

        // --- STEP D: GENERATE PDF ---
        const pdfPath = await generatePDF(data, photoLinks);
        
        // --- STEP E: SEND EMAIL (SMART ROUTING) ---
        let targetRecipients = [];
        let subjectPrefix = "";

        if (data.priorityLevel === 'accident') {
            // ROUTE: Accident
            targetRecipients = MAIL_ACCIDENT;
            subjectPrefix = "🚨 URGENT: ACCIDENT REPORT";
        } else {
            // ROUTE: Maintenance (High, Low, EDV, MPH)
            targetRecipients = MAIL_MAINTENANCE;
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
            text: `A new report has been submitted.\n\nDriver: ${data.driverName}\nType: ${data.priorityLevel.toUpperCase()}\n\nView Photos & Files: https://drive.google.com/drive/folders/${reportFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
        console.log(`Email Sent Successfully to: ${targetRecipients.join(', ')}`);

        // Cleanup
        fs.unlinkSync(pdfPath);
        res.json({ success: true });

    } catch (error) {
        console.error("Error processing report:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =========================================================
// 5. HELPER FUNCTION: PDF GENERATOR
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

    drawText("SLGP INCIDENT / MAINTENANCE REPORT", bold, 18);
    y -= 10;
    drawText(`Date: ${new Date().toLocaleString()}`);
    drawText(`Driver: ${data.driverName}`);
    
    if (data.vinLast4) {
        drawText(`VIN (Last 4): ${data.vinLast4}`);
    }
    y -= 20;

    drawText(`Report Type: ${data.priorityLevel.toUpperCase()}`, bold, 14);
    y -= 10;

    if (data.priorityLevel === 'high') {
        drawText(`Issue: ${data.highIssues}`);
        if(data.highNotes) drawText(`Notes: ${data.highNotes}`);
    }
    if (data.priorityLevel === 'low') {
        drawText(`Issue: ${data.lowIssues}`);
        if(data.lowNotes) drawText(`Notes: ${data.lowNotes}`);
    }
    if (data.priorityLevel === 'edv') {
        drawText(`Issue: ${data.edvIssues}`);
        if(data.edvNotes) drawText(`Notes: ${data.edvNotes}`);
    }
    if (data.priorityLevel === 'mph') {
        drawText(`Street: ${data.mphRoadName}`);
        drawText(`Location: ${data.mphCity}, ${data.mphState}`);
        drawText(`GPS: ${data.gpsLat}, ${data.gpsLng}`);
    }
    if (data.priorityLevel === 'accident') {
        drawText(`Statement: ${data.accidentStatement}`);
        drawText(`Police Report #: ${data.policeReportNumber}`);
        drawText(`Case #: ${data.lmetCaseNumber}`);
        drawText(`GPS: ${data.gpsLat}, ${data.gpsLng}`);
        
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

// =========================================================
// 6. START THE SERVER
// =========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
