/**
 * video_pipeline.js — shared post-upload processing pipeline.
 *
 * WHY THIS EXISTS:
 * The direct-upload handler (/upload-to-google-drive) and the chunked-upload
 * handler (/upload/complete) used to each contain their OWN copy of the
 * engine→enhance→keyframe→damage→Drive→email→quality pipeline. The chunked copy
 * had drifted and was missing: Drive date/type folder organization, damage report
 * persisted to manifest, annotated-damage email attachments, completeness check,
 * dynamic email subject, public-read permissions, pending-submission clearing,
 * performance logging, engine telemetry, and recordDriverSubmission() — meaning
 * driver quality metrics silently skipped every chunked upload (most bad-LTE
 * submissions). This module is the SINGLE source both paths now call, so they can
 * never diverge again.
 *
 * USAGE:
 *   const videoPipeline = require('./video_pipeline');
 *   videoPipeline.init({ ...module-level deps... });   // once, at startup
 *   await videoPipeline.process(ctx);                   // per job
 *
 * The pipeline is intentionally framework-agnostic: it takes a plain `ctx`
 * object, never an Express req/res. Both call sites adapt their own context.
 */

'use strict';

// ── Injected dependencies (set once via init) ────────────────────────────────
let deps = null;

function init(d) {
    deps = d;
}

function _need() {
    if (!deps) throw new Error('video_pipeline.process() called before init()');
    return deps;
}

/**
 * process(ctx) — run the full pipeline for one assembled video.
 *
 * ctx = {
 *   jobId            : string  (required)
 *   videoPath        : string  (required) — path to the assembled/uploaded file
 *   driverName       : string  (required)
 *   vin              : string  (required)
 *   inspectionType   : string  (required) 'Pre-Trip' | 'Post-Trip'
 *   fileSizeMB       : string|number (required) — raw size before enhancement
 *   hostname         : string  (optional) — for bandwidth probe URL
 *   userAgent        : string  (optional) — for perf log
 *   ip               : string  (optional) — for perf log
 *   startTime        : number  (optional) — ms epoch when upload began (defaults now)
 *   source           : string  (optional) 'direct' | 'chunked'
 * }
 *
 * Returns: { success, fileId, viewLink, wasEnhanced, finalSizeMB } on success.
 * Throws on failure — caller decides retry vs permanent (uses isRetriable).
 */
