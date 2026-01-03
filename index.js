const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const app = express();
const upload = multer();

// --- CONFIGURATION ---
const PARENT_FOLDER_ID = '0AC1GE3XEm4K9Uk9PVA'; // Your Folder ID
const KEY_FILE_PATH = './service-account.json'; 
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const PORT = process.env.PORT || 8080; // Changed to 8080 or environment port

// --- MIDDLEWARE ---
app.use(express.json());

// IMPORTANT: Serves files from the ROOT directory since your HTML files 
// (menu.html, video.html, etc.) are in the same folder as index.js
app.use(express.static(__dirname)); 


// --- AUTHENTICATION ---
const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: SCOPES,
});

// --- HELPER: FOLDER NAMES ---
function getTodayFolderName() {
    const date = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const dayName = days[date.getDay()];
    const monthName = months[date.getMonth()];
    const dayNum = date.getDate();

    const suffix = (dayNum) => {
        if (dayNum > 3 && dayNum < 21) return 'th';
        switch (dayNum % 10) {
            case 1:  return "st";
            case 2:  return "nd";
            case 3:  return "rd";
            default: return "th";
        }
    };
    return `${dayName} ${monthName} ${dayNum}${suffix(dayNum)}`;
}

// --- HELPER: FIND/CREATE DRIVE FOLDER ---
async function getDailyFolderId(drive) {
    try {
        const folderName = getTodayFolderName();
        const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${PARENT_FOLDER_ID}' in parents and trashed=false`;
        
        const res = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });

        if (res.data.files.length > 0) {
            console.log(`Using existing folder: ${folderName}`);
            return res.data.files[0].id;
        } else {
            console.log(`Creating new folder: ${folderName}`);
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [PARENT_FOLDER_ID],
            };
            const folder = await drive.files.create({ resource: fileMetadata, fields: 'id' });
            return folder.data.id;
        }
    } catch (error) {
        console.error('Folder creation failed. Uploading to Parent Folder instead.');
        return PARENT_FOLDER_ID;
    }
}

// --- SECURITY: VIDEO LOCK LOGIC ---
const checkVideoLock = (req, res, next) => {
    // LOCKED STATUS: Set to true to lock the video functionality
    const isLocked = true; 

    if (isLocked) {
        console.log("Video Page Access Attempt: BLOCKED (Locked State)");
        // Redirects back to the main menu if they try to access video
        res.redirect('/');
    } else {
        next();
    }
};

// --- ROUTES (MATCHING YOUR EXACT FILENAMES) ---

// 1. Home / Menu
// Serving 'menu.html' as the main entry point
app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'menu.html')); 
});

// 2. Video (LOCKED)
app.get('/video', checkVideoLock, (req, res) => { 
    res.sendFile(path.join(__dirname, 'video.html')); 
});

// 3. Smart Report Handler (Fixes "Cannot GET /report")
app.get('/report', (req, res) => {
    const mode = req.query.mode;

    if (mode === 'accident') {
        // ERROR FIX: Matches "accident - report.html" exactly
        res.sendFile(path.join(__dirname, 'accident - report.html'));
    } else if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    } else if (mode === 'insurance') {
        res.sendFile(path.join(__dirname, 'insurance.html'));
    } else {
        // Default fallback
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    }
});

// 4. Direct Links (Backwards Compatibility)
app.get('/report-issue', (req, res) => { 
    res.sendFile(path.join(__dirname, 'report-issue.html')); 
});
app.get('/accident-report', (req, res) => { 
    res.sendFile(path.join(__dirname, 'accident - report.html')); 
});
app.get('/insurance', (req, res) => { 
    res.sendFile(path.join(__dirname, 'insurance.html')); 
});


// --- GOOGLE DRIVE UPLOAD ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const { driverName, vin, inspectionType } = req.body;
        
        // Basic validation
        if (!req.file) {
            console.error("Upload failed: No file received");
            return res.status(400).send('No video file uploaded.');
        }

        const drive = google.drive({ version: 'v3', auth });
        const targetFolderId = await getDailyFolderId(drive);
        
        const timestamp = new Date().toLocaleTimeString().replace(/:/g, '-');
        const fileName = `${inspectionType} - ${driverName} - ${vin} - ${timestamp}.mp4`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const fileMetadata = { name: fileName, parents: [targetFolderId] };
        const media = { mimeType: req.file.mimetype, body: bufferStream };

        console.log(`Starting upload: ${fileName}`);
        const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });

        console.log(`Upload Success! ID: ${response.data.id}`);
        res.status(200).send('Upload successful');
    } catch (error) {
        console.error('Error uploading to Drive:', error);
        res.status(500).send('Error uploading to Drive');
    }
});

app.post('/submit-report', (req, res) => {
    console.log('Report Data Received:', req.body);
    res.json({ success: true });
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Files served from: ${__dirname}`);
});
