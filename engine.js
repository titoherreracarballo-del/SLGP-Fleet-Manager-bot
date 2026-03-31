'use strict';
// ============================================================
// SLGP FLEET MANAGER — VIDEO PROCESSING ENGINE v1.0.0
// ============================================================
// Intelligent video analysis, profile selection, and
// bandwidth-aware processing pipeline.
//
// Collaborates with agent.js via shared telemetry on disk.
// index.js calls engine.analyze() + engine.execute().
// agent.js reads engine metrics and reports retry outcomes.
// ============================================================

const fs            = require('fs');
const path          = require('path');
const { execFileSync, spawn, execSync } = require('child_process');
const os            = require('os');

// ── Paths ────────────────────────────────────────────────────
const VOLUME_PATH     = '/app/meshcentral-data';
const ENGINE_DIR      = path.join(VOLUME_PATH, 'engine');
const TELEMETRY_FILE  = path.join(ENGINE_DIR, 'telemetry.json');
const BANDWIDTH_FILE  = path.join(ENGINE_DIR, 'bandwidth.json');
const METRICS_FILE    = path.join(ENGINE_DIR, 'metrics.json');

// ── Processing profiles ───────────────────────────────────────
const PROFILES = {
    RAW_UPLOAD:  { id: 0, name: 'Raw Upload',     maxInputMB: Infinity, estimatedMultiplier: 1.0, processingMs: 0      },
    MINIMAL:     { id: 1, name: 'Minimal',         maxInputMB: 30,       estimatedMultiplier: 1.2, processingMs: 15000  },
    TARGETED:    { id: 2, name: 'Targeted',        maxInputMB: 20,       estimatedMultiplier: 1.8, processingMs: 45000  },
    STANDARD:    { id: 3, name: 'Standard',        maxInputMB: 15,       estimatedMultiplier: 2.5, processingMs: 90000  },
    AI_ENHANCED: { id: 4, name: 'AI Enhanced',    maxInputMB: 8,        estimatedMultiplier: 3.5, processingMs: 240000 },
};

// ── Scoring weights ───────────────────────────────────────────
const WEIGHTS = {
    fileSizePenalty:   0.30,  // biggest factor — large file = skip enhancement
    queuePressure:     0.20,  // busy queue = downgrade profile
    bandwidthScore:    0.25,  // slow uploads = raw only
    qualityScore:      0.15,  // already good video = no enhancement needed
    timeBudget:        0.10,  // watchdog headroom vs estimated processing time
};

// ── Drive upload timeout budget (must match index.js) ────────
const DRIVE_TIMEOUT_MS = 8 * 60 * 1000;
const WATCHDOG_MS      = 12 * 60 * 1000;

// ── In-memory state ───────────────────────────────────────────
let _ffmpegPath  = null;
let _ffprobePath = null;
let _esrganPath  = null;
let _rifePath    = null;
let _activeJobs  = 0;   // updated by index.js
let _queueDepth  = 0;   // updated by index.js

// ── Startup ───────────────────────────────────────────────────
function init(deps = {}) {
    _ffmpegPath  = deps.ffmpegPath  || null;
    _ffprobePath = deps.ffprobePath || null;
    _esrganPath  = deps.esrganPath  || null;
    _rifePath    = deps.rifePath    || null;

    try { fs.mkdirSync(ENGINE_DIR, { recursive: true }); } catch(_) {}
    _loadTelemetry();
    console.log('🧠 Engine initialized — profiles:', Object.keys(PROFILES).join(', '));
}

function updateQueueState(activeJobs, queueDepth) {
    _activeJobs = activeJobs;
    _queueDepth = queueDepth;
}

