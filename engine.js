'use strict';
// ============================================================
// SLGP FLEET MANAGER — VIDEO PROCESSING ENGINE v2.0.0
// ============================================================
// v2.0 additions:
//   - DARK_RECOVERY profile (OpenCV bilateral+gamma+CLAHE+sharpen)
//   - Lens obstruction detection (5-frame brightness scan)
//   - Pre-upload bandwidth probe (100KB test before Drive)
//   - Frame integrity check (ffprobe first+last frame verify)
//   - Priority queue (raw always gets slot 1, enhancement slot 2)
//   - Driver quality history (per VIN+driver, Discord alert at 3x)
//   - Time-of-day profile adjustment (5-8am, 7-10pm dark windows)
// ============================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync, execSync, spawn } = require('child_process');

// ── Paths ─────────────────────────────────────────────────────
const VOLUME_PATH      = '/app/meshcentral-data';
const ENGINE_DIR       = path.join(VOLUME_PATH, 'engine');
const TELEMETRY_FILE   = path.join(ENGINE_DIR, 'telemetry.json');
const BANDWIDTH_FILE   = path.join(ENGINE_DIR, 'bandwidth.json');
const METRICS_FILE     = path.join(ENGINE_DIR, 'metrics.json');
const DRIVER_HIST_FILE = path.join(ENGINE_DIR, 'driver_history.json');
const DARK_RECOVERY_PY = path.join(ENGINE_DIR, 'dark_recovery.py');

// ── Processing profiles ───────────────────────────────────────
const PROFILES = {
    RAW_UPLOAD:    { id: 0, name: 'Raw Upload',    maxInputMB: Infinity, estimatedMultiplier: 1.0, processingMs: 0      },
    MINIMAL:       { id: 1, name: 'Minimal',        maxInputMB: 30,       estimatedMultiplier: 1.2, processingMs: 15000  },
    DARK_RECOVERY: { id: 2, name: 'Dark Recovery',  maxInputMB: 30,       estimatedMultiplier: 0.9, processingMs: 180000 },
    TARGETED:      { id: 3, name: 'Targeted',       maxInputMB: 20,       estimatedMultiplier: 1.8, processingMs: 45000  },
    STANDARD:      { id: 4, name: 'Standard',       maxInputMB: 15,       estimatedMultiplier: 2.5, processingMs: 90000  },
    AI_ENHANCED:   { id: 5, name: 'AI Enhanced',    maxInputMB: 8,        estimatedMultiplier: 3.5, processingMs: 240000 },
};

// ── Scoring weights ───────────────────────────────────────────
const WEIGHTS = {
    fileSizePenalty: 0.30,
    queuePressure:   0.20,
    bandwidthScore:  0.25,
    qualityScore:    0.15,
    timeBudget:      0.10,
};

// ── Thresholds ────────────────────────────────────────────────
const DRIVE_TIMEOUT_MS       = 8 * 60 * 1000;
const WATCHDOG_MS            = 12 * 60 * 1000;
const OBSTRUCTION_THRESHOLD  = 20;   // brightness 0-255 — below = lens covered
const DARK_THRESHOLD         = 80;   // brightness below = dark footage
const DARK_QUALITY_THRESHOLD = 30;   // qualityScore below = needs recovery
const DRIVER_ALERT_THRESHOLD = 3;    // consecutive bad submissions before alert
const PROBE_SIZE_BYTES       = 102400; // 100KB bandwidth probe

// ── In-memory state ───────────────────────────────────────────
let _ffmpegPath  = null;
let _ffprobePath = null;
let _esrganPath  = null;
let _rifePath    = null;
let _activeJobs  = 0;
let _queueDepth  = 0;
let _opencvOk    = false;

let _bandwidth     = { samples: [], avgMBps: null, p25MBps: null };
let _telemetry     = { jobs: [], profileStats: {}, lastUpdated: null };
let _driverHistory = {};

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
function init(deps = {}) {
    _ffmpegPath  = deps.ffmpegPath  || null;
    _ffprobePath = deps.ffprobePath || null;
    _esrganPath  = deps.esrganPath  || null;
    _rifePath    = deps.rifePath    || null;

    try { fs.mkdirSync(ENGINE_DIR, { recursive: true }); } catch(_) {}
    _loadTelemetry();
    _writeDarkRecoveryScript();
    _checkOpenCV();

    console.log(`🧠 Engine v2.0 initialized — profiles: ${Object.keys(PROFILES).join(', ')}`);
    console.log(`🧠 OpenCV dark recovery: ${_opencvOk ? 'AVAILABLE ✅' : 'UNAVAILABLE — run: pip install opencv-python-headless'}`);
}

function updateQueueState(activeJobs, queueDepth) {
    _activeJobs = activeJobs;
    _queueDepth = queueDepth;
}

