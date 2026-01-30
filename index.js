require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const nodemailer = require('nodemailer');
const multer = require('multer');
const webpush = require('web-push');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE CONFIGURATION
// ============================================

// Security Headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "https://api.open-meteo.com", "https://nominatim.openstreetmap.org"],
            frameSrc: ["'self'"],
            fontSrc: ["'self'", "data:"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'", "blob:"],
            workerSrc: ["'self'", "blob:"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'slgp-fleet-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Serve Static Files
app.use(express.static('src', {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// ============================================
// RATE LIMITING
// ============================================

const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: 'Too many requests from this IP, please try again later.'
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: 'Too many uploads from this IP, please try again later.'
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many login attempts, please try again later.'
});

app.use('/api/', generalLimiter);

// ============================================
// EMAIL CONFIGURATION
// ============================================

// Main Fleet Email
const mainTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Incidents Email
const incidentsTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.INCIDENTS_EMAIL_USER,
        pass: process.env.INCIDENTS_PASS
    }
});

// SMTP Email (for custom domain)
const smtpTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// ============================================
// GOOGLE DRIVE CONFIGURATION
// ============================================

let driveClient = null;

function initializeDrive() {
    try {
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        
        driveClient = google.drive({ version: 'v3', auth });
        console.log('✅ Google Drive initialized successfully');
    } catch (error) {
        console.error('❌ Failed to initialize Google Drive:', error.message);
    }
}

initializeDrive();

// ============================================
// WEB PUSH CONFIGURATION
// ============================================

webpush.setVapidDetails(
    'mailto:' + process.env.EMAIL_USER,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

let pushSubscriptions = [];

// ============================================
// MULTER CONFIGURATION (File Uploads)
// ============================================

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024 // 500MB max
    }
});

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

function isAuthenticated(req, res, next) {
    // Skip auth for static files and certain routes
    if (req.path.startsWith('/login') || 
        req.path.startsWith('/api/login') ||
        req.path === '/manifest.json' ||
        req.path === '/sw.js' ||
        req.path.match(/\.(jpg|jpeg|png|gif|pdf|css|js)$/)) {
        return next();
    }
    
    if (req.session && req.session.authenticated) {
        return next();
    }
    
    res.redirect('/login.html');
}

// Apply authentication to all routes except login
app.use(isAuthenticated);

// ============================================
// ROUTES - AUTHENTICATION
// ============================================