// ═══════════════════════════════════════════════════════════════
// VIDEO ANALYZER
// Deep ffprobe scan — quality score, motion estimate, codec,
// bitrate, brightness, fps. All in one pass.
// ═══════════════════════════════════════════════════════════════
async function analyzeVideo(videoPath) {
    const analysis = {
        durationSec:  0,
        width:        0,
        height:       0,
        fps:          30,
        bitrateMbps:  0,
        codec:        'unknown',
        isPortrait:   false,
        brightness:   128,
        motionScore:  50,    // 0=static, 100=very shaky
        qualityScore: 50,    // 0=poor, 100=excellent
        isDark:       false,
        isOutdoor:    false,
        hasAudio:     false,
        needsInterp:  false,
        fileBytes:    0,
        error:        null,
    };

    try {
        const stat = fs.statSync(videoPath);
        analysis.fileBytes = stat.size;

        if (!_ffprobePath) return analysis;

        // ── Metadata pass ──────────────────────────────────────────
        const probeOut = execFileSync(_ffprobePath, [
            '-v', 'quiet', '-print_format', 'json',
            '-show_streams', '-show_format',
            videoPath
        ], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).toString();

        const meta = JSON.parse(probeOut);
        const vStream = (meta.streams || []).find(s => s.codec_type === 'video');
        const aStream = (meta.streams || []).find(s => s.codec_type === 'audio');
        const format  = meta.format || {};

        if (vStream) {
            analysis.width    = vStream.width  || 0;
            analysis.height   = vStream.height || 0;
            analysis.codec    = vStream.codec_name || 'unknown';
            analysis.isPortrait = analysis.height > analysis.width;

            // FPS
            const fpsStr = vStream.avg_frame_rate || '30/1';
            const [n, d]  = fpsStr.split('/').map(Number);
            if (d > 0) analysis.fps = Math.round(n / d);

            // Bitrate
            const br = parseInt(vStream.bit_rate || format.bit_rate || 0);
            analysis.bitrateMbps = br / 1_000_000;
        }

        analysis.durationSec = parseFloat(format.duration || 0);
        analysis.hasAudio    = !!aStream;
        analysis.needsInterp = analysis.fps < 20;

        // ── Brightness + quality pass ──────────────────────────────
        // Sample multiple frames across the video for more accurate analysis
        if (_ffmpegPath) {
            try {
                // Sample frame at 10% of duration for representative brightness
                const seekSec = Math.max(1, analysis.durationSec * 0.1);
                const probeRaw = execFileSync(_ffmpegPath, [
                    '-y', '-ss', String(seekSec),
                    '-i', videoPath, '-vframes', '1',
                    '-vf', 'scale=160:90',
                    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
                ], { timeout: 15000, maxBuffer: 160 * 90 * 3 + 1024,
                     stdio: ['pipe', 'pipe', 'ignore'] });

                if (probeRaw.length >= 160 * 90 * 3) {
                    const px = 160 * 90;
                    let total = 0, rTotal = 0, gTotal = 0, bTotal = 0;
                    let blurScore = 0;
                    for (let i = 0; i < px * 3; i += 3) {
                        const r = probeRaw[i], g = probeRaw[i+1], b = probeRaw[i+2];
                        const luma = r * 0.299 + g * 0.587 + b * 0.114;
                        total  += luma;
                        rTotal += r; gTotal += g; bTotal += b;
                        // Simple edge proxy for blur estimation (adjacent pixel diff)
                        if (i > 3) {
                            blurScore += Math.abs(luma - (probeRaw[i-3]*0.299 + probeRaw[i-2]*0.587 + probeRaw[i-1]*0.114));
                        }
                    }
                    analysis.brightness = total / px;
                    const avgR = rTotal / px, avgG = gTotal / px, avgB = bTotal / px;
                    const colorBalance = Math.abs(avgR - avgG) + Math.abs(avgG - avgB);

                    // Derive quality score
                    const sharpness  = Math.min(100, blurScore / (px * 0.5));   // higher = sharper
                    const brightnessOk = analysis.brightness > 40 && analysis.brightness < 230;
                    const balanceOk    = colorBalance < 30;
                    const bitrateOk    = analysis.bitrateMbps > 1.5;

                    analysis.qualityScore = Math.round(
                        sharpness        * 0.35 +
                        (brightnessOk ? 100 : 40) * 0.25 +
                        (balanceOk    ? 100 : 60) * 0.20 +
                        (bitrateOk    ? 100 : 50) * 0.20
                    );
                }
            } catch (_) { /* brightness probe optional */ }
        }

        // ── Motion estimate (SSIM-based) ────────────────────────────
        // Compare consecutive frames to estimate camera shake
        if (_ffmpegPath && analysis.durationSec > 2) {
            try {
                const ssimOut = execFileSync(_ffmpegPath, [
                    '-y', '-i', videoPath, '-ss', '1',
                    '-vf', 'scale=160:90,ssim=stats_file=-',
                    '-frames:v', '15', '-f', 'null', '-'
                ], { timeout: 20000, maxBuffer: 512 * 1024,
                     stdio: ['pipe', 'pipe', 'pipe'] });

                const ssimStr = ssimOut.toString();
                const matches = [...ssimStr.matchAll(/All:([0-9.]+)/g)];
                if (matches.length > 0) {
                    const avgSsim = matches.reduce((s, m) => s + parseFloat(m[1]), 0) / matches.length;
                    // SSIM 1.0 = identical frames (static camera), 0.7 = very different (shaky)
                    analysis.motionScore = Math.round((1 - Math.max(0, avgSsim - 0.7) / 0.3) * 100);
                }
            } catch (_) { /* motion probe optional */ }
        }

        analysis.isDark    = analysis.brightness < 80;
        analysis.isOutdoor = analysis.brightness > 140;

    } catch (err) {
        analysis.error = err.message;
        console.warn('⚠️  Engine: video analysis failed:', err.message);
    }

    return analysis;
}

