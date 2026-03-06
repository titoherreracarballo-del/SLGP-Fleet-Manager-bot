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
const ENHANCED_DIR      = path.join(VOLUME_PATH, 'enhanced');
const LOGS_DIR          = path.join(VOLUME_PATH, 'logs');
const ACTIVE_PIDS_FILE  = path.join(VOLUME_PATH, 'active_pids.json');
const RETRY_QUEUE_FILE  = path.join(VOLUME_PATH, 'retry_queue.json');
const INTERNAL_PORT     = process.env.PORT || 3000;
const MAX_RETRY_ATTEMPTS = 3;
// Backoff: attempt 1 = 30s, attempt 2 = 2min, attempt 3 = 5min
const RETRY_BACKOFF_MS  = [30_000, 120_000, 300_000];
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
// In-memory buffer — flushes every 5s instead of every log call
const _logBuffer = [];
let   _logFlushTimer = null;

function _flushLogs() {
    if (_logBuffer.length === 0) return;
    const toWrite = _logBuffer.splice(0);
    try {
        let logs = [];
        try { logs = JSON.parse(fs.readFileSync(AGENT_LOG_FILE, 'utf8')); } catch(e) {}
        logs.push(...toWrite);
        if (logs.length > 500) logs = logs.slice(-500);
        fs.writeFileSync(AGENT_LOG_FILE, JSON.stringify(logs)); // compact, not pretty-printed
    } catch(e) {}
}

function agentLog(category, message, data = {}) {
    const entry = { category, message, ...data, ts: new Date().toISOString() };
    console.log(`🤖 [Agent/${category}] ${message}`);
    _logBuffer.push(entry);
    // Debounce: flush 5s after last log call
    clearTimeout(_logFlushTimer);
    _logFlushTimer = setTimeout(_flushLogs, 5000);
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
function reapDir(dirPath, label, staleMs) {
    if (!fs.existsSync(dirPath)) return { reaped: 0, totalMB: 0 };
    const now = Date.now();
    let reaped = 0, totalMB = 0;
    try {
        for (const file of fs.readdirSync(dirPath)) {
            const ext = path.extname(file).toLowerCase();
            if (!['.mp4', '.webm', '.mov', ''].includes(ext)) continue;
            const filePath = path.join(dirPath, file);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) continue;
                const ageMs = now - stat.mtimeMs;
                if (ageMs > staleMs) {
                    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
                    fs.unlinkSync(filePath);
                    reaped++;
                    totalMB += parseFloat(sizeMB);
                    agentLog('REAPER', `Deleted stale ${label}: ${file} (${sizeMB}MB, ${(ageMs/1000/60).toFixed(1)}min old)`, { file, sizeMB, ageMs });
                }
            } catch(e) {}
        }
    } catch(e) {
        agentLog('REAPER', `Reap error in ${label}: ${e.message}`);
    }
    return { reaped, totalMB };
}

