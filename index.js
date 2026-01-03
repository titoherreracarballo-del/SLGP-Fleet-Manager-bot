const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const path = require('path');
const app = express();
const upload = multer();

// --- CONFIGURATION ---
// ⚠️ IMPORTANT: PASTE YOUR SPECIFIC GOOGLE DRIVE FOLDER ID HERE
const PARENT_FOLDER_ID = 'YOUR_FOLDER_ID_HERE'; 

// ⚠️ IMPORTANT: MAKE SURE THIS PATH POINTS TO YOUR JSON KEY FILE
const KEY_FILE_PATH = './service-account.json'; 

// SCOPES
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));

// --- AUTHENTICATION ---
const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: SCOPES,
});

// --- HELPER: GET TODAY'S FOLDER NAME (e.g. "Saturday Jan 3rd") ---
function getTodayFolderName() {
    const date = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    const dayName = days[date.getDay()];
    const monthName = months[date.getMonth()];
    const dayNum = date.getDate();

    // Add suffix (st, nd, rd, th)
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

// --- HELPER: FIND OR CREATE DAILY FOLDER ---
async function getDailyFolderId(drive) {
    const folderName = getTodayFolderName();
    
    // 1. Check if the folder already exists inside your PARENT folder
    const query = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${PARENT_FOLDER_ID}' in parents and trashed=false`;
    
    try {
        const res = await drive.files.list({
            q: query,
            fields: 'files(id, name)',
            spaces: 'drive',
        });

        if (res.data.files.length > 0) {
            // Folder exists, return its ID
            console.log(`Using existing folder: ${folderName} (ID: ${res.data.files[0].id})`);
            return res.data.files[0].id;
        } else {
            // Folder doesn't exist, create it
            console.log(`Creating new folder: ${folderName}`);
            const fileMetadata = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [PARENT_FOLDER_ID], // Creates it INSIDE your main fleet folder
            };
            const folder = await drive.files.create({
                resource: fileMetadata,
                fields: 'id',
            });
            return folder.data.id;
        }
    } catch (error) {
        console.error('Error finding/creating folder:', error);
        throw error; // Stop upload if we can't organize folders
    }
}

// --- ROUTE: VIDEO UPLOAD ---
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const { driverName, vin, inspectionType } = req.body;
        
        if (!req.file) {
            return res.status(400).send('No video file uploaded.');
        }

        const drive = google.drive({ version: 'v3', auth });

        // 1. Get the correct Daily Folder ID
        const dailyFolderId = await getDailyFolderId(drive);

        // 2. Prepare File Name
        // Format: Pre-Trip - John Doe - 1051 - 12-05-30-PM.mp4
        const timestamp = new Date().toLocaleTimeString().replace(/:/g, '-');
        const fileName = `${inspectionType} - ${driverName} - ${vin} - ${timestamp}.mp4`;

        // 3. Create Stream
        const bufferStream = new stream.PassThrough();
        bufferStream.end(req.file.buffer);

        // 4. Upload Logic
        const fileMetadata = {
            name: fileName,
            parents: [dailyFolderId], // <--- This puts the file into the date-specific folder
        };

        const media = {
            mimeType: req.file.mimetype,
            body: bufferStream,
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });

        console.log(`Success! Video uploaded to folder "${getTodayFolderName()}". File ID: ${response.data.id}`);
        res.status(200).send('Upload successful');

    } catch (error) {
        console.error('Error uploading to Drive:', error);
        res.status(500).send('Error uploading to Drive');
    }
});

// --- ROUTE: REPORT ISSUE UPLOAD (Handles Photos) ---
app.post('/submit-report', async (req, res) => {
    // Note: Since the user hasn't asked for specific Google Drive logic for photos yet,
    // this currently just logs the data to the console. 
    // You can add similar Drive logic here later if needed.
    try {
        console.log('Report Received:', req.body);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.json({ success: false, error: error.message });
    }
});

// --- ROUTE: SERVE HTML FILES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve other pages dynamically
app.get('/:page', (req, res) => {
    const page = req.params.page;
    // Allowlist of valid pages for security
    const validPages = ['report-issue', 'accident-report', 'video', 'insurance'];
    const pageName = page.replace('.html', '');

    if (validPages.includes(pageName)) {
        res.sendFile(path.join(__dirname, 'public', page.endsWith('.html') ? page : `${page}.html`));
    } else {
        res.status(404).send('Page not found');
    }
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