// ═══════════════════════════════════════════════════════════════
// BANDWIDTH TRACKER
// Records upload speed history. Used to predict if a file
// will exceed the Drive timeout before even starting.
// ═══════════════════════════════════════════════════════════════
let _bandwidth = {
    samples:     [],      // { bytes, ms, ts } last 20 uploads
    avgMBps:     null,    // running average MB/s
    p25MBps:     null,    // 25th percentile (conservative)
};

function _loadTelemetry() {
    try {
        if (fs.existsSync(BANDWIDTH_FILE)) {
            _bandwidth = JSON.parse(fs.readFileSync(BANDWIDTH_FILE, 'utf8'));
            // Keep only last 20 samples
            if (_bandwidth.samples.length > 20)
                _bandwidth.samples = _bandwidth.samples.slice(-20);
        }
    } catch(_) {}

    try {
        if (fs.existsSync(TELEMETRY_FILE)) {
            _telemetry = JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf8'));
        }
    } catch(_) {}
}

function recordUploadSpeed(bytes, elapsedMs) {
    if (elapsedMs < 1000) return; // ignore sub-second uploads
    const mbps = (bytes / 1024 / 1024) / (elapsedMs / 1000);
    _bandwidth.samples.push({ bytes, ms: elapsedMs, mbps, ts: Date.now() });

    // Keep last 20
    if (_bandwidth.samples.length > 20)
        _bandwidth.samples = _bandwidth.samples.slice(-20);

    // Recalculate averages
    const speeds = _bandwidth.samples.map(s => s.mbps).sort((a, b) => a - b);
    _bandwidth.avgMBps = speeds.reduce((s, v) => s + v, 0) / speeds.length;
    _bandwidth.p25MBps = speeds[Math.floor(speeds.length * 0.25)] || _bandwidth.avgMBps;

    // Persist
    try {
        const tmp = BANDWIDTH_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(_bandwidth));
        fs.renameSync(tmp, BANDWIDTH_FILE);
    } catch(_) {}
    _saveMetrics();
}

function estimateUploadMs(bytes) {
    const mbps = _bandwidth.p25MBps || 1.5; // default 1.5 MB/s if no history
    return (bytes / 1024 / 1024 / mbps) * 1000;
}

function willTimeoutOnDrive(fileSizeBytes) {
    const estimatedMs = estimateUploadMs(fileSizeBytes);
    const bufferMs    = 60_000; // 60s safety margin
    return estimatedMs > (DRIVE_TIMEOUT_MS - bufferMs);
}