function reapStaleUploads() {
    // Reap both upload temps and enhanced files (enhanced dir leak if Drive upload fails)
    const uploads  = reapDir(UPLOAD_DIR,   'upload',   UPLOAD_STALE_AGE_MS);
    const enhanced = reapDir(ENHANCED_DIR, 'enhanced', UPLOAD_STALE_AGE_MS);
    const total    = uploads.reaped + enhanced.reaped;
    const totalMB  = uploads.totalMB + enhanced.totalMB;
    if (total > 0) agentLog('REAPER', `Reap complete: removed ${total} file(s), freed ${totalMB.toFixed(2)}MB`, { uploads: uploads.reaped, enhanced: enhanced.reaped, totalMB });
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

// ============================================
// RETRY WATCHER
// Reads retry_queue.json written by index.js
// when a Drive upload fails with a network error.
// Calls /api/internal/retry-job/:jobId on index.js
// which owns the Drive client and email setup.
// ============================================
const RETRY_CHECK_INTERVAL = 60 * 1000; // check every 60 seconds
const pendingRetries = new Map(); // jobId -> scheduled timeout handle

async function processRetryQueue() {
    if (!fs.existsSync(RETRY_QUEUE_FILE)) return;

    let queue;
    try {
        queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf8'));
    } catch(e) {
        agentLog('RETRY_WATCHER', 'Could not read retry queue', { error: e.message });
        return;
    }

    if (!queue || queue.length === 0) return;

    agentLog('RETRY_WATCHER', `Found ${queue.length} job(s) in retry queue`);

    for (const entry of queue) {
        const { jobId, attemptCount, failedAt, lastError } = entry;

        // Skip if we already have this job scheduled
        if (pendingRetries.has(jobId)) continue;

        // Skip if max attempts exceeded (index.js will clean this up but belt+suspenders)
        if (attemptCount > MAX_RETRY_ATTEMPTS) {
            agentLog('RETRY_WATCHER', `Job ${jobId} exceeded max retries — skipping`, { attemptCount });
            continue;
        }

        // Calculate backoff delay based on attempt number
        const backoffMs = RETRY_BACKOFF_MS[Math.min(attemptCount - 1, RETRY_BACKOFF_MS.length - 1)];
        const timeSinceFailure = Date.now() - failedAt;

        if (timeSinceFailure < backoffMs) {
            const waitSec = Math.round((backoffMs - timeSinceFailure) / 1000);
            agentLog('RETRY_WATCHER', `Job ${jobId} waiting ${waitSec}s before retry ${attemptCount}/${MAX_RETRY_ATTEMPTS}`, { lastError });
            // Schedule it for when the backoff expires
            const handle = setTimeout(() => {
                pendingRetries.delete(jobId);
                triggerRetry(entry);
            }, backoffMs - timeSinceFailure);
            pendingRetries.set(jobId, handle);
        } else {
            // Backoff already elapsed — retry now
            agentLog('RETRY_WATCHER', `Job ${jobId} backoff elapsed — triggering retry ${attemptCount}/${MAX_RETRY_ATTEMPTS}`);
            triggerRetry(entry);
        }
    }
}

async function triggerRetry(entry) {
    const { jobId, driverName, vin, attemptCount } = entry;
    agentLog('RETRY_WATCHER', `Calling retry endpoint for job ${jobId}`, { driverName, vin, attempt: attemptCount });

    try {
        const http = require('http');
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port:     INTERNAL_PORT,
                path:     `/api/internal/retry-job/${jobId}`,
                method:   'POST',
                headers:  { 'Content-Type': 'application/json', 'Content-Length': 0 },
                timeout:  10000
            }, (res) => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        if (res.statusCode === 200) {
                            agentLog('RETRY_WATCHER', `Retry triggered successfully for ${jobId}`, parsed);
                            resolve(parsed);
                        } else {
                            agentLog('RETRY_WATCHER', `Retry endpoint returned ${res.statusCode} for ${jobId}`, parsed);
                            resolve(parsed); // index.js handles the failure
                        }
                    } catch(e) { reject(new Error('Bad response from retry endpoint')); }
                });
            });
            req.on('error',   reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Retry endpoint timeout')); });
            req.end();
        });
    } catch(e) {
        agentLog('RETRY_WATCHER', `Failed to call retry endpoint for ${jobId}`, { error: e.message });
    }
}

// ── Startup ──────────────────────────────────────────────────
agentLog('STARTUP', 'Maintenance agent started', { pid: process.pid, node: process.version });

// Ensure dirs exist
if (!fs.existsSync(LOGS_DIR)) { try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch(e) {} }
if (!fs.existsSync(UPLOAD_DIR)) { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch(e) {} }

// Initialize PID file
try { if (!fs.existsSync(ACTIVE_PIDS_FILE)) fs.writeFileSync(ACTIVE_PIDS_FILE, JSON.stringify([])); } catch(e) {}