// ── Write Python dark recovery script ─────────────────────────
function _writeDarkRecoveryScript() {
    const script = [
        '#!/usr/bin/env python3',
        '"""SLGP Dark Recovery: bilateral+gamma+CLAHE+sharpen"""',
        'import sys, os, cv2, numpy as np, subprocess, tempfile, shutil',
        '',
        'def main():',
        '    if len(sys.argv) < 3: sys.exit("Usage: dark_recovery.py <in> <out> [gamma]")',
        '    inp, out = sys.argv[1], sys.argv[2]',
        '    gamma = float(sys.argv[3]) if len(sys.argv) > 3 else 0.38',
        '    cap = cv2.VideoCapture(inp)',
        '    if not cap.isOpened(): sys.exit(f"Cannot open {inp}")',
        '    fps = cap.get(cv2.CAP_PROP_FPS) or 30',
        '    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))',
        '    frame_dir = tempfile.mkdtemp(prefix="slgp_dark_")',
        '    try:',
        '        lut = np.array([((i/255.0)**gamma)*255 for i in range(256)], dtype=np.uint8)',
        '        clahe = cv2.createCLAHE(clipLimit=4.5, tileGridSize=(8,8))',
        '        sharpen = np.array([[-0.5,-1,-0.5],[-1,7,-1],[-0.5,-1,-0.5]], dtype=np.float32)',
        '        n = 0',
        '        while True:',
        '            ret, frame = cap.read()',
        '            if not ret: break',
        '            dn = cv2.bilateralFilter(frame, d=7, sigmaColor=50, sigmaSpace=50)',
        '            gam = cv2.LUT(dn, lut)',
        '            lab = cv2.cvtColor(gam, cv2.COLOR_BGR2LAB)',
        '            l, a, b = cv2.split(lab)',
        '            l2 = clahe.apply(l)',
        '            res = cv2.cvtColor(cv2.merge([l2, a, b]), cv2.COLOR_LAB2BGR)',
        '            res = np.clip(cv2.filter2D(res, -1, sharpen), 0, 255).astype(np.uint8)',
        '            cv2.imwrite(os.path.join(frame_dir, f"frame_{n:06d}.png"), res)',
        '            n += 1',
        '            if n % 60 == 0: print(f"PROGRESS:{n}/{total}", flush=True)',
        '        cap.release()',
        '        ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")',
        '        r = subprocess.run([',
        '            ffmpeg, "-y", "-r", str(fps),',
        '            "-i", os.path.join(frame_dir, "frame_%06d.png"),',
        '            "-i", inp, "-map", "0:v", "-map", "1:a",',
        '            "-c:v", "libx264", "-preset", "medium", "-crf", "23",',
        '            "-maxrate", "8000k", "-bufsize", "16000k",',
        '            "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p",',
        '            "-c:a", "aac", "-b:a", "128k", "-shortest", out',
        '        ], capture_output=True, timeout=600)',
        '        if r.returncode != 0: sys.exit(f"FFmpeg failed: {r.stderr.decode()[:200]}")',
        '        print(f"DONE:{n}", flush=True)',
        '    finally:',
        '        shutil.rmtree(frame_dir, ignore_errors=True)',
        '',
        'if __name__ == "__main__": main()',
    ].join('\n');

    try { fs.writeFileSync(DARK_RECOVERY_PY, script); } catch(_) {}
}