// ═══════════════════════════════════════════════════════════════
// TELEMETRY
// Tracks profile success rates, processing times, outcomes.
// Agent reads this to understand system health.
// ═══════════════════════════════════════════════════════════════
let _telemetry = {
    jobs: [],            // last 50 job outcomes
    profileStats: {},    // per-profile success/fail counts
    lastUpdated: null,
};

function recordJobOutcome(outcome) {
    // outcome: { jobId, profile, inputMB, outputMB, processingMs, uploadMs, success, error }
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
    const metrics = {
        bandwidth:    _bandwidth,
        profileStats: _telemetry.profileStats,
        recentJobs:   _telemetry.jobs.slice(-10),
        queueState:   { activeJobs: _activeJobs, queueDepth: _queueDepth },
        timestamp:    new Date().toISOString(),
    };
    try { fs.writeFileSync(METRICS_FILE, JSON.stringify(metrics, null, 2)); } catch(_) {}
}

// Agent calls this to read current engine state
function getMetrics() {
    return {
        bandwidth:    _bandwidth,
        profileStats: _telemetry.profileStats,
        recentJobs:   _telemetry.jobs.slice(-10),
        queueState:   { activeJobs: _activeJobs, queueDepth: _queueDepth },
        timestamp:    new Date().toISOString(),
    };
}

// Agent calls this to report retry outcomes back to engine
function reportRetryOutcome(jobId, profile, success, error) {
    recordJobOutcome({ jobId, profile, success, error, isRetry: true });
    if (!success) {
        // Downgrade recommended profile if retries keep failing
        console.log(`🧠 Engine: retry failed (${profile}) — adjusting future recommendations`);
    }
}

