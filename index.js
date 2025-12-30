const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const app = express();

const upload = multer({ dest: 'uploads/' });

// --- GOOGLE DRIVE CONFIGURATION ---
// Using the Folder ID you provided: 1ldYUYV0BO2nEJ23GHKK5qN1o2
const FOLDER_ID = '1ldYUYV0BO2nEJ23GHKK5qN1o2';

let auth;
try {
    // Parse the GCP_SA_KEY variable you created in Railway
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
} catch (err) {
    console.error("CRITICAL ERROR: GCP_SA_KEY is missing or invalid in Railway variables.");
}

app.use(express.static(__dirname));

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType, serviceType } = req.body;
        
        // Naming format: VIN_TYPE_DRIVER.mp4
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

        // Delete the temporary file from the server after upload
        fs.unlinkSync(req.file.path);
        res.status(200).send({ id: response.data.id });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).send('Upload Failed');
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`SLGP Server Active on Port ${PORT}`);
});