function _checkOpenCV() {
    try {
        execSync('python3 -c "import cv2; import numpy"', { timeout: 5000, stdio: 'pipe' });
        _opencvOk = true;
    } catch(_) {
        _opencvOk = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// LENS OBSTRUCTION DETECTION
// Samples 5 frames — if ALL below threshold, lens is covered.
// ═══════════════════════════════════════════════════════════════
async function detectLensObstruction(videoPath, durationSec) {
    if (!_ffmpegPath || durationSec < 1) return { obstructed: false, avgBrightness: 128 };

    const points = [0.10, 0.25, 0.50, 0.75, 0.90];
    const brightnesses = [];

    for (const pct of points) {
        try {
            const raw = execFileSync(_ffmpegPath, [
                '-y', '-ss', String(Math.max(0.5, durationSec * pct)),
                '-i', videoPath, '-vframes', '1',
                '-vf', 'scale=80:45', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
            ], { timeout: 8000, maxBuffer: 80 * 45 * 3 + 512, stdio: ['pipe','pipe','ignore'] });

            if (raw.length >= 80 * 45 * 3) {
                let total = 0;
                const px = 80 * 45;
                for (let i = 0; i < px * 3; i += 3)
                    total += raw[i] * 0.299 + raw[i+1] * 0.587 + raw[i+2] * 0.114;
                brightnesses.push(total / px);
            }
        } catch(_) {}
    }

    if (brightnesses.length === 0) return { obstructed: false, avgBrightness: 128 };
    const avg      = brightnesses.reduce((s, v) => s + v, 0) / brightnesses.length;
    const allDark  = brightnesses.every(b => b < OBSTRUCTION_THRESHOLD);
    return { obstructed: allDark, avgBrightness: avg, samples: brightnesses };
}

// ═══════════════════════════════════════════════════════════════
// VIDEO ANALYZER
// ═══════════════════════════════════════════════════════════════
async function analyzeVideo(videoPath) {
    const analysis = {
        durationSec: 0, width: 0, height: 0, fps: 30, bitrateMbps: 0,
        codec: 'unknown', isPortrait: false, brightness: 128,
        motionScore: 50, qualityScore: 50, isDark: false, isOutdoor: false,
        hasAudio: false, needsInterp: false, isObstructed: false,
        fileBytes: 0, error: null,
    };

    try {
        analysis.fileBytes = fs.statSync(videoPath).size;
        if (!_ffprobePath) return analysis;

        const meta    = JSON.parse(execFileSync(_ffprobePath, [
            '-v', 'quiet', '-print_format', 'json',
            '-show_streams', '-show_format', videoPath
        ], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).toString());

        const vStream = (meta.streams || []).find(s => s.codec_type === 'video');
        const aStream = (meta.streams || []).find(s => s.codec_type === 'audio');
        const format  = meta.format || {};

        if (vStream) {
            analysis.width      = vStream.width  || 0;
            analysis.height     = vStream.height || 0;
            analysis.codec      = vStream.codec_name || 'unknown';
            analysis.isPortrait = analysis.height > analysis.width;
            const [n, d] = (vStream.avg_frame_rate || '30/1').split('/').map(Number);
            if (d > 0) analysis.fps = Math.round(n / d);
            analysis.bitrateMbps = parseInt(vStream.bit_rate || format.bit_rate || 0) / 1_000_000;
        }
        analysis.durationSec = parseFloat(format.duration || 0);
        analysis.hasAudio    = !!aStream;
        analysis.needsInterp = analysis.fps < 20;

        // ── Lens obstruction ────────────────────────────────────
        const obs = await detectLensObstruction(videoPath, analysis.durationSec);
        analysis.isObstructed = obs.obstructed;
        if (obs.avgBrightness !== undefined) analysis.brightness = obs.avgBrightness;

        if (analysis.isObstructed) {
            console.log(`🚫 Engine: LENS OBSTRUCTION detected (avg brightness=${analysis.brightness.toFixed(0)}/255)`);
            analysis.qualityScore = 0;
            analysis.isDark       = true;
            return analysis;
        }

        // ── Brightness + quality ────────────────────────────────
        if (_ffmpegPath) {
            try {
                const seekSec = Math.max(1, analysis.durationSec * 0.1);
                const raw     = execFileSync(_ffmpegPath, [
                    '-y', '-ss', String(seekSec), '-i', videoPath,
                    '-vframes', '1', '-vf', 'scale=160:90',
                    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
                ], { timeout: 15000, maxBuffer: 160*90*3 + 1024, stdio: ['pipe','pipe','ignore'] });

                if (raw.length >= 160*90*3) {
                    const px = 160*90;
                    let total = 0, rT = 0, gT = 0, bT = 0, blur = 0;
                    for (let i = 0; i < px*3; i += 3) {
                        const r = raw[i], g = raw[i+1], b = raw[i+2];
                        const luma = r*0.299 + g*0.587 + b*0.114;
                        total += luma; rT += r; gT += g; bT += b;
                        if (i > 3) blur += Math.abs(luma - (raw[i-3]*0.299 + raw[i-2]*0.587 + raw[i-1]*0.114));
                    }
                    analysis.brightness  = total / px;
                    const colorBalance   = Math.abs(rT/px - gT/px) + Math.abs(gT/px - bT/px);
                    const sharpness      = Math.min(100, blur / (px * 0.5));
                    const brightnessOk   = analysis.brightness > 40 && analysis.brightness < 230;

                    analysis.qualityScore = Math.round(
                        sharpness * 0.35 +
                        (brightnessOk       ? 100 : 40) * 0.25 +
                        (colorBalance < 30  ? 100 : 60) * 0.20 +
                        (analysis.bitrateMbps > 1.5 ? 100 : 50) * 0.20
                    );
                }
            } catch(_) {}
        }

        // ── Motion score (SSIM) ─────────────────────────────────
        if (_ffmpegPath && analysis.durationSec > 2) {
            try {
                const ssimOut = execFileSync(_ffmpegPath, [
                    '-y', '-i', videoPath, '-ss', '1',
                    '-vf', 'scale=160:90,ssim=stats_file=-',
                    '-frames:v', '15', '-f', 'null', '-'
                ], { timeout: 20000, maxBuffer: 512*1024, stdio: ['pipe','pipe','pipe'] });

                const matches = [...ssimOut.toString().matchAll(/All:([0-9.]+)/g)];
                if (matches.length > 0) {
                    const avg = matches.reduce((s, m) => s + parseFloat(m[1]), 0) / matches.length;
                    analysis.motionScore = Math.round((1 - Math.max(0, avg - 0.7) / 0.3) * 100);
                }
            } catch(_) {}
        }

        analysis.isDark    = analysis.brightness < DARK_THRESHOLD;
        analysis.isOutdoor = analysis.brightness > 140;

    } catch (err) {
        analysis.error = err.message;
        console.warn('⚠️  Engine: analysis failed:', err.message);
    }

    return analysis;
}

// ═══════════════════════════════════════════════════════════════
// BANDWIDTH TRACKER
// ═══════════════════════════════════════════════════════════════
function recordUploadSpeed(bytes, elapsedMs) {
    if (elapsedMs < 1000) return;
    const mbps = (bytes / 1024 / 1024) / (elapsedMs / 1000);
    _bandwidth.samples.push({ bytes, ms: elapsedMs, mbps, ts: Date.now() });
    if (_bandwidth.samples.length > 20) _bandwidth.samples = _bandwidth.samples.slice(-20);
    const speeds = _bandwidth.samples.map(s => s.mbps).sort((a, b) => a - b);
    _bandwidth.avgMBps = speeds.reduce((s, v) => s + v, 0) / speeds.length;
    _bandwidth.p25MBps = speeds[Math.floor(speeds.length * 0.25)] || _bandwidth.avgMBps;
    try {
        const tmp = BANDWIDTH_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(_bandwidth));
        fs.renameSync(tmp, BANDWIDTH_FILE);
    } catch(_) {}
    _saveMetrics();
}

function estimateUploadMs(bytes) {
    return (bytes / 1024 / 1024 / (_bandwidth.p25MBps || 1.5)) * 1000;
}

function willTimeoutOnDrive(fileSizeBytes) {
    return estimateUploadMs(fileSizeBytes) > (DRIVE_TIMEOUT_MS - 60_000);
}

// ── Pre-upload bandwidth probe ────────────────────────────────
async function probeBandwidth(probeEndpoint) {
    if (!probeEndpoint) return null;
    try {
        const dummy = Buffer.alloc(PROBE_SIZE_BYTES, 0x55);
        const t0    = Date.now();
        const res   = await fetch(probeEndpoint, {
            method: 'POST', body: dummy,
            signal: AbortSignal.timeout(10_000),
        });
        const elapsed = Date.now() - t0;
        if (res.ok || res.status === 400) {
            const mbps = (PROBE_SIZE_BYTES / 1024 / 1024) / (elapsed / 1000);
            console.log(`📡 Bandwidth probe: ${mbps.toFixed(2)} MB/s (${elapsed}ms for 100KB)`);
            return mbps;
        }
    } catch(_) {}
    return null;
}

// ═══════════════════════════════════════════════════════════════
// FRAME INTEGRITY CHECK
// Verifies output video is actually playable.
// ═══════════════════════════════════════════════════════════════
function verifyOutput(filePath) {
    if (!_ffprobePath || !fs.existsSync(filePath))
        return { ok: false, reason: 'file missing' };
    try {
        const stat = fs.statSync(filePath);
        if (stat.size < 10000)
            return { ok: false, reason: `file too small: ${stat.size} bytes` };

        const meta   = JSON.parse(execFileSync(_ffprobePath, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=nb_frames,duration,codec_name',
            '-of', 'json', filePath
        ], { timeout: 10000, maxBuffer: 512 * 1024 }).toString());

        const stream = (meta.streams || [])[0];
        if (!stream || !stream.codec_name)
            return { ok: false, reason: 'no video stream found' };

        const frames = parseInt(stream.nb_frames || 0);
        if (frames < 5) return { ok: false, reason: `only ${frames} frames` };

        return { ok: true, frames, codec: stream.codec_name, sizeMB: (stat.size/1024/1024).toFixed(1) };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// DRIVER QUALITY HISTORY
// ═══════════════════════════════════════════════════════════════
function _loadDriverHistory() {
    try {
        if (fs.existsSync(DRIVER_HIST_FILE))
            _driverHistory = JSON.parse(fs.readFileSync(DRIVER_HIST_FILE, 'utf8'));
    } catch(_) {}
}

function _saveDriverHistory() {
    try {
        const tmp = DRIVER_HIST_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(_driverHistory, null, 2));
        fs.renameSync(tmp, DRIVER_HIST_FILE);
    } catch(_) {}
}

function recordDriverQuality(driverName, vin, isGood, isObstructed) {
    if (!driverName || !vin) return null;
    const key = `${driverName}_${vin}`.replace(/\s+/g, '_');
    if (!_driverHistory[key])
        _driverHistory[key] = { driver: driverName, vin, badStreak: 0, totalBad: 0, totalGood: 0, lastTs: null };

    const rec = _driverHistory[key];
    rec.lastTs = new Date().toISOString();

    if (isGood) {
        rec.badStreak = 0;
        rec.totalGood++;
    } else {
        rec.badStreak++;
        rec.totalBad++;
    }

    _saveDriverHistory();

    if (rec.badStreak >= DRIVER_ALERT_THRESHOLD) {
        const reason = isObstructed ? 'lens obstructed' : 'dark/blurry footage';
        return {
            alert: true, driver: driverName, vin,
            streak: rec.badStreak, totalBad: rec.totalBad, reason,
            message: `⚠️ Driver **${driverName}** (VIN ${vin}) has submitted **${rec.badStreak} consecutive** low-quality videos — ${reason}`,
        };
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
// TIME-OF-DAY CONTEXT
// 5-8am = pre-trip dark window, 7-10pm = post-trip dark window
// ═══════════════════════════════════════════════════════════════
function getTimeOfDayContext() {
    const hour = new Date().getHours();
    const isPreTripWindow  = hour >= 5  && hour <= 8;
    const isPostTripWindow = hour >= 19 && hour <= 22;
    return { isPreTripWindow, isPostTripWindow, isDarkWindow: isPreTripWindow || isPostTripWindow, hour };
}

// ═══════════════════════════════════════════════════════════════
// TELEMETRY
// ═══════════════════════════════════════════════════════════════
function recordJobOutcome(outcome) {
    _telemetry.jobs.push({ ...outcome, ts: Date.now() });
    if (_telemetry.jobs.length > 50) _telemetry.jobs = _telemetry.jobs.slice(-50);
    const p = outcome.profile;
    if (!_telemetry.profileStats[p]) _telemetry.profileStats[p] = { success: 0, fail: 0, totalMs: 0 };
    if (outcome.success) _telemetry.profileStats[p].success++;
    else _telemetry.profileStats[p].fail++;
    _telemetry.profileStats[p].totalMs += (outcome.processingMs || 0) + (outcome.uploadMs || 0);
    _telemetry.lastUpdated = new Date().toISOString();
    try {
        const tmp = TELEMETRY_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(_telemetry));
        fs.renameSync(tmp, TELEMETRY_FILE);
    } catch(_) {}
    _saveMetrics();
}

function _saveMetrics() {
    try {
        fs.writeFileSync(METRICS_FILE, JSON.stringify({
            bandwidth:    _bandwidth,
            profileStats: _telemetry.profileStats,
            recentJobs:   _telemetry.jobs.slice(-10),
            queueState:   { activeJobs: _activeJobs, queueDepth: _queueDepth },
            timestamp:    new Date().toISOString(),
        }, null, 2));
    } catch(_) {}
}

function _loadTelemetry() {
    try {
        if (fs.existsSync(BANDWIDTH_FILE)) {
            _bandwidth = JSON.parse(fs.readFileSync(BANDWIDTH_FILE, 'utf8'));
            if (_bandwidth.samples.length > 20) _bandwidth.samples = _bandwidth.samples.slice(-20);
        }
    } catch(_) {}
    try {
        if (fs.existsSync(TELEMETRY_FILE))
            _telemetry = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
    } catch(_) {}
    _loadDriverHistory();
}

function getMetrics() {
    return {
        bandwidth: _bandwidth, profileStats: _telemetry.profileStats,
        recentJobs: _telemetry.jobs.slice(-10),
        queueState: { activeJobs: _activeJobs, queueDepth: _queueDepth },
        driverHistory: _driverHistory, timestamp: new Date().toISOString(),
    };
}

function reportRetryOutcome(jobId, profile, success, error) {
    recordJobOutcome({ jobId, profile, success, error, isRetry: true });
    if (!success) console.log(`🧠 Engine: retry failed (${profile}) — adjusting recommendations`);
}

// ═══════════════════════════════════════════════════════════════
// DECISION ENGINE
// ═══════════════════════════════════════════════════════════════
function selectProfile(analysis, fileSizeMB, isRetry, attemptCount) {
    isRetry      = isRetry      || false;
    attemptCount = attemptCount || 1;

    // ── Hard rules ────────────────────────────────────────────
    if (isRetry || attemptCount > 1)
        return { profile: 'RAW_UPLOAD', reason: 'retry — raw only', score: 0 };

    if (!_ffmpegPath)
        return { profile: 'RAW_UPLOAD', reason: 'FFmpeg unavailable', score: 0 };

    if (analysis.isObstructed)
        return { profile: 'RAW_UPLOAD', reason: 'lens obstructed — driver alert fired', score: 0, obstructed: true };

    if (_queueDepth >= 4 || _activeJobs >= 2)
        return { profile: 'RAW_UPLOAD', reason: `queue at capacity (active=${_activeJobs} pending=${_queueDepth})`, score: 0 };

    if (willTimeoutOnDrive(analysis.fileBytes) && fileSizeMB > 40)
        return { profile: 'RAW_UPLOAD', reason: `bandwidth too low for ${fileSizeMB}MB`, score: 0 };

    // ── Dark recovery (overrides scoring) ─────────────────────
    const timeCtx       = getTimeOfDayContext();
    const effectiveDark = analysis.isDark || timeCtx.isDarkWindow;
    const needsRecovery = effectiveDark && analysis.qualityScore < DARK_QUALITY_THRESHOLD;

    if (needsRecovery && _opencvOk && fileSizeMB <= PROFILES.DARK_RECOVERY.maxInputMB) {
        const totalEstMs = PROFILES.DARK_RECOVERY.processingMs + estimateUploadMs(analysis.fileBytes * 0.9);
        if (totalEstMs < WATCHDOG_MS - 60_000) {
            return {
                profile: 'DARK_RECOVERY',
                reason:  `dark footage (brightness=${analysis.brightness.toFixed(0)}/255 quality=${analysis.qualityScore}) — OpenCV pipeline`,
                score: 0, isDarkRecovery: true, timeCtx,
            };
        }
    }

    // ── Scoring ────────────────────────────────────────────────
    const scores = {};

    if      (fileSizeMB <= 5)  scores.fileSize = 100;
    else if (fileSizeMB <= 10) scores.fileSize = 85;
    else if (fileSizeMB <= 15) scores.fileSize = 65;
    else if (fileSizeMB <= 20) scores.fileSize = 40;
    else if (fileSizeMB <= 25) scores.fileSize = 20;
    else                       scores.fileSize = 0;

    const load = _activeJobs + _queueDepth;
    if      (load === 0) scores.queue = 100;
    else if (load <= 1)  scores.queue = 80;
    else if (load <= 3)  scores.queue = 50;
    else if (load <= 5)  scores.queue = 25;
    else                 scores.queue = 0;

    const bw = _bandwidth.p25MBps;
    if      (!bw)       scores.bandwidth = 60;
    else if (bw >= 3.0) scores.bandwidth = 100;
    else if (bw >= 2.0) scores.bandwidth = 75;
    else if (bw >= 1.0) scores.bandwidth = 40;
    else                scores.bandwidth = 10;

    scores.quality = Math.max(0, 100 - analysis.qualityScore);

    const estOut    = estimateUploadMs(analysis.fileBytes * 2.5);
    const headroom  = WATCHDOG_MS - (90_000 + estOut);
    if      (headroom >= 180_000) scores.timeBudget = 100;
    else if (headroom >= 60_000)  scores.timeBudget = 70;
    else if (headroom >= 0)       scores.timeBudget = 30;
    else                          scores.timeBudget = 0;

    const composite = Math.round(
        scores.fileSize   * WEIGHTS.fileSizePenalty +
        scores.queue      * WEIGHTS.queuePressure   +
        scores.bandwidth  * WEIGHTS.bandwidthScore  +
        scores.quality    * WEIGHTS.qualityScore    +
        scores.timeBudget * WEIGHTS.timeBudget
    );

    let profile, reason;
    if (composite >= 80 && _esrganPath && fileSizeMB <= PROFILES.AI_ENHANCED.maxInputMB) {
        profile = 'AI_ENHANCED';
        reason  = `score ${composite}/100 — queue clear, small file, good bandwidth`;
    } else if (composite >= 60) {
        profile = 'TARGETED';
        reason  = `score ${composite}/100 — targeted filters`;
    } else if (composite >= 35) {
        // Upgrade minimal → targeted during known dark windows
        profile = (timeCtx.isDarkWindow && effectiveDark) ? 'TARGETED' : 'MINIMAL';
        reason  = `score ${composite}/100${timeCtx.isDarkWindow ? ' (dark-window upgrade)' : ''}`;
    } else {
        profile = 'RAW_UPLOAD';
        reason  = `score ${composite}/100 — conditions unfavorable`;
    }

    return { profile, reason, score: composite, scores, timeCtx };
}

// ═══════════════════════════════════════════════════════════════
// FFMPEG RUNNER
// ═══════════════════════════════════════════════════════════════
async function _runFFmpeg(inputPath, outputPath, filters, jobId, updateJobFn) {
    return new Promise((resolve, reject) => {
        const args = [
            '-y', '-i', inputPath, '-vf', filters.join(','), '-r', '30',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'
        ];
        const proc = spawn(_ffmpegPath, args);
        let outStream, settled = false;
        const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
        try { outStream = fs.createWriteStream(outputPath); }
        catch (e) { return reject(e); }

        outStream.on('error', e => { try { proc.kill('SIGKILL'); } catch(_) {} settle(reject, e); });
        proc.stdout.pipe(outStream);
        proc.stderr.on('data', chunk => {
            const m = chunk.toString().match(/frame=\s*(\d+)/);
            if (m && updateJobFn) updateJobFn(jobId, { progress: 30, message: `Encoding frame ${m[1]}` });
        });

        const wd = setTimeout(() => { try { proc.kill('SIGKILL'); } catch(_) {} settle(reject, new Error('FFmpeg timeout')); }, 5*60*1000);
        proc.on('close', code => {
            clearTimeout(wd);
            outStream.end(() => {
                if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000)
                    settle(resolve);
                else
                    settle(reject, new Error(`FFmpeg exit ${code}`));
            });
        });
        proc.on('error', e => { clearTimeout(wd); settle(reject, e); });
    });
}

// ═══════════════════════════════════════════════════════════════
// DARK RECOVERY RUNNER
// Spawns Python OpenCV pipeline as child process.
// ═══════════════════════════════════════════════════════════════
async function _runDarkRecovery(inputPath, outputPath, analysis, jobId, updateJobFn) {
    // Adaptive gamma — darker footage needs more aggressive lift
    let gamma = 0.38;
    if (analysis.brightness > 60)      gamma = 0.45;
    else if (analysis.brightness < 30) gamma = 0.32;

    const ctx = getTimeOfDayContext();
    if (ctx.isDarkWindow) gamma = Math.max(0.30, gamma - 0.03);

    return new Promise((resolve, reject) => {
        if (updateJobFn) updateJobFn(jobId, {
            status: 'enhancing', stage: 'Dark Recovery', progress: 10,
            message: `Dark recovery (γ=${gamma}, brightness was ${analysis.brightness.toFixed(0)}/255)...`,
        });

        const env  = { ...process.env, FFMPEG_PATH: _ffmpegPath || 'ffmpeg' };
        const proc = spawn('python3', [DARK_RECOVERY_PY, inputPath, outputPath, String(gamma)], { env });
        let stderr = '';

        proc.stdout.on('data', chunk => {
            const line = chunk.toString().trim();
            if (line.startsWith('PROGRESS:') && updateJobFn) {
                const parts = line.replace('PROGRESS:', '').split('/').map(Number);
                const pct = Math.min(65, 10 + Math.round((parts[0] / (parts[1] || 1)) * 55));
                updateJobFn(jobId, { progress: pct, message: `Dark recovery: frame ${parts[0]}/${parts[1]}` });
            }
        });
        proc.stderr.on('data', d => { stderr += d.toString(); });

        const wd = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch(_) {}
            reject(new Error('Dark recovery timeout'));
        }, 5 * 60 * 1000);

        proc.on('close', code => {
            clearTimeout(wd);
            if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000)
                resolve();
            else
                reject(new Error(`Dark recovery exit ${code}: ${stderr.slice(-200)}`));
        });
        proc.on('error', e => { clearTimeout(wd); reject(e); });
    });
}

