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

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static(__dirname)); // Serve files from Root

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
        // If we can't create a folder (permission error), use the PARENT ID instead of failing.
        console.error('Folder creation failed (Permissions?), uploading to Parent Folder instead.');
        return PARENT_FOLDER_ID;
    }
}

// --- ROUTES (Matched to your File Names) ---

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'menu.html')); });
app.get('/video', (req, res) => { res.sendFile(path.join(__dirname, 'video.html')); });
app.get('/report-issue', (req, res) => { res.sendFile(path.join(__dirname, 'report-issue.html')); });
app.get('/accident-report', (req, res) => { res.sendFile(path.join(__dirname, 'accident - report.html')); });
app.get('/insurance', (req, res) => { res.sendFile(path.join(__dirname, 'insurance.html')); });

// --- UPLOAD LOGIC ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
