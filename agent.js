'use strict';
// ============================================================
// SLGP FLEET MANAGER - MAINTENANCE AGENT v1.0.0
// Forked from index.js on startup. Runs silently in background.
// Handles: orphan FFmpeg killer, upload reaper, log rotation,
//          memory watchdog, cache indexer, health ping, disk report
// ============================================================

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Paths (must match index.js) ──────────────────────────────
const VOLUME_PATH       = '/app/meshcentral-data';
const UPLOAD_DIR        = path.join(VOLUME_PATH, 'uploads');
const LOGS_DIR          = path.join(VOLUME_PATH, 'logs');
const ACTIVE_PIDS_FILE  = path.join(VOLUME_PATH, 'active_pids.json');
const AGENT_LOG_FILE    = path.join(LOGS_DIR, 'agent.json');
const ERROR_LOG         = path.join(LOGS_DIR, 'errors.json');
const DEBUG_LOG         = path.join(LOGS_DIR, 'debug.json');
const CAMERA_LOG        = path.join(LOGS_DIR, 'camera-issues.json');
const PERFORMANCE_LOG   = path.join(LOGS_DIR, 'performance.json');

// ── Thresholds ───────────────────────────────────────────────
const FFMPEG_ORPHAN_AGE_MS   = 5  * 60 * 1000;  // kill ffmpeg if stuck > 5 min
const UPLOAD_STALE_AGE_MS    = 10 * 60 * 1000;  // delete upload temp > 10 min
const LOG_MAX_BYTES          = 500 * 1024;       // rotate logs > 500KB
const LOG_KEEP_ENTRIES       = 200;              // keep last 200 entries per log
const MEMORY_WARN_MB         = 400;             // warn if heap > 400MB
const HEALTH_PING_PORT       = process.env.PORT || 8080;
const HEALTH_PING_INTERVAL   = 5  * 60 * 1000;  // ping every 5 min
const ORPHAN_CHECK_INTERVAL  = 2  * 60 * 1000;  // scan for orphans every 2 min
const UPLOAD_REAP_INTERVAL   = 5  * 60 * 1000;  // reap uploads every 5 min
const LOG_ROTATE_INTERVAL    = 30 * 60 * 1000;  // rotate logs every 30 min
const MEMORY_CHECK_INTERVAL  = 5  * 60 * 1000;  // check memory every 5 min
const MIDNIGHT_HOUR          = 23;
const MIDNIGHT_MIN           = 58;

// ── Utilities ────────────────────────────────────────────────
function agentLog(category, message, data = {}) {
    const entry = { category, message, ...data, ts: new Date().toISOString() };
    console.log(`🤖 [Agent/${category}] ${message}`);
    try {
        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(AGENT_LOG_FILE, 'utf8')); } catch(e) {}
        logs.push(entry);
        if (logs.length > 500) logs = logs.slice(-500);
        fs.writeFileSync(AGENT_LOG_FILE, JSON.stringify(logs, null, 2));
    } catch(e) {}
}

function getActivePids() {
    try {
        if (!fs.existsSync(ACTIVE_PIDS_FILE)) return new Set();
        return new Set(JSON.parse(fs.readFileSync(ACTIVE_PIDS_FILE, 'utf8')));
    } catch(e) { return new Set(); }
}

function isProcessRunning(pid) {
    try { process.kill(pid, 0); return true; } catch(e) { return false; }
}

function getProcessAge(pid) {
    try {
        // /proc/[pid]/stat field 22 = starttime in clock ticks since boot
        const stat    = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields  = stat.split(' ');
        const ticks   = parseInt(fields[21]);
        const clkTck  = 100; // standard Linux HZ
        const uptime  = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
        const ageS    = uptime - (ticks / clkTck);
        return ageS * 1000; // ms
    } catch(e) { return 0; }
}

// ── TASK 1: FFmpeg Orphan Killer ────────────────────────────
function killOrphanFFmpeg() {
    try {
        const activePids = getActivePids();
        let output = '';
        try { output = execSync('pgrep -x ffmpeg', { encoding: 'utf8', stdio: 'pipe' }); } catch(e) {
            return; // no ffmpeg processes running - all good
        }

        const runningPids = output.trim().split('\n').map(Number).filter(Boolean);
        let killed = 0;

        for (const pid of runningPids) {
            if (activePids.has(pid)) {
                // This is a registered active job - never touch it
                agentLog('ORPHAN', `PID ${pid} is an active job - protected`, { pid });
                continue;
            }

            const ageMs = getProcessAge(pid);
            if (ageMs > FFMPEG_ORPHAN_AGE_MS) {
                try {
                    process.kill(pid, 'SIGKILL');
                    killed++;
                    agentLog('ORPHAN', `Killed orphan FFmpeg PID ${pid} (age: ${(ageMs/1000/60).toFixed(1)}min)`, { pid, ageMs });
                } catch(e) {
                    agentLog('ORPHAN', `Failed to kill PID ${pid}: ${e.message}`, { pid });
                }
            } else {
                agentLog('ORPHAN', `PID ${pid} running ${(ageMs/1000).toFixed(0)}s - within threshold, leaving`, { pid, ageMs });
            }
        }

        if (killed > 0) agentLog('ORPHAN', `Orphan sweep complete - killed ${killed} process(es)`, { killed });
    } catch(e) {
        agentLog('ORPHAN', `Orphan check error: ${e.message}`);
    }
}