async function process(ctx) {
    const {
        fs, path, engine, nodemailer, logger,
        UPLOAD_DIR, ENHANCED_DIR, VIDEO_DRIVE_ID,
        PERFORMANCE_LOG, ERROR_LOG,
        getDriveClient, getDiscordClient,
        extractKeyframes, classifyDamage, addVideoChapters,
        checkWalkaroundCompleteness, recordDriverSubmission,
        readPendingSubs, writePendingSubs,
        appendLog, syncInspectionToStreamlit,
        updateJob, isRetriable,
        saveToRetryQueue,
        ANNOTATE_SCRIPT,
    } = _need();

    const {
        jobId, driverName, vin, inspectionType,
    } = ctx;
    let videoPath  = ctx.videoPath;
    const startTime = ctx.startTime || Date.now();
    const fileSizeMB = typeof ctx.fileSizeMB === 'number'
        ? ctx.fileSizeMB.toFixed(2)
        : (ctx.fileSizeMB || '0');
    const hostname = ctx.hostname || 'slgpmeshserver.com';

    const driveClient   = getDriveClient();
    const discordClient = getDiscordClient ? getDiscordClient() : null;

    let enhancedVideoPath = null;
    let wasEnhanced       = false;
    let enginePlan        = null;

    try {
        logger.info(`📹 Pipeline started for job ${jobId} (${ctx.source || 'unknown'} source)`);

        // Manifest: queued → processing
        try {
            const mPath = path.join(UPLOAD_DIR, `${jobId}.manifest.json`);
            if (fs.existsSync(mPath)) {
                const mData = JSON.parse(fs.readFileSync(mPath, 'utf8'));
                mData.status = 'processing';
                mData.processingStartedAt = new Date().toISOString();
                fs.writeFileSync(mPath, JSON.stringify(mData, null, 2));
            }
        } catch (_) {}

        let finalVideoPath = videoPath;

        // ── Engine: analyze + select profile ───────────────────────────────
        try {
            enginePlan = await engine.analyze(videoPath, fileSizeMB, jobId);
        } catch (analyzeErr) {
            logger.warn(`⚠️ Engine analysis failed, defaulting to RAW_UPLOAD: ${analyzeErr.message}`);
            enginePlan = {
                analysis:  { brightness: 128, isDark: false, isPortrait: false, needsInterp: false, motionScore: 50, qualityScore: 50, fileBytes: 0 },
                decision:  { profile: 'RAW_UPLOAD', reason: 'analysis error — safe fallback', score: 0 },
                outputPath: null,
            };
        }
        enginePlan.videoPath  = videoPath;
        enginePlan.fileSizeMB = fileSizeMB;
        enginePlan.jobId      = jobId;

        const enhancedFileName = `enhanced_${Date.now()}_${path.basename(videoPath)}`;
        const outputDir = fs.existsSync(ENHANCED_DIR) ? ENHANCED_DIR : UPLOAD_DIR;
        enginePlan.outputPath = path.join(outputDir, enhancedFileName + '.mp4');
        try { fs.mkdirSync(outputDir, { recursive: true }); } catch (_) {}

        const engineResult = await engine.execute(enginePlan, jobId, updateJob);

        // ── Lens obstruction alert ──────────────────────────────────────────
        if (enginePlan.decision && enginePlan.decision.obstructed) {
            logger.warn(`🚫 Job ${jobId}: lens obstruction for ${driverName} VIN ${vin}`);
            try {
                if (discordClient) {
                    const ch = discordClient.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
                    if (ch) ch.send(`🚫 **Lens Obstruction** — Driver **${driverName}** VIN \`${vin}\` submitted a blocked video. Ask them to clean the lens and resubmit.`);
                }
            } catch (_) {}
        }

        // ── Driver quality history (engine-side, 3-in-a-row alerting) ───────
        try {
            const isGoodQuality = enginePlan.analysis.qualityScore >= 30 && !enginePlan.decision.obstructed;
            const driverAlert   = engine.recordDriverQuality(driverName, vin, isGoodQuality, enginePlan.decision.obstructed);
            if (driverAlert) {
                logger.warn(`⚠️ Driver quality alert: ${driverAlert.message}`);
                try {
                    if (discordClient) {
                        const ch = discordClient.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
                        if (ch) ch.send(driverAlert.message);
                    }
                } catch (_) {}
            }
        } catch (_) {}

        if (engineResult.wasEnhanced) {
            finalVideoPath    = engineResult.finalPath;
            enhancedVideoPath = engineResult.finalPath;
            wasEnhanced       = true;
            updateJob(jobId, { status: 'uploading', stage: 'Uploading to Drive', progress: 68, message: 'Enhancement complete — uploading to Google Drive...' });
        } else {
            finalVideoPath = engineResult.finalPath || videoPath;
            updateJob(jobId, { status: 'uploading', stage: 'Uploading to Drive', progress: 30, message: 'Uploading to Google Drive...' });
        }

        const finalStats  = fs.statSync(finalVideoPath);
        const finalSizeMB = (finalStats.size / 1024 / 1024).toFixed(2);
        const fileName    = `${driverName}_${vin}_${inspectionType}_${wasEnhanced ? 'ENHANCED_' : ''}${Date.now()}.mp4`;

        // ── Keyframes + damage classification (non-blocking) ────────────────
        let keyframes    = [];
        let damageReport = null;
        try {
            updateJob(jobId, { status: 'uploading', stage: 'Analyzing frames', progress: 65, message: 'Extracting key frames for damage review...' });
            keyframes = await extractKeyframes(finalVideoPath, jobId);
            if (keyframes.length > 0) {
                damageReport = await classifyDamage(keyframes, driverName, vin, inspectionType);
                if (damageReport) {
                    try {
                        const mPath = path.join(UPLOAD_DIR, `${jobId}.manifest.json`);
                        if (fs.existsSync(mPath)) {
                            const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
                            m.damageReport  = damageReport;
                            m.keyframeCount = keyframes.length;
                            fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
                        }
                    } catch (_) {}
                    logger.info(`🔍 Damage: ${damageReport.overallCondition} — ${damageReport.items?.length || 0} item(s) — confidence: ${damageReport.confidenceScore}%`);
                }
                finalVideoPath = await addVideoChapters(finalVideoPath, keyframes, jobId);
            }
        } catch (e) {
            logger.warn(`⚠️ Frame analysis failed (non-fatal): ${e.message}`);
        }

        // ── Pre-upload bandwidth probe (informational) ──────────────────────
        try {
            const probeUrl  = `https://${hostname}/api/bandwidth-probe`;
            const liveSpeed = await engine.probeBandwidth(probeUrl);
            if (liveSpeed && liveSpeed < 0.8 && finalStats.size > 10 * 1024 * 1024) {
                logger.warn(`⚠️ Low bandwidth probe: ${liveSpeed.toFixed(2)} MB/s — ${finalSizeMB}MB upload may timeout`);
            }
        } catch (_) {}

        // ── Drive folder organization: /YYYY-MM-DD/Inspection-Type/ ─────────
        let uploadFolderId = VIDEO_DRIVE_ID;
        try {
            const today          = new Date().toISOString().split('T')[0];
            const dayFolderName  = today;
            const typeFolderName = inspectionType.replace(/[^a-zA-Z0-9 _-]/g, '');

            const daySearch = await driveClient.files.list({
                q: `name='${dayFolderName}' and '${VIDEO_DRIVE_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            let dayFolderId;
            if (daySearch.data.files.length) {
                dayFolderId = daySearch.data.files[0].id;
            } else {
                const dayFolder = await driveClient.files.create({
                    requestBody: { name: dayFolderName, mimeType: 'application/vnd.google-apps.folder', parents: [VIDEO_DRIVE_ID] },
                    fields: 'id', supportsAllDrives: true
                });
                dayFolderId = dayFolder.data.id;
            }

            const typeSearch = await driveClient.files.list({
                q: `name='${typeFolderName}' and '${dayFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            if (typeSearch.data.files.length) {
                uploadFolderId = typeSearch.data.files[0].id;
            } else {
                const typeFolder = await driveClient.files.create({
                    requestBody: { name: typeFolderName, mimeType: 'application/vnd.google-apps.folder', parents: [dayFolderId] },
                    fields: 'id', supportsAllDrives: true
                });
                uploadFolderId = typeFolder.data.id;
            }
            logger.info(`📁 Drive folder: ${dayFolderName}/${typeFolderName}`);
        } catch (folderErr) {
            logger.warn(`Drive folder creation failed — using root: ${folderErr.message}`);
            uploadFolderId = VIDEO_DRIVE_ID;
        }

        // ── Drive upload ────────────────────────────────────────────────────
        const fileMetadata = {
            name: fileName,
            parents: [uploadFolderId],
            mimeType: 'video/mp4',
            properties: {
                driver: driverName, vin, inspectionType,
                uploadDate: new Date().toISOString(),
                codec: wasEnhanced ? 'H.264 Enhanced (20Mbps)' : 'Original',
                resolution: '1920x1080',
                enhanced: String(wasEnhanced),
                downloadPreferred: 'true'
            },
            description: `Fleet Video Inspection - ${inspectionType} for VIN ${vin} by ${driverName}`
        };
        const media = { mimeType: 'video/mp4', body: fs.createReadStream(finalVideoPath) };

        const driveResponse = await Promise.race([
            driveClient.files.create({
                requestBody: fileMetadata, media,
                fields: 'id, name, webViewLink, webContentLink, size, videoMediaMetadata, createdTime',
                supportsAllDrives: true
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Google Drive upload timeout after 8 minutes')), 8 * 60 * 1000))
        ]);

        updateJob(jobId, { status: 'uploading', stage: 'Finalizing', progress: 90, message: 'Drive upload complete — sending notifications...' });

        const uploadTime    = ((Date.now() - startTime) / 1000).toFixed(1);
        const fileId        = driveResponse.data.id;
        const videoMetadata = driveResponse.data.videoMediaMetadata || {};
        const videoDuration = videoMetadata.durationMillis ? `${(videoMetadata.durationMillis / 1000 / 60).toFixed(1)} minutes` : 'Unknown';

        logger.info(`✅ Drive upload complete in ${uploadTime}s — File ID: ${fileId}`);

        // ── Auto-clear pending submissions for this driver+VIN ──────────────
        try {
            const _pend = readPendingSubs();
            const _upd  = _pend.map(p =>
                (p.driverName === driverName && p.vin === vin && p.status !== 'complete')
                    ? { ...p, status: 'complete', completedAt: new Date().toISOString() }
                    : p
            );
            writePendingSubs(_upd);
        } catch (_) {}

        // ── Performance log ─────────────────────────────────────────────────
        try {
            await appendLog(PERFORMANCE_LOG, {
                type: 'performance', action: 'video_upload',
                duration: Date.now() - startTime, success: true,
                fileSize: finalStats.size,
                details: `${driverName} - ${vin} - ${inspectionType}`,
                userAgent: ctx.userAgent || null, ip: ctx.ip || null
            });
        } catch (_) {}

        // ── Public-read permissions ─────────────────────────────────────────
        try {
            await driveClient.permissions.create({
                fileId, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true
            });
        } catch (permError) {
            logger.warn(`⚠️ Could not set permissions: ${permError.message}`);
        }

        const viewLink             = driveResponse.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
        const directDownloadLink   = `https://drive.google.com/uc?export=download&id=${fileId}`;
        const embedLink            = `https://drive.google.com/file/d/${fileId}/preview`;
        const thumbnailLink        = `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;

        // ── Email notification (with annotated-damage attachments) ──────────
        try {
            const transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com', port: 587, secure: false,
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
                connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000,
                tls: { rejectUnauthorized: false }
            });

            const emailAttachments = [];
            if (damageReport && damageReport.damageFound && keyframes.length) {
                try {
                    const { execFileSync } = require('child_process');
                    for (let ki = 0; ki < Math.min(keyframes.length, 3); ki++) {
                        const kf = keyframes[ki];
                        if (!fs.existsSync(kf)) continue;
                        const outPath = kf.replace(/\.jpg$/, '_annotated.jpg');
                        const items   = JSON.stringify(damageReport.items || []);
                        try {
                            execFileSync('python3', [ANNOTATE_SCRIPT, kf, outPath, items], { timeout: 15000 });
                            if (fs.existsSync(outPath)) {
                                emailAttachments.push({ filename: `damage_frame_${ki + 1}.jpg`, path: outPath, cid: `damage_frame_${ki + 1}` });
                            }
                        } catch (annotErr) {
                            logger.warn(`Annotation failed for frame ${ki}: ${annotErr.message}`);
                            emailAttachments.push({ filename: `frame_${ki + 1}.jpg`, path: kf, cid: `damage_frame_${ki + 1}` });
                        }
                    }
                } catch (e) {
                    logger.warn(`Keyframe annotation error: ${e.message}`);
                }
            }

            const durSec       = videoMetadata.durationMillis ? videoMetadata.durationMillis / 1000 : 0;
            const completeness = checkWalkaroundCompleteness(durSec, parseFloat(finalSizeMB), inspectionType);

            let emailSubject;
            if (damageReport && damageReport.damageFound) {
                emailSubject = `⚠️ DAMAGE DETECTED: ${inspectionType} - ${driverName} (VIN: ${vin})`;
            } else if (!completeness.complete) {
                emailSubject = `⚠️ INCOMPLETE WALK-AROUND: ${inspectionType} - ${driverName} (VIN: ${vin})`;
            } else {
                emailSubject = `📹 Video Inspection Ready: ${inspectionType} - ${driverName} (VIN: ${vin})`;
            }

            const damageRows = (() => {
                if (!damageReport) return '';
                const cond  = damageReport.overallCondition || 'unknown';
                const color = cond === 'good' ? '#059669' : cond === 'fair' ? '#d97706' : '#dc2626';
                let html = '<tr style="background:white"><td style="padding:12px;font-weight:bold;color:#4b5563">Condition:</td><td style="padding:12px;color:' + color + ';font-weight:bold">' + cond.toUpperCase() + '</td></tr>';
                if (damageReport.damageFound && damageReport.items && damageReport.items.length) {
                    html += '<tr style="background:#fef3c7"><td style="padding:12px;font-weight:bold;color:#92400e">⚠️ Damage:</td><td style="padding:12px;color:#92400e">';
                    html += damageReport.items.map(x => x.severity + ' ' + x.type + ' — ' + x.location).join('<br>');
                    html += '</td></tr>';
                }
                html += '<tr style="background:#f3f4f6"><td style="padding:12px;font-weight:bold;color:#4b5563">Action:</td><td style="padding:12px;color:#1f2937">' + (damageReport.recommendedAction || 'none').replace(/_/g, ' ') + '</td></tr>';
                return html;
            })();

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: ['slgpfleetmanager@gmail.com'],
                subject: emailSubject,
                attachments: emailAttachments,
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
                                <tr style="background: #f3f4f6;"><td style="padding: 12px; font-weight: bold; color: #4b5563;">Quality:</td><td style="padding: 12px; color: #1f2937;">${wasEnhanced ? '1920x1080 H.264 Enhanced + denoising' : '1920x1080 Original'}</td></tr>
                                ${damageRows}
                            </table>
                            <div style="text-align: center; margin: 25px 0;">
                                <a href="${viewLink}" style="display: inline-block; background: #10b981; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px;">📱 OPEN IN DRIVE</a>
                                <a href="${directDownloadLink}" style="display: inline-block; background: #3b82f6; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; margin: 8px;">⬇️ DOWNLOAD 1080p</a>
                            </div>
                        </div>
                    </div>
                `
            });
            logger.info('✅ Email notification sent');
        } catch (emailError) {
            logger.error(`⚠️ Email notification failed: ${emailError.message}`);
            try {
                await appendLog(ERROR_LOG, {
                    type: 'server_error', severity: 'warning',
                    message: 'Video notification email failed',
                    stack: emailError.stack, source: 'video_pipeline-email'
                });
            } catch (_) {}
        }

        // ── recordDriverSubmission (quality metrics — the chunked path's gap) ─
        try {
            const blurCount = keyframes.filter(f => f.isBlurred).length;
            const totalKf   = keyframes.length;
            const durSec    = videoMetadata.durationMillis ? videoMetadata.durationMillis / 1000 : 0;
            recordDriverSubmission(driverName, {
                durationSec:  durSec,
                blurryFrames: blurCount,
                totalFrames:  totalKf,
                damageFound:  !!(damageReport && damageReport.damageFound),
                fileSizeMB:   parseFloat(fileSizeMB) || 0,
            });
        } catch (qErr) { logger.warn(`Quality record failed: ${qErr.message}`); }

        // ── Streamlit DB sync (fire-and-forget) ─────────────────────────────
        try {
            syncInspectionToStreamlit({ driverName, vin, inspectionType, fileName, fileId, viewLink, directDownloadLink });
        } catch (_) {}

        // ── Cleanup temp files ──────────────────────────────────────────────
        for (const p of [videoPath, enhancedVideoPath]) {
            if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
        }

        // ── Job complete ────────────────────────────────────────────────────
        updateJob(jobId, {
            status: 'complete', stage: 'Done', progress: 100,
            message: `✅ Complete! ${wasEnhanced ? 'Enhanced to 20Mbps' : 'Uploaded'} in ${uploadTime}s`,
            enhanced: wasEnhanced, viewLink,
            result: {
                success: true, fileId, fileName, fileSize: finalSizeMB, rawSize: fileSizeMB,
                enhanced: wasEnhanced, uploadTime, viewLink,
                downloadLink: directDownloadLink, embedLink, thumbnailLink,
                metadata: videoMetadata, createdTime: driveResponse.data.createdTime
            }
        });

        // Persist completion to manifest
        try {
            const mPath = path.join(UPLOAD_DIR, `${jobId}.manifest.json`);
            if (fs.existsSync(mPath)) {
                const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
                m.status = 'complete';
                m.completedAt = new Date().toISOString();
                m.fileId = fileId;
                fs.writeFileSync(mPath, JSON.stringify(m, null, 2));
            }
        } catch (_) {}

        try { engine.recordUploadComplete(enginePlan, finalStats.size, parseFloat(uploadTime) * 1000, true, null); } catch (_) {}

        logger.info(`✅ Job ${jobId} complete in ${uploadTime}s`);
        return { success: true, fileId, viewLink, wasEnhanced, finalSizeMB };

    } catch (error) {
        try { engine.recordUploadComplete(enginePlan, 0, 0, false, error.message); } catch (_) {}
        logger.error(`❌ Pipeline error (job ${jobId}): ${error.message}`);

        try {
            await appendLog(ERROR_LOG, {
                type: 'server_error', severity: 'error',
                message: 'Video pipeline failed', stack: error.stack, source: 'video_pipeline'
            });
        } catch (_) {}

        // Retry vs permanent
        const survivingFile = [enhancedVideoPath, videoPath].find(p => p && fs.existsSync(p));
        if (isRetriable(error.message) && survivingFile) {
            logger.info(`🔁 Retriable error — preserving file for agent retry: ${survivingFile}`);
            saveToRetryQueue({
                jobId, filePath: survivingFile, driverName, vin, inspectionType,
                fileSizeMB, wasEnhanced, failedAt: Date.now(), attemptCount: 1, lastError: error.message
            });
            updateJob(jobId, { status: 'failed', stage: 'Queued for retry', progress: 0, message: 'Upload failed — retrying automatically...', error: error.message });
        } else {
            for (const p of [videoPath, enhancedVideoPath]) {
                if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} }
            }
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
            updateJob(jobId, { status: 'failed', stage: 'Error', progress: 0, message: `Upload failed: ${error.message}`, error: error.message });
        }
        throw error;
    }
}

module.exports = { init, process };
