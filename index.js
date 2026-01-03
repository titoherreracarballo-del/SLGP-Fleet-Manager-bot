const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const app = express();
const upload = multer();

// --- CONFIGURATION ---
// ✅ YOUR GOOGLE DRIVE FOLDER ID IS NOW SET
const PARENT_FOLDER_ID = '0AC1GE3XEm4K9Uk9PVA'; 

// ⚠️ MAKE SURE THIS FILE EXISTS IN YOUR ROOT FOLDER
const KEY_FILE_PATH = './service-account.json'; 

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// --- MIDDLEWARE ---
app.use(express.json());
// This tells the server to look for files inside the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTHENTICATION ---
const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: SCOPES,
});

// --- HELPER: GENERATE FOLDER NAME (e.g. "Saturday Jan 3rd") ---
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

// --- HELPER: FIND OR CREATE FOLDER ---
async function getDailyFolderId(drive) {
    const folderName = getTodayFolderName();
    const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${PARENT_FOLDER_ID}' in parents and trashed=false`;
    
    try {
        const res = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });

        if (res.data.files.length > 0) {
            console.log(`Using existing folder: ${folderName} (ID: ${res.data.files[0].id})`);
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
        console.error('Error finding/creating folder:', error);
        throw error;
    }
}

// --- EXPLICIT ROUTES (Fixes "Not Found" Error) ---

// 1. Home Page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Video Page
app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

// 3. Report Issue Page
app.get('/report-issue', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'report-issue.html'));
});

// 4. Accident Report Page
app.get('/accident-report', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'accident-report.html'));
});

// 5. Insurance Page
app.get('/insurance', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'insurance.html'));
});


// --- UPLOAD LOGIC ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const { driverName, vin, inspectionType } = req.body;
        if (!req.file) return res.status(400).send('No video file uploaded.');

        const drive = google.drive({ version: 'v3', auth });
        
        // 1. Get/Create the Date Folder
        const dailyFolderId = await getDailyFolderId(drive);
        
        // 2. Name the file
        const timestamp = new Date().toLocaleTimeString().replace(/:/g, '-');
        const fileName = `${inspectionType} - ${driverName} - ${vin} - ${timestamp}.mp4`;

        // 3. Upload it
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        const fileMetadata = { name: fileName, parents: [dailyFolderId] };
        const media = { mimeType: req.file.mimetype, body: bufferStream };

        const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });

        console.log(`Success! Video uploaded. ID: ${response.data.id}`);
        res.status(200).send('Upload successful');
    } catch (error) {
        console.error('Error uploading:', error);
        res.status(500).send('Error uploading to Drive');
    }
});

// Report Issue Handler (Placeholder for future drive logic if needed)
app.post('/submit-report', async (req, res) => {
    try {
        console.log('Report Received:', req.body);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
