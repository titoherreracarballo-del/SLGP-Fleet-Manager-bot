const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

const FOLDER_ID = '1ldYUYV0BO2nEJ23GHKK5qN1o2';

let auth;
try {
    // Parse the GCP_SA_KEY from Railway Environment Variables
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    console.log("SUCCESS: GCP Auth initialized.");
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY is invalid JSON. Check Railway variables.");
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }

        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType, serviceType } = req.body;
        
        const fileMetadata = {
            name: `${vin}_${inspectionType.toUpperCase()}_${driverName}_${serviceType}.mp4`,
            parents: [FOLDER_ID],
        };

        const media = {
            mimeType: 'video/mp4',
            body: fs.createReadStream(req.file.path),
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });

        console.log(`Successfully uploaded file: ${response.data.id}`);

        // Cleanup local storage
        if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        res.status(200).send('Upload Successful');
    } catch (error) {
        // Detailed error logging to solve the 502/Failed error
        console.error("UPLOAD ERROR DETAILS:", error.message);
        res.status(500).send(`Upload Failed: ${error.message}`);
    }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`-----------------------------------------`);
    console.log(`SLGP SERVER v1.1.10 LIVE ON PORT: ${PORT}`);
    console.log(`-----------------------------------------`);
});
