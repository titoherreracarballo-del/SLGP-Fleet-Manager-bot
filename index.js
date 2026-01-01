const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron'); // REQUIRED: Add "node-cron": "^3.0.0" to package.json

const app = express();
const upload = multer({ dest: 'uploads/' });

// Folder ID for "Daily Fleet Health Checks"
const DRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';

// Persistent Log File (Stored on your mounted volume)
const LOG_FILE = '/app/meshcentral-data/submission_log.json';

// --- HELPER: Load Logs ---
function loadLogs() {
    try {
        if (fs.existsSync(LOG_FILE)) {
            return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Error reading log file:", e);
    }
    return [];
}

// --- HELPER: Save Log ---
function saveLog(entry) {
    const logs = loadLogs();
    logs.push(entry);
    try {
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) {
        console.error("Error writing to log file:", e);
    }
}

let auth;
try {
    // Parse credentials from Railway variable
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Service Account Authenticated.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY parsing failed.");
}

// --- HELPER: Generate and Upload Report ---
async function generateReport(typeFilter, reportTitle) {
    console.log(`Generating ${reportTitle}...`);
    const logs = loadLogs();
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Filter for logs from TODAY and matching the TYPE (Pre/Post)
    const relevantLogs = logs.filter(entry => {
        return entry.date === todayStr && 
               entry.inspectionType.toLowerCase().includes(typeFilter);
    });

    if (relevantLogs.length === 0) {
        console.log(`No entries found for ${reportTitle}. Skipping upload.`);
        return;
    }

    // Create Report Text
    let reportContent = `FLEET REPORT: ${reportTitle}\nDATE: ${todayStr}\n-----------------------------------\n\n`;
    relevantLogs.forEach((log, index) => {
        reportContent += `${index + 1}. Driver: ${log.driverName}\n`;
        reportContent += `   VIN: ${log.vin}\n`;
        reportContent += `   Time: ${log.time}\n`;
        reportContent += `   File: ${log.fileName}\n\n`;
    });

    // Save report temporarily
    const reportPath = path.join(__dirname, `${reportTitle}_${todayStr}.txt`);
    fs.writeFileSync(reportPath, reportContent);

    // Upload Report to Google Drive
    try {
        const drive = google.drive({ version: 'v3', auth });
        const fileMetadata = {
            name: `${reportTitle}_${todayStr}.txt`,
            parents: [DRIVE_FOLDER_ID],
        };
        const media = {
            mimeType: 'text/plain',
            body: fs.createReadStream(reportPath),
        };

        await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
            supportsAllDrives: true,
            supportsTeamDrives: true
        });
        console.log(`REPORT UPLOADED: ${reportTitle}`);
    } catch (error) {
        console.error(`FAILED to upload report: ${error.message}`);
    }
}

// --- SCHEDULER: 12:00 PM (Pre-checks) ---
cron.schedule('0 12 * * *', () => {
    generateReport('pre', 'DAILY_PRECHECK_REPORT');
}, { timezone: "America/New_York" });

// --- SCHEDULER: 11:00 PM (Post-checks) ---
cron.schedule('0 23 * * *', () => {
    generateReport('post', 'DAILY_POSTCHECK_REPORT');
}, { timezone: "America/New_York" });


app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file received.');

        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType } = req.body;
        
        // --- TWEAK 3: Rename File with Timestamp ---
        const now = new Date();
        // File-safe timestamp (no colons)
        const timeStringFile = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
        // Readable logs
        const timeStringLog = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
        const dateStringLog = now.toISOString().split('T')[0];

        // New Name: Driver_VIN_Type_Time.mp4
        const finalFileName = `${driverName}_${vin}_${inspectionType}_${timeStringFile}.mp4`;

        const fileMetadata = {
            name: finalFileName,
            parents: [DRIVE_FOLDER_ID],
        };

        const media = {
            mimeType: 'video/mp4',
            body: fs.createReadStream(req.file.path),
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
            supportsAllDrives: true, 
            supportsTeamDrives: true
        });

        console.log(`SYNC SUCCESS: ${finalFileName}`);

        // --- TWEAK 4: Log Data for Report ---
        saveLog({
            date: dateStringLog,
            time: timeStringLog,
            driverName: driverName,
            vin: vin,
            inspectionType: inspectionType,
            fileName: finalFileName
        });
        
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        
        res.status(200).send('Upload Successful');
    } catch (error) {
        console.error("UPLOAD ERROR DETAILS:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`-----------------------------------------`);
    console.log(`SLGP SERVER v1.3.0 LIVE ON PORT: ${PORT}`);
    console.log(`-----------------------------------------`);
});
