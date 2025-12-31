const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

const DRIVE_FOLDER_ID = '1ldYUYV0BO2nEJ23GHKK5qN1o2';

let auth;
try {
    const credentials = JSON.parse(process.env.GCP_SA_KEY);
    auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
} catch (err) {
    console.error("GCP_SA_KEY error.");
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    try {
        const drive = google.drive({ version: 'v3', auth });
        const { driverName, vin, inspectionType, serviceType } = req.body;
        const fileMetadata = {
            name: `${vin}_${inspectionType.toUpperCase()}_${driverName}_${serviceType}.mp4`,
            parents: [DRIVE_FOLDER_ID],
        };
        const media = { body: fs.createReadStream(req.file.path), mimeType: 'video/mp4' };
        await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });
        fs.unlinkSync(req.file.path); 
        res.status(200).send('Upload Successful');
    } catch (error) {
        res.status(500).send('Upload Failed');
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`SLGP LIVE: v1.2.0 - Active on Port ${PORT}`);
});
