/**
 * SLGP FLEET PORTAL - BACKEND v6.3
 * Features:
 * 1. PDF Report Generation (with PDFLib)
 * 2. Google Drive Uploads (Reports + Photos)
 * 3. Email Notifications (Nodemailer)
 * 4. Serve Static Files (HTML/Images)
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

// --- CONFIGURATION ---

// 1. Google Drive Folder ID (Where reports/photos are saved)
// I extracted this from your link: https://drive.google.com/drive/folders/1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy
const PARENT_FOLDER_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy'; 

// 2. Email Settings (The "Sender")
const EMAIL_USER = 'strategiclogisticsgroupllc@gmail.com'; 
const EMAIL_PASS = 'wnSx-72@!'; // Check if this is your App Password!

// 3. Email Recipients (Where reports go)
const RECIPIENTS = ['strategiclogisticsgroupllc@gmail.com', 'slgpincidentreporting@gmail.com'];

// 4. Service Account Credentials (The "Robot" Key)
// Make sure 'credentials.json' is uploaded to your Railway project root!
const KEY_FILE_PATH = path.join(__dirname, 'credentials.json');

// --- MIDDLEWARE ---
app.use(express.static(__dirname)); // Serves your HTML and JPG files
app.use(express.json({ limit: '50mb' })); // Allows big photo uploads

// --- ROUTES ---

// 1. Serve the Main Menu
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'menu.html'));
});

// 2. Serve the Video Page
app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'video.html'));
});

// 3. Serve the Report Page
app.get('/report', (req, res) => {
    res.sendFile(path.join(__dirname, 'report.html'));
});

// 4. MAIN REPORT SUBMISSION HANDLER
app.post('/submit-report', async (req, res) => {
    console.log("Received Report Submission...");
    const data = req.body;

    try {
        // A. Authenticate with Google Drive
        const auth = new google.auth.GoogleAuth({
            keyFile: KEY_FILE_PATH,
            scopes: ['https://www.googleapis.com/auth/drive.file'],
        });
        const drive = google.drive({ version: 'v3', auth });

        // B. Create a Sub-folder for this specific report (e.g., "John Doe - 2023-10-27")
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

        // C. Upload Photos to that Folder & Collect Links
        let photoLinks = [];
        
        // Helper to upload a single base64 image
        const uploadImage = async (imgObj, type) => {
            if (!imgObj || !imgObj.data) return;
            const buffer = Buffer.from(imgObj.data, 'base64');
            const stream = require('stream');
            const bs = new stream.PassThrough();
            bs.end(buffer);

            const photoName = `${type}_${imgObj.name}`;
            const photoFile = await drive.files.create({
                resource: {
                    name: photoName,
                    parents: [reportFolderId]
                },
                media: {
                    mimeType: 'image/jpeg',
                    body: bs
                },
                fields: 'webViewLink'
            });
            photoLinks.push({ name: photoName, link: photoFile.data.webViewLink });
        };

        // Upload all photos found in the payload
        if (data.highPhotos) await uploadImage(data.highPhotos, 'HighPriority');
        if (data.lowPhotos) await uploadImage(data.lowPhotos, 'LowPriority');
        if (data.edvPhotos) await uploadImage(data.edvPhotos, 'EDV');
        if (data.mphPhotos) await uploadImage(data.mphPhotos, 'MPH');
        if (data.accidentPhotos) await uploadImage(data.accidentPhotos, 'Accident');

        // D. Generate PDF Report
        const pdfPath = await generatePDF(data, photoLinks);
        
        // E. Email the PDF
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });

        const mailOptions = {
            from: EMAIL_USER,
            to: RECIPIENTS,
            subject: `🚨 New Report: ${data.priorityLevel.toUpperCase()} - ${data.driverName}`,
            text: `A new report has been submitted.\n\nDriver: ${data.driverName}\nType: ${data.priorityLevel}\nFolder: https://drive.google.com/drive/folders/${reportFolderId}`,
            attachments: [{ filename: 'Report.pdf', path: pdfPath }]
        };

        await transporter.sendMail(mailOptions);
        console.log("Email Sent Successfully.");

        // Cleanup: Delete local PDF
        fs.unlinkSync(pdfPath);

        res.json({ success: true });

    } catch (error) {
        console.error("Error processing report:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- HELPER: PDF GENERATOR ---
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

    // Header
    drawText("SLGP INCIDENT / MAINTENANCE REPORT", bold, 18);
    y -= 10;
    drawText(`Date: ${new Date().toLocaleString()}`);
    drawText(`Driver: ${data.driverName}`);
    drawText(`VIN (Last 4): ${data.vinLast4}`);
    y -= 20;

    // Issue Type
    drawText(`Report Type: ${data.priorityLevel.toUpperCase()}`, bold, 14);
    y -= 10;

    // Details based on Type
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
        
        // Add Signature Image if present
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
        // Note: We can't put clickable links easily in this basic text, 
        // but the email body has the folder link.
    });

    const pdfBytes = await doc.save();
    const filePath = path.join(__dirname, `report-${Date.now()}.pdf`);
    fs.writeFileSync(filePath, pdfBytes);
    return filePath;
}

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