// ── TASK 2: Upload Dir Reaper ────────────────────────────────
function reapStaleUploads() {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    try {
        const files  = fs.readdirSync(UPLOAD_DIR);
        const now    = Date.now();
        let reaped   = 0;
        let totalMB  = 0;

        for (const file of files) {
            // Skip non-media files (PDFs and logs managed separately)
            const ext = path.extname(file).toLowerCase();
            if (!['.mp4', '.webm', '.mov', ''].includes(ext)) continue;

            const filePath = path.join(UPLOAD_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) continue;

                const ageMs = now - stat.mtimeMs;
                if (ageMs > UPLOAD_STALE_AGE_MS) {
                    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
                    fs.unlinkSync(filePath);
                    reaped++;
                    totalMB += parseFloat(sizeMB);
                    agentLog('REAPER', `Deleted stale upload: ${file} (${sizeMB}MB, age: ${(ageMs/1000/60).toFixed(1)}min)`, { file, sizeMB, ageMs });
                }
            } catch(e) {}
        }

        if (reaped > 0) agentLog('REAPER', `Upload reap: removed ${reaped} file(s), freed ${totalMB.toFixed(2)}MB`, { reaped, totalMB });
    } catch(e) {
        agentLog('REAPER', `Upload reap error: ${e.message}`);
    }
}

// ── TASK 3: Log Rotation ─────────────────────────────────────
function rotateLogs() {
    const logFiles = [ERROR_LOG, DEBUG_LOG, CAMERA_LOG, PERFORMANCE_LOG, AGENT_LOG_FILE];

    for (const logFile of logFiles) {
        if (!fs.existsSync(logFile)) continue;
        try {
            const stat = fs.statSync(logFile);
            if (stat.size < LOG_MAX_BYTES) continue;

            const logs    = JSON.parse(fs.readFileSync(logFile, 'utf8'));
            const before  = logs.length;
            const trimmed = logs.slice(-LOG_KEEP_ENTRIES);
            fs.writeFileSync(logFile, JSON.stringify(trimmed, null, 2));

            const after     = trimmed.length;
            const savedKB   = ((stat.size - fs.statSync(logFile).size) / 1024).toFixed(0);
            agentLog('ROTATE', `Rotated ${path.basename(logFile)}: ${before} → ${after} entries, freed ${savedKB}KB`, { logFile: path.basename(logFile), before, after, savedKB });
        } catch(e) {
            agentLog('ROTATE', `Rotation error for ${path.basename(logFile)}: ${e.message}`);
        }
    }
}

