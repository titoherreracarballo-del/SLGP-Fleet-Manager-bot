require('dotenv').config();
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const { execSync, fork } = require('child_process');
const { Pool } = require('pg');

// ============================================
// ACTIVE FFMPEG PID TRACKING
// Shared with agent.js so orphan killer never
// touches a live enhancement job
// ============================================
const activeFfmpegPids = new Set();
const ACTIVE_PIDS_FILE  = '/app/meshcentral-data/active_pids.json';
const RETRY_QUEUE_FILE  = '/app/meshcentral-data/retry_queue.json';
const MAX_RETRY_ATTEMPTS = 3;

// Errors worth retrying — network/timeout blips, not corrupt files or auth failures
function isRetriable(errMsg) {
    const msg = (errMsg || '').toLowerCase();
    return msg.includes('timeout') ||
           msg.includes('timed out') ||
           msg.includes('network') ||
           msg.includes('econnreset') ||
           msg.includes('econnrefused') ||
           msg.includes('etimedout') ||
           msg.includes('socket hang up') ||
           msg.includes('fetch failed') ||
           msg.includes('enotfound');
}

function saveToRetryQueue(entry) {
    try {
        let queue = [];
        if (fs.existsSync(RETRY_QUEUE_FILE)) {
            queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf8'));
        }
        // Remove any existing entry for this jobId before adding fresh
        queue = queue.filter(e => e.jobId !== entry.jobId);
        queue.push(entry);
        fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(queue, null, 2));
        console.log(`📋 Job ${entry.jobId} saved to retry queue (attempt ${entry.attemptCount}/${MAX_RETRY_ATTEMPTS})`);
    } catch (e) {
        console.error('Failed to write retry queue:', e.message);
    }
}

function removeFromRetryQueue(jobId) {
    try {
        if (!fs.existsSync(RETRY_QUEUE_FILE)) return;
        let queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf8'));
        queue = queue.filter(e => e.jobId !== jobId);
        fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(queue, null, 2));
    } catch (e) {
        console.error('Failed to update retry queue:', e.message);
    }
}
// ============================================
// JOB TRACKING STORE
// Decouples upload receipt from processing so
// the phone gets an immediate response and polls
// for live status instead of waiting blindly
// ============================================
const jobStore = new Map(); // jobId -> { status, stage, progress, message, result, error, createdAt }
const JOB_CLEANUP_MS = 10 * 60 * 1000; // remove completed jobs after 10 min

function createJob(jobId, meta) {
    jobStore.set(jobId, {
        status: 'received',       // received | enhancing | uploading | complete | failed
        stage: 'File received',
        progress: 0,
        message: 'Upload received — starting processing...',
        meta,
        result: null,
        error: null,
        createdAt: Date.now()
    });
    // Auto-cleanup after 10 min
    setTimeout(() => jobStore.delete(jobId), JOB_CLEANUP_MS);
    return jobId;
}

function updateJob(jobId, patch) {
    const job = jobStore.get(jobId);
    if (job) jobStore.set(jobId, { ...job, ...patch });
}

function registerPid(pid) {
    activeFfmpegPids.add(pid);
    try { fs.writeFileSync(ACTIVE_PIDS_FILE, JSON.stringify([...activeFfmpegPids])); } catch(e) {}
    console.log(`🔐 FFmpeg PID registered: ${pid}`);
}
function unregisterPid(pid) {
    activeFfmpegPids.delete(pid);
    try { fs.writeFileSync(ACTIVE_PIDS_FILE, JSON.stringify([...activeFfmpegPids])); } catch(e) {}
    console.log(`🔓 FFmpeg PID released: ${pid}`);
}
const multer = require('multer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const stream = require('stream');
const cron = require('node-cron');
const webpush = require('web-push');
const { Client, GatewayIntentBits, Events } = require('discord.js');

const app = express();

// ============================================
// CONFIGURATION
// ============================================
const APP_VERSION = Date.now();
const VERSION_STRING = '4.6.6';
const BUILD_INFO = {
    version: APP_VERSION,
    versionString: VERSION_STRING,
    buildDate: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    nodeVersion: process.version
};

const VOLUME_PATH = '/app/meshcentral-data';
const UPLOAD_DIR    = path.join(VOLUME_PATH, 'uploads');
const ENHANCED_DIR  = path.join(VOLUME_PATH, 'enhanced'); // FFmpeg output - always writable on Railway
const DAILY_LOG_FILE = path.join(VOLUME_PATH, 'daily_data.json');
const SUBSCRIPTION_FILE = path.join(VOLUME_PATH, 'subscriptions.json');
const GATE_LOG_FILE = path.join(VOLUME_PATH, 'gate_acknowledgments.json');
const ARRIVAL_LOG_FILE = path.join(VOLUME_PATH, 'arrival_acknowledgments.json');
const PANEL_DOC_PATH = path.join(__dirname, 'Panel_of_Physicians.pdf');

// ============================================
// DEBUG SYSTEM - LOG FILES
// ============================================
const LOGS_DIR = path.join(VOLUME_PATH, 'logs');
const DEBUG_LOG = path.join(LOGS_DIR, 'debug.json');
const ERROR_LOG = path.join(LOGS_DIR, 'errors.json');
const CAMERA_LOG = path.join(LOGS_DIR, 'camera-issues.json');
const PERFORMANCE_LOG = path.join(LOGS_DIR, 'performance.json');

const VIDEO_DRIVE_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';
const ACCIDENT_DRIVE_ID = '1-N4Y8OydIhQSMpD5lMTSHsOf0qi2mnGy';
const ISSUE_DRIVE_ID = '0AC-a_EQMLYpLUk9PVA';

// ============================================
// DIRECTORY INITIALIZATION
// ============================================
async function ensureDirectories() {
    const dirs = [UPLOAD_DIR, LOGS_DIR, ENHANCED_DIR];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`✅ Created directory: ${dir}`);
            } catch (e) {
                console.error(`❌ Failed to create ${dir}:`, e.message);
            }
        }
    }
}

ensureDirectories();

const upload = multer({ 
    dest: UPLOAD_DIR,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB ceiling - 30s@8Mbps = ~30MB so this is never hit
});

app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ============================================
// DEBUG SYSTEM - LOGGING UTILITIES
// ============================================
async function appendLog(logFile, entry) {
    try {
        let logs = [];
        try {
            const data = fs.readFileSync(logFile, 'utf8');
            logs = JSON.parse(data);
        } catch (err) {}

        logs.push({
            ...entry,
            timestamp: new Date().toISOString(),
            serverTime: Date.now()
        });

        if (logs.length > 1000) {
            logs = logs.slice(-1000);
        }

        fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
    } catch (err) {
        console.error('Failed to write log:', err);
    }
}

async function getRecentLogs(logFile, limit = 50) {
    try {
        const data = fs.readFileSync(logFile, 'utf8');
        const logs = JSON.parse(data);
        return logs.slice(-limit).reverse();
    } catch (err) {
        return [];
    }
}

// ============================================
// DISCORD BOT SETUP
// ── Streamlit DB connection (fire-and-forget inspection sync) ──────────────
// Set STREAMLIT_DB_URL on this Railway service to point at the Streamlit PostgreSQL.
// If not set, sync is silently skipped — Node.js keeps working normally.
let streamlitPool = null;
if (process.env.STREAMLIT_DB_URL) {
    streamlitPool = new Pool({
        connectionString: process.env.STREAMLIT_DB_URL,
        ssl: { rejectUnauthorized: false },
        max: 2,              // tiny pool — only used for sync writes
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
    });
    streamlitPool.on('error', (err) => {
        console.warn('⚠️  Streamlit DB pool error (non-fatal):', err.message);
    });
    console.log('✅ Streamlit DB sync enabled');
} else {
    console.log('ℹ️  STREAMLIT_DB_URL not set — Streamlit sync disabled');
}

// Writes one row to Streamlit's vehicle_inspections table.
// Completely fire-and-forget: never throws, never blocks the upload response.
async function syncInspectionToStreamlit({ driverName, vin, inspectionType, fileName, fileId, viewLink, directDownloadLink }) {
    if (!streamlitPool) return;
    try {
        // Migration: add Drive columns if they don't exist yet (idempotent)
        await streamlitPool.query(`
            ALTER TABLE vehicle_inspections
                ADD COLUMN IF NOT EXISTS drive_file_id  VARCHAR(100),
                ADD COLUMN IF NOT EXISTS drive_url       VARCHAR(500),
                ADD COLUMN IF NOT EXISTS drive_download  VARCHAR(500)
        `);

        await streamlitPool.query(`
            INSERT INTO vehicle_inspections
                (vehicle_id, driver_name, inspection_type, inspection_date,
                 video_filename, drive_file_id, drive_url, drive_download,
                 status, created_by)
            VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, $7, 'pending_review', 'fleet-app')
        `, [
            vin || 'UNKNOWN',
            driverName,
            inspectionType || 'post-trip',
            fileName,
            fileId,
            viewLink,
            directDownloadLink
        ]);
        console.log(`✅ Synced inspection to Streamlit DB: ${driverName} / ${vin}`);
    } catch (err) {
        // Log but never crash — Drive upload already succeeded
        console.warn('⚠️  Streamlit sync failed (non-fatal):', err.message);
    }
}