// ============================================
// INTERRUPTED JOB RECOVERY
// Scans UPLOAD_DIR for *.manifest.json files
// with status 'pending' or 'enhancing' or 'uploading'
// — these are jobs that were mid-flight when Railway
// deployed a new version and restarted the container.
// We requeue them so no driver inspection is lost.
// ============================================
async function recoverInterruptedJobs() {
    agentLog('RECOVERY', 'Scanning for interrupted jobs...');

    let manifestFiles;
    try {
        const allFiles = fs.readdirSync(UPLOAD_DIR);
        manifestFiles = allFiles.filter(f => f.endsWith('.manifest.json'));
    } catch (e) {
        agentLog('RECOVERY', 'Could not read UPLOAD_DIR', { error: e.message });
        return;
    }

    if (manifestFiles.length === 0) {
        agentLog('RECOVERY', 'No manifest files found — nothing to recover');
        return;
    }

    agentLog('RECOVERY', `Found ${manifestFiles.length} manifest file(s)`);

    const RECOVERABLE_STATUSES = ['pending', 'enhancing', 'uploading'];
    let recovered = 0;

    for (const mFile of manifestFiles) {
        const mPath = path.join(UPLOAD_DIR, mFile);
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
        } catch (e) {
            agentLog('RECOVERY', `Could not parse manifest ${mFile}`, { error: e.message });
            continue;
        }

        const { jobId, driverName, vin, inspectionType, videoFile, status, submittedAt } = manifest;

        // Skip already complete or permanently failed jobs
        if (!RECOVERABLE_STATUSES.includes(status)) {
            // Clean up old completed manifests (older than 24h)
            const age = Date.now() - new Date(submittedAt || 0).getTime();
            if (age > 24 * 60 * 60 * 1000) {
                try { fs.unlinkSync(mPath); } catch(_) {}
                agentLog('RECOVERY', `Cleaned up old manifest: ${mFile}`);
            }
            continue;
        }

        // Check the video file still exists on disk
        const videoPath = path.join(UPLOAD_DIR, videoFile);
        if (!fs.existsSync(videoPath)) {
            agentLog('RECOVERY', `Video file missing for ${jobId} — marking as unrecoverable`, { videoFile });
            try {
                manifest.status = 'failed_permanent';
                manifest.error  = 'Video file missing after restart';
                fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
            } catch(_) {}
            continue;
        }

        // How old is this job?
        const ageMs  = Date.now() - new Date(submittedAt || 0).getTime();
        const ageMins = Math.round(ageMs / 60000);

        agentLog('RECOVERY', `Recovering interrupted job ${jobId}`, {
            driver: driverName, vin, status, ageMins
        });

        // Push to retry queue so index.js picks it up
        try {
            let queue = [];
            if (fs.existsSync(RETRY_QUEUE_FILE)) {
                queue = JSON.parse(fs.readFileSync(RETRY_QUEUE_FILE, 'utf8'));
            }

            // Don't double-queue
            const alreadyQueued = queue.some(e => e.jobId === jobId);
            if (alreadyQueued) {
                agentLog('RECOVERY', `Job ${jobId} already in retry queue — skipping`);
                continue;
            }

            queue.push({
                jobId,
                driverName,
                vin,
                inspectionType,
                videoFile,       // agent passes this so index.js knows the file
                attemptCount: 1,
                queuedAt:     Date.now(),
                reason:       'interrupted_by_deploy',
                lastError:    `Job was ${status} when server restarted`,
            });

            fs.writeFileSync(RETRY_QUEUE_FILE, JSON.stringify(queue, null, 2));

            // Update manifest so we don't re-add it on next scan
            manifest.status    = 'queued_for_recovery';
            manifest.recoveredAt = new Date().toISOString();
            fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));

            agentLog('RECOVERY', `Job ${jobId} queued for recovery`, { driver: driverName, vin });
            recovered++;

        } catch (e) {
            agentLog('RECOVERY', `Failed to queue recovery for ${jobId}`, { error: e.message });
        }
    }

    if (recovered > 0) {
        agentLog('RECOVERY', `✅ Queued ${recovered} interrupted job(s) for reprocessing`);
        // Trigger immediate retry processing rather than waiting for the interval
        setTimeout(() => processRetryQueue(), 5000);
    } else {
        agentLog('RECOVERY', 'No interrupted jobs found — all clear');
    }
}

// Run all tasks once on startup (staggered to avoid burst)
setTimeout(() => killOrphanFFmpeg(),   5000);
setTimeout(() => reapStaleUploads(),  10000);
setTimeout(() => rotateLogs(),        15000);
setTimeout(() => checkMemory(),       20000);
setTimeout(() => healthPing(),        30000);
setTimeout(() => processRetryQueue(),      45000); // check retry queue after server fully warms up
setTimeout(() => recoverInterruptedJobs(), 60000); // scan for jobs interrupted by deploy/restart

// ── Scheduled intervals ──────────────────────────────────────
setInterval(killOrphanFFmpeg,    ORPHAN_CHECK_INTERVAL);
setInterval(reapStaleUploads,    UPLOAD_REAP_INTERVAL);
setInterval(rotateLogs,          LOG_ROTATE_INTERVAL);
setInterval(checkMemory,         MEMORY_CHECK_INTERVAL);
setInterval(healthPing,          HEALTH_PING_INTERVAL);
setInterval(checkMidnight,       60 * 1000);   // check every minute for midnight
setInterval(processRetryQueue,   RETRY_CHECK_INTERVAL); // watch for failed jobs to retry

// ── Graceful shutdown ────────────────────────────────────────
process.on('SIGTERM', () => {
    agentLog('SHUTDOWN', 'Agent received SIGTERM - shutting down');
    _flushLogs(); // flush any buffered logs before exit
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