// ── TASK 4: Memory Watchdog ──────────────────────────────────
function checkMemory() {
    try {
        const mem        = process.memoryUsage();
        const heapMB     = (mem.heapUsed  / 1024 / 1024).toFixed(1);
        const totalMB    = (mem.heapTotal / 1024 / 1024).toFixed(1);
        const rssMB      = (mem.rss       / 1024 / 1024).toFixed(1);

        agentLog('MEMORY', `Heap: ${heapMB}/${totalMB}MB used, RSS: ${rssMB}MB`, { heapMB, totalMB, rssMB });

        if (parseFloat(heapMB) > MEMORY_WARN_MB) {
            agentLog('MEMORY', `⚠️  HIGH MEMORY: ${heapMB}MB heap used - above ${MEMORY_WARN_MB}MB threshold`, { heapMB, MEMORY_WARN_MB });
            // Write to error log so it shows in debug dashboard
            try {
                let errors = [];
                try { errors = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch(e) {}
                errors.push({ type: 'agent_warning', severity: 'warning', message: `High memory: ${heapMB}MB heap`, source: 'agent', timestamp: new Date().toISOString(), serverTime: Date.now() });
                if (errors.length > 1000) errors = errors.slice(-1000);
                fs.writeFileSync(ERROR_LOG, JSON.stringify(errors, null, 2));
            } catch(e) {}
        }
    } catch(e) {
        agentLog('MEMORY', `Memory check error: ${e.message}`);
    }
}

// ── TASK 5: Self-Health Ping ─────────────────────────────────
async function healthPing() {
    const start = Date.now();
    try {
        const http = require('http');
        await new Promise((resolve, reject) => {
            const req = http.get(`http://localhost:${HEALTH_PING_PORT}/version`, { timeout: 10000 }, (res) => {
                const ms = Date.now() - start;
                if (res.statusCode === 200) {
                    agentLog('HEALTH', `Server ping OK - ${ms}ms response`, { ms, statusCode: res.statusCode });
                    if (ms > 3000) agentLog('HEALTH', `⚠️  SLOW RESPONSE: ${ms}ms - server may be under load`, { ms });
                } else {
                    agentLog('HEALTH', `Server ping returned ${res.statusCode}`, { statusCode: res.statusCode, ms });
                }
                res.resume();
                resolve();
            });
            req.on('error', (e) => reject(e));
            req.on('timeout', () => { req.destroy(); reject(new Error('Health ping timeout (10s)')); });
        });
    } catch(e) {
        agentLog('HEALTH', `⚠️  Health ping FAILED: ${e.message} - server may be down`, { error: e.message });
    }
}

// ── TASK 6: Midnight Disk / Volume Summary ───────────────────
function diskSummary() {
    try {
        let totalFiles  = 0;
        let totalBytes  = 0;
        const logSizes  = {};

        // Upload dir stats
        if (fs.existsSync(UPLOAD_DIR)) {
            const files = fs.readdirSync(UPLOAD_DIR);
            for (const f of files) {
                try {
                    const stat = fs.statSync(path.join(UPLOAD_DIR, f));
                    if (stat.isFile()) { totalFiles++; totalBytes += stat.size; }
                } catch(e) {}
            }
        }

        // Log sizes
        const logFiles = [ERROR_LOG, DEBUG_LOG, CAMERA_LOG, PERFORMANCE_LOG, AGENT_LOG_FILE];
        for (const lf of logFiles) {
            if (fs.existsSync(lf)) {
                try {
                    const stat = fs.statSync(lf);
                    logSizes[path.basename(lf)] = (stat.size / 1024).toFixed(1) + 'KB';
                } catch(e) {}
            }
        }

        // Volume total (if available)
        let volumeInfo = '';
        try {
            volumeInfo = execSync(`df -h ${VOLUME_PATH} | tail -1`, { encoding: 'utf8', stdio: 'pipe' }).trim();
        } catch(e) {}

        agentLog('DISK', `Daily summary - Uploads: ${totalFiles} files, ${(totalBytes/1024/1024).toFixed(2)}MB | Logs: ${JSON.stringify(logSizes)}`, {
            uploadFiles: totalFiles,
            uploadMB: (totalBytes/1024/1024).toFixed(2),
            logSizes,
            volumeInfo
        });

        // Notify parent process (index.js)
        if (process.send) {
            process.send(`Daily disk summary: ${totalFiles} upload files, ${(totalBytes/1024/1024).toFixed(2)}MB. Volume: ${volumeInfo}`);
        }
    } catch(e) {
        agentLog('DISK', `Disk summary error: ${e.message}`);
    }
}

// ── Midnight scheduler ───────────────────────────────────────
let midnightFired = false;
function checkMidnight() {
    const now = new Date();
    if (now.getHours() === MIDNIGHT_HOUR && now.getMinutes() >= MIDNIGHT_MIN) {
        if (!midnightFired) {
            midnightFired = true;
            diskSummary();
            // Reset flag after 2 min so it doesn't re-fire the same minute
            setTimeout(() => { midnightFired = false; }, 2 * 60 * 1000);
        }
    }
}

// ── Startup ──────────────────────────────────────────────────
agentLog('STARTUP', 'Maintenance agent started', { pid: process.pid, node: process.version });

// Ensure dirs exist
if (!fs.existsSync(LOGS_DIR)) { try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch(e) {} }
if (!fs.existsSync(UPLOAD_DIR)) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch(e) {} }

// Initialize PID file
try { if (!fs.existsSync(ACTIVE_PIDS_FILE)) fs.writeFileSync(ACTIVE_PIDS_FILE, JSON.stringify([])); } catch(e) {}

// Run all tasks once on startup (staggered to avoid burst)
setTimeout(() => killOrphanFFmpeg(),  5000);
setTimeout(() => reapStaleUploads(),  10000);
setTimeout(() => rotateLogs(),        15000);
setTimeout(() => checkMemory(),       20000);
setTimeout(() => healthPing(),        30000);

// ── Scheduled intervals ──────────────────────────────────────
setInterval(killOrphanFFmpeg,  ORPHAN_CHECK_INTERVAL);
setInterval(reapStaleUploads,  UPLOAD_REAP_INTERVAL);
setInterval(rotateLogs,        LOG_ROTATE_INTERVAL);
setInterval(checkMemory,       MEMORY_CHECK_INTERVAL);
setInterval(healthPing,        HEALTH_PING_INTERVAL);
setInterval(checkMidnight,     60 * 1000); // check every minute for midnight

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGTERM', () => {
    agentLog('SHUTDOWN', 'Agent received SIGTERM - shutting down');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    agentLog('ERROR', `Uncaught exception: ${err.message}`, { stack: err.stack });
    // Don't crash - agent must stay alive
});

process.on('unhandledRejection', (reason) => {
    agentLog('ERROR', `Unhandled rejection: ${reason}`);
    // Don't crash
});
