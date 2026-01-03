const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const app = express();
const upload = multer();

// --- CONFIGURATION ---
const PARENT_FOLDER_ID = '0AC1GE3XEm4K9Uk9PVA'; // Your Drive Folder ID
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const PORT = process.env.PORT || 8080;

// --- MIDDLEWARE ---
app.use(express.json());
// Serve static files from the root directory
app.use(express.static(__dirname)); 


// --- AUTHENTICATION (RAILWAY FIX) ---
// We try to read from the Env Variable 'GCP_SA_KEY' first.
// If that doesn't exist, we fall back to a local file (for local testing).
let auth;
try {
    if (process.env.GCP_SA_KEY) {
        // Parse the JSON string from Railway Environment Variable
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        auth = new google.auth.GoogleAuth({
            credentials,
            scopes: SCOPES,
        });
        console.log("Authentication: Using Environment Variable (Railway Mode)");
    } else {
        // Fallback for local testing if you have the file
        auth = new google.auth.GoogleAuth({
            keyFile: './service-account.json',
            scopes: SCOPES,
        });
        console.log("Authentication: Using local file ./service-account.json");
    }
} catch (err) {
    console.error("CRITICAL AUTH ERROR: Could not load Google Credentials.", err);
}


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
    // CURRENT STATUS: UNLOCKED (false)
    const isLocked = false; 

    if (isLocked) {
        // Redirects to home if locked
        res.redirect('/');
    } else {
        next();
    }
};

// --- ROUTES ---

// 1. Home / Menu
app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'menu.html')); 
});

// 2. Video (Unlocked)
app.get('/video', checkVideoLock, (req, res) => { 
    res.sendFile(path.join(__dirname, 'video.html')); 
});

// 3. Smart Report Handler
app.get('/report', (req, res) => {
    const mode = req.query.mode;
    if (mode === 'accident') {
        res.sendFile(path.join(__dirname, 'accident - report.html'));
    } else if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    } else if (mode === 'insurance') {
        res.sendFile(path.join(__dirname, 'insurance.html'));
    } else {
        res.sendFile(path.join(__dirname, 'report-issue.html'));
    }
});

// 4. Direct Links (Backwards Compatibility)
app.get('/report-issue', (req, res) => { res.sendFile(path.join(__dirname, 'report-issue.html')); });
app.get('/accident-report', (req, res) => { res.sendFile(path.join(__dirname, 'accident - report.html')); });
app.get('/insurance', (req, res) => { res.sendFile(path.join(__dirname, 'insurance.html')); });


// --- GOOGLE DRIVE UPLOAD ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No video file uploaded.');
        
        // Use the auth object we created at the top
        if (!auth) {
             return res.status(500).send('Server Error: Google Credentials not loaded. Check Railway Variables.');
        }

        const drive = google.drive({ version: 'v3', auth });
        
        // Try to get Daily Folder, fallback to Parent
        const targetFolderId = await getDailyFolderId(drive);
        
        const { driverName, vin, inspectionType } = req.body;
        const timestamp = new Date().toLocaleTimeString().replace(/:/g, '-');
        
        // Safe variable handling
        const safeDriverName = driverName || 'Driver';
        const safeVin = vin || 'NoVIN';
        const safeType = inspectionType || 'Video';

        const fileName = `${safeType} - ${safeDriverName} - ${safeVin} - ${timestamp}.mp4`;

        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const fileMetadata = { name: fileName, parents: [targetFolderId] };
        const media = { mimeType: req.file.mimetype, body: bufferStream };

        const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });

        console.log(`Success! Video ID: ${response.data.id}`);
        res.status(200).send('Upload successful');
    } catch (error) {
        console.error('Error uploading:', error);
        res.status(500).send('Error uploading to Drive: ' + error.message);
    }
});

app.post('/submit-report', (req, res) => {
    console.log('Report Data:', req.body);
    res.json({ success: true });
});

// --- SERVER START ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