app.post('/api/login', authLimiter, (req, res) => {
    const { password } = req.body;
    
    // Simple password authentication
    const correctPassword = process.env.PORTAL_PASSWORD || 'SLGP2025!';
    
    if (password === correctPassword) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ============================================
// ROUTES - GATE CHECKS
// ============================================

app.post('/log-gate-check', async (req, res) => {
    try {
        const { name } = req.body;
        const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        
        // Log to console
        console.log(`✅ Departure Gate: ${name} at ${timestamp}`);
        
        // Send email notification
        await mainTransporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: `Departure Gate Check - ${name}`,
            html: `
                <h2>Departure Gate Check</h2>
                <p><strong>Driver:</strong> ${name}</p>
                <p><strong>Time:</strong> ${timestamp}</p>
                <p><strong>Type:</strong> Departure</p>
            `
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Gate check error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/log-arrival-check', async (req, res) => {
    try {
        const { name } = req.body;
        const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        
        console.log(`✅ Arrival Gate: ${name} at ${timestamp}`);
        
        await mainTransporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: `Arrival Gate Check - ${name}`,
            html: `
                <h2>Arrival Gate Check</h2>
                <p><strong>Driver:</strong> ${name}</p>
                <p><strong>Time:</strong> ${timestamp}</p>
                <p><strong>Type:</strong> Arrival</p>
            `
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Arrival check error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ROUTES - REPORT SUBMISSION
// ============================================

app.post('/submit-report', async (req, res) => {
    try {
        const report = req.body;
        const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        
        console.log(`📋 Report Received: ${report.reportType} from ${report.driverName}`);
        
        // Prepare email attachments for photos
        const attachments = [];
        
        if (report.photos && report.photos.length > 0) {
            report.photos.forEach((photo, index) => {
                attachments.push({
                    filename: photo.name || `photo_${index + 1}.jpg`,
                    content: photo.data,
                    encoding: 'base64'
                });
            });
        }
        
        // Add signature if present
        if (report.signature) {
            attachments.push({
                filename: 'signature.png',
                content: report.signature,
                encoding: 'base64'
            });
        }
        
        // Build email content based on report type
        let emailHtml = '';
        let subject = '';
        
        if (report.reportType === 'ACCIDENT_REPORT') {
            subject = `🚨 ACCIDENT REPORT - ${report.driverName} - VIN ${report.vinLast4}`;
            emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f5f5f5; padding: 20px;">
                    <div style="background: #EF4444; color: white; padding: 20px; text-align: center;">
                        <h1 style="margin: 0;">⚠️ ACCIDENT REPORT</h1>
                    </div>
                    
                    <div style="background: white; padding: 20px; margin-top: 10px;">
                        <h2 style="color: #EF4444; border-bottom: 2px solid #EF4444; padding-bottom: 10px;">Driver Information</h2>
                        <p><strong>Driver Name:</strong> ${report.driverName}</p>
                        <p><strong>VIN Last 4:</strong> ${report.vinLast4}</p>
                        <p><strong>Email:</strong> ${report.driverEmail || 'Not provided'}</p>
                        <p><strong>Date/Time:</strong> ${report.date} ${report.time}</p>
                        
                        <h2 style="color: #EF4444; border-bottom: 2px solid #EF4444; padding-bottom: 10px; margin-top: 30px;">Incident Details</h2>
                        <p><strong>Type:</strong> ${report.incidentType}</p>
                        <p><strong>Location:</strong> ${report.locationData.street}, ${report.locationData.city}, ${report.locationData.state} ${report.locationData.zip}</p>
                        <p><strong>GPS:</strong> ${report.locationData.gpsLat}, ${report.locationData.gpsLng}</p>
                        <p><strong>Weather:</strong> ${report.weather}</p>
                        
                        <h2 style="color: #EF4444; border-bottom: 2px solid #EF4444; padding-bottom: 10px; margin-top: 30px;">Statement</h2>
                        <p style="background: #f9f9f9; padding: 15px; border-left: 4px solid #EF4444;">${report.statement}</p>
                        
                        <h2 style="color: #EF4444; border-bottom: 2px solid #EF4444; padding-bottom: 10px; margin-top: 30px;">Official Reports</h2>
                        <p><strong>Police Report #:</strong> ${report.policeReport}</p>
                        <p><strong>LMET Case #:</strong> ${report.lmetCase}</p>
                        
                        <h2 style="color: #EF4444; border-bottom: 2px solid #EF4444; padding-bottom: 10px; margin-top: 30px;">Checklist Acknowledgment</h2>
                        <ul>
                            ${report.checklist.map(item => `<li>${item}</li>`).join('')}
                        </ul>
                        
                        <h2 style="color: #EF4444; border-bottom: 2px solid #EF4444; padding-bottom: 10px; margin-top: 30px;">Affidavit</h2>
                        <p style="background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; font-size: 12px;">${report.affidavit}</p>
                        
                        <p style="margin-top: 30px; font-size: 12px; color: #666;">
                            <strong>Photos Attached:</strong> ${report.photos ? report.photos.length : 0}<br>
                            <strong>Signature:</strong> Attached
                        </p>
                    </div>
                </div>
            `;
        } else {
            // Issue Report
            subject = `🔧 ${report.reportType} - ${report.driverName} - VIN ${report.vinLast4}`;
            emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f5f5f5; padding: 20px;">
                    <div style="background: #2563EB; color: white; padding: 20px; text-align: center;">
                        <h1 style="margin: 0;">🔧 ISSUE REPORT</h1>
                    </div>
                    
                    <div style="background: white; padding: 20px; margin-top: 10px;">
                        <h2 style="color: #2563EB; border-bottom: 2px solid #2563EB; padding-bottom: 10px;">Driver Information</h2>
                        <p><strong>Driver Name:</strong> ${report.driverName}</p>
                        <p><strong>VIN Last 4:</strong> ${report.vinLast4}</p>
                        <p><strong>Vehicle Type:</strong> ${report.vehicleType}</p>
                        <p><strong>Date/Time:</strong> ${report.date} ${report.time}</p>
                        
                        <h2 style="color: #2563EB; border-bottom: 2px solid #2563EB; padding-bottom: 10px; margin-top: 30px;">Issue Details</h2>
                        <p><strong>Category:</strong> ${report.reportType}</p>
                        <p><strong>Selected Issues:</strong></p>
                        <ul>
                            ${report.tags.map(tag => `<li>${tag}</li>`).join('')}
                        </ul>
                        
                        ${report.otherDescription ? `
                            <h2 style="color: #2563EB; border-bottom: 2px solid #2563EB; padding-bottom: 10px; margin-top: 30px;">Additional Notes</h2>
                            <p style="background: #f9f9f9; padding: 15px; border-left: 4px solid #2563EB;">${report.otherDescription}</p>
                        ` : ''}
                        
                        ${report.addressStreet ? `
                            <h2 style="color: #2563EB; border-bottom: 2px solid #2563EB; padding-bottom: 10px; margin-top: 30px;">Location (MPH Error)</h2>
                            <p>${report.addressStreet}<br>${report.addressCity}, ${report.addressState}</p>
                        ` : ''}
                        
                        <p style="margin-top: 30px; font-size: 12px; color: #666;">
                            <strong>Photos Attached:</strong> ${report.photos ? report.photos.length : 0}
                        </p>
                    </div>
                </div>
            `;
        }
        
        // Send to Incidents email
        await incidentsTransporter.sendMail({
            from: process.env.INCIDENTS_EMAIL_USER,
            to: process.env.INCIDENTS_EMAIL_USER,
            subject: subject,
            html: emailHtml,
            attachments: attachments
        });
        
        // If accident and email provided, send Panel of Physicians
        if (report.reportType === 'ACCIDENT_REPORT' && report.driverEmail) {
            const panelPdfPath = path.join(__dirname, 'src', 'Panel_of_Physicians.pdf');
            
            if (fs.existsSync(panelPdfPath)) {
                await incidentsTransporter.sendMail({
                    from: process.env.INCIDENTS_EMAIL_USER,
                    to: report.driverEmail,
                    subject: 'Panel of Physicians - SLGP Fleet',
                    html: `
                        <h2>Panel of Physicians</h2>
                        <p>Dear ${report.driverName},</p>
                        <p>Attached is the Panel of Physicians document as requested.</p>
                        <p>If you have any questions, please contact dispatch immediately.</p>
                        <p><strong>Dispatch:</strong> 470-713-0953</p>
                    `,
                    attachments: [{
                        filename: 'Panel_of_Physicians.pdf',
                        path: panelPdfPath
                    }]
                });
            }
        }
        
        res.json({ success: true, message: 'Report submitted successfully' });
        
    } catch (error) {
        console.error('Report submission error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ROUTES - VIDEO UPLOAD TO GOOGLE DRIVE
// ============================================

app.post('/upload-to-google-drive', upload.single('video'), uploadLimiter, async (req, res) => {
    try {
        if (!driveClient) {
            throw new Error('Google Drive not initialized');
        }
        
        const { driverName, vin, inspectionType } = req.body;
        const videoFile = req.file;
        
        if (!videoFile) {
            throw new Error('No video file provided');
        }
        
        console.log(`📹 Uploading video: ${inspectionType} for ${driverName} (VIN: ${vin})`);
        
        // Create filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${inspectionType}_${driverName}_${vin}_${timestamp}.mp4`;
        
        // Upload to Google Drive
        const fileMetadata = {
            name: filename,
            parents: [process.env.GDRIVE_FOLDER_ID]
        };
        
        const media = {
            mimeType: 'video/mp4',
            body: require('stream').Readable.from(videoFile.buffer)
        };
        
        const driveResponse = await driveClient.files.create({
            requestBody: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink'
        });
        
        console.log(`✅ Video uploaded successfully: ${driveResponse.data.name}`);
        
        // Send email notification
        await mainTransporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.EMAIL_USER,
            subject: `📹 Video Inspection: ${inspectionType} - ${driverName}`,
            html: `
                <h2>Video Inspection Uploaded</h2>
                <p><strong>Driver:</strong> ${driverName}</p>
                <p><strong>VIN:</strong> ${vin}</p>
                <p><strong>Type:</strong> ${inspectionType}</p>
                <p><strong>Timestamp:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</p>
                <p><strong>File:</strong> ${driveResponse.data.name}</p>
                <p><a href="${driveResponse.data.webViewLink}" style="background: #2563EB; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 10px;">View Video</a></p>
            `
        });
        
        res.json({ 
            success: true, 
            fileId: driveResponse.data.id,
            fileName: driveResponse.data.name
        });
        
    } catch (error) {
        console.error('Video upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ROUTES - PUSH NOTIFICATIONS
// ============================================

app.get('/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/subscribe', (req, res) => {
    const subscription = req.body;
    pushSubscriptions.push(subscription);
    console.log('✅ New push subscription added');
    res.json({ success: true });
});

app.post('/send-notification', async (req, res) => {
    try {
        const { title, body } = req.body;
        
        const payload = JSON.stringify({
            title: title,
            body: body,
            icon: '/icon.jpg',
            badge: '/icon.jpg'
        });
        
        const results = await Promise.allSettled(
            pushSubscriptions.map(sub => webpush.sendNotification(sub, payload))
        );
        
        // Remove failed subscriptions
        pushSubscriptions = pushSubscriptions.filter((_, index) => 
            results[index].status === 'fulfilled'
        );
        
        res.json({ success: true, sent: results.filter(r => r.status === 'fulfilled').length });
        
    } catch (error) {
        console.error('Notification error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// ROUTES - VERSION CHECK (for auto-update)
// ============================================

const APP_VERSION = '2.0.0';

app.get('/version', (req, res) => {
    res.json({ version: APP_VERSION });
});

// ============================================
// ROUTES - ROUTING
// ============================================

app.get('/report', (req, res) => {
    const mode = req.query.mode;
    
    if (mode === 'accident') {
        res.sendFile(path.join(__dirname, 'src', 'accident.html'));
    } else if (mode === 'issue') {
        res.sendFile(path.join(__dirname, 'src', 'report-issue.html'));
    } else if (mode === 'insurance') {
        res.sendFile(path.join(__dirname, 'src', 'insurance.html'));
    } else {
        res.redirect('/');
    }
});

app.get('/video', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'video.html'));
});

app.get('/alerts', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'alerts.html'));
});

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'success.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'menu.html'));
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ 
        success: false, 
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message 
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   SLGP Fleet Manager Server          ║
    ║   Version: ${APP_VERSION}                   ║
    ╠═══════════════════════════════════════╣
    ║   Server running on port ${PORT}        ║
    ║   Environment: ${process.env.NODE_ENV || 'development'}          ║
    ╚═══════════════════════════════════════╝
    
    ✅ Express server initialized
    ✅ Email transporters configured
    ${driveClient ? '✅ Google Drive connected' : '❌ Google Drive failed'}
    ✅ Push notifications ready
    ✅ Rate limiting active
    ✅ Security headers enabled
    
    🌐 Access at: http://localhost:${PORT}
    `);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    process.exit(0);
});
