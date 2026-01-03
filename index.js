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
const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.use(express.json());
// Serve all files from root (CSS, JS, Images)
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

// --- HELPER: FIND/CREATE DRIVE FOLDER (WITH FAILSAFE) ---
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
        // --- FAILSAFE ---
        // If folder creation fails, we just upload to the main parent folder so it still works.
        console.error('Folder logic failed (Permissions?). Defaulting to Parent Folder.');
        return PARENT_FOLDER_ID;
    }
}

// --- SECURITY: VIDEO LOCK MIDDLEWARE ---
const checkVideoLock = (req, res, next) => {
    // Set this to TRUE to lock the video page.
    const isLocked = true; 

    if (isLocked) {
        console.log("Access denied: Video page is locked.");
        // You can redirect to home, or send a 403 Forbidden message
        // res.status(403).send("<h1>This feature is currently locked.</h1><a href='/'>Go Back</a>");
        
        // OR: Redirect back to the main menu
        res.redirect('/');
    } else {
        next();
    }
};

// --- ROUTES ---

// 1. Home
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'menu.html')); });

// 2. Video (LOCKED)
// We apply the 'checkVideoLock' middleware here.
app.get('/video', checkVideoLock, (req, res) => { 
    res.sendFile(path.join(__dirname, 'video.html')); 
});

// 3. THE FIX: Smart Report Route
// This catches /report?mode=accident and serves the right file
app.get('/report', (req, res) => {
    const mode = req.query.mode;

    console.log(`Route Handler: Received request for mode: ${mode}`);

    if (mode === 'accident') {
        res.sendFile(path.join(__dirname, 'accident - report.html'));
    } else if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    } else if (mode === 'insurance') {
        res.sendFile(path.join(__dirname, 'insurance.html'));
    } else {
        // If no mode is found, default to report-issue or menu
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    }
});

// Keep these as fallbacks in case old links still use them
app.get('/report-issue', (req, res) => { res.sendFile(path.join(__dirname, 'report-issue.html')); });
app.get('/accident-report', (req, res) => { res.sendFile(path.join(__dirname, 'accident - report.html')); });
app.get('/insurance', (req, res) => { res.sendFile(path.join(__dirname, 'insurance.html')); });


// --- UPLOAD LOGIC (Unchanged but Secured) ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        // OPTIONAL: Uncomment next line if you want to prevent uploads when locked
        // if (true) return res.status(403).send("Uploads are currently locked.");

        const { driverName, vin, inspectionType } = req.body;
        if (!req.file) return res.status(400).send('No video file uploaded.');

        const drive = google.drive({ version: 'v3', auth });
        
        // Try to get Daily Folder, fallback to Parent if it fails
        const targetFolderId = await getDailyFolderId(drive);
        
        const timestamp = new Date().toLocaleTimeString().replace(/:/g, '-');
        const fileName = `${inspectionType} - ${driverName} - ${vin} - ${timestamp}.mp4`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const fileMetadata = { name: fileName, parents: [targetFolderId] };
        const media = { mimeType: req.file.mimetype, body: bufferStream };

        const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });

        console.log(`Success! Video ID: ${response.data.id}`);
        res.status(200).send('Upload successful');
    } catch (error) {
        console.error('Error uploading:', error);
        res.status(500).send('Error uploading to Drive');
    }
});

app.post('/submit-report', async (req, res) => {
    try {
        console.log('Report Received:', req.body);
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// --- SERVER START ---
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