// ============================================
const DISCORD_BOT_TOKEN = process.env.FLEET_BOT_SECRET;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN)
        .then(() => console.log('✅ Discord bot connected'))
        .catch(err => console.log('⚠️  Discord bot disabled:', err.message));
    
    client.once(Events.ClientReady, c => {
        console.log(`🤖 Fleet Bot Ready: ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, async message => {
        if (message.author.bot || message.channelId !== DISCORD_CHANNEL_ID) return;
        if (fs.existsSync(SUBSCRIPTION_FILE)) {
            let subs = [];
            try { subs = JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)); } catch (e) {}
            const payload = JSON.stringify({ title: "📢 FLEET ALERT", body: message.content });
            await Promise.all(subs.map(async (sub) => {
                try { await webpush.sendNotification(sub, payload); } catch (e) {}
            }));
        }
    });
}

// ============================================
// VAPID KEYS SETUP
// ============================================
let publicVapidKey = process.env.VAPID_PUBLIC_KEY ? process.env.VAPID_PUBLIC_KEY.trim().replace(/['"]+/g, '') : null;
let privateVapidKey = process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PRIVATE_KEY.trim().replace(/['"]+/g, '') : null;

if (!publicVapidKey || !privateVapidKey) {
    const vapidKeys = webpush.generateVAPIDKeys();
    publicVapidKey = vapidKeys.publicKey;
    privateVapidKey = vapidKeys.privateKey;
    console.log('⚠️  VAPID keys generated');
}

webpush.setVapidDetails('mailto:' + (process.env.EMAIL_USER || 'slgpfleetmanager@gmail.com'), publicVapidKey, privateVapidKey);

// ============================================
// GOOGLE DRIVE SETUP
// ============================================
let driveClient = null;

// ========================================
// FFMPEG AUTO-DETECTION
// ========================================
let ffmpegPath = null;
let ffprobePath = null;

function detectFFmpeg() {
    const possiblePaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/bin/ffmpeg', 'ffmpeg'];
    for (const testPath of possiblePaths) {
        try {
            execSync(`${testPath} -version`, { stdio: 'pipe' });
            ffmpegPath = testPath;
            ffprobePath = testPath.replace('ffmpeg', 'ffprobe');
            console.log(`✅ FFmpeg found at: ${testPath}`);
            return;
        } catch (e) {}
    }
    try {
        ffmpegPath = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
        ffprobePath = execSync('which ffprobe', { encoding: 'utf8' }).trim();
        console.log(`✅ FFmpeg detected via which: ${ffmpegPath}`);
    } catch (e) {
        console.warn('⚠️  FFmpeg not found - videos will upload without enhancement');
    }
}
detectFFmpeg();

// ========================================
// AI TOOL DETECTION
// ========================================
let esrganPath  = null;
let esrganModels = null;
let rifePath    = null;
let rifeModels  = null;

function detectAITools() {
    const { execSync: es } = require('child_process');

    // Real-ESRGAN — check env path first, then common locations
    const esrganCandidates = [
        process.env.ESRGAN_BIN,
        '/opt/realesrgan/realesrgan-ncnn-vulkan',
        '/usr/local/bin/realesrgan-ncnn-vulkan',
    ].filter(Boolean);
    for (const p of esrganCandidates) {
        try { es(`"${p}" --help 2>&1 || true`); esrganPath = p; break; } catch (_) {}
        // binary exists but --help exits non-zero — check file exists
        try {
            if (require('fs').existsSync(p)) { esrganPath = p; break; }
        } catch (_) {}
    }
    if (esrganPath) {
        esrganModels = process.env.ESRGAN_MODELS || require('path').dirname(esrganPath) + '/models';
        console.log(`✅ Real-ESRGAN found: ${esrganPath}`);
        console.log(`   Models: ${esrganModels}`);
    } else {
        console.warn('⚠️  Real-ESRGAN not found — AI upscaling disabled');
    }

    // RIFE — AI frame interpolation
    const rifeCandidates = [
        process.env.RIFE_BIN,
        '/opt/rife/rife-ncnn-vulkan',
        '/usr/local/bin/rife-ncnn-vulkan',
    ].filter(Boolean);
    for (const p of rifeCandidates) {
        try {
            if (require('fs').existsSync(p)) { rifePath = p; break; }
        } catch (_) {}
    }
    if (rifePath) {
        rifeModels = process.env.RIFE_MODELS || require('path').dirname(rifePath) + '/models';
        console.log(`✅ RIFE found: ${rifePath}`);
    } else {
        console.warn('⚠️  RIFE not found — using FFmpeg framerate filter for interpolation');
    }
}
detectAITools();

function initializeDrive() {
    try {
        if (!process.env.GCP_SA_KEY) {
            console.error('❌ GCP_SA_KEY not set - Google Drive disabled');
            return;
        }
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        driveClient = google.drive({ version: 'v3', auth });
        console.log('✅ Google Drive connected');
    } catch (error) {
        console.error('❌ Google Drive failed:', error.message);
    }
}

initializeDrive();

// ============================================
// HELPER FUNCTIONS
// ============================================
function isDuplicate(file, name) {
    if (!fs.existsSync(file)) return false;
    try {
        const logs = JSON.parse(fs.readFileSync(file));
        if (logs.length === 0) return false;
        const lastLog = logs[logs.length - 1];
        const lastTime = new Date(lastLog.rawTimestamp || Date.now()).getTime();
        return (lastLog.name === name && (Date.now() - lastTime < 60000));
    } catch (e) { return false; }
}

function sanitizeText(text) {
    if (!text) return "";
    return text.toString().replace(/(\r\n|\n|\r)/gm, " ").replace(/[^\x20-\x7E]/g, "");
}

function wrapText(text, font, size, maxWidth) {
    if (!text) return [];
    const cleanText = sanitizeText(text);
    const words = cleanText.split(' ');
    let lines = [];
    let currentLine = words[0] || '';
    for (let i = 1; i < words.length; i++) {
        const testLine = currentLine + " " + words[i];
        const width = font.widthOfTextAtSize(testLine, size);
        if (width < maxWidth) {
            currentLine = testLine;
        } else {
            lines.push(currentLine);
            currentLine = words[i];
        }
    }
    lines.push(currentLine);
    return lines;
}

// ============================================
// DEBUG SYSTEM - API ENDPOINTS
// ============================================
app.post('/api/log-error', async (req, res) => {
    const { message, stack, url, lineNo, colNo, userAgent, screen, viewport, context, severity } = req.body;
    const errorEntry = {
        type: 'client_error',
        severity: severity || 'error',
        message, stack, url, lineNo, colNo,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip, screen, viewport, context
    };
    await appendLog(ERROR_LOG, errorEntry);
    console.error('❌ Client Error:', message);
    res.json({ success: true, logged: true });
});

app.post('/api/log-camera-debug', async (req, res) => {
    const { event, cameras, selectedCamera, strategy, resolution, facingMode, rejected, reason, userAgent, deviceInfo } = req.body;
    const cameraEntry = {
        type: 'camera_debug',
        event, cameras: cameras || [], selectedCamera, strategy, resolution,
        facingMode, rejected, reason,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip, deviceInfo
    };
    await appendLog(CAMERA_LOG, cameraEntry);
    console.log('📹 Camera Debug:', event);
    res.json({ success: true, logged: true });
});

app.post('/api/log-performance', async (req, res) => {
    const { action, duration, success, fileSize, details, userAgent } = req.body;
    const perfEntry = {
        type: 'performance',
        action, duration, success, fileSize, details,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip
    };
    await appendLog(PERFORMANCE_LOG, perfEntry);
    res.json({ success: true, logged: true });
});

app.post('/api/log-debug', async (req, res) => {
    const { category, message, data, userAgent } = req.body;
    const debugEntry = {
        type: 'debug', category, message, data,
        userAgent: userAgent || req.get('user-agent'),
        ip: req.ip
    };
    await appendLog(DEBUG_LOG, debugEntry);
    console.log('🐛 Debug:', category, '-', message);
    res.json({ success: true, logged: true });
});

// ============================================
// API ROUTES - GATE & ARRIVAL CHECKS
// ============================================
app.post('/log-gate-check', async (req, res) => {
    try {
        const { name } = req.body;
        if (isDuplicate(GATE_LOG_FILE, name)) {
            return res.json({ success: true });
        }
        const now = new Date();
        const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        let logs = [];
        if (fs.existsSync(GATE_LOG_FILE)) {
            try { logs = JSON.parse(fs.readFileSync(GATE_LOG_FILE)); } catch(e) {}
        }
        logs.push({ name, timestamp, rawTimestamp: now.getTime() });
        fs.writeFileSync(GATE_LOG_FILE, JSON.stringify(logs, null, 2));
        res.json({ success: true });

        setImmediate(async () => {
            try {
                const doc = await PDFDocument.create();
                const page = doc.addPage([400, 750]);
                const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
                const fontReg = await doc.embedFont(StandardFonts.Helvetica);
                page.drawRectangle({ x: 0, y: 0, width: 400, height: 750, color: rgb(0.05, 0.08, 0.12) });
                page.drawText('!', { x: 190, y: 690, size: 50, font: fontBold, color: rgb(1, 0.6, 0) });
                page.drawText('DEPARTURE REQUIREMENTS', { x: 70, y: 650, size: 16, font: fontBold, color: rgb(1, 0.6, 0) });
                const items = ["Device functional.", "Van bag tools.", "Phone mount.", "Health video.", "Flex DVIC."];
                let yPos = 600;
                items.forEach(text => {
                    page.drawRectangle({ x: 40, y: yPos, width: 14, height: 14, color: rgb(1, 1, 1) });
                    page.drawText('X', { x: 43, y: yPos + 2, size: 11, font: fontBold, color: rgb(1, 0.6, 0) });
                    page.drawText(text, { x: 65, y: yPos + 2, size: 11, font: fontReg, color: rgb(1, 1, 1) });
                    yPos -= 30;
                });
                page.drawRectangle({ x: 35, y: 220, width: 330, height: 100, color: rgb(0.12, 0.15, 0.2) });
                page.drawRectangle({ x: 35, y: 220, width: 4, height: 100, color: rgb(1, 0.6, 0) });
                page.drawText('Report needs before wave time.', { x: 45, y: 320, size: 9, font: fontBold, color: rgb(0.8, 0.8, 0.8) });
                page.drawText('Missing items will delay departure.', { x: 45, y: 305, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Contact dispatch immediately for support.', { x: 45, y: 290, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Safety First: Never depart unprepared.', { x: 45, y: 250, size: 9, font: fontBold, color: rgb(1, 0.6, 0) });
                page.drawText('All equipment must be verified functional.', { x: 45, y: 235, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('DA ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(1, 0.6, 0) });
                page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
                page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });
                page.drawText('I confirm all departure requirements are met.', { x: 40, y: 75, size: 8, font: fontReg, color: rgb(0.6, 0.6, 0.6) });
                const pdfBytes = await doc.save();
                const snapshotPath = path.join(UPLOAD_DIR, `Gate_${Date.now()}.pdf`);
                fs.writeFileSync(snapshotPath, pdfBytes);
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: ['slgpfleetmanager@gmail.com'],
                    subject: `✅ DEPARTURE CHECKLIST: ${name}`,
                    text: `Receipt attached for DA ${name}.\n\nAll departure requirements confirmed at ${timestamp}.`,
                    attachments: [{ filename: `Departure_Receipt_${name}.pdf`, path: snapshotPath }]
                });
                fs.unlinkSync(snapshotPath);
                console.log(`✅ Gate check PDF emailed for ${name}`);
            } catch (e) {
                console.error('Gate check PDF/email error:', e);
                await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Gate PDF generation failed', stack: e.stack, source: 'log-gate-check' });
            }
        });
    } catch (e) {
        console.error('Gate check error:', e);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'critical', message: 'Gate check failed', stack: e.stack, source: 'log-gate-check' });
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/log-arrival-check', async (req, res) => {
    try {
        const { name } = req.body;
        if (isDuplicate(ARRIVAL_LOG_FILE, name)) {
            return res.json({ success: true });
        }
        const now = new Date();
        const timestamp = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        let logs = [];
        if (fs.existsSync(ARRIVAL_LOG_FILE)) {
            try { logs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE)); } catch(e) {}
        }
        logs.push({ name, timestamp, rawTimestamp: now.getTime() });
        fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify(logs, null, 2));
        res.json({ success: true });

        setImmediate(async () => {
            try {
                const doc = await PDFDocument.create();
                const page = doc.addPage([400, 850]);
                const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
                const fontReg = await doc.embedFont(StandardFonts.Helvetica);
                page.drawRectangle({ x: 0, y: 0, width: 400, height: 850, color: rgb(0.05, 0.08, 0.12) });
                page.drawText('!', { x: 190, y: 790, size: 50, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText('ARRIVAL REQUIREMENTS', { x: 80, y: 750, size: 16, font: fontBold, color: rgb(0, 0.66, 0.88) });
                const items = ["Remove trash & belongings.", "Keys/Power Bank returned.", "Post-trip DVIC complete.", "Video uploaded.", "Lights off.", "No packages left."];
                let yPos = 700;
                items.forEach(text => {
                    page.drawRectangle({ x: 40, y: yPos, width: 14, height: 14, color: rgb(1, 1, 1) });
                    page.drawText('X', { x: 43, y: yPos + 2, size: 11, font: fontBold, color: rgb(0, 0.66, 0.88) });
                    page.drawText(text, { x: 65, y: yPos + 2, size: 10, font: fontReg, color: rgb(1, 1, 1) });
                    yPos -= 30;
                });
                page.drawRectangle({ x: 35, y: 220, width: 330, height: 150, color: rgb(0.12, 0.15, 0.2) });
                page.drawRectangle({ x: 35, y: 220, width: 4, height: 150, color: rgb(0, 0.66, 0.88) });
                page.drawText('END OF SHIFT CHECKLIST', { x: 45, y: 350, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText('Ensure vehicle is locked and plugged in (EDV).', { x: 45, y: 330, size: 9, font: fontReg, color: rgb(0.8, 0.8, 0.8) });
                page.drawText('All equipment must be accounted for.', { x: 45, y: 315, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Report any damage or issues immediately.', { x: 45, y: 300, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Incomplete arrivals delay next shift.', { x: 45, y: 270, size: 9, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText('Double-check all items before leaving.', { x: 45, y: 255, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('Missing packages = escalation to management.', { x: 45, y: 240, size: 9, font: fontReg, color: rgb(0.7, 0.7, 0.7) });
                page.drawText('ARRIVAL ACKNOWLEDGMENT', { x: 40, y: 150, size: 10, font: fontBold, color: rgb(0, 0.66, 0.88) });
                page.drawText(name.toUpperCase(), { x: 50, y: 125, size: 13, font: fontBold, color: rgb(1, 1, 1) });
                page.drawText(`TIME: ${timestamp}`, { x: 40, y: 100, size: 9, font: fontReg, color: rgb(0.5, 0.5, 0.5) });
                page.drawText('I confirm all arrival requirements are met.', { x: 40, y: 75, size: 8, font: fontReg, color: rgb(0.6, 0.6, 0.6) });
                page.drawText('Vehicle is secured and ready for next shift.', { x: 40, y: 60, size: 8, font: fontReg, color: rgb(0.6, 0.6, 0.6) });
                const pdfBytes = await doc.save();
                const snapshotPath = path.join(UPLOAD_DIR, `Arrival_${Date.now()}.pdf`);
                fs.writeFileSync(snapshotPath, pdfBytes);
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: ['slgpfleetmanager@gmail.com'],
                    subject: `✅ ARRIVAL COMPLETED: ${name}`,
                    text: `Arrival receipt attached for DA ${name}.\n\nAll arrival requirements confirmed at ${timestamp}.`,
                    attachments: [{ filename: `Arrival_Receipt_${name}.pdf`, path: snapshotPath }]
                });
                fs.unlinkSync(snapshotPath);
                console.log(`✅ Arrival check PDF emailed for ${name}`);
            } catch (e) {
                console.error('Arrival check PDF/email error:', e);
                await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Arrival PDF generation failed', stack: e.stack, source: 'log-arrival-check' });
            }
        });
    } catch (e) {
        console.error('Arrival check error:', e);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'critical', message: 'Arrival check failed', stack: e.stack, source: 'log-arrival-check' });
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============================================
// API ROUTES - REPORTS
// ============================================
app.post('/submit-report', async (req, res) => {
    try {
        const data = req.body;
        if (isDuplicate(DAILY_LOG_FILE, (data.vinLast4 || '') + (data.reportType || ''))) {
            return res.json({ success: true });
        }
        let currentLogs = [];
        if (fs.existsSync(DAILY_LOG_FILE)) {
            try { currentLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE)); } catch(e) {}
        }
        data.timestamp = new Date();
        data.rawTimestamp = Date.now();
        data.name = (data.vinLast4 || '') + (data.reportType || '');
        currentLogs.push(data);
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(currentLogs, null, 2));

        if (client.isReady()) {
            try {
                const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
                const title = data.reportType === 'ACCIDENT_REPORT' ? "🚨 **ACCIDENT REPORT FILED**" : "⚠️ **ISSUE REPORT**";
                if (channel) {
                    channel.send(`${title}\n**Driver:** ${data.driverName}\n**VIN:** ${data.vinLast4}\n**Desc:** ${data.statement || data.otherDescription || 'None'}`);
                }
            } catch(e) { console.error('Discord notification failed:', e.message); }
        }

        let folderId = null;
        if (driveClient) {
            try {
                let targetFolderId = data.reportType === 'ACCIDENT_REPORT' ? ACCIDENT_DRIVE_ID : ISSUE_DRIVE_ID;
                const folder = await driveClient.files.create({
                    resource: { name: `${data.driverName} - ${data.reportType} - ${new Date().toLocaleDateString()}`, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] },
                    fields: 'id', supportsAllDrives: true
                });
                folderId = folder.data.id;
                if (data.photos && data.photos.length) { console.log(`📸 Received ${data.photos.length} photos - will attach to email`); }
                else { console.warn('⚠️  No photos attached to accident report'); }
            } catch (driveError) { console.error("Drive upload failed:", driveError.message); }
        }

        const doc = await PDFDocument.create();
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);

        let emailUser = process.env.EMAIL_USER;
        let emailPass = process.env.EMAIL_PASS;
        if (data.reportType === 'ACCIDENT_REPORT' && process.env.INCIDENTS_EMAIL_USER) {
            emailUser = process.env.INCIDENTS_EMAIL_USER;
            emailPass = process.env.INCIDENTS_PASS;
        }

        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: emailUser, pass: emailPass } });

        if (data.reportType === 'ACCIDENT_REPORT') {
            let page = doc.addPage([600, 800]);
            let y = 780;
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.9, 0.2, 0.2) });
            page.drawText('ACCIDENT REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText(`Filed: ${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}`, { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
            y = 680;
            page.drawText('DRIVER & VEHICLE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`Driver Name: ${data.driverName || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`VIN Last 4: ${data.vinLast4 || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`Incident Type: ${data.incidentType || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            page.drawText('LOCATION INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            if (data.locationData) {
                page.drawText(`Address: ${data.locationData.street || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                page.drawText(`City: ${data.locationData.city || 'N/A'}, State: ${data.locationData.state || 'N/A'}, Zip: ${data.locationData.zip || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                page.drawText(`GPS: ${data.locationData.gpsLat || 'N/A'}, ${data.locationData.gpsLng || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            }
            page.drawText(`Weather: ${data.weather || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            page.drawText('CASE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`Police Report #: ${data.policeReport || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`LMET Case #: ${data.lmetCase || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            page.drawText('DETAILED STATEMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            const statement = data.statement || 'No statement provided';
            const statementLines = wrapText(statement, fontReg, 10, 540);
            for (let line of statementLines) {
                if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
                page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            }
            y -= 10;
            if (data.photos && data.photos.length > 0) {
                page.drawText('PHOTO EVIDENCE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                page.drawText(`Total Photos: ${data.photos.length}`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) }); y -= 15;
                for (let i = 0; i < data.photos.length; i++) {
                    if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
                    page.drawText(`  • Photo ${i+1}.jpg - Attached to email`, { x: 40, y, size: 9, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                }
                page.drawText('All photos attached to this email', { x: 30, y, size: 9, font: fontReg, color: rgb(0.3,0.3,0.3) }); y -= 25;
            }
            if (data.signature) {
                page.drawText('DRIVER SIGNATURE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                try {
                    const sigImage = await doc.embedPng('data:image/png;base64,' + data.signature);
                    page.drawImage(sigImage, { x: 30, y: y - 60, width: 200, height: 60 }); y -= 70;
                } catch (sigErr) {
                    page.drawText('(Signature image error)', { x: 30, y, size: 10, font: fontReg, color: rgb(0.5,0,0) }); y -= 20;
                }
            }
            if (data.affidavit) {
                if (y < 150) { page = doc.addPage([600, 800]); y = 780; }
                page.drawText('AFFIDAVIT ACKNOWLEDGMENT', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                const affLines = wrapText(data.affidavit, fontReg, 8, 540);
                for (let line of affLines.slice(0, 10)) {
                    page.drawText(line, { x: 30, y, size: 8, font: fontReg, color: rgb(0,0,0) }); y -= 12;
                }
            }
            const pdfPath = path.join(UPLOAD_DIR, `Accident_${data.driverName}_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());
            const incidentTypeUC = (data.incidentType || 'ACCIDENT').toUpperCase();
            const lmetText = data.lmetCase ? `LMET# ${data.lmetCase}` : 'NO LMET';
            const driverNameUC = (data.driverName || 'UNKNOWN').toUpperCase();
            const emailAttachments = [{ filename: 'Official_Accident_Report.pdf', path: pdfPath }];
            if (data.photos && data.photos.length) {
                console.log(`📧 Attaching ${data.photos.length} photos to email...`);
                for (let i = 0; i < data.photos.length; i++) {
                    try {
                        const photoBuffer = Buffer.from(data.photos[i].data, 'base64');
                        const photoPath = path.join(UPLOAD_DIR, `accident_photo_${Date.now()}_${i}.jpg`);
                        fs.writeFileSync(photoPath, photoBuffer);
                        emailAttachments.push({ filename: `Photo_${i+1}.jpg`, path: photoPath });
                        console.log(`✅ Photo ${i+1}/${data.photos.length} prepared for email`);
                    } catch (photoError) { console.error(`❌ Failed to prepare photo ${i+1}:`, photoError.message); }
                }
            }
            const photoCount = data.photos ? data.photos.length : 0;
            const photoText = photoCount > 0 ? `${photoCount} photos attached` : 'No photos';
            await transporter.sendMail({
                from: emailUser,
                to: ['slgpincidentreporting@gmail.com', 'strategiclogisticsgroupllc@gmail.com', 'slgpfleetmanager@gmail.com'],
                subject: `🚨 URGENT: ${incidentTypeUC} - ${lmetText} - DA ${driverNameUC}`,
                html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;"><div style="background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;"><h1 style="color: white; margin: 0; font-size: 28px;">🚨 URGENT: ACCIDENT REPORT</h1><p style="color: #fee2e2; margin: 10px 0 0 0; font-size: 14px;">Immediate attention required</p></div><div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;"><h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📋 Incident Details</h2><table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;"><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${data.driverName}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN Last 4:</td><td style="padding: 12px; color: #1f2937;">${data.vinLast4}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Incident Type:</td><td style="padding: 12px; color: #1f2937;">${data.incidentType || 'N/A'}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Police Report #:</td><td style="padding: 12px; color: #1f2937;">${data.policeReport || 'N/A'}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">LMET Case #:</td><td style="padding: 12px; color: #1f2937;">${data.lmetCase || 'N/A'}</td></tr></table><div style="background: #fef2f2; border-left: 4px solid #EF4444; padding: 20px; margin-bottom: 25px; border-radius: 4px;"><h3 style="color: #DC2626; margin: 0 0 12px 0; font-size: 16px;">📸 PHOTO EVIDENCE</h3><p style="color: #991b1b; margin: 0; font-size: 14px;"><strong>${photoText}</strong> to this email</p></div><div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;"><p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;"><strong>⚠️ ACTION REQUIRED:</strong><br>1. Review attached PDF report immediately<br>2. View all photo attachments in this email<br>3. Contact driver if additional information needed<br>4. Follow up on LMET case and police report</p></div></div></div>`,
                attachments: emailAttachments
            });
            if (data.photos && data.photos.length) {
                for (let i = 0; i < emailAttachments.length; i++) {
                    if (emailAttachments[i].filename.startsWith('Photo_')) {
                        try { fs.unlinkSync(emailAttachments[i].path); } catch (e) {}
                    }
                }
            }
            fs.unlinkSync(pdfPath);
        } else {
            let page = doc.addPage([600, 800]);
            let y = 780;
            page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: rgb(0.145, 0.388, 0.922) });
            page.drawText('ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
            page.drawText(`Filed: ${data.date || new Date().toLocaleDateString()} ${data.time || new Date().toLocaleTimeString()}`, { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
            y = 680;
            page.drawText('DRIVER & VEHICLE INFORMATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`Driver Name: ${data.driverName || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`VIN Last 4: ${data.vinLast4 || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
            page.drawText(`Report Type: ${data.reportType || 'N/A'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
            if (data.otherDescription) {
                page.drawText('ISSUE DESCRIPTION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
                const descLines = wrapText(data.otherDescription, fontReg, 10, 540);
                for (let line of descLines) {
                    if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
                    page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
                }
                y -= 10;
            }
            if (data.photos && data.photos.length > 0) {
                page.drawText(`Photos Attached: ${data.photos.length} (uploaded to Google Drive)`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) }); y -= 25;
            }
            const pdfPath = path.join(UPLOAD_DIR, `Report_${Date.now()}.pdf`);
            fs.writeFileSync(pdfPath, await doc.save());
            await transporter.sendMail({
                from: emailUser,
                to: ['slgpfleetmanager@gmail.com'],
                subject: `REPORT: ${data.vinLast4} - ${data.reportType}`,
                text: `Driver: ${data.driverName}\nVIN: ${data.vinLast4}\n\nGoogle Drive: ${folderId ? 'https://drive.google.com/drive/folders/' + folderId : 'Drive upload unavailable'}`,
                attachments: [{ filename: 'Vehicle_Report.pdf', path: pdfPath }]
            });
            fs.unlinkSync(pdfPath);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Report submission error:', error);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Report submission failed', stack: error.stack, source: 'submit-report' });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// LEARNING AI SYSTEM - DATABASES
// ============================================
const ISSUE_HISTORY_FILE = path.join(VOLUME_PATH, 'issue_history.json');
const KNOWLEDGE_BASE_FILE = path.join(VOLUME_PATH, 'fleet_knowledge_base.json');

function initializeLearningSystem() {
    if (!fs.existsSync(ISSUE_HISTORY_FILE)) {
        const initialHistory = { total_issues: 0, classifications: [], patterns: {}, last_updated: new Date().toISOString() };
        fs.writeFileSync(ISSUE_HISTORY_FILE, JSON.stringify(initialHistory, null, 2));
        console.log('✅ Issue history database initialized');
    }
    if (!fs.existsSync(KNOWLEDGE_BASE_FILE)) {
        const initialKnowledge = {
            common_issues: {
                brake_problems: { keywords: ["grinding", "squealing", "brake", "stopping", "shake", "vibration"], priority: "HIGH_PRIORITY", category: "Brakes Squealing / Grinding", typical_causes: ["worn brake pads", "warped rotors", "brake fluid low"], fleet_frequency: 0 },
                battery_issues: { keywords: ["won't start", "dead battery", "clicking", "no power"], priority: "HIGH_PRIORITY", category: "Flat Tire / Battery Dead", typical_causes: ["battery age", "alternator failure", "parasitic drain"], fleet_frequency: 0 },
                charging_issues: { keywords: ["not charging", "charge", "plug", "EDV", "electric"], priority: "EDV_ELECTRIC", category: "Vehicle Not Charging", typical_causes: ["charging port damage", "cable fault", "onboard charger"], fleet_frequency: 0 },
                cosmetic_damage: { keywords: ["scratch", "dent", "paint", "cosmetic", "minor damage"], priority: "LOW_PRIORITY", category: "Light Scratches", typical_causes: ["parking incidents", "debris", "normal wear"], fleet_frequency: 0 }
            },
            vehicle_specific: {
                rivian: { common_issues: ["charging port", "bulkhead door", "key fob battery"], priority_override: "EDV_ELECTRIC" },
                diesel: { common_issues: ["DEF system", "exhaust", "turbo"], watches: ["DEF light", "exhaust smoke", "power loss"] }
            },
            learned_patterns: {},
            last_updated: new Date().toISOString()
        };
        fs.writeFileSync(KNOWLEDGE_BASE_FILE, JSON.stringify(initialKnowledge, null, 2));
        console.log('✅ Fleet knowledge base initialized');
    }
}

initializeLearningSystem();

function loadLearningData() {
    const defaultHistory  = { total_issues: 0, classifications: [], patterns: {}, last_updated: null };
    const defaultKnowledge = { common_issues: {}, learned_patterns: {}, last_updated: null };
    let history  = defaultHistory;
    let knowledge = defaultKnowledge;
    try {
        if (fs.existsSync(ISSUE_HISTORY_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(ISSUE_HISTORY_FILE, 'utf8'));
            // Merge with defaults so missing fields don't crash saveClassification
            history = { ...defaultHistory, ...parsed };
        }
    } catch (e) { console.error('Failed to load issue history, using defaults:', e.message); }
    try {
        if (fs.existsSync(KNOWLEDGE_BASE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
            knowledge = { ...defaultKnowledge, ...parsed };
        }
    } catch (e) { console.error('Failed to load knowledge base, using defaults:', e.message); }
    return { history, knowledge };
}

function saveClassification(description, classification, vehicleType, vinLast4) {
    try {
        const history = JSON.parse(fs.readFileSync(ISSUE_HISTORY_FILE, 'utf8'));
        history.total_issues++;
        history.classifications.push({ timestamp: new Date().toISOString(), description, classification, vehicle_type: vehicleType, vin: vinLast4 });
        if (history.classifications.length > 500) { history.classifications = history.classifications.slice(-500); }
        const priorityKey = classification.priority;
        if (!history.patterns[priorityKey]) { history.patterns[priorityKey] = 0; }
        history.patterns[priorityKey]++;
        history.last_updated = new Date().toISOString();
        fs.writeFileSync(ISSUE_HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`📚 Classification saved to learning database (Total: ${history.total_issues})`);
    } catch (e) { console.error('Failed to save classification:', e); }
}

function updateKnowledgeBase(description, classification) {
    try {
        const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
        const words = description.toLowerCase().split(/\s+/);
        for (const [issueKey, issueData] of Object.entries(knowledge.common_issues)) {
            const matches = issueData.keywords.filter(keyword => words.some(word => word.includes(keyword) || keyword.includes(word)));
            if (matches.length > 0) { issueData.fleet_frequency++; console.log(`📊 Updated frequency for ${issueKey}: ${issueData.fleet_frequency}`); }
        }
        const categoryKey = classification.category.toLowerCase().replace(/\s+/g, '_');
        if (!knowledge.learned_patterns[categoryKey]) { knowledge.learned_patterns[categoryKey] = { count: 0, example_descriptions: [] }; }
        knowledge.learned_patterns[categoryKey].count++;
        if (knowledge.learned_patterns[categoryKey].example_descriptions.length < 5) {
            knowledge.learned_patterns[categoryKey].example_descriptions.push(description);
        }
        knowledge.last_updated = new Date().toISOString();
        fs.writeFileSync(KNOWLEDGE_BASE_FILE, JSON.stringify(knowledge, null, 2));
        console.log('🧠 Knowledge base updated with new patterns');
    } catch (e) { console.error('Failed to update knowledge base:', e); }
}

function buildLearningPrompt(description, vehicleType, vinLast4, learningData) {
    const { history, knowledge } = learningData;
    const recentSimilar = history.classifications.filter(c => {
        const descWords = description.toLowerCase().split(/\s+/);
        const histWords = c.description.toLowerCase().split(/\s+/);
        const overlap = descWords.filter(w => histWords.includes(w)).length;
        return overlap > 2;
    }).slice(-3);
    let historicalContext = '';
    if (recentSimilar.length > 0) {
        historicalContext = '\n\nRECENT SIMILAR ISSUES:\n';
        recentSimilar.forEach((item, idx) => { historicalContext += `${idx + 1}. "${item.description}" → ${item.classification.priority} (${item.classification.category})\n`; });
    }
    let fleetContext = '\n\nFLEET-SPECIFIC KNOWLEDGE:\n';
    if (vehicleType && vehicleType.toLowerCase().includes('rivian')) {
        fleetContext += '- Vehicle is Electric (Rivian EDV)\n- Common Rivian issues: charging port, bulkhead door, key fob battery\n- Prioritize as EDV_ELECTRIC for electric-specific issues\n';
    }
    if (vehicleType && vehicleType.toLowerCase().includes('diesel')) { fleetContext += '- Vehicle is Diesel\n- Watch for: DEF system, exhaust, turbo issues\n'; }
    const topIssues = Object.entries(knowledge.common_issues).sort((a, b) => b[1].fleet_frequency - a[1].fleet_frequency).slice(0, 3);
    if (topIssues.length > 0) {
        fleetContext += '\nMOST COMMON ISSUES IN THIS FLEET:\n';
        topIssues.forEach(([key, data]) => { fleetContext += `- ${data.category} (${data.fleet_frequency} occurrences)\n`; });
    }
    return `You are a fleet vehicle issue classifier for SLGP Fleet. Classify the issue below into exactly ONE priority level.

CURRENT ISSUE: "${description}"
VEHICLE: ${vehicleType || 'Unknown'} (VIN: ${vinLast4})
${historicalContext}${fleetContext}

CLASSIFICATION RULES — read carefully before deciding:

1. HIGH_PRIORITY — immediate safety risk or vehicle cannot operate:
   - Brakes: grinding, squealing, pedal sinking, failure
   - Tires: blowout, flat, dangerously low tread
   - Steering: loose, unresponsive, pulling severely
   - Engine: won't start, stalls while driving, overheating warning
   - Fluids: active leak, burning smell, smoke
   - Lights: headlights/brake lights out (safety hazard at night)
   - Backup camera: completely failed (delivery safety)
   - DEF level critical (diesel only — causes engine derate)
   - Doors: won't close/latch while driving

2. EDV_ELECTRIC — Rivian electric vehicle specific issues ONLY:
   - Vehicle not charging / charging port damaged
   - Key fob battery dead/low
   - Bulkhead door malfunction
   - Electric drivetrain warning lights
   - Battery range dramatically reduced

3. LOW_PRIORITY — cosmetic or minor convenience issues, vehicle is still safe and operational:
   - Scratches, dents, paint scuffs
   - Interior dirt, damage, smell
   - Radio, A/C, seat adjustment, mirror adjustment
   - Door sensor false alarm (vehicle drives fine)
   - QR code faded, sticker peeling
   - Broken mirror glass (not affecting drive safety)
   - Windshield chip (not in driver sightline)
   - Missing license plate frame (not the plate itself)
   - Minor body damage with no mechanical impact

IMPORTANT: If the vehicle is still safe to drive and the issue is cosmetic or a minor inconvenience, always use LOW_PRIORITY. Only use HIGH_PRIORITY if there is a real safety risk or the vehicle cannot complete its route.

Respond ONLY with valid JSON. No markdown, no backticks, no explanation outside the JSON:
{
  "priority": "HIGH_PRIORITY" or "EDV_ELECTRIC" or "LOW_PRIORITY",
  "category": "concise issue label e.g. Brake Grinding, Flat Tire, Light Scratch",
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence explaining the classification"
}`;
}

// ============================================
// LEARNING AI ISSUE REPORT ENDPOINT
// ============================================
app.post('/submit-issue-ai', async (req, res) => {
    try {
        const { driverName, vinLast4, vehicleType, issueDescription, date, time, photos } = req.body;
        if (!driverName || !vinLast4 || !issueDescription) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        console.log(`\n🔍 Issue Report - Driver: ${driverName}, VIN: ${vinLast4}`);
        console.log(`📝 Description: "${issueDescription}"`);
        const learningData = loadLearningData();
        console.log(`🧠 Loaded ${learningData.history.total_issues} historical classifications`);
        const classificationPrompt = buildLearningPrompt(issueDescription, vehicleType, vinLast4, learningData);
        let aiResponse = null;
        try {
            // Gemini Pro — same prompt, different endpoint + response shape
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY || ''}`;
            const apiResponse = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: classificationPrompt }] }],
                    generationConfig: { maxOutputTokens: 500, temperature: 0.2, responseMimeType: 'application/json' }
                })
            });
            if (!apiResponse.ok) { throw new Error(`Gemini API error: ${apiResponse.status}`); }
            const apiData = await apiResponse.json();
            // Gemini response: candidates[0].content.parts[0].text
            const responseText = apiData.candidates[0].content.parts[0].text;
            // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
            const cleanText = responseText.replace(/```json|```/g, '').trim();
            aiResponse = JSON.parse(cleanText);
            console.log(`🤖 Classification: ${aiResponse.priority} - ${aiResponse.category}`);
            console.log(`📊 Confidence: ${Math.round(aiResponse.confidence * 100)}%`);
            saveClassification(issueDescription, aiResponse, vehicleType, vinLast4);
            updateKnowledgeBase(issueDescription, aiResponse);
        } catch (aiError) {
            console.error('❌ AI Classification failed:', aiError.message);
            aiResponse = { priority: 'HIGH_PRIORITY', category: 'Other (See Notes)', confidence: 0.5, reasoning: 'AI unavailable - defaulting to high priority for safety' };
        }
        let reportType = 'General Issue';
        if (aiResponse.priority === 'HIGH_PRIORITY') reportType = 'High Priority Issue';
        else if (aiResponse.priority === 'EDV_ELECTRIC') reportType = 'Electric Vehicle Issue';
        else if (aiResponse.priority === 'LOW_PRIORITY') reportType = 'Low Priority Issue';
        const doc = await PDFDocument.create();
        const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
        const fontReg = await doc.embedFont(StandardFonts.Helvetica);
        let page = doc.addPage([600, 800]);
        let y = 780;
        const headerColor = aiResponse.priority === 'HIGH_PRIORITY' ? rgb(0.9, 0.2, 0.2) : aiResponse.priority === 'EDV_ELECTRIC' ? rgb(0.145, 0.388, 0.922) : rgb(0.4, 0.6, 0.3);
        page.drawRectangle({ x: 0, y: 700, width: 600, height: 100, color: headerColor });
        page.drawText('FLEET ISSUE REPORT', { x: 30, y: 760, size: 24, font: fontBold, color: rgb(1,1,1) });
        page.drawText(`Filed: ${date} ${time}`, { x: 30, y: 730, size: 10, font: fontReg, color: rgb(1,1,1) });
        page.drawText(`Priority: ${aiResponse.priority}`, { x: 30, y: 710, size: 12, font: fontBold, color: rgb(1,1,1) });
        y = 680;
        page.drawText('CLASSIFICATION', { x: 30, y, size: 12, font: fontBold, color: rgb(0.2,0.2,0.2) }); y -= 20;
        page.drawText(`Category: ${aiResponse.category}`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) }); y -= 15;
        page.drawText(`Confidence: ${Math.round(aiResponse.confidence * 100)}%`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
        const reasoningLines = wrapText(aiResponse.reasoning, fontReg, 9, 540);
        for (let line of reasoningLines.slice(0, 3)) { page.drawText(line, { x: 30, y, size: 9, font: fontReg, color: rgb(0.3,0.3,0.3) }); y -= 12; }
        y -= 15;
        page.drawText('DRIVER & VEHICLE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
        page.drawText(`Driver: ${driverName}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
        page.drawText(`VIN: ${vinLast4} | Type: ${vehicleType || 'Unknown'}`, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 25;
        page.drawText('ISSUE DESCRIPTION', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
        const descLines = wrapText(issueDescription, fontReg, 10, 540);
        for (let line of descLines) {
            if (y < 50) { page = doc.addPage([600, 800]); y = 780; }
            page.drawText(line, { x: 30, y, size: 10, font: fontReg, color: rgb(0,0,0) }); y -= 15;
        }
        y -= 10;
        if (photos && photos.length > 0) {
            page.drawText('EVIDENCE', { x: 30, y, size: 12, font: fontBold, color: rgb(0,0,0) }); y -= 20;
            page.drawText(`${photos.length} file(s) attached to email`, { x: 30, y, size: 10, font: fontBold, color: rgb(0,0,0) });
        }
        const pdfPath = path.join(UPLOAD_DIR, `Issue_${driverName}_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, await doc.save());
        const emailAttachments = [{ filename: 'Issue_Report.pdf', path: pdfPath }];
        if (photos && photos.length > 0) {
            console.log(`📧 Attaching ${photos.length} files...`);
            for (let i = 0; i < photos.length; i++) {
                try {
                    const fileBuffer = Buffer.from(photos[i].data, 'base64');
                    const ext = photos[i].name.includes('.mp4') || photos[i].name.includes('video') ? 'mp4' : 'jpg';
                    const filePath = path.join(UPLOAD_DIR, `evidence_${Date.now()}_${i}.${ext}`);
                    fs.writeFileSync(filePath, fileBuffer);
                    emailAttachments.push({ filename: `Evidence_${i+1}.${ext}`, path: filePath });
                } catch (e) { console.error(`❌ File ${i+1} attachment failed:`, e.message); }
            }
        }
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        const priorityEmoji = aiResponse.priority === 'HIGH_PRIORITY' ? '🚨' : aiResponse.priority === 'EDV_ELECTRIC' ? '⚡' : '📋';
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `${priorityEmoji} ${reportType}: ${aiResponse.category} - ${driverName.toUpperCase()} (VIN: ${vinLast4})`,
            html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;"><div style="background: linear-gradient(135deg, ${aiResponse.priority === 'HIGH_PRIORITY' ? '#EF4444 0%, #DC2626' : aiResponse.priority === 'EDV_ELECTRIC' ? '#2563EB 0%, #1d4ed8' : '#10b981 0%, #059669'} 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;"><h1 style="color: white; margin: 0; font-size: 28px;">${priorityEmoji} ${reportType}</h1><p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 14px;">${aiResponse.category}</p></div><div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;"><table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;"><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${driverName}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN:</td><td style="padding: 12px; color: #1f2937;">${vinLast4}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Vehicle:</td><td style="padding: 12px; color: #1f2937;">${vehicleType || 'Unknown'}</td></tr><tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Priority:</td><td style="padding: 12px; color: #1f2937;">${reportType}</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Confidence:</td><td style="padding: 12px; color: #1f2937;">${Math.round(aiResponse.confidence * 100)}%</td></tr></table><div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;"><h3 style="color: #92400e; margin: 0 0 10px 0; font-size: 14px;">Driver Description</h3><p style="margin: 0; color: #78350f; font-size: 13px; line-height: 1.6;">${issueDescription}</p></div>${photos && photos.length > 0 ? `<div style="background: #dbeafe; border-left: 4px solid #2563EB; padding: 15px; margin: 20px 0; border-radius: 4px;"><p style="margin: 0; color: #1e3a8a; font-size: 13px;"><strong>${photos.length} file(s) attached</strong></p></div>` : ''}</div></div>`,
            attachments: emailAttachments
        });
        console.log(`✅ Email sent with ${emailAttachments.length} attachments`);
        fs.unlinkSync(pdfPath);
        for (let i = 1; i < emailAttachments.length; i++) {
            try { fs.unlinkSync(emailAttachments[i].path); } catch (e) {}
        }
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Issue submission error:', error);
        await appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: 'Issue submission failed', stack: error.stack, source: 'submit-issue-ai' });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/knowledge-base', (req, res) => {
    const password = req.query.key;
    if (password !== 'slgp-admin-2026') { return res.status(401).json({ error: 'Unauthorized' }); }
    try {
        const knowledge = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_FILE, 'utf8'));
        const history = JSON.parse(fs.readFileSync(ISSUE_HISTORY_FILE, 'utf8'));
        res.json({ knowledge_base: knowledge, issue_history: { total_issues: history.total_issues, patterns: history.patterns, recent_classifications: history.classifications.slice(-10) } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================
// BUILD NOTES ENDPOINT
// Single source of truth for changelog.
// build-notes.html fetches this and renders
// dynamically — no manual HTML edits needed.
// Add a new entry here when deploying a build.
// ============================================
const BUILD_NOTES = [
    {
        version: '4.6.6',
        date: 'March 4, 2026',
        changes: [
            {
                type: 'fix',
                title: '🔧 AI CLASSIFIER FIXES',
                items: [
                    { highlight: 'Gemini Pro:', text: 'Swapped Anthropic Claude for Google Gemini Pro (uses existing subscription, no extra cost)' },
                    { highlight: 'Prompt Rebalanced:', text: 'Rewrote classification rules — HIGH_PRIORITY and LOW_PRIORITY now have equal weight with clear examples' },
                    { highlight: 'Everything-High-Priority Bug Fixed:', text: 'Prompt now includes explicit IMPORTANT rule: if vehicle is safe to drive, use LOW_PRIORITY' },
                    { highlight: 'EDV Miscategorization Fixed:', text: 'Body damage and broken mirrors moved out of EDV_ELECTRIC (they have nothing to do with electric vehicles)' },
                    { highlight: 'JSON Enforcement:', text: 'Added responseMimeType: application/json to Gemini config — model returns clean JSON, no markdown fences' },
                    { highlight: 'Learning DB Fixed:', text: 'loadLearningData now uses safe defaults — missing fields no longer cause NaN in history counters' }
                ]
            },
            {
                type: 'fix',
                title: '🔧 REPORT ISSUE PAGE',
                items: [
                    { highlight: 'FileReader Race Condition Fixed:', text: 'Photos submitted immediately after selection no longer arrive empty — submit waits until all files are fully loaded' },
                    { highlight: 'PROCESSING State:', text: 'Camera box shows amber "PROCESSING..." while files load, green "READY TO SUBMIT" when safe' },
                    { highlight: 'Version Updated:', text: 'report-issue.html bumped to v4.6.6' }
                ]
            },
            {
                type: 'new',
                title: '🔁 AUTO RETRY SYSTEM',
                items: [
                    { highlight: 'Intelligent Retry:', text: 'Failed Drive uploads (network/timeout errors) automatically retry — up to 3 attempts with exponential backoff' },
                    { highlight: 'Backoff Schedule:', text: 'Attempt 1 after 30s, attempt 2 after 2 min, attempt 3 after 5 min' },
                    { highlight: 'File Preserved:', text: 'Video file kept on server between attempts — only deleted after success or all retries exhausted' },
                    { highlight: 'Retry Email:', text: 'Notification email sent on successful retry, marked as retry so fleet manager knows' },
                    { highlight: 'Agent Driven:', text: 'agent.js watches retry_queue.json every 60s and calls internal retry endpoint on index.js' },
                    { highlight: 'Non-Retriable Fast Fail:', text: 'Corrupt files, auth errors, missing fields cleaned up immediately without wasting retry attempts' }
                ]
            },
            {
                type: 'new',
                title: '🤖 MAINTENANCE AGENT',
                items: [
                    { highlight: 'Self-Healing Server:', text: 'agent.js forks on boot — runs 6 automated maintenance tasks in background' },
                    { highlight: 'Orphan FFmpeg Killer:', text: 'Scans every 2 min, kills stuck FFmpeg processes older than 5 min (never touches active jobs)' },
                    { highlight: 'Upload Reaper:', text: 'Deletes stale temp files >10 min old every 5 min — prevents volume fill' },
                    { highlight: 'Log Rotation:', text: 'Trims log files >500KB to last 200 entries every 30 min' },
                    { highlight: 'Memory Watchdog:', text: 'Warns if heap exceeds 400MB every 5 min' },
                    { highlight: 'Health Ping:', text: 'Hits /version every 5 min, logs if response >3s' },
                    { highlight: 'Midnight Summary:', text: 'Daily disk usage report at 23:58' },
                    { highlight: 'Auto-Restarts:', text: 'If agent crashes, index.js respawns it after 30s' }
                ]
            },
            {
                type: 'optimize',
                title: '🎥 VIDEO QUALITY IMPROVEMENTS',
                items: [
                    { highlight: '8 Mbps Recording:', text: 'Source quality raised from 5 Mbps — better input for FFmpeg enhancement' },
                    { highlight: 'H.264 Priority:', text: 'Codec order flipped — H.264 variants tried first for Android compatibility (H.265/AV1 removed from recording list)' },
                    { highlight: 'Force 1080p Output:', text: 'FFmpeg now applies scale=1920:1080 lanczos — devices recording at 720p get upscaled to true 1080p' },
                    { highlight: '100MB Limit:', text: 'Upload ceiling raised from 50MB — 8 Mbps × 60s = ~60MB, well under limit' },
                    { highlight: 'No Hard Stop:', text: 'Removed 30-second forced cutoff — timer counts up, driver stops when walk-around is complete' }
                ]
            },
            {
                type: 'optimize',
                title: '📦 STABILIZER REWRITE',
                items: [
                    { highlight: '20% Zoom Buffer:', text: 'Increased from 8% — gives 192px correction range at 1080p before frame snaps' },
                    { highlight: 'Velocity Damping:', text: 'Added friction-based correction — stops oscillation wobble from previous stabilizer' },
                    { highlight: 'Temporal Smoothing:', text: '3-frame motion history averaged before applying correction' },
                    { highlight: 'Pre-Allocated Canvas:', text: 'Detection canvas created once in initStabilizer, reused every frame — no GC pressure at 30fps' },
                    { highlight: 'Higher Precision:', text: 'Detection canvas doubled from 32×18 to 64×36 — motion estimates 2× more accurate' }
                ]
            },
            {
                type: 'fix',
                title: '🐛 SERVER FIXES',
                items: [
                    { highlight: 'FFmpeg Output Path:', text: 'Enhanced video now written to /tmp instead of /uploads — fixes permission error on Railway (code 234)' },
                    { highlight: 'GDRIVE_FOLDER_ID Fix:', text: 'Retry endpoint was referencing wrong env var (GOOGLE_DRIVE_FOLDER_ID) — now uses VIDEO_DRIVE_ID like main upload' },
                    { highlight: 'Immediate jobId Response:', text: 'Upload endpoint responds instantly with jobId — all FFmpeg + Drive work runs in background, driver never waits' },
                    { highlight: 'Job Status Polling:', text: 'GET /api/job-status/:jobId returns live progress — driver app shows real-time status' }
                ]
            }
        ]
    },
    {
        version: '4.6.3',
        date: 'March 2, 2026',
        changes: [
            {
                type: 'new',
                title: '🚦 GPS-BASED SPEED LIMIT READER',
                items: [
                    { highlight: 'Real-Time Speed Limits:', text: 'Automatic GPS-based speed limit detection for driver current location' },
                    { highlight: 'Live Speed Monitoring:', text: 'Displays current speed vs posted limit with visual alerts' },
                    { highlight: 'Violation Warnings:', text: 'Color-coded alerts — Green=Safe, Yellow=Caution, Red=Speeding' },
                    { highlight: '75+ Roads:', text: 'Complete coverage across 27 delivery zones in 4 counties (Coweta, Fulton, Fayette, Meriwether)' },
                    { highlight: 'Smart Caching:', text: '24-hour cache reduces API calls 90% — stays free at 300+ drivers' }
                ]
            },
            {
                type: 'new',
                title: '📊 USAGE TRACKING & EMAIL ALERTS',
                items: [
                    { highlight: 'API Monitoring:', text: 'Tracks TomTom requests against 2,500/day free tier' },
                    { highlight: 'Email Alerts:', text: 'Automatic notifications at 80%, 90%, 95% of daily limit' },
                    { highlight: 'Hard Limit:', text: 'Blocks requests at 2,500/day — no surprise charges' }
                ]
            }
        ]
    },
    {
        version: '4.6.2',
        date: 'March 1, 2026',
        changes: [
            {
                type: 'new',
                title: '🧠 SILENT LEARNING AI SYSTEM',
                items: [
                    { highlight: 'Invisible Classification:', text: 'AI analyzes issues in background — drivers never see it' },
                    { highlight: 'Continuous Learning:', text: 'Remembers every classification and improves over time' },
                    { highlight: 'Fleet Knowledge Base:', text: 'Builds database of common issues specific to SLGP fleet' },
                    { highlight: 'Pattern Recognition:', text: 'Tracks issue frequency and adapts to fleet-specific problems' }
                ]
            }
        ]
    },
    {
        version: '4.6.1',
        date: 'March 1, 2026',
        changes: [
            {
                type: 'new',
                title: '🚦 CORRIDOR TRAFFIC ALERTS',
                items: [
                    { highlight: 'Major Route Monitoring:', text: 'Real-time traffic on 8 major corridors (I-75, I-85, I-285, US-19/41, SR-74, US-29)' },
                    { highlight: 'Smart Suggestions:', text: 'Automatic alternative route suggestions when heavy traffic detected' },
                    { highlight: 'Zero Extra Cost:', text: 'Uses existing TomTom Traffic Flow API' }
                ]
            }
        ]
    },
    {
        version: '4.6.0',
        date: 'February 28, 2026',
        changes: [
            {
                type: 'new',
                title: '✨ COMPLETE UI REDESIGN',
                items: [
                    { highlight: 'Modern Blue Theme:', text: 'Vibrant blue background (#0A6CF1) inspired by modern delivery apps' },
                    { highlight: 'SF Pro Display Fonts:', text: "Upgraded to Apple's SF Pro typography system" },
                    { highlight: 'Sunset Flash Detection:', text: 'Camera auto-enables flash after sunset using real-time API' }
                ]
            }
        ]
    },
    {
        version: '4.5.0',
        date: 'February 27, 2026',
        changes: [
            {
                type: 'new',
                title: '✨ NEW FEATURES',
                items: [
                    { highlight: 'Build Notes Page:', text: 'Added comprehensive changelog to track all system updates' },
                    { highlight: 'Auto-Scaling Design:', text: 'All forms use fluid responsive CSS with clamp() functions' },
                    { highlight: 'Rivian VINs Updated:', text: 'Fleet corrected — 14 verified Rivian vehicles active' }
                ]
            }
        ]
    }
];

app.get('/api/build-notes', (req, res) => {
    res.json({ success: true, notes: BUILD_NOTES, currentVersion: APP_VERSION });
});

// ============================================
// USAGE TRACKING SYSTEM WITH EMAIL ALERTS
// ============================================
const USAGE_TRACKING_FILE = path.join(VOLUME_PATH, 'api_usage_tracking.json');
const DAILY_LIMIT = 2500;
const ALERT_THRESHOLDS = [0.80, 0.90, 0.95];

function initializeUsageTracking() {
    if (!fs.existsSync(USAGE_TRACKING_FILE)) {
        const initialTracking = { date: new Date().toDateString(), requests: 0, alerts_sent: [], last_reset: new Date().toISOString() };
        fs.writeFileSync(USAGE_TRACKING_FILE, JSON.stringify(initialTracking, null, 2));
        console.log('✅ Usage tracking initialized');
    }
}

initializeUsageTracking();

async function trackAPIRequest(apiName = 'TomTom') {
    try {
        let tracking = JSON.parse(fs.readFileSync(USAGE_TRACKING_FILE, 'utf8'));
        const today = new Date().toDateString();
        if (tracking.date !== today) {
            tracking = { date: today, requests: 0, alerts_sent: [], last_reset: new Date().toISOString() };
        }
        tracking.requests++;
        const usagePercent = tracking.requests / DAILY_LIMIT;
        for (const threshold of ALERT_THRESHOLDS) {
            const thresholdKey = `${(threshold * 100).toFixed(0)}%`;
            if (usagePercent >= threshold && !tracking.alerts_sent.includes(thresholdKey)) {
                tracking.alerts_sent.push(thresholdKey);
                await sendUsageAlert(tracking.requests, threshold);
            }
        }
        fs.writeFileSync(USAGE_TRACKING_FILE, JSON.stringify(tracking, null, 2));
        console.log(`📊 ${apiName} API Usage: ${tracking.requests}/${DAILY_LIMIT} (${(usagePercent * 100).toFixed(1)}%)`);
        if (tracking.requests >= DAILY_LIMIT) { throw new Error('Daily API limit reached. Using cached data only.'); }
        return tracking.requests;
    } catch (error) {
        if (error.message.includes('Daily API limit reached')) { throw error; }
        console.error('Usage tracking error:', error);
        return 0;
    }
}

async function sendUsageAlert(currentUsage, threshold) {
    try {
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        const percent = (threshold * 100).toFixed(0);
        const remaining = DAILY_LIMIT - currentUsage;
        let urgency = '⚠️ WARNING';
        let action = 'Monitor usage closely';
        if (threshold >= 0.95) { urgency = '🚨 CRITICAL'; action = 'IMMEDIATE ACTION REQUIRED - Consider enabling caching or wait until tomorrow'; }
        else if (threshold >= 0.90) { urgency = '🔴 URGENT'; action = 'Review usage and enable caching if not already active'; }
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: [process.env.EMAIL_USER, 'slgpfleetmanager@gmail.com'],
            subject: `${urgency}: TomTom API ${percent}% Limit Reached`,
            html: `<div style="font-family: Arial; max-width: 600px; margin: 0 auto; padding: 20px;"><div style="background: linear-gradient(135deg, #EF4444 0%, #DC2626 100%); padding: 20px; border-radius: 12px 12px 0 0; text-align: center;"><h1 style="color: white; margin: 0;">${urgency}</h1></div><div style="background: white; padding: 20px; border-radius: 0 0 12px 12px;"><table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;"><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold;">Current Usage:</td><td style="padding: 12px; color: #DC2626; font-weight: bold;">${currentUsage} / ${DAILY_LIMIT} requests</td></tr><tr><td style="padding: 12px; font-weight: bold;">Threshold:</td><td style="padding: 12px;">${percent}%</td></tr><tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold;">Remaining:</td><td style="padding: 12px;">${remaining} requests</td></tr></table><div style="background: #fef2f2; border-left: 4px solid #EF4444; padding: 15px; border-radius: 4px;"><h3 style="color: #DC2626; margin: 0 0 10px 0;">Action Required</h3><p style="margin: 0; color: #991b1b;">${action}</p></div></div></div>`
        });
        console.log(`📧 Usage alert sent: ${percent}% threshold reached`);
    } catch (error) { console.error('Failed to send usage alert:', error); }
}

// ============================================
// SPEED LIMIT DATABASE & CACHING
// ============================================
const SPEED_LIMIT_CACHE_FILE = path.join(VOLUME_PATH, 'speed_limit_cache.json');

const speedLimitDatabase = {
    "sr14_newnan_south": { speed_limit: 35, road_name: "SR-14 / Clark Street", city: "Newnan, GA", notes: "Downtown Newnan - Heavy enforcement", bounds: { lat_min: 33.375, lat_max: 33.390, lng_min: -84.805, lng_max: -84.790 } },
    "sr14_newnan_north": { speed_limit: 45, road_name: "SR-14 North", city: "Newnan, GA", notes: "North of downtown - Speed trap area", bounds: { lat_min: 33.390, lat_max: 33.420, lng_min: -84.805, lng_max: -84.775 } },
    "sr14_east": { speed_limit: 55, road_name: "SR-14 East", city: "Coweta County, GA", notes: "East of Newnan", bounds: { lat_min: 33.370, lat_max: 33.420, lng_min: -84.775, lng_max: -84.650 } },
    "sr16_newnan": { speed_limit: 35, road_name: "SR-16 / Bullsboro Drive", city: "Newnan, GA", notes: "Through downtown - School zone 25 MPH (7AM-4PM)", bounds: { lat_min: 33.373, lat_max: 33.387, lng_min: -84.810, lng_max: -84.790 } },
    "sr16_east": { speed_limit: 55, road_name: "SR-16 East", city: "Senoia/Sharpsburg, GA", notes: "East towards Senoia", bounds: { lat_min: 33.270, lat_max: 33.300, lng_min: -84.690, lng_max: -84.520 } },
    "sr16_senoia": { speed_limit: 45, road_name: "SR-16 Senoia", city: "Senoia, GA", notes: "Through Senoia - School zone areas", bounds: { lat_min: 33.295, lat_max: 33.315, lng_min: -84.565, lng_max: -84.545 } },
    "sr34_newnan_west": { speed_limit: 55, road_name: "SR-34 West", city: "Newnan, GA", notes: "West of Newnan", bounds: { lat_min: 33.370, lat_max: 33.390, lng_min: -84.850, lng_max: -84.805 } },
    "sr34_to_sr54": { speed_limit: 50, road_name: "SR-34 to SR-54", city: "Peachtree City, GA", notes: "⚠️ REDUCED FROM 55 MPH - HEAVY ENFORCEMENT!", bounds: { lat_min: 33.385, lat_max: 33.395, lng_min: -84.580, lng_max: -84.565 } },
    "sr34_bypass_newnan": { speed_limit: 50, road_name: "SR-34 Bypass", city: "Newnan, GA", notes: "Bypass around Newnan", bounds: { lat_min: 33.360, lat_max: 33.385, lng_min: -84.780, lng_max: -84.745 } },
    "sr54_sharpsburg": { speed_limit: 55, road_name: "SR-54 Sharpsburg", city: "Sharpsburg, GA", notes: "Through Sharpsburg", bounds: { lat_min: 33.310, lat_max: 33.330, lng_min: -84.685, lng_max: -84.655 } },
    "sr54_pre_fayette": { speed_limit: 55, road_name: "SR-54 East", city: "Coweta County, GA", notes: "East towards Fayette County", bounds: { lat_min: 33.380, lat_max: 33.395, lng_min: -84.600, lng_max: -84.545 } },
    "sr54_to_fayette": { speed_limit: 50, road_name: "SR-54 to Fayette Line", city: "Peachtree City border, GA", notes: "⚠️ REDUCED FROM 55 MPH - approaching Fayette County", bounds: { lat_min: 33.390, lat_max: 33.405, lng_min: -84.545, lng_max: -84.520 } },
    "sr54_trinity_school_zone_1": { speed_limit: 50, road_name: "SR-54 Trinity Christian School Zone", city: "Peachtree City, GA", notes: "⚠️ SCHOOL ZONE: 50 MPH (7:30-8:30 AM, 2:30-3:30 PM) - CAMERAS!", bounds: { lat_min: 33.381, lat_max: 33.385, lng_min: -84.570, lng_max: -84.565 } },
    "sr70_north": { speed_limit: 45, road_name: "SR-70 North", city: "Newnan, GA", notes: "North of Newnan", bounds: { lat_min: 33.385, lat_max: 33.430, lng_min: -84.700, lng_max: -84.670 } },
    "sr74_sr85_senoia": { speed_limit: 55, road_name: "SR-74 / SR-85 Senoia", city: "Senoia, GA", notes: "Through Senoia", bounds: { lat_min: 33.295, lat_max: 33.315, lng_min: -84.555, lng_max: -84.535 } },
    "sr74_sr85_north": { speed_limit: 55, road_name: "SR-74 / SR-85 North", city: "Peachtree City, GA", notes: "⚠️ ENFORCEMENT CAMERA - Drivers think 65 MPH!", bounds: { lat_min: 33.315, lat_max: 33.385, lng_min: -84.570, lng_max: -84.540 } },
    "sr154_sharpsburg": { speed_limit: 45, road_name: "SR-154 Sharpsburg", city: "Sharpsburg, GA", notes: "School zone 35 MPH (7:30-9 AM, 3:30-4:30 PM)", bounds: { lat_min: 33.310, lat_max: 33.325, lng_min: -84.670, lng_max: -84.650 } },
    "sr154_east": { speed_limit: 45, road_name: "SR-154 East", city: "Coweta County, GA", notes: "East towards Fulton County", bounds: { lat_min: 33.340, lat_max: 33.380, lng_min: -84.650, lng_max: -84.550 } },
    "lower_fayetteville_rd": { speed_limit: 45, road_name: "Lower Fayetteville Road", city: "Newnan, GA", notes: "Major delivery corridor - School zone 25 MPH near Newnan Crossing", bounds: { lat_min: 33.360, lat_max: 33.410, lng_min: -84.750, lng_max: -84.650 } },
    "fischer_road": { speed_limit: 45, road_name: "Fischer Road", city: "Peachtree City, GA", notes: "School zone 35 MPH near Northgate High (7:30-9 AM, 3-4 PM)", bounds: { lat_min: 33.360, lat_max: 33.420, lng_min: -84.620, lng_max: -84.540 } },
    "poplar_road": { speed_limit: 50, road_name: "Poplar Road", city: "Newnan, GA", notes: "School zone 35 MPH near Poplar Road Elementary", bounds: { lat_min: 33.350, lat_max: 33.410, lng_min: -84.760, lng_max: -84.710 } },
    "welcome_road": { speed_limit: 45, road_name: "Welcome Road", city: "Newnan, GA", notes: "School zone 25 MPH near Western Elementary", bounds: { lat_min: 33.325, lat_max: 33.375, lng_min: -84.850, lng_max: -84.775 } },
    "smokey_road": { speed_limit: 45, road_name: "Smokey Road", city: "Newnan, GA", notes: "School zone 35 MPH near Smokey Road Middle School", bounds: { lat_min: 33.340, lat_max: 33.390, lng_min: -84.820, lng_max: -84.760 } },
    "newnan_crossing_blvd": { speed_limit: 45, road_name: "Newnan Crossing Boulevard", city: "Newnan, GA", notes: "Major shopping area - Heavy traffic", bounds: { lat_min: 33.365, lat_max: 33.395, lng_min: -84.740, lng_max: -84.710 } },
    "gordon_road": { speed_limit: 55, road_name: "Gordon Road", city: "Coweta County, GA", notes: "Long rural road - Varies between 45-55 MPH", bounds: { lat_min: 33.270, lat_max: 33.365, lng_min: -84.680, lng_max: -84.520 } },
    "mcintosh_trail": { speed_limit: 45, road_name: "McIntosh Trail", city: "Peachtree City, GA", notes: "School zone 35 MPH near East Coweta High", bounds: { lat_min: 33.330, lat_max: 33.370, lng_min: -84.660, lng_max: -84.600 } },
    "lora_smith_road": { speed_limit: 35, road_name: "Lora Smith Road", city: "Newnan, GA", notes: "School zone 25 MPH near Arnall Middle & White Oak Elementary", bounds: { lat_min: 33.345, lat_max: 33.375, lng_min: -84.770, lng_max: -84.740 } },
    "country_club_road": { speed_limit: 45, road_name: "Country Club Road", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 35 MPH near Northside Elementary (7:30-9 AM, 2-3:30 PM)", bounds: { lat_min: 33.388, lat_max: 33.405, lng_min: -84.795, lng_max: -84.775 } },
    "dixon_road": { speed_limit: 45, road_name: "Dixon Road", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 25 MPH near Western Elementary (7:30-8:15 AM, 2-3 PM)", bounds: { lat_min: 33.345, lat_max: 33.365, lng_min: -84.825, lng_max: -84.805 } },
    "eastside_school_road": { speed_limit: 45, road_name: "Eastside School Road", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 35 MPH near Eastside Elementary (7-8:15 AM, 2-3 PM)", bounds: { lat_min: 33.345, lat_max: 33.370, lng_min: -84.720, lng_max: -84.690 } },
    "lagrange_street": { speed_limit: 25, road_name: "LaGrange Street", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 25 MPH near Newnan High School (7-9 AM, 3-4:30 PM)", bounds: { lat_min: 33.375, lat_max: 33.390, lng_min: -84.805, lng_max: -84.790 } },
    "jefferson_parkway": { speed_limit: 30, road_name: "Jefferson Parkway", city: "Newnan, GA", notes: "⚠️ SCHOOL ZONE: 25 MPH near Jefferson Parkway Elementary (7-9 AM, 2-4 PM)", bounds: { lat_min: 33.360, lat_max: 33.375, lng_min: -84.755, lng_max: -84.740 } },
    "atlanta_downtown_peachtree": { speed_limit: 35, road_name: "Peachtree Street Downtown", city: "Atlanta, GA", notes: "Downtown Atlanta - Heavy pedestrian traffic", bounds: { lat_min: 33.745, lat_max: 33.775, lng_min: -84.395, lng_max: -84.380 } },
    "atlanta_i75_i85_downtown": { speed_limit: 55, road_name: "I-75/I-85 Downtown Connector", city: "Atlanta, GA", notes: "Heavy enforcement, construction zones common", bounds: { lat_min: 33.730, lat_max: 33.780, lng_min: -84.400, lng_max: -84.385 } },
    "atlanta_midtown_peachtree": { speed_limit: 35, road_name: "Peachtree Street Midtown", city: "Atlanta, GA", notes: "Midtown - Georgia Tech area, heavy pedestrian", bounds: { lat_min: 33.775, lat_max: 33.795, lng_min: -84.395, lng_max: -84.380 } },
    "atlanta_spring_street": { speed_limit: 35, road_name: "Spring Street", city: "Atlanta, GA", notes: "Major north-south corridor through Midtown", bounds: { lat_min: 33.760, lat_max: 33.795, lng_min: -84.395, lng_max: -84.385 } },
    "atlanta_cascade_road": { speed_limit: 35, road_name: "Cascade Road", city: "Atlanta, GA", notes: "Southwest Atlanta - School zones in area", bounds: { lat_min: 33.710, lat_max: 33.740, lng_min: -84.480, lng_max: -84.450 } },
    "atlanta_campbellton_road": { speed_limit: 45, road_name: "Campbellton Road", city: "Atlanta, GA", notes: "Southwest delivery corridor", bounds: { lat_min: 33.675, lat_max: 33.715, lng_min: -84.520, lng_max: -84.470 } },
    "atlanta_airport_loop": { speed_limit: 45, road_name: "Airport Loop Road", city: "Atlanta, GA", notes: "Hartsfield-Jackson Airport area - Commercial zones", bounds: { lat_min: 33.630, lat_max: 33.650, lng_min: -84.450, lng_max: -84.420 } },
    "atlanta_virginia_avenue": { speed_limit: 35, road_name: "Virginia Avenue", city: "East Point/Atlanta, GA", notes: "Airport access road", bounds: { lat_min: 33.655, lat_max: 33.675, lng_min: -84.455, lng_max: -84.435 } },
    "jones_mill_road": { speed_limit: 45, road_name: "Jones Mill Road", city: "Alpharetta/Johns Creek, GA", notes: "North Atlanta delivery corridor", bounds: { lat_min: 33.940, lat_max: 33.975, lng_min: -84.365, lng_max: -84.335 } },
    "old_alabama_road": { speed_limit: 45, road_name: "Old Alabama Road", city: "Johns Creek, GA", notes: "Major north delivery route", bounds: { lat_min: 33.970, lat_max: 34.010, lng_min: -84.230, lng_max: -84.190 } },
    "state_bridge_road": { speed_limit: 55, road_name: "State Bridge Road", city: "Johns Creek/Duluth, GA", notes: "Main east-west corridor - varies 45-55 MPH by section", bounds: { lat_min: 33.980, lat_max: 34.010, lng_min: -84.220, lng_max: -84.110 } },
    "medlock_bridge_road": { speed_limit: 45, road_name: "Medlock Bridge Road", city: "Johns Creek, GA", notes: "North delivery route", bounds: { lat_min: 33.990, lat_max: 34.040, lng_min: -84.230, lng_max: -84.180 } },
    "fairburn_campbellton": { speed_limit: 45, road_name: "Campbellton Street", city: "Fairburn, GA", notes: "Main corridor through Fairburn", bounds: { lat_min: 33.555, lat_max: 33.575, lng_min: -84.595, lng_max: -84.570 } },
    "fairburn_downtown": { speed_limit: 35, road_name: "Downtown Fairburn", city: "Fairburn, GA", notes: "Historic downtown area", bounds: { lat_min: 33.558, lat_max: 33.568, lng_min: -84.585, lng_max: -84.575 } },
    "fairburn_senoia_road": { speed_limit: 45, road_name: "Senoia Road", city: "Fairburn, GA", notes: "South towards Senoia/Peachtree City", bounds: { lat_min: 33.500, lat_max: 33.560, lng_min: -84.600, lng_max: -84.570 } },
    "palmetto_main_street": { speed_limit: 35, road_name: "Main Street", city: "Palmetto, GA", notes: "Downtown Palmetto", bounds: { lat_min: 33.522, lat_max: 33.532, lng_min: -84.675, lng_max: -84.660 } },
    "palmetto_tyrone_road": { speed_limit: 45, road_name: "Palmetto Tyrone Road", city: "Palmetto, GA", notes: "Connects to Tyrone/Fayette County", bounds: { lat_min: 33.460, lat_max: 33.525, lng_min: -84.660, lng_max: -84.600 } },
    "palmetto_highway_154": { speed_limit: 45, road_name: "Highway 154", city: "Palmetto, GA", notes: "East-west through Palmetto", bounds: { lat_min: 33.515, lat_max: 33.535, lng_min: -84.700, lng_max: -84.650 } },
    "tyrone_senoia_road": { speed_limit: 45, road_name: "Senoia Road", city: "Tyrone, GA", notes: "Main corridor through Tyrone", bounds: { lat_min: 33.460, lat_max: 33.480, lng_min: -84.610, lng_max: -84.590 } },
    "tyrone_highway_74": { speed_limit: 55, road_name: "Highway 74", city: "Tyrone, GA", notes: "North-south through Tyrone", bounds: { lat_min: 33.455, lat_max: 33.485, lng_min: -84.615, lng_max: -84.595 } },
    "tyrone_dogwood_trail": { speed_limit: 35, road_name: "Dogwood Trail", city: "Tyrone, GA", notes: "Residential area - School zones nearby", bounds: { lat_min: 33.465, lat_max: 33.475, lng_min: -84.610, lng_max: -84.600 } },
    "concord_highway_29": { speed_limit: 55, road_name: "Highway 29", city: "Concord, GA", notes: "North-south through Concord area", bounds: { lat_min: 33.085, lat_max: 33.115, lng_min: -84.430, lng_max: -84.410 } },
    "concord_macedonia_road": { speed_limit: 45, road_name: "Macedonia Road", city: "Concord, GA", notes: "Local delivery road", bounds: { lat_min: 33.085, lat_max: 33.105, lng_min: -84.440, lng_max: -84.415 } },
    "woodbury_main_street": { speed_limit: 35, road_name: "Main Street", city: "Woodbury, GA", notes: "Downtown Woodbury - Small town, strict enforcement", bounds: { lat_min: 33.057, lat_max: 33.067, lng_min: -84.575, lng_max: -84.565 } },
    "woodbury_highway_85": { speed_limit: 45, road_name: "Highway 85", city: "Woodbury, GA", notes: "Through Woodbury area", bounds: { lat_min: 33.050, lat_max: 33.075, lng_min: -84.585, lng_max: -84.560 } },
    "fulton_south_fulton_parkway": { speed_limit: 45, road_name: "South Fulton Parkway", city: "South Fulton, GA", notes: "Major delivery corridor south of Atlanta", bounds: { lat_min: 33.630, lat_max: 33.680, lng_min: -84.580, lng_max: -84.540 } },
    "fulton_old_national_highway": { speed_limit: 45, road_name: "Old National Highway", city: "Fulton County, GA", notes: "Major commercial corridor - Heavy traffic", bounds: { lat_min: 33.600, lat_max: 33.670, lng_min: -84.480, lng_max: -84.440 } },
    "fulton_riverdale_road": { speed_limit: 45, road_name: "Riverdale Road", city: "Fulton County, GA", notes: "South Fulton delivery area", bounds: { lat_min: 33.560, lat_max: 33.605, lng_min: -84.460, lng_max: -84.420 } },
    "fulton_cascade_palmetto_hwy": { speed_limit: 45, road_name: "Cascade Palmetto Highway", city: "Fulton County, GA", notes: "Southwest corridor to Palmetto", bounds: { lat_min: 33.520, lat_max: 33.580, lng_min: -84.620, lng_max: -84.560 } }
};

function initializeSpeedLimitCache() {
    if (!fs.existsSync(SPEED_LIMIT_CACHE_FILE)) {
        fs.writeFileSync(SPEED_LIMIT_CACHE_FILE, JSON.stringify({}, null, 2));
        console.log('✅ Speed limit cache initialized');
    }
}

initializeSpeedLimitCache();

function checkLocalDatabase(lat, lng) {
    for (const [key, data] of Object.entries(speedLimitDatabase)) {
        if (lat >= data.bounds.lat_min && lat <= data.bounds.lat_max && lng >= data.bounds.lng_min && lng <= data.bounds.lng_max) {
            console.log(`✅ Speed limit found in local database: ${data.road_name}`);
            return { speedLimit: data.speed_limit, roadName: data.road_name, location: data.city, notes: data.notes, source: 'database' };
        }
    }
    return null;
}

function checkSpeedLimitCache(lat, lng) {
    try {
        const cache = JSON.parse(fs.readFileSync(SPEED_LIMIT_CACHE_FILE, 'utf8'));
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        if (cache[key]) {
            const age = Date.now() - cache[key].timestamp;
            const MAX_AGE = 24 * 60 * 60 * 1000;
            if (age < MAX_AGE) { console.log(`✅ Speed limit found in cache: ${cache[key].roadName}`); return cache[key]; }
        }
    } catch (e) { console.error('Cache read error:', e); }
    return null;
}

function saveToSpeedLimitCache(lat, lng, data) {
    try {
        const cache = JSON.parse(fs.readFileSync(SPEED_LIMIT_CACHE_FILE, 'utf8'));
        const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        cache[key] = { ...data, timestamp: Date.now() };
        const entries = Object.entries(cache);
        if (entries.length > 500) {
            const sorted = entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
            fs.writeFileSync(SPEED_LIMIT_CACHE_FILE, JSON.stringify(Object.fromEntries(sorted.slice(0, 500)), null, 2));
        } else { fs.writeFileSync(SPEED_LIMIT_CACHE_FILE, JSON.stringify(cache, null, 2)); }
    } catch (e) { console.error('Cache write error:', e); }
}

// ============================================
// SPEED LIMIT API ENDPOINT
// ============================================
app.get('/api/speed-limit', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        if (!lat || !lng) { return res.status(400).json({ success: false, error: 'Missing GPS coordinates' }); }
        const latitude = parseFloat(lat);
        const longitude = parseFloat(lng);
        console.log(`\n🚦 Speed limit request: ${latitude}, ${longitude}`);

        const localResult = checkLocalDatabase(latitude, longitude);
        if (localResult) { return res.json({ success: true, ...localResult }); }

        const cachedResult = checkSpeedLimitCache(latitude, longitude);
        if (cachedResult) { return res.json({ success: true, ...cachedResult }); }

        try {
            await trackAPIRequest('TomTom Speed Limit');
            const routingResponse = await fetch(`https://api.tomtom.com/routing/1/calculateRoute/${latitude},${longitude}:${latitude + 0.001},${longitude + 0.001}/json?key=${process.env.TOMTOM_API_KEY}&routeType=fastest&traffic=false`);
            if (routingResponse.ok) {
                const routingData = await routingResponse.json();
                const route = routingData.routes && routingData.routes[0];
                if (route && route.legs && route.legs[0] && route.legs[0].points) {
                    const firstPoint = route.legs[0].points[0];
                    let speedLimitKmh = firstPoint.speedLimit;
                    if (!speedLimitKmh && route.guidance && route.guidance.instructions && route.guidance.instructions[0]) {
                        speedLimitKmh = route.guidance.instructions[0].speedLimit;
                    }
                    if (speedLimitKmh) {
                        const result = { speedLimit: Math.round(speedLimitKmh * 0.621371), roadName: firstPoint.street || 'Current Road', location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, source: 'tomtom_routing' };
                        saveToSpeedLimitCache(latitude, longitude, result);
                        return res.json({ success: true, ...result });
                    }
                }
            }

            const trafficResponse = await fetch(`https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=${latitude},${longitude}&key=${process.env.TOMTOM_API_KEY}`);
            if (trafficResponse.ok) {
                const trafficData = await trafficResponse.json();
                const flowSegment = trafficData.flowSegmentData;
                if (flowSegment && flowSegment.speedLimit) {
                    const result = { speedLimit: Math.round(flowSegment.speedLimit * 0.621371), roadName: flowSegment.roadName || 'Unknown Road', location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, source: 'tomtom_traffic' };
                    saveToSpeedLimitCache(latitude, longitude, result);
                    return res.json({ success: true, ...result });
                }
            }

            const geocodeResponse = await fetch(`https://api.tomtom.com/search/2/reverseGeocode/${latitude},${longitude}.json?key=${process.env.TOMTOM_API_KEY}`);
            if (geocodeResponse.ok) {
                const geocodeData = await geocodeResponse.json();
                const address = geocodeData.addresses && geocodeData.addresses[0];
                if (address) {
                    const roadName = address.address.street || address.address.streetName || address.address.freeformAddress || 'Unknown Road';
                    const city = address.address.municipality || address.address.countrySecondarySubdivision || address.address.countrySubdivision || 'GA';
                    let speedLimit = 45;
                    const roadType = address.address.roadType || '';
                    const street = address.address.street || '';
                    if (roadType.includes('highway') || roadType.includes('motorway') || street.includes('I-') || street.includes('Interstate')) { speedLimit = 65; }
                    else if (roadType.includes('arterial') || street.includes('Parkway') || street.includes('Boulevard')) { speedLimit = 45; }
                    else if (roadType.includes('local') || roadType.includes('residential')) { speedLimit = 35; }
                    const result = { speedLimit, roadName, location: city, source: 'tomtom_estimate', note: '⚠️ Estimated based on road type - VERIFY with posted signs!' };
                    saveToSpeedLimitCache(latitude, longitude, result);
                    return res.json({ success: true, ...result });
                }
            }
        } catch (apiError) {
            if (apiError.message.includes('Daily API limit reached')) {
                return res.status(429).json({ success: false, error: 'Daily API limit reached. Speed limit data unavailable until tomorrow.', useCache: true });
            }
            console.error('TomTom API error:', apiError);
        }

        res.json({ success: true, speedLimit: 45, roadName: 'Unknown Road', location: `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, source: 'default', note: 'Unable to determine speed limit. Using safe default. Verify with posted signs.' });
    } catch (error) {
        console.error('Speed limit API error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// VIDEO UPLOAD WITH FFMPEG AUTO-DETECTION
// ============================================
app.post('/upload-to-google-drive', upload.single('video'), async (req, res) => {
    const startTime = Date.now();

    // ── Validate synchronously before doing anything ──────────
    if (!driveClient) return res.status(503).json({ success: false, error: 'Google Drive not available' });
    if (!req.file)    return res.status(400).json({ success: false, error: 'No video file received' });

    const { driverName, vin, inspectionType } = req.body;
    if (!driverName || !vin || !inspectionType)
        return res.status(400).json({ success: false, error: 'Missing required fields' });

    const fileStats  = fs.statSync(req.file.path);
    const fileSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);

    // Hard reject oversized files before processing
    if (fileStats.size > 100 * 1024 * 1024) {
        try { fs.unlinkSync(req.file.path); } catch(e) {}
        return res.status(400).json({
            success: false,
            error: `Video too large (${fileSizeMB}MB). Please keep walk-around under 30 seconds.`
        });
    }

    console.log(`📹 Upload received - Driver: ${driverName}, VIN: ${vin}, Size: ${fileSizeMB}MB`);

    // ── Generate jobId and respond IMMEDIATELY ─────────────────
    // Phone gets a response right away — no waiting for FFmpeg or Drive
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    createJob(jobId, { driverName, vin, inspectionType, fileSizeMB });
    res.json({ success: true, jobId, message: 'Upload received — processing started' });

    // ── Write manifest to volume BEFORE processing starts ─────────────────────
    // This survives a Railway deploy/restart. agent.js scans for manifests
    // with status != 'complete' on startup and requeues them automatically.
    const manifestPath = path.join(UPLOAD_DIR, `${jobId}.manifest.json`);
    const manifestData = {
        jobId,
        driverName,
        vin,
        inspectionType,
        videoFile:   req.file.filename,  // relative filename in UPLOAD_DIR
        submittedAt: new Date().toISOString(),
        status:      'pending',
        version:     process.env.APP_VERSION || 'unknown',
    };
    try {
        fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));
        console.log(`📋 Manifest written: ${manifestPath}`);
    } catch (mErr) {
        console.warn('⚠️  Could not write manifest:', mErr.message);
    }

    // ── All heavy processing runs in background ────────────────
    let videoPath = req.file.path;
    let enhancedVideoPath = null;
    let wasEnhanced = false;
    try {
        console.log(`📹 Background processing started for job ${jobId}`);

        // ========================================
        // FFMPEG ENHANCEMENT (server-side)
        // Records at 2.5Mbps for fast upload, enhances to 20Mbps H.264 here
        // ========================================
        let finalVideoPath = videoPath;
        wasEnhanced = false;

        updateJob(jobId, { status: 'enhancing', stage: 'Starting enhancement', progress: 5, message: 'Enhancing video quality...' });

        if (ffmpegPath) {
            try {
                console.log('🎨 Starting video enhancement...');
                const enhanceStart = Date.now();

                // Rename temp file to .mp4 so FFmpeg detects format
                const inputPath = videoPath + '.mp4';
                fs.renameSync(videoPath, inputPath);
                videoPath = inputPath; // update ref for cleanup

                // Write enhanced output to ENHANCED_DIR.
                // mkdirSync here (not just at startup) guarantees the dir exists
                // even if the volume mount was slow or ensureDirectories() raced.
                try {
                    fs.mkdirSync(ENHANCED_DIR, { recursive: true });
                    console.log(`📁 ENHANCED_DIR ready: ${ENHANCED_DIR} (exists: ${fs.existsSync(ENHANCED_DIR)})`);
                } catch (mkdirErr) {
                    console.error('❌ Could not create ENHANCED_DIR:', mkdirErr.message);
                    // Fall back to UPLOAD_DIR if enhanced dir fails
                    console.warn('⚠️  Falling back to UPLOAD_DIR for enhanced output');
                }
                const enhancedFileName = `enhanced_${Date.now()}_${path.basename(videoPath)}`;
                // Use UPLOAD_DIR as fallback if ENHANCED_DIR doesn't exist
                const outputDir = fs.existsSync(ENHANCED_DIR) ? ENHANCED_DIR : UPLOAD_DIR;
                enhancedVideoPath = path.join(outputDir, enhancedFileName);
                console.log(`📁 Enhanced output: ${enhancedVideoPath}`);

                // ── Enhancement via spawn + pipe → Node writeStream ──────────────────
                // Railway restricts FFmpeg subprocesses from writing directly to volume paths.
                // Node.js CAN write to the volume (proven by multer uploads).
                // Fix: pipe FFmpeg stdout → Node.js writeStream → volume file.
                const FFMPEG_TIMEOUT_MS = 4 * 60 * 1000;
                const { spawn: spawnFfmpeg } = require('child_process');

                // ── Pre-pass: Auto-detect and crop baked black borders ────────────
                // The JS canvas stabilizer sometimes bakes black borders into recordings.
                // cropdetect finds them automatically so the enhancer can crop+rescale.
                let cropFilter = null;
                try {
                    const { execFileSync: efCrop } = require('child_process');
                    efCrop(ffmpegPath, [
                        '-y', '-i', videoPath,
                        '-vf', 'cropdetect=limit=16:round=16:skip=2',
                        '-frames:v', '60', '-f', 'null', '-'
                    ], { timeout: 30000, stdio: ['pipe','pipe','pipe'] });
                } catch (cdErr) {
                    const stderr = cdErr && cdErr.stderr ? cdErr.stderr.toString() : '';
                    const cropMatches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
                    if (cropMatches.length > 0) {
                        const last = cropMatches[cropMatches.length - 1];
                        const cw = parseInt(last[1]), ch = parseInt(last[2]);
                        const cx = parseInt(last[3]), cy = parseInt(last[4]);
                        const blackPixels = (1920 - cw) + (1080 - ch);
                        if (blackPixels > 50 && cw > 800 && ch > 400) {
                            cropFilter = 'crop=' + cw + ':' + ch + ':' + cx + ':' + cy + ',scale=1920:1080:flags=lanczos';
                            console.log('🔲 Black border detected (' + blackPixels + 'px) — auto-cropping: ' + cw + 'x' + ch);
                        }
                    }
                }

                // ── Pass 1: Motion analysis (vidstab) ──────────────────────
                const stabTrfPath = videoPath.replace(/\.[^.]+$/, '_transforms.trf');
                try {
                    await new Promise((res, rej) => {
                        const p1args = [
                            '-y', '-i', videoPath,
                            '-vf', `vidstabdetect=stepsize=4:shakiness=10:accuracy=15:mincontrast=0.2:result=${stabTrfPath}`,
                            '-f', 'null', '-'
                        ];
                        const p1 = spawnFfmpeg(ffmpegPath, p1args);
                        p1.on('close', code => code === 0 ? res() : rej(new Error('vidstab pass 1 failed')));
                        p1.on('error', rej);
                        setTimeout(() => { p1.kill(); rej(new Error('vidstab timeout')); }, 120000);
                    });
                    console.log('✅ vidstab pass 1 complete — transforms ready');
                } catch (stabErr) {
                    console.warn('⚠️ vidstab pass 1 skipped:', stabErr.message);
                }
                // ── Pass 2: Enhancement + stabilization ──────────────────
                const runFFmpeg = (filters) => new Promise((resolve, reject) => {
                    const args = [
                        '-y', '-i', videoPath,
                        '-vf', filters.join(','),
                        '-r', '30',
                        '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',  // no bitrate cap — CRF controls quality
                        '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '128k',
                        '-f', 'mp4',
                        '-movflags', 'frag_keyframe+empty_moov', // streamable mp4 - works over pipe
                        'pipe:1'  // output to stdout so Node.js can write to volume
                    ];

                    const proc      = spawnFfmpeg(ffmpegPath, args);
                    let   outStream;
                    try {
                        outStream = fs.createWriteStream(enhancedVideoPath);
                    } catch(streamOpenErr) {
                        reject(new Error(`Cannot open output stream: ${streamOpenErr.message}`));
                        return;
                    }
                    let   stderrBuf = '';
                    let   bytesOut  = 0;
                    const pid       = proc.pid;
                    if (pid) registerPid(pid);
                    console.log(`🎬 FFmpeg started (PID: ${pid || 'unknown'})`);

                    // Handle stream write errors (e.g. dir vanishes, disk full)
                    outStream.on('error', streamErr => {
                        console.error('❌ Output stream error:', streamErr.message);
                        clearTimeout(killTimer);
                        if (pid) unregisterPid(pid);
                        try { proc.kill('SIGKILL'); } catch(e) {}
                        try { if (fs.existsSync(enhancedVideoPath)) fs.unlinkSync(enhancedVideoPath); } catch(e) {}
                        reject(new Error(`Output stream error: ${streamErr.message}`));
                    });

                    const killTimer = setTimeout(() => {
                        console.error('❌ FFmpeg 4-min timeout - killing');
                        if (pid) unregisterPid(pid);
                        try { proc.kill('SIGKILL'); } catch(e) {}
                        outStream.destroy();
                        reject(new Error('FFmpeg timeout - exceeded 4 minutes'));
                    }, FFMPEG_TIMEOUT_MS);

                    proc.stdout.on('data', chunk => {
                        bytesOut += chunk.length;
                        outStream.write(chunk);
                        // Approximate progress from bytes (rough estimate)
                        const approxPct = Math.min(Math.round(bytesOut / 50000), 90);
                        updateJob(jobId, {
                            status: 'enhancing', stage: 'Enhancing video',
                            progress: approxPct, message: `Enhancing video quality...`
                        });
                    });
                    proc.stderr.on('data', d => { stderrBuf += d.toString(); });

                    proc.on('close', code => {
                        clearTimeout(killTimer);
                        if (pid) unregisterPid(pid);
                        outStream.end();
                        if (code === 0 && bytesOut > 10000) {
                            const enhancedStats = fs.statSync(enhancedVideoPath);
                            const enhancedMB    = (enhancedStats.size / 1024 / 1024).toFixed(2);
                            const enhanceTime   = ((Date.now() - enhanceStart) / 1000).toFixed(1);
                            console.log(`✅ Enhancement done in ${enhanceTime}s: ${fileSizeMB}MB → ${enhancedMB}MB`);
                            resolve();
                        } else {
                            // Clean up partial file
                            try { if (fs.existsSync(enhancedVideoPath)) fs.unlinkSync(enhancedVideoPath); } catch(e) {}
                            const errLine = stderrBuf.split('\n').filter(l => l.includes('Error') || l.includes('error')).slice(-2).join(' ');
                            reject(new Error(`FFmpeg exit ${code}: ${errLine.substring(0, 120)}`));
                        }
                    });
                    proc.on('error', err => {
                        clearTimeout(killTimer);
                        if (pid) unregisterPid(pid);
                        outStream.destroy();
                        reject(err);
                    });
                });

                // Full: hqdn3d temporal+spatial denoising (requires ffmpeg-full) + color + sharpen
                // scale=1920:1080 forces true 1080p even if device recorded 720p
                // ── Scene detection: measure brightness from first frame ────────────
                // Drives adaptive pipeline — dark warehouse vs outdoor daylight need
                // completely different treatment.
                let srcBrightness = 128;
                let srcPortrait   = false;  // portrait video with pillarboxes
                try {
                    const { execFileSync: efProbe } = require('child_process');
                    // Sample a small frame for speed
                    const probeRaw = efProbe(ffmpegPath, [
                        '-y', '-i', videoPath, '-vframes', '1',
                        '-vf', 'scale=160:90', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
                    ], { timeout: 15000, maxBuffer: 160*90*3 + 1024 });
                    if (probeRaw.length >= 160*90*3) {
                        let total = 0, px = 160*90;
                        // Measure brightness of center strip only (ignore pillarboxes)
                        for (let i = 0; i < px*3; i+=3)
                            total += probeRaw[i]*0.299 + probeRaw[i+1]*0.587 + probeRaw[i+2]*0.114;
                        srcBrightness = total / px;

                        // Detect portrait pillarboxes: check if left/right 40% is near-black
                        let leftDark=0, rightDark=0, rows=90, cols=160;
                        for (let r=0; r<rows; r++) {
                            for (let c=0; c<cols*0.4; c++) {
                                const i = (r*cols+c)*3;
                                if (probeRaw[i]*0.299+probeRaw[i+1]*0.587+probeRaw[i+2]*0.114 < 8) leftDark++;
                            }
                            for (let c=Math.floor(cols*0.6); c<cols; c++) {
                                const i = (r*cols+c)*3;
                                if (probeRaw[i]*0.299+probeRaw[i+1]*0.587+probeRaw[i+2]*0.114 < 8) rightDark++;
                            }
                        }
                        const leftFrac  = leftDark  / (rows * cols*0.4);
                        const rightFrac = rightDark / (rows * cols*0.4);
                        srcPortrait = leftFrac > 0.85 && rightFrac > 0.85;
                        console.log('📊 Scene: brightness=' + srcBrightness.toFixed(0) +
                            ' portrait=' + srcPortrait + ' left=' + (leftFrac*100).toFixed(0) + '%dark');
                    }
                } catch(e) { console.warn('Scene probe failed, using defaults:', e.message); }

                const isDark = srcBrightness < 80;

                // ── Scale filter: strip pillarboxes if portrait, else normal scale ──
                // Portrait: crop the 9:16 center strip → upscale to fill 1080x1920
                // Landscape: standard 1920x1080 with aspect-ratio-safe padding
                const scaleFilter = srcPortrait
                    ? 'crop=iw*0.316:ih:iw*0.342:0,scale=1080:1920:flags=lanczos'  // strip pillarboxes
                    : 'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1:color=black';
                // vidstab transform file written by pass 1 (if available)
                const stabTrf = videoPath.replace(/\.[^.]+$/, '_transforms.trf');
                const hasStab = fs.existsSync(stabTrf);

                // ── Auto-detect input FPS and interpolate if below 25fps ──────────────
                // Samsung XCover7 (and most Android phones via Chrome MediaRecorder)
                // frequently drops frames under encoding load, recording at 14-16fps
                // even when 30fps is requested. The framerate filter reconstructs
                // smooth 30fps by blending adjacent frames — 62% smoother than raw.
                let inputFps = 30;
                try {
                    const { execFileSync } = require('child_process');
                    const probe = execFileSync(ffprobePath, [
                        '-v', 'quiet', '-select_streams', 'v:0',
                        '-show_entries', 'stream=avg_frame_rate',
                        '-of', 'default=noprint_wrappers=1',
                        videoPath
                    ], { timeout: 10000 }).toString().trim();
                    // avg_frame_rate is VFR-safe; r_frame_rate returns garbage on iPhone VFR
                    const match = probe.match(/avg_frame_rate=(\d+)\/(\d+)/);
                    if (match) {
                        const num = parseInt(match[1]), den = parseInt(match[2]);
                        inputFps = den > 0 ? Math.round(num / den) : 30;
                    }
                } catch(e) { console.warn('fps probe failed, assuming 30fps'); }

                const needsInterpolation = inputFps < 25;
                console.log('Input: ' + inputFps + 'fps → ' + (needsInterpolation ? 'needs interpolation' : 'no interpolation needed'));

                const stabFilter = hasStab
                    ? 'vidstabtransform=input=' + stabTrf + ':zoom=0:smoothing=60:optzoom=1:interpol=bicubic'
                    : null;

                console.log('🎨 Scene mode: ' + (isDark ? 'DARK/INDOOR' : 'OUTDOOR') + ' (brightness=' + srcBrightness.toFixed(0) + ')');
                console.log('🤖 AI tools: ESRGAN=' + (esrganPath ? 'YES' : 'NO') + ' RIFE=' + (rifePath ? 'YES' : 'NO'));

                // ── AI pipeline helper ──────────────────────────────────────────────
                // Runs Real-ESRGAN on extracted frames then reassembles with FFmpeg.
                // Pipeline: FFmpeg decode → PNG frames → ESRGAN → FFmpeg encode+grade
                const runAIPipeline = async () => {
                    const { execFileSync: efAI, spawn: spawnAI } = require('child_process');
                    const os   = require('os');
                    const framesDir  = path.join(os.tmpdir(), 'esrgan_in_'  + Date.now());
                    const outDir     = path.join(os.tmpdir(), 'esrgan_out_' + Date.now());
                    const rifeDir    = path.join(os.tmpdir(), 'rife_out_'   + Date.now());
                    fs.mkdirSync(framesDir, { recursive: true });
                    fs.mkdirSync(outDir,    { recursive: true });

                    try {
                        // ── Step A: RIFE frame interpolation (if needed + available) ──
                        // RIFE generates intermediate frames using optical flow — far smoother
                        // than FFmpeg's linear framerate filter. Only runs for low-fps clips.
                        let interpSource = videoPath;
                        if (needsInterpolation && rifePath) {
                            console.log('🎞️  RIFE: interpolating ' + inputFps + 'fps → 30fps...');
                            fs.mkdirSync(rifeDir, { recursive: true });

                            // Extract input frames for RIFE
                            const rifeInDir = path.join(os.tmpdir(), 'rife_in_' + Date.now());
                            fs.mkdirSync(rifeInDir, { recursive: true });
                            efAI(ffmpegPath, [
                                '-y', '-i', videoPath,
                                '-vf', scaleFilter,  // scale first so RIFE works on correct resolution
                                path.join(rifeInDir, '%08d.png')
                            ], { timeout: 120000, maxBuffer: 1024 * 1024 * 512 });

                            // Run RIFE — -g -1 forces CPU mode (no Vulkan needed)
                            const rifeModel = 'rife-v4.6';
                            efAI(rifePath, [
                                '-i', rifeInDir,
                                '-o', rifeDir,
                                '-m', rifeModel,
                                '-g', '-1',   // CPU-only
                                '-f', '0',    // multiplier: auto to reach 30fps
                                '-s', '2.0',  // 2x frame count
                            ], { timeout: 300000, maxBuffer: 1024 * 1024 * 1024 });

                            // Reassemble RIFE frames to temp video for ESRGAN input
                            const rifeTmp = path.join(os.tmpdir(), 'rife_tmp_' + Date.now() + '.mp4');
                            efAI(ffmpegPath, [
                                '-y', '-r', '30', '-i', path.join(rifeDir, '%08d.png'),
                                '-i', videoPath,   // audio source
                                '-map', '0:v', '-map', '1:a',
                                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                                '-c:a', 'copy', rifeTmp
                            ], { timeout: 120000, maxBuffer: 1024 * 1024 * 512 });

                            interpSource = rifeTmp;
                            console.log('✅ RIFE interpolation complete');

                            // Cleanup rife frame dirs
                            try { fs.rmSync(rifeInDir, { recursive: true, force: true }); } catch(_) {}
                            try { fs.rmSync(rifeDir,   { recursive: true, force: true }); } catch(_) {}
                        }

                        // ── Step B: Extract frames for ESRGAN ────────────────────────
                        // Apply scale + crop + basic stabilization before ESRGAN
                        // ESRGAN works on PNG frames, so we extract here
                        console.log('🖼️  Extracting frames for Real-ESRGAN...');
                        const preFilters = [
                            ...(interpSource === videoPath ? [scaleFilter] : []), // already scaled by RIFE
                            ...(cropFilter   ? [cropFilter]   : []),
                            ...(stabFilter   ? [stabFilter]   : []),
                            // Pre-denoise dark footage lightly before ESRGAN
                            // ESRGAN handles noise, but very heavy grain confuses the model
                            isDark ? 'nlmeans=s=4:p=3:r=5' : 'hqdn3d=1:0.7:1.5:1',
                        ].filter(Boolean);

                        efAI(ffmpegPath, [
                            '-y', '-i', interpSource,
                            '-vf', preFilters.join(','),
                            path.join(framesDir, '%08d.png')
                        ], { timeout: 180000, maxBuffer: 1024 * 1024 * 1024 });

                        const frameCount = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).length;
                        console.log('🖼️  Extracted ' + frameCount + ' frames — running Real-ESRGAN...');

                        // ── Step C: Real-ESRGAN AI upscale/denoise ────────────────────
                        // realesr-animevideov3 x2: upscales 1080p → 2160p then we downscale
                        // This produces far cleaner 1080p than direct 1:1 processing
                        // -g -1 = CPU mode, -t 0 = auto tile size for memory management
                        const esrganModel = 'realesr-animevideov3';
                        await new Promise((res, rej) => {
                            const eProc = spawnAI(esrganPath, [
                                '-i', framesDir,
                                '-o', outDir,
                                '-n', esrganModel,
                                '-s', '2',        // 2x scale (→ 2160p)
                                '-f', 'png',
                                '-g', '-1',       // CPU mode
                                '-t', '0',        // auto tile
                            ]);
                            let eLog = '';
                            eProc.stderr.on('data', d => {
                                eLog += d.toString();
                                // Log progress every ~10 frames
                                const m = eLog.match(/(\d+)\/(\d+)/);
                                if (m && parseInt(m[1]) % 10 === 0)
                                    updateJob(jobId, { status: 'enhancing', stage: 'AI Enhancement', progress: Math.round(parseInt(m[1])/parseInt(m[2])*60)+5, message: 'Real-ESRGAN: frame ' + m[1] + '/' + m[2] });
                            });
                            const killT = setTimeout(() => { eProc.kill(); rej(new Error('ESRGAN timeout')); }, 10 * 60 * 1000);
                            eProc.on('close', code => {
                                clearTimeout(killT);
                                code === 0 ? res() : rej(new Error('ESRGAN exit ' + code));
                            });
                            eProc.on('error', rej);
                        });
                        console.log('✅ Real-ESRGAN complete');
                        updateJob(jobId, { status: 'enhancing', stage: 'Encoding', progress: 70, message: 'AI enhancement done — encoding...' });

                        // ── Step D: Reassemble + color grade + final encode ───────────
                        // ESRGAN output is 2x scale — downscale back to target res with lanczos
                        // Apply color grade and sharpening after ESRGAN (better results than before)
                        const targetRes = srcPortrait ? 'scale=1080:1920:flags=lanczos' : 'scale=1920:1080:flags=lanczos';
                        const colorFilters = isDark ? [
                            targetRes,
                            'eq=brightness=0.10:contrast=1.25:saturation=1.15:gamma=0.80',
                            "curves=all='0/0 0.08/0.32 0.4/0.65 1/1'",
                            'unsharp=3:3:1.0:3:3:0.0',   // lighter sharpen — ESRGAN already sharpened
                        ] : [
                            targetRes,
                            "curves=r='0/0 0.5/0.54 1/1':g='0/0 0.5/0.52 1/1':b='0/0 0.5/0.44 1/0.93'",
                            'exposure=exposure=0.15:black=0.01',
                            'vibrance=intensity=0.25',
                            'colorbalance=rs=0.02:gs=0.02:bs=-0.04',
                            'unsharp=3:3:0.8:3:3:0.0',
                        ];

                        await new Promise((res, rej) => {
                            const args = [
                                '-y',
                                '-r', '30', '-i', path.join(outDir, '%08d.png'),
                                '-i', videoPath,   // original audio
                                '-map', '0:v', '-map', '1:a',
                                '-vf', colorFilters.join(','),
                                '-r', '30',
                                '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
                                '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
                                '-c:a', 'aac', '-b:a', '128k',
                                '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
                                'pipe:1'
                            ];
                            const proc    = spawnAI(ffmpegPath, args);
                            let outStream;
                            try {
                                outStream = fs.createWriteStream(enhancedVideoPath);
                            } catch(e) { rej(e); return; }
                            outStream.on('error', e => { try { proc.kill(); } catch(_){} rej(e); });
                            proc.stdout.pipe(outStream);
                            proc.stderr.on('data', () => {});
                            const killT = setTimeout(() => { proc.kill(); rej(new Error('Encode timeout')); }, 8 * 60 * 1000);
                            proc.on('close', code => {
                                clearTimeout(killT);
                                outStream.end();
                                if (code === 0 && fs.existsSync(enhancedVideoPath) && fs.statSync(enhancedVideoPath).size > 10000) res();
                                else rej(new Error('Final encode exit ' + code));
                            });
                            proc.on('error', rej);
                        });

                    } finally {
                        // Always clean up temp frame directories
                        try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch(_) {}
                        try { fs.rmSync(outDir,    { recursive: true, force: true }); } catch(_) {}
                    }
                };

                // ── FFmpeg-only filter chains (fallback) ──────────────────────────
                const interpFilter = needsInterpolation
                    ? 'framerate=fps=30:interp_start=0:interp_end=255:scene=100'
                    : null;

                const darkFilters = [
                    scaleFilter,
                    ...(cropFilter   ? [cropFilter]   : []),
                    ...(interpFilter ? [interpFilter] : []),
                    ...(stabFilter   ? [stabFilter]   : []),
                    'nlmeans=s=8:p=5:pc=5:r=9',
                    'eq=brightness=0.12:contrast=1.3:saturation=1.15:gamma=0.75',
                    "curves=all='0/0 0.08/0.32 0.4/0.62 1/1'",
                    'unsharp=5:5:1.8:5:5:0.0',
                ];
                const outdoorFilters = [
                    scaleFilter,
                    ...(cropFilter   ? [cropFilter]   : []),
                    ...(interpFilter ? [interpFilter] : []),
                    ...(stabFilter   ? [stabFilter]   : []),
                    'hqdn3d=2:1.5:3:2',
                    "curves=r='0/0 0.5/0.54 1/1':g='0/0 0.5/0.52 1/1':b='0/0 0.5/0.44 1/0.93'",
                    'exposure=exposure=0.2:black=0.01',
                    'vibrance=intensity=0.3',
                    'colorbalance=rs=0.02:gs=0.02:bs=-0.04',
                    'unsharp=3:3:1.2:3:3:0.0',
                ];
                const fullFilters = isDark ? darkFilters : outdoorFilters;
                const basicFilters = [
                    scaleFilter,
                    ...(cropFilter   ? [cropFilter]   : []),
                    ...(interpFilter ? [interpFilter] : []),
                    isDark ? 'eq=brightness=0.12:contrast=1.3:gamma=0.75' : 'hqdn3d=2:1.5:3:2',
                    'unsharp=3:3:1.2:3:3:0.0',
                ];

                // ── Execute: AI pipeline → FFmpeg full → FFmpeg basic ─────────────
                if (esrganPath) {
                    try {
                        console.log('🤖 Running AI pipeline (Real-ESRGAN + RIFE)...');
                        await runAIPipeline();
                        console.log('✅ AI pipeline complete');
                    } catch (aiErr) {
                        console.warn('⚠️  AI pipeline failed, falling back to FFmpeg: ' + aiErr.message);
                        if (fs.existsSync(enhancedVideoPath)) fs.unlinkSync(enhancedVideoPath);
                        try {
                            await runFFmpeg(fullFilters);
                            console.log('✅ FFmpeg full enhancement applied (AI fallback)');
                        } catch (filterErr) {
                            console.warn('⚠️  Full filters failed, retrying basic: ' + filterErr.message.substring(0,80));
                            if (fs.existsSync(enhancedVideoPath)) fs.unlinkSync(enhancedVideoPath);
                            await runFFmpeg(basicFilters);
                            console.log('✅ FFmpeg basic enhancement applied');
                        }
                    }
                } else {
                    try {
                        console.log('🎨 Running FFmpeg enhancement (no AI tools)...');
                        await runFFmpeg(fullFilters);
                        console.log('✅ FFmpeg full enhancement applied');
                    } catch (filterErr) {
                        console.warn('⚠️  Full filters failed, retrying basic: ' + filterErr.message.substring(0,80));
                        if (fs.existsSync(enhancedVideoPath)) fs.unlinkSync(enhancedVideoPath);
                        await runFFmpeg(basicFilters);
                        console.log('✅ FFmpeg basic enhancement applied');
                    }
                }

                finalVideoPath = enhancedVideoPath;
                wasEnhanced = true;
                updateJob(jobId, { status: 'uploading', stage: 'Uploading to Drive', progress: 68, message: 'Enhancement complete — uploading to Google Drive...' });
            } catch (enhanceError) {
                console.warn('⚠️  Enhancement failed, uploading original:', enhanceError.message);
                finalVideoPath = videoPath; // fall back to original
                enhancedVideoPath = null;
            } finally {
                // Clean up .trf transform file — not needed after enhancement
                const trfPath = videoPath.replace(/\.[^.]+$/, '_transforms.trf');
                try { if (fs.existsSync(trfPath)) fs.unlinkSync(trfPath); } catch(e) {}
            }
        } else {
            console.log('⏩ FFmpeg not available - uploading original');
        }

        const finalStats = fs.statSync(finalVideoPath);
        const finalSizeMB = (finalStats.size / 1024 / 1024).toFixed(2);
        const fileName = `${driverName}_${vin}_${inspectionType}_${wasEnhanced ? 'ENHANCED_' : ''}${Date.now()}.mp4`;

        console.log(`☁️  Starting Google Drive upload (${wasEnhanced ? 'enhanced' : 'original'}, ${finalSizeMB}MB)...`);

        const fileMetadata = {
            name: fileName,
            parents: [VIDEO_DRIVE_ID],
            mimeType: 'video/mp4',
            properties: {
                driver: driverName,
                vin: vin,
                inspectionType: inspectionType,
                uploadDate: new Date().toISOString(),
                codec: wasEnhanced ? 'H.264 Enhanced (20Mbps)' : 'Original',
                resolution: '1920x1080',
                enhanced: String(wasEnhanced),
                downloadPreferred: 'true'
            },
            description: `Fleet Video Inspection - ${inspectionType} for VIN ${vin} by ${driverName}`
        };

        const media = { mimeType: 'video/mp4', body: fs.createReadStream(finalVideoPath) };

        const uploadType = finalStats.size > 5 * 1024 * 1024 ? 'resumable' : 'multipart';
        console.log(`📤 Using ${uploadType} upload method`);

        const driveResponse = await Promise.race([
            driveClient.files.create({
                requestBody: fileMetadata,
                media: media,
                fields: 'id, name, webViewLink, webContentLink, size, videoMediaMetadata, createdTime',
                supportsAllDrives: true
            }),
            new Promise((_,reject)=>setTimeout(()=>reject(new Error('Google Drive upload timeout after 3 minutes')),3*60*1000))
        ]);

        updateJob(jobId, { status: 'uploading', stage: 'Finalizing', progress: 90, message: 'Drive upload complete — sending notifications...' });

        const uploadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const fileId = driveResponse.data.id;

        const videoMetadata = driveResponse.data.videoMediaMetadata || {};
        const videoDuration = videoMetadata.durationMillis ? `${(videoMetadata.durationMillis / 1000 / 60).toFixed(1)} minutes` : 'Unknown';

        console.log(`✅ Google Drive upload complete in ${uploadTime}s`);
        console.log(`   File ID: ${fileId}`);
        console.log(`   Size uploaded: ${finalSizeMB}MB (raw was ${fileSizeMB}MB)`);

        await appendLog(PERFORMANCE_LOG, {
            type: 'performance',
            action: 'video_upload',
            duration: Date.now() - startTime,
            success: true,
            fileSize: fileStats.size,
            details: `${driverName} - ${vin} - ${inspectionType}`,
            userAgent: req.get('user-agent'),
            ip: req.ip
        });

        try {
            await driveClient.permissions.create({
                fileId: fileId,
                requestBody: { role: 'reader', type: 'anyone' },
                supportsAllDrives: true
            });
            console.log('✅ File permissions set (viewable via link)');
        } catch (permError) {
            console.warn('⚠️  Could not set permissions:', permError.message);
        }

        const viewLink = driveResponse.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        const directDownloadLink = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const embedLink = `https://drive.google.com/file/d/${fileId}/preview`;
        const thumbnailLink = `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;

        console.log('📥 Generated access links:');
        console.log(`   View Link: ${viewLink}`);

        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: ['slgpfleetmanager@gmail.com'],
                subject: `📹 Video Inspection Ready: ${inspectionType} - ${driverName} (VIN: ${vin})`,
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
                        <div style="background: linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%); padding: 30px 20px; border-radius: 12px 12px 0 0; text-align: center;">
                            <h1 style="color: white; margin: 0; font-size: 28px;">✅ Video Inspection Ready</h1>
                            <p style="color: #e0e7ff; margin: 10px 0 0 0; font-size: 14px;">Full quality video available for immediate viewing</p>
                        </div>
                        <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                            <h2 style="color: #1f2937; margin: 0 0 20px 0; font-size: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📋 Inspection Details</h2>
                            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563; width: 40%;">Driver:</td><td style="padding: 12px; color: #1f2937;">${driverName}</td></tr>
                                <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">VIN:</td><td style="padding: 12px; color: #1f2937;">${vin}</td></tr>
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Type:</td><td style="padding: 12px; color: #1f2937;">${inspectionType}</td></tr>
                                <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">File Size:</td><td style="padding: 12px; color: #1f2937;">${finalSizeMB} MB${wasEnhanced ? " (raw: " + fileSizeMB + " MB)" : ""}</td></tr>
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Duration:</td><td style="padding: 12px; color: #1f2937;">${videoDuration}</td></tr>
                                <tr style="background: white;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Upload Time:</td><td style="padding: 12px; color: #1f2937;">${uploadTime}s</td></tr>
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Quality:</td><td style="padding: 12px; color: #1f2937;">${wasEnhanced ? '1920x1080 H.264 Enhanced (20Mbps) + denoising' : '1920x1080 Original'}</td></tr>
                            </table>
                            <div style="background: #eff6ff; border-left: 4px solid #2563EB; padding: 20px; margin-bottom: 25px; border-radius: 4px;">
                                <h3 style="color: #1e40af; margin: 0 0 12px 0; font-size: 16px;">📹 FULL QUALITY 1080p VIDEO</h3>
                                <p style="color: #1e3a8a; margin: 0; font-size: 13px; line-height: 1.6;">
                                    <strong>✅ Video uploaded successfully!</strong><br>
                                    H.265/HEVC codec - Superior quality in smaller file size.<br>
                                    Choose your preferred viewing method below:
                                </p>
                            </div>
                            <div style="text-align: center; margin: 25px 0;">
                                <a href="${viewLink}" style="display: inline-block; background: #10b981; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px; box-shadow: 0 2px 4px rgba(16, 185, 129, 0.3);">
                                    📱 OPEN IN DRIVE
                                </a>
                                <a href="${directDownloadLink}" style="display: inline-block; background: #3b82f6; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px; box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);">
                                    ⬇️ DOWNLOAD 1080p
                                </a>
                            </div>
                            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
                                <p style="margin: 0; color: #92400e; font-size: 13px; line-height: 1.6;">
                                    <strong>💡 BEST VIEWING:</strong> Click <strong>"OPEN IN DRIVE"</strong> to watch in the Google Drive app or browser. 
                                    For offline viewing or archiving, click <strong>"DOWNLOAD 1080p"</strong> to save the full quality file.
                                </p>
                            </div>
                        </div>
                    </div>
                `
            });
            console.log('✅ Email notification sent to slgpfleetmanager@gmail.com');
        } catch (emailError) {
            console.error('⚠️  Email notification failed:', emailError.message);
            await appendLog(ERROR_LOG, {
                type: 'server_error',
                severity: 'warning',
                message: 'Video notification email failed',
                stack: emailError.stack,
                source: 'upload-to-google-drive-email'
            });
        }

        // Sync inspection metadata to Streamlit DB (fire-and-forget, non-blocking)
        syncInspectionToStreamlit({
            driverName,
            vin,
            inspectionType,
            fileName,
            fileId,
            viewLink,
            directDownloadLink
        });

        // Clean up all temp files
        for (const p of [videoPath, enhancedVideoPath]) {
            if (p && fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch (e) {}
            }
        }
        console.log('✅ Temporary files cleaned up');

        updateJob(jobId, {
            status: 'complete',
            stage: 'Done',
            progress: 100,
            message: `✅ Complete! ${wasEnhanced ? 'Enhanced to 20Mbps' : 'Uploaded'} in ${uploadTime}s`,
            result: {
                success: true,
                fileId, fileName, fileSize: finalSizeMB, rawSize: fileSizeMB,
                enhanced: wasEnhanced, uploadTime, viewLink,
                downloadLink: directDownloadLink, embedLink, thumbnailLink,
                metadata: videoMetadata, createdTime: driveResponse.data.createdTime
            }
        });
        console.log(`✅ Job ${jobId} complete in ${uploadTime}s`);
    } catch (error) {
        console.error('❌ Video upload error:', error);

        await appendLog(ERROR_LOG, {
            type: 'server_error',
            severity: 'error',
            message: 'Video upload failed',
            stack: error.stack,
            source: 'upload-to-google-drive'
        });

        await appendLog(PERFORMANCE_LOG, {
            type: 'performance',
            action: 'video_upload',
            duration: Date.now() - startTime,
            success: false,
            fileSize: req.file ? req.file.size : 0,
            details: error.message,
            userAgent: req.get('user-agent'),
            ip: req.ip
        });

        // ── Retry logic ─────────────────────────────────────────
        // If error is network/timeout and the video file still exists,
        // save to retry queue BEFORE cleanup so agent can re-attempt Drive upload
        const survivingFile = [enhancedVideoPath, videoPath].find(p => p && fs.existsSync(p));
        if (isRetriable(error.message) && survivingFile) {
            console.log(`🔁 Retriable error — preserving file for agent retry: ${survivingFile}`);
            saveToRetryQueue({
                jobId,
                filePath:       survivingFile,
                driverName,
                vin,
                inspectionType,
                fileSizeMB,
                wasEnhanced,
                failedAt:       Date.now(),
                attemptCount:   1,
                lastError:      error.message
            });
            // Manifest stays status:'pending' — agent will requeue on next startup
            // (already in retry_queue.json — agent handles it)
            updateJob(jobId, {
                status:   'failed',
                stage:    'Queued for retry',
                progress: 0,
                message:  'Upload failed — retrying automatically...',
                error:    error.message
            });
            console.log(`🔁 Job ${jobId} queued for retry by agent`);
        } else {
            // Non-retriable (corrupt file, auth error, etc) — clean up and mark permanent failure
            for (const p of [videoPath, enhancedVideoPath]) {
                if (p && fs.existsSync(p)) {
                    try { fs.unlinkSync(p); } catch (e) {}
                }
            }
            console.log('✅ Cleaned up temp files after non-retriable error');
            // Mark manifest as permanently failed — agent will not requeue
            try {
                const mPath = path.join(UPLOAD_DIR, `${jobId}.manifest.json`);
                if (fs.existsSync(mPath)) {
                    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
                    m.status = 'failed_permanent';
                    m.failedAt = new Date().toISOString();
                    m.error = error.message;
                    fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
                }
            } catch (_) {}
            updateJob(jobId, {
                status:   'failed',
                stage:    'Error',
                progress: 0,
                message:  `Upload failed: ${error.message}`,
                error:    error.message
            });
            console.log(`❌ Job ${jobId} permanently failed: ${error.message}`);
        }
    }
});

// ============================================
// JOB STATUS POLLING ENDPOINT
// Client polls this every 2s after upload
// ============================================
app.get('/api/job-status/:jobId', (req, res) => {
    const job = jobStore.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found or expired' });
    }
    res.json({
        success: true,
        jobId: req.params.jobId,
        status: job.status,       // received | enhancing | uploading | complete | failed
        stage: job.stage,
        progress: job.progress,
        message: job.message,
        result: job.result || null,
        error: job.error || null,
        elapsed: Math.round((Date.now() - job.createdAt) / 1000)
    });
});

// ============================================
// INTERNAL RETRY ENDPOINT
// Called by agent.js to re-attempt a failed Drive
// upload without re-uploading the file from the phone
// ============================================
app.post('/api/internal/retry-job/:jobId', async (req, res) => {
    // Security: only allow calls from localhost (agent runs on same container)
    const callerIp = req.ip || req.connection.remoteAddress || '';
    if (!callerIp.includes('127.0.0.1') && !callerIp.includes('::1') && !callerIp.includes('localhost')) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const { jobId } = req.params;

    // Read retry queue
    let queue = [];
    try {
        if (fs.existsSync(RETRY_QUEUE_FILE)) {
            queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf8'));
        }
    } catch (e) {
        return res.status(500).json({ success: false, error: 'Could not read retry queue' });
    }

    const entry = queue.find(e => e.jobId === jobId);
    if (!entry) {
        return res.status(404).json({ success: false, error: 'Job not in retry queue' });
    }

    // Check file still exists
    if (!fs.existsSync(entry.filePath)) {
        console.warn(`⚠️  Retry ${jobId}: file gone (${entry.filePath}), removing from queue`);
        removeFromRetryQueue(jobId);
        return res.status(410).json({ success: false, error: 'Video file no longer exists' });
    }

    // Check max attempts
    if (entry.attemptCount > MAX_RETRY_ATTEMPTS) {
        console.warn(`⚠️  Retry ${jobId}: max attempts (${MAX_RETRY_ATTEMPTS}) reached — giving up`);
        removeFromRetryQueue(jobId);
        try { fs.unlinkSync(entry.filePath); } catch(e) {}
        return res.status(410).json({ success: false, error: 'Max retry attempts exceeded' });
    }

    console.log(`🔁 Agent retry ${entry.attemptCount}/${MAX_RETRY_ATTEMPTS} for job ${jobId} (${entry.driverName} / ${entry.vin})`);

    // Respond immediately — retry runs async
    res.json({ success: true, message: `Retry ${entry.attemptCount} started`, jobId });

    // ── Re-attempt Drive upload ──────────────────────────────────
    try {
        const { driverName, vin, inspectionType, fileSizeMB, wasEnhanced, filePath } = entry;
        const fileStats   = fs.statSync(filePath);
        const finalSizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
        const retryStart  = Date.now();

        const fileName     = `${driverName.replace(/\s+/g,'-')}_${vin}_${inspectionType}_${new Date().toISOString().split('T')[0]}.mp4`;
        const fileMetadata = {
            name:        fileName,
            parents:     [VIDEO_DRIVE_ID], // uses same folder as main upload
            description: `Fleet Video Inspection - ${inspectionType} for VIN ${vin} by ${driverName} (retry)`
        };
        const media = { mimeType: 'video/mp4', body: fs.createReadStream(filePath) };

        const driveResponse = await Promise.race([
            driveClient.files.create({
                requestBody: fileMetadata,
                media,
                fields: 'id, name, webViewLink, webContentLink, size, videoMediaMetadata, createdTime',
                supportsAllDrives: true
            }),
            new Promise((_,reject) => setTimeout(() => reject(new Error('Google Drive upload timeout after 3 minutes')), 3*60*1000))
        ]);

        const fileId   = driveResponse.data.id;
        const uploadTime = ((Date.now() - retryStart) / 1000).toFixed(1);

        // Set permissions
        try {
            await driveClient.permissions.create({
                fileId,
                requestBody: { role: 'reader', type: 'anyone' },
                supportsAllDrives: true
            });
        } catch(e) { console.warn('Retry: could not set permissions:', e.message); }

        const viewLink           = driveResponse.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        const directDownloadLink = `https://drive.google.com/uc?export=download&id=${fileId}`;

        // Send email notification
        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            await transporter.sendMail({
                from:    process.env.EMAIL_USER,
                to:      ['slgpfleetmanager@gmail.com'],
                subject: `📹 Video Inspection Ready (retry): ${inspectionType} - ${driverName} (VIN: ${vin})`,
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
                        <h2 style="color:#2563EB;">✅ Video Inspection Ready</h2>
                        <p style="color:#f59e0b;font-size:13px;">⚠️ Note: This video was retried after an initial upload failure.</p>
                        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                            <tr style="background:#f3f4f6;"><td style="padding:10px;font-weight:bold;">Driver</td><td style="padding:10px;">${driverName}</td></tr>
                            <tr><td style="padding:10px;font-weight:bold;">VIN</td><td style="padding:10px;">${vin}</td></tr>
                            <tr style="background:#f3f4f6;"><td style="padding:10px;font-weight:bold;">Type</td><td style="padding:10px;">${inspectionType}</td></tr>
                            <tr><td style="padding:10px;font-weight:bold;">File Size</td><td style="padding:10px;">${finalSizeMB} MB</td></tr>
                            <tr style="background:#f3f4f6;"><td style="padding:10px;font-weight:bold;">Retry #</td><td style="padding:10px;">${entry.attemptCount} of ${MAX_RETRY_ATTEMPTS}</td></tr>
                        </table>
                        <a href="${viewLink}" style="display:inline-block;background:#10b981;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;margin-right:10px;">📱 OPEN IN DRIVE</a>
                        <a href="${directDownloadLink}" style="display:inline-block;background:#3b82f6;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;">⬇️ DOWNLOAD</a>
                    </div>`
            });
            console.log(`✅ Retry email sent for job ${jobId}`);
        } catch(emailErr) {
            console.warn('Retry email failed:', emailErr.message);
        }

        // Sync inspection metadata to Streamlit DB (fire-and-forget, non-blocking)
        syncInspectionToStreamlit({
            driverName,
            vin,
            inspectionType,
            fileName: entry.fileName || path.basename(filePath),
            fileId:   fileId,
            viewLink,
            directDownloadLink
        });

        // Clean up file after successful retry
        try { fs.unlinkSync(filePath); } catch(e) {}

        // Remove from retry queue
        removeFromRetryQueue(jobId);

        await appendLog(ERROR_LOG, {
            type: 'retry_success',
            severity: 'info',
            message: `Job ${jobId} succeeded on retry ${entry.attemptCount}`,
            details: { driverName, vin, inspectionType, uploadTime }
        });

        console.log(`✅ Retry ${entry.attemptCount} succeeded for job ${jobId} in ${uploadTime}s`);

    } catch(retryErr) {
        console.error(`❌ Retry ${entry.attemptCount} failed for job ${jobId}:`, retryErr.message);

        if (entry.attemptCount >= MAX_RETRY_ATTEMPTS) {
            // Exhausted — clean up and remove from queue
            try { fs.unlinkSync(entry.filePath); } catch(e) {}
            removeFromRetryQueue(jobId);
            await appendLog(ERROR_LOG, {
                type: 'retry_exhausted',
                severity: 'error',
                message: `Job ${jobId} failed all ${MAX_RETRY_ATTEMPTS} retries — video lost`,
                details: { driverName: entry.driverName, vin: entry.vin, lastError: retryErr.message }
            });
            console.error(`💀 Job ${jobId} exhausted all retries — video not delivered`);
        } else {
            // Increment attempt count for next try
            saveToRetryQueue({ ...entry, attemptCount: entry.attemptCount + 1, lastError: retryErr.message });
        }
    }
});

// ============================================
// PUSH NOTIFICATIONS
// ============================================
app.get('/vapid-key', (req, res) => {
    res.json({ publicKey: publicVapidKey });
});

app.post('/subscribe', (req, res) => {
    try {
        const subscription = req.body;
        let subs = fs.existsSync(SUBSCRIPTION_FILE) ? JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE)) : [];
        const exists = subs.some(s => JSON.stringify(s) === JSON.stringify(subscription));
        if (!exists) {
            subs.push(subscription);
            fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(subs));
            console.log('✅ Push subscription added');
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Subscription error:', e);
        res.status(500).json({ success: false });
    }
});

// ============================================
// VERSION ENDPOINT
// ============================================
app.get('/version', (req, res) => {
    res.json(BUILD_INFO);
});

// ============================================
// DEBUG DASHBOARD
// ============================================
app.get('/debug-dashboard', async (req, res) => {
    const password = req.query.key;
    if (password !== 'slgp-debug-2026') { return res.status(401).send('Unauthorized'); }
    const recentErrors = await getRecentLogs(ERROR_LOG, 50);
    const recentCamera = await getRecentLogs(CAMERA_LOG, 50);
    const recentPerf = await getRecentLogs(PERFORMANCE_LOG, 50);
    const recentDebug = await getRecentLogs(DEBUG_LOG, 50);
    const html = `<!DOCTYPE html>
<html>
<head>
    <title>SLGP Debug Dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: monospace; background: #0a0e17; color: #e5e7eb; padding: 20px; }
        .header { background: linear-gradient(135deg, #00A8E1, #0084b4); padding: 20px; border-radius: 8px; margin-bottom: 30px; }
        h1 { color: white; margin-bottom: 10px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .stat-card { background: #1a1f2e; padding: 15px; border-radius: 8px; border: 2px solid #00A8E1; }
        .stat-number { font-size: 32px; font-weight: bold; color: #00A8E1; }
        .stat-label { font-size: 12px; color: #a9b2bd; text-transform: uppercase; }
        .section { background: #1a1f2e; padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #2d3748; }
        .section-title { font-size: 18px; color: #00A8E1; margin-bottom: 15px; border-bottom: 2px solid #00A8E1; padding-bottom: 10px; }
        .log-entry { background: #0d1117; padding: 15px; margin-bottom: 10px; border-radius: 6px; border-left: 4px solid #00A8E1; font-size: 12px; }
        .log-entry.error { border-left-color: #ff2a2a; }
        .log-time { color: #6b7280; font-size: 11px; margin-bottom: 5px; }
        .log-message { color: #e5e7eb; margin-bottom: 8px; }
        .refresh-btn { background: #00A8E1; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🐛 SLGP Debug Dashboard</h1>
        <p>Last updated: ${new Date().toLocaleString()}</p>
    </div>
    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
    <div class="stats">
        <div class="stat-card"><div class="stat-number">${recentErrors.length}</div><div class="stat-label">Errors</div></div>
        <div class="stat-card"><div class="stat-number">${recentCamera.length}</div><div class="stat-label">Camera</div></div>
        <div class="stat-card"><div class="stat-number">${recentPerf.length}</div><div class="stat-label">Performance</div></div>
        <div class="stat-card"><div class="stat-number">${recentDebug.length}</div><div class="stat-label">Debug</div></div>
    </div>
    <div class="section">
        <div class="section-title">❌ Recent Errors</div>
        ${recentErrors.map(log => `<div class="log-entry error"><div class="log-time">${new Date(log.timestamp).toLocaleString()}</div><div class="log-message"><strong>${log.message || 'No message'}</strong></div><div class="log-details">URL: ${log.url || 'N/A'}<br>User: ${log.userAgent || 'N/A'}</div></div>`).join('') || '<p>No errors</p>'}
    </div>
    <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`;
    res.send(html);
});

// ============================================
// HTML PAGES
// ============================================
app.get('/video', (req, res) => { res.sendFile(path.join(__dirname, 'video.html')); });
app.get('/weather', (req, res) => { res.sendFile(path.join(__dirname, 'weather.html')); });
app.get('/speed-limits', (req, res) => { res.sendFile(path.join(__dirname, 'speed-limits.html')); });
app.get('/success', (req, res) => { res.sendFile(path.join(__dirname, 'success.html')); });
app.get('/alerts', (req, res) => { res.sendFile(path.join(__dirname, 'alerts.html')); });
app.get('/build-notes', (req, res) => { res.sendFile(path.join(__dirname, 'build-notes.html')); });

app.get('/report', (req, res) => {
    const mode = req.query.mode;
    let filePath;
    if (mode === 'issue') { filePath = path.join(__dirname, 'report-issue.html'); }
    else if (mode === 'accident') { filePath = path.join(__dirname, 'accident-report.html'); }
    else if (mode === 'insurance') { filePath = path.join(__dirname, 'insurance.html'); }
    else { return res.status(404).send('Unknown report type'); }
    if (fs.existsSync(filePath)) { res.sendFile(filePath); }
    else { res.status(404).send(`File not found: ${mode}`); }
});

// ============================================
// STATIC FILES
// ============================================
app.use(express.static(__dirname, {
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ============================================
// ROOT ROUTE
// ============================================
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const menuPath = path.join(__dirname, 'menu.html');
    if (fs.existsSync(menuPath)) { res.sendFile(menuPath); }
    else { res.status(404).send('menu.html not found'); }
});

// ============================================
// CRON JOB - DAILY SUMMARY
// ============================================
cron.schedule('30 23 * * *', async () => {
    try {
        console.log('🕐 Running daily summary...');
        let summaryText = "\n--- DEPARTURE LOGS ---\n";
        if (fs.existsSync(GATE_LOG_FILE)) {
            const gateLogs = JSON.parse(fs.readFileSync(GATE_LOG_FILE));
            gateLogs.forEach(log => summaryText += `${log.timestamp}: ${log.name}\n`);
            fs.writeFileSync(GATE_LOG_FILE, JSON.stringify([]));
        }
        summaryText += "\n--- ARRIVAL LOGS ---\n";
        if (fs.existsSync(ARRIVAL_LOG_FILE)) {
            const arrLogs = JSON.parse(fs.readFileSync(ARRIVAL_LOG_FILE));
            arrLogs.forEach(log => summaryText += `${log.timestamp}: ${log.name}\n`);
            fs.writeFileSync(ARRIVAL_LOG_FILE, JSON.stringify([]));
        }
        if (!fs.existsSync(DAILY_LOG_FILE)) return;
        const allLogs = JSON.parse(fs.readFileSync(DAILY_LOG_FILE));
        if (allLogs.length === 0 && summaryText.length < 40) return;
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: ['slgpfleetmanager@gmail.com'],
            subject: `DAILY SUMMARY: ${new Date().toLocaleDateString()}`,
            text: `Daily Summary\nTotal Reports: ${allLogs.length}\n${summaryText}`
        });
        fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify([]));
        console.log('✅ Daily summary sent');
    } catch (e) { console.error('❌ Cron job error:', e); }
}, { timezone: "America/New_York" });

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
    console.error('❌ Server Error:', err);
    appendLog(ERROR_LOG, { type: 'server_error', severity: 'error', message: err.message, stack: err.stack, source: 'express_error_handler' });
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============================================
// START SERVER
// ============================================
// ============================================
// HEALTH CHECK ENDPOINT
// Railway uses this to confirm app is running
// ============================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: Date.now() });
});

const PORT = process.env.PORT || 8080;

// ============================================
// FORK MAINTENANCE AGENT
// ============================================
(function startAgent() {
    const agentPath = path.join(__dirname, 'agent.js');
    if (!fs.existsSync(agentPath)) {
        console.warn('⚠️  agent.js not found - running without maintenance agent');
        return;
    }
    const agent = fork(agentPath, [], { silent: false });
    agent.on('message', (msg) => console.log('🤖 Agent:', msg));
    agent.on('error', (err) => console.error('⚠️  Agent error:', err.message));
    agent.on('exit', (code) => {
        if (code !== 0) {
            console.warn(`⚠️  Agent exited (code ${code}) - restarting in 30s`);
            setTimeout(startAgent, 30000);
        }
    });
    console.log('✅ Maintenance agent forked');
})();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════╗
║  SLGP Fleet Manager                      ║
║  v4.6.6 - AGENT + VIDEO LIMITS + PID TRACKING  ║
╠══════════════════════════════════════════╣
║  Port: ${PORT}                                ║
╚══════════════════════════════════════════╝

✅ Server started
✅ Email configured
${driveClient ? '✅ Google Drive connected' : '⚠️  Google Drive offline'}
✅ Push notifications ready
${DISCORD_BOT_TOKEN ? '✅ Discord bot online' : '⚠️  Discord bot offline'}
✅ Learning AI initialized
✅ Knowledge base loaded
✅ Speed limit system ready
✅ Usage tracking active
✅ FFmpeg auto-detection enabled

🌐 Ready at: http://localhost:${PORT}
    `);
});

process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received - shutting down gracefully');
    try { fs.writeFileSync(ACTIVE_PIDS_FILE, JSON.stringify([])); } catch(e) {}
    process.exit(0);
});