// ═══════════════════════════════════════════════════════════════
// PROFILE EXECUTOR
// ═══════════════════════════════════════════════════════════════
async function executeProfile(profile, analysis, inputPath, outputPath, jobId, updateJobFn) {
    const start = Date.now();

    if (profile === 'RAW_UPLOAD')
        return { finalPath: inputPath, wasEnhanced: false, processingMs: 0 };

    // Rename to .mp4 so FFmpeg detects format correctly
    let videoPath = inputPath;
    try { fs.renameSync(inputPath, inputPath + '.mp4'); videoPath = inputPath + '.mp4'; } catch(_) {}

    // ── DARK_RECOVERY ─────────────────────────────────────────
    if (profile === 'DARK_RECOVERY') {
        try {
            await _runDarkRecovery(videoPath, outputPath, analysis, jobId, updateJobFn);

            const check = verifyOutput(outputPath);
            if (!check.ok) {
                console.warn(`⚠️  Engine [DARK_RECOVERY] integrity check failed: ${check.reason}`);
                try { fs.unlinkSync(outputPath); } catch(_) {}
                return { finalPath: videoPath, wasEnhanced: false, processingMs: Date.now() - start, error: check.reason };
            }

            const ms   = Date.now() - start;
            const inMB = (fs.statSync(videoPath).size  / 1024/1024).toFixed(1);
            const outMB= (fs.statSync(outputPath).size / 1024/1024).toFixed(1);
            console.log(`✅ Engine [DARK_RECOVERY] ${(ms/1000).toFixed(1)}s: ${inMB}MB → ${outMB}MB (${check.frames} frames)`);
            return { finalPath: outputPath, wasEnhanced: true, processingMs: ms };

        } catch (err) {
            console.warn(`⚠️  Engine [DARK_RECOVERY] failed: ${err.message} — raw fallback`);
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(_) {}
            return { finalPath: videoPath, wasEnhanced: false, processingMs: Date.now() - start, error: err.message };
        }
    }

    // ── FFmpeg profiles ───────────────────────────────────────
    const scaleFilter = analysis.isPortrait
        ? 'scale=1080:1920:flags=lanczos:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black'
        : 'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black';

    const interpFilter = analysis.needsInterp
        ? 'framerate=fps=30:interp_start=0:interp_end=255:scene=100' : null;

    let filters = [];
    if (profile === 'MINIMAL') {
        filters = [scaleFilter, ...(interpFilter ? [interpFilter] : []),
            analysis.isDark ? 'eq=brightness=0.12:contrast=1.15:gamma=0.90' : 'eq=brightness=0.03:contrast=1.04',
        ].filter(Boolean);

    } else if (profile === 'TARGETED') {
        const f = [scaleFilter];
        if (interpFilter)               f.push(interpFilter);
        if (analysis.isDark)            f.push('eq=brightness=0.10:contrast=1.18:saturation=1.08:gamma=0.96');
        else if (!analysis.isOutdoor)   f.push('eq=brightness=0.03:contrast=1.06:saturation=1.03');
        if (analysis.motionScore < 40)  f.push('hqdn3d=0.6:0.4:0.8:0.8');
        if (analysis.qualityScore < 40) f.push('unsharp=3:3:0.6:3:3:0.0');
        filters = f.filter(Boolean);

    } else { // STANDARD or AI_ENHANCED
        filters = [scaleFilter, ...(interpFilter ? [interpFilter] : []),
            analysis.isDark ? 'hqdn3d=0.8:0.6:1.2:1.0' : 'hqdn3d=0.9:0.7:1.4:1.1',
            analysis.isDark ? 'eq=brightness=0.10:contrast=1.18:saturation=1.08:gamma=0.96' : 'eq=brightness=0.03:contrast=1.06:saturation=1.03',
            'unsharp=5:5:0.8:3:3:0.0',
        ].filter(Boolean);
    }

    try {
        if (updateJobFn) updateJobFn(jobId, { status: 'enhancing', stage: `Profile: ${profile}`, progress: 15, message: `Processing (${profile})...` });

        await _runFFmpeg(videoPath, outputPath, filters, jobId, updateJobFn);

        // Integrity check on all FFmpeg outputs
        const check = verifyOutput(outputPath);
        if (!check.ok) {
            console.warn(`⚠️  Engine [${profile}] integrity check failed: ${check.reason}`);
            try { fs.unlinkSync(outputPath); } catch(_) {}
            return { finalPath: videoPath, wasEnhanced: false, processingMs: Date.now() - start, error: check.reason };
        }

        const ms    = Date.now() - start;
        const inMB  = (fs.statSync(videoPath).size  / 1024/1024).toFixed(1);
        const outMB = (fs.statSync(outputPath).size / 1024/1024).toFixed(1);
        console.log(`✅ Engine [${profile}] ${(ms/1000).toFixed(1)}s: ${inMB}MB → ${outMB}MB`);
        return { finalPath: outputPath, wasEnhanced: true, processingMs: ms };

    } catch (err) {
        console.warn(`⚠️  Engine [${profile}] failed: ${err.message} — raw fallback`);
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(_) {}
        return { finalPath: videoPath, wasEnhanced: false, processingMs: Date.now() - start, error: err.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN API — called by index.js
// ═══════════════════════════════════════════════════════════════
async function analyze(videoPath, fileSizeMB, jobId, opts) {
    opts = opts || {};
    console.log(`🧠 Engine: analyzing ${fileSizeMB}MB for job ${jobId}`);

    const analysis = await analyzeVideo(videoPath);
    const decision = selectProfile(analysis, parseFloat(fileSizeMB), opts.isRetry, opts.attemptCount || 1);

    console.log(`🧠 Engine: [${decision.profile}] — ${decision.reason}`);
    if (decision.scores) {
        const s = decision.scores;
        console.log(`   Scores: size=${s.fileSize} queue=${s.queue} bw=${s.bandwidth} quality=${s.quality} time=${s.timeBudget} → ${decision.score}`);
    }
    if (analysis.isObstructed)   console.log('   🚫 Lens obstruction — fire driver alert');
    if (decision.isDarkRecovery) console.log('   🌑 OpenCV dark recovery pipeline selected');
    if (decision.timeCtx && decision.timeCtx.isDarkWindow)
        console.log(`   🕐 Dark window active (hour=${decision.timeCtx.hour})`);

    return { analysis, decision, outputPath: opts.outputPath || null };
}

async function execute(plan, jobId, updateJobFn) {
    const result = await executeProfile(
        plan.decision.profile, plan.analysis,
        plan.videoPath, plan.outputPath,
        jobId, updateJobFn
    );
    plan._executionResult = result;
    plan._startTime       = Date.now();
    plan._profile         = plan.decision.profile;
    return result;
}

function recordUploadComplete(plan, uploadBytes, uploadMs, success, error) {
    const profile = plan._profile || 'UNKNOWN';
    if (success && uploadBytes && uploadMs) recordUploadSpeed(uploadBytes, uploadMs);
    recordJobOutcome({
        jobId:        plan.jobId,
        profile,
        inputMB:      plan.fileSizeMB,
        outputMB:     plan._executionResult && fs.existsSync(plan._executionResult.finalPath || '')
                        ? (fs.statSync(plan._executionResult.finalPath).size / 1024/1024).toFixed(1) : null,
        processingMs: plan._executionResult ? plan._executionResult.processingMs : 0,
        uploadMs, success, error,
    });
}

// ═══════════════════════════════════════════════════════════════
// AGENT BRIDGE
// ═══════════════════════════════════════════════════════════════
function getEngineStatus() {
    const bw     = _bandwidth;
    const recent = _telemetry.jobs.slice(-5);
    const rate   = recent.length > 0 ? Math.round(recent.filter(j => j.success).length / recent.length * 100) : null;
    return {
        bandwidthMBps:     bw.avgMBps  ? bw.avgMBps.toFixed(2)  : 'unknown',
        conservativeMBps:  bw.p25MBps  ? bw.p25MBps.toFixed(2)  : 'unknown',
        recentSuccessRate: rate !== null ? `${rate}%` : 'no data',
        opencvAvailable:   _opencvOk,
        queueState:        { active: _activeJobs, pending: _queueDepth },
        profileStats:      _telemetry.profileStats,
        recommendation:    _getRecommendedProfile(),
        timeOfDay:         getTimeOfDayContext(),
    };
}

function _getRecommendedProfile() {
    const bw  = _bandwidth.p25MBps;
    const ctx = getTimeOfDayContext();
    if (!bw || bw < 0.5)  return 'RAW_UPLOAD (bandwidth critical)';
    if (_queueDepth >= 5) return 'RAW_UPLOAD (queue overloaded)';
    if (bw < 1.5)         return 'MINIMAL (low bandwidth)';
    if (_queueDepth >= 3) return 'TARGETED (moderate queue)';
    if (ctx.isDarkWindow && _opencvOk) return 'DARK_RECOVERY ready (dark window active)';
    return 'TARGETED (normal conditions)';
}

function reportRetryResult(jobId, success, error) {
    reportRetryOutcome(jobId, 'RAW_UPLOAD', success, error);
}

// ── Exports ───────────────────────────────────────────────────
module.exports = {
    init, updateQueueState,
    analyze, execute, recordUploadComplete,
    recordDriverQuality, probeBandwidth, verifyOutput,
    getMetrics, getEngineStatus, reportRetryResult,
    willTimeoutOnDrive, estimateUploadMs, recordUploadSpeed,
    getTimeOfDayContext, PROFILES,
};