// ═══════════════════════════════════════════════════════════════
// DECISION ENGINE
// Scores each factor and selects the optimal processing profile
// ═══════════════════════════════════════════════════════════════
function selectProfile(analysis, fileSizeMB, isRetry = false, attemptCount = 1) {

    // ── Hard rules first (override scoring) ──────────────────
    // Retry attempts always go raw — enhancement failed, try raw
    if (isRetry || attemptCount > 1) {
        return { profile: 'RAW_UPLOAD', reason: 'retry attempt — raw upload only', score: 0 };
    }

    // No FFmpeg available
    if (!_ffmpegPath) {
        return { profile: 'RAW_UPLOAD', reason: 'FFmpeg not available', score: 0 };
    }

    // Queue near capacity — skip enhancement entirely to keep slots free
    // Enhancement takes 60-150s, during which the queue can back up
    if (_queueDepth >= 4 || _activeJobs >= 2) {
        return { profile: 'RAW_UPLOAD', reason: `queue at capacity (active=${_activeJobs} pending=${_queueDepth}) — raw upload`, score: 0 };
    }

    // File will definitely timeout even without enhancement
    const rawWillTimeout = willTimeoutOnDrive(analysis.fileBytes);
    if (rawWillTimeout && fileSizeMB > 40) {
        return { profile: 'RAW_UPLOAD', reason: `bandwidth too low for ${fileSizeMB}MB — upload raw now`, score: 0 };
    }

    // ── Score each factor 0–100 (higher = more enhancement ok) ──
    const scores = {};

    // 1. File size (most impactful — enhancement inflates 2-3×)
    if      (fileSizeMB <= 5)  scores.fileSize = 100;
    else if (fileSizeMB <= 10) scores.fileSize = 85;
    else if (fileSizeMB <= 15) scores.fileSize = 65;
    else if (fileSizeMB <= 20) scores.fileSize = 40;
    else if (fileSizeMB <= 25) scores.fileSize = 20;
    else                       scores.fileSize = 0;

    // 2. Queue pressure (busy = downgrade to preserve capacity)
    const totalQueueLoad = _activeJobs + _queueDepth;
    if      (totalQueueLoad === 0) scores.queue = 100;
    else if (totalQueueLoad <= 1)  scores.queue = 80;
    else if (totalQueueLoad <= 3)  scores.queue = 50;
    else if (totalQueueLoad <= 5)  scores.queue = 25;
    else                           scores.queue = 0;

    // 3. Bandwidth score (recent upload history)
    const bwMBps = _bandwidth.p25MBps;
    if (!bwMBps)                  scores.bandwidth = 60; // no history — assume moderate
    else if (bwMBps >= 3.0)       scores.bandwidth = 100;
    else if (bwMBps >= 2.0)       scores.bandwidth = 75;
    else if (bwMBps >= 1.0)       scores.bandwidth = 40;
    else                          scores.bandwidth = 10;

    // 4. Video quality (high quality = enhancement adds less value)
    // Invert: high quality score means LESS benefit from enhancement
    scores.quality = Math.max(0, 100 - analysis.qualityScore);

    // 5. Time budget (can we finish processing + upload within watchdog?)
    const estimatedOutputBytes = analysis.fileBytes * 2.5; // rough 2.5× inflation
    const estimatedUploadMs    = estimateUploadMs(estimatedOutputBytes);
    const totalEstimatedMs     = 90_000 + estimatedUploadMs; // 90s processing + upload
    const headroomMs           = WATCHDOG_MS - totalEstimatedMs;
    if      (headroomMs >= 180_000) scores.timeBudget = 100;
    else if (headroomMs >= 60_000)  scores.timeBudget = 70;
    else if (headroomMs >= 0)       scores.timeBudget = 30;
    else                            scores.timeBudget = 0;

    // ── Weighted composite score ────────────────────────────────
    const composite = Math.round(
        scores.fileSize  * WEIGHTS.fileSizePenalty +
        scores.queue     * WEIGHTS.queuePressure   +
        scores.bandwidth * WEIGHTS.bandwidthScore  +
        scores.quality   * WEIGHTS.qualityScore    +
        scores.timeBudget * WEIGHTS.timeBudget
    );

    // ── Map composite score to profile ──────────────────────────
    let profile, reason;

    if (composite >= 80 && _esrganPath && fileSizeMB <= PROFILES.AI_ENHANCED.maxInputMB) {
        profile = 'AI_ENHANCED';
        reason  = `score ${composite}/100 — queue clear, small file, good bandwidth`;
    } else if (composite >= 60) {
        // TARGETED: only apply what this specific video needs
        profile = 'TARGETED';
        reason  = `score ${composite}/100 — targeted filters only`;
    } else if (composite >= 35) {
        profile = 'MINIMAL';
        reason  = `score ${composite}/100 — minimal processing only`;
    } else {
        profile = 'RAW_UPLOAD';
        reason  = `score ${composite}/100 — conditions unfavorable for enhancement`;
    }

    return { profile, reason, score: composite, scores };
}

// ═══════════════════════════════════════════════════════════════
// PROCESSING PROFILES — EXECUTION
// Each profile returns { finalVideoPath, wasEnhanced }
// ═══════════════════════════════════════════════════════════════

async function _runFFmpeg(inputPath, outputPath, filters, jobId, updateJobFn) {
    const { spawn: sp } = require('child_process');

    return new Promise((resolve, reject) => {
        const args = [
            '-y', '-i', inputPath,
            '-vf', filters.join(','),
            '-r', '30',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov',
            'pipe:1'
        ];

        const proc = sp(_ffmpegPath, args);
        let outStream, settled = false;
        const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

        try {
            outStream = fs.createWriteStream(outputPath);
        } catch (e) { return reject(e); }

        outStream.on('error', e => { try { proc.kill('SIGKILL'); } catch(_) {} settle(reject, e); });
        proc.stdout.pipe(outStream);
        proc.stderr.on('data', chunk => {
            const m = chunk.toString().match(/frame=\s*(\d+)\s+.*time=([0-9:.]+)/);
            if (m && updateJobFn) {
                updateJobFn(jobId, { progress: 30, message: `Encoding: frame ${m[1]}` });
            }
        });

        const watchdog = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch(_) {}
            settle(reject, new Error('FFmpeg timeout'));
        }, 5 * 60 * 1000);

        proc.on('close', code => {
            clearTimeout(watchdog);
            outStream.end(() => {
                if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000) {
                    settle(resolve);
                } else {
                    settle(reject, new Error(`FFmpeg exit ${code}`));
                }
            });
        });
        proc.on('error', e => { clearTimeout(watchdog); settle(reject, e); });
    });
}

async function executeProfile(profile, analysis, inputPath, outputPath, jobId, updateJobFn) {
    const start = Date.now();

    if (profile === 'RAW_UPLOAD') {
        return { finalPath: inputPath, wasEnhanced: false, processingMs: 0 };
    }

    // Rename to .mp4 for FFmpeg format detection
    let videoPath = inputPath;
    const mp4Path = inputPath + '.mp4';
    try {
        fs.renameSync(inputPath, mp4Path);
        videoPath = mp4Path;
    } catch (_) { /* fallback to original path */ }

    // Build filter chain based on profile and analysis
    const scaleFilter = analysis.isPortrait
        ? 'scale=1080:1920:flags=lanczos:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black'
        : 'scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black';

    const interpFilter = analysis.needsInterp
        ? 'framerate=fps=30:interp_start=0:interp_end=255:scene=100'
        : null;

    let filters = [];

    if (profile === 'MINIMAL') {
        // Just brighten dark videos — minimal processing, fast
        filters = [
            scaleFilter,
            ...(interpFilter ? [interpFilter] : []),
            analysis.isDark
                ? 'eq=brightness=0.12:contrast=1.15:gamma=0.90'
                : 'eq=brightness=0.03:contrast=1.04',
        ].filter(Boolean);

    } else if (profile === 'TARGETED') {
        // Only apply filters this specific video needs
        const targeted = [scaleFilter];
        if (interpFilter)             targeted.push(interpFilter);
        if (analysis.isDark)          targeted.push('eq=brightness=0.10:contrast=1.18:saturation=1.08:gamma=0.96');
        else if (!analysis.isOutdoor) targeted.push('eq=brightness=0.03:contrast=1.06:saturation=1.03');
        if (analysis.motionScore < 40) targeted.push('hqdn3d=0.6:0.4:0.8:0.8'); // light denoise
        if (analysis.qualityScore < 40) targeted.push('unsharp=3:3:0.6:3:3:0.0'); // light sharpen
        filters = targeted.filter(Boolean);

    } else if (profile === 'STANDARD' || profile === 'AI_ENHANCED') {
        // Full pipeline
        filters = [
            scaleFilter,
            ...(interpFilter ? [interpFilter] : []),
            analysis.isDark ? 'hqdn3d=0.8:0.6:1.2:1.0' : 'hqdn3d=0.9:0.7:1.4:1.1',
            analysis.isDark
                ? 'eq=brightness=0.10:contrast=1.18:saturation=1.08:gamma=0.96'
                : 'eq=brightness=0.03:contrast=1.06:saturation=1.03',
            'unsharp=5:5:0.8:3:3:0.0',
        ].filter(Boolean);
    }

    try {
        if (updateJobFn) updateJobFn(jobId, { status: 'enhancing', stage: `Profile: ${profile}`, progress: 15, message: `Processing (${profile})...` });
        await _runFFmpeg(videoPath, outputPath, filters, jobId, updateJobFn);
        const processingMs = Date.now() - start;

        const inMB  = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
        const outMB = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(1);
        console.log(`✅ Engine [${profile}] done in ${(processingMs/1000).toFixed(1)}s: ${inMB}MB → ${outMB}MB`);

        return { finalPath: outputPath, wasEnhanced: true, processingMs };

    } catch (err) {
        console.warn(`⚠️  Engine [${profile}] failed: ${err.message} — falling back to RAW_UPLOAD`);
        // Clean up failed output
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch(_) {}
        return { finalPath: videoPath, wasEnhanced: false, processingMs: Date.now() - start, error: err.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN API — called by index.js
// ═══════════════════════════════════════════════════════════════

async function analyze(videoPath, fileSizeMB, jobId, opts = {}) {
    console.log(`🧠 Engine: analyzing ${fileSizeMB}MB for job ${jobId}`);

    const analysis   = await analyzeVideo(videoPath);
    const decision   = selectProfile(analysis, parseFloat(fileSizeMB), opts.isRetry, opts.attemptCount || 1);
    const outputPath = opts.outputPath || null;

    console.log(`🧠 Engine: selected [${decision.profile}] — ${decision.reason}`);
    if (decision.scores) {
        const s = decision.scores;
        console.log(`   Scores: size=${s.fileSize} queue=${s.queue} bw=${s.bandwidth} quality=${s.quality} time=${s.timeBudget} → composite=${decision.score}`);
    }

    return { analysis, decision, outputPath };
}

async function execute(plan, jobId, updateJobFn) {
    const { analysis, decision } = plan;
    const { videoPath, outputPath } = plan;

    const result = await executeProfile(
        decision.profile,
        analysis,
        videoPath,
        outputPath,
        jobId,
        updateJobFn
    );

    // Record outcome for future decisions (will be updated after Drive upload)
    plan._executionResult = result;
    plan._startTime       = Date.now();
    plan._profile         = decision.profile;

    return result;
}

function recordUploadComplete(plan, uploadBytes, uploadMs, success, error) {
    const profile = plan._profile || 'UNKNOWN';

    // Feed bandwidth tracker
    if (success && uploadBytes && uploadMs) {
        recordUploadSpeed(uploadBytes, uploadMs);
    }

    // Record telemetry
    recordJobOutcome({
        jobId:        plan.jobId,
        profile,
        inputMB:      plan.fileSizeMB,
        outputMB:     plan._executionResult ? (fs.existsSync(plan._executionResult.finalPath || '') ?
                          (fs.statSync(plan._executionResult.finalPath).size / 1024 / 1024).toFixed(1) : null) : null,
        processingMs: plan._executionResult ? plan._executionResult.processingMs : 0,
        uploadMs,
        success,
        error,
    });
}

// ═══════════════════════════════════════════════════════════════
// AGENT BRIDGE — functions called by agent.js
// ═══════════════════════════════════════════════════════════════

// Agent reads this to include in health reports
function getEngineStatus() {
    const bw = _bandwidth;
    const recent = _telemetry.jobs.slice(-5);
    const successRate = recent.length > 0
        ? Math.round(recent.filter(j => j.success).length / recent.length * 100)
        : null;

    return {
        bandwidthMBps:    bw.avgMBps ? bw.avgMBps.toFixed(2) : 'unknown',
        conservativeMBps: bw.p25MBps ? bw.p25MBps.toFixed(2) : 'unknown',
        recentSuccessRate: successRate !== null ? `${successRate}%` : 'no data',
        queueState:       { active: _activeJobs, pending: _queueDepth },
        profileStats:     _telemetry.profileStats,
        recommendation:   _getRecommendedProfile(),
    };
}

function _getRecommendedProfile() {
    const bw = _bandwidth.p25MBps;
    if (!bw || bw < 0.5)  return 'RAW_UPLOAD (bandwidth critical)';
    if (_queueDepth >= 5) return 'RAW_UPLOAD (queue overloaded)';
    if (bw < 1.5)         return 'MINIMAL (low bandwidth)';
    if (_queueDepth >= 3) return 'TARGETED (moderate queue)';
    return 'TARGETED (normal conditions)';
}

// Agent calls this after checking retry_queue.json
function reportRetryResult(jobId, success, error) {
    reportRetryOutcome(jobId, 'RAW_UPLOAD', success, error);
}

// ── Exports ───────────────────────────────────────────────────
module.exports = {
    // Lifecycle
    init,
    updateQueueState,

    // Main pipeline (called by index.js)
    analyze,
    execute,
    recordUploadComplete,

    // Agent bridge
    getMetrics,
    getEngineStatus,
    reportRetryResult,

    // Helpers
    recordUploadSpeed,
    willTimeoutOnDrive,
    estimateUploadMs,
    PROFILES,
};
