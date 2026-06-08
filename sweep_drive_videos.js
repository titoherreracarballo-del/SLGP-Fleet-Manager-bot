#!/usr/bin/env node
/**
 * sweep_drive_videos.js — one-time cleanup.
 *
 * Moves loose walk-around videos sitting at the Drive ROOT into the same
 * /YYYY-MM-DD/<Inspection-Type>/ folder structure the live pipeline now uses.
 *
 * WHY: the old chunked-upload path uploaded straight to the Drive root with no
 * folder organization (the direct-upload path foldered correctly). After the
 * video_pipeline.js refactor BOTH paths folder correctly going forward — this
 * script cleans up the historical backlog that landed at root.
 *
 * SAFETY:
 *   - DRY RUN BY DEFAULT. Prints exactly what it WOULD move and moves nothing.
 *     You must pass --go to actually move files.
 *   - Only touches loose VIDEO files at the root that match the known filename
 *     pattern. Never touches folders. Never touches anything already inside a
 *     subfolder. Never touches non-video files (Docs, Sheets, etc.).
 *   - Uses Drive "move" (add new parent + remove root parent) — the file keeps
 *     its ID, links, permissions. Nothing is re-uploaded or duplicated.
 *   - Reuses existing date/type folders; never creates duplicates.
 *
 * USAGE (run on the server, from the fleet repo dir so it shares .env + node_modules):
 *   cd /root/slgp-fleet
 *   node sweep_drive_videos.js            # dry run — shows the plan, moves nothing
 *   node sweep_drive_videos.js --go       # actually move the files
 *   node sweep_drive_videos.js --go --limit 10   # move only the first 10 (cautious first pass)
 *
 * Auth + root folder are read from the SAME env vars the app uses
 * (GCP_SA_KEY / GOOGLE_APPLICATION_CREDENTIALS, GDRIVE_FOLDER_ID).
 */

'use strict';

require('dotenv').config();
const { google } = require('googleapis');

const ROOT_ID = process.env.GDRIVE_FOLDER_ID || '0AC1GE3XEm4K9Uk9PVA';

const GO    = process.argv.includes('--go');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// Filename pattern: <driver>_<vin(4)>_<Pre|Post-Trip>_[ENHANCED_]<timestamp>.mp4
// Driver may contain spaces; VIN is 4 alphanumerics; timestamp is ms epoch.
const NAME_RE = /^(.+?)_([0-9A-Za-z]{4})_(Pre-Trip|Post-Trip)_(?:ENHANCED_)?(\d{10,})\.(mp4|webm|mov)$/i;

function authDrive() {
    let auth;
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });
    } else if (process.env.GCP_SA_KEY) {
        const credentials = JSON.parse(process.env.GCP_SA_KEY);
        auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    } else {
        console.error('❌ No Google credentials (GCP_SA_KEY / GOOGLE_APPLICATION_CREDENTIALS). Run from the app dir so .env loads.');
        process.exit(1);
    }
    return google.drive({ version: 'v3', auth });
}

// Date folder name from the upload timestamp — MUST match the live pipeline,
// which uses new Date().toISOString().split('T')[0] (UTC). Using UTC here keeps
// the sweep consistent with where new uploads land.
function dateFolderFromTs(tsMs) {
    return new Date(Number(tsMs)).toISOString().split('T')[0]; // YYYY-MM-DD (UTC)
}

function typeFolderName(type) {
    return type.replace(/[^a-zA-Z0-9 _-]/g, '');
}

async function listRootVideos(drive) {
    // Loose files directly under ROOT that are videos and NOT folders.
    const files = [];
    let pageToken = null;
    do {
        const res = await drive.files.list({
            q: `'${ROOT_ID}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
            fields: 'nextPageToken, files(id,name,mimeType,parents)',
            pageSize: 1000,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
        for (const f of res.data.files) {
            // Only real video files (by mimeType or extension)
            const isVideo = (f.mimeType && f.mimeType.startsWith('video/')) ||
                            /\.(mp4|webm|mov)$/i.test(f.name);
            if (isVideo) files.push(f);
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
}

// folder cache: "parentId/childName" -> childId, so we never create duplicates
const _folderCache = new Map();

async function findOrCreateFolder(drive, parentId, name, dryRun) {
    const cacheKey = `${parentId}/${name}`;
    if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

    const res = await drive.files.list({
        q: `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });
    if (res.data.files.length) {
        const id = res.data.files[0].id;
        _folderCache.set(cacheKey, id);
        return id;
    }

    if (dryRun) {
        // Pretend-create; use a placeholder so the plan reads sensibly.
        const placeholder = `(would-create:${name})`;
        _folderCache.set(cacheKey, placeholder);
        return placeholder;
    }

    const created = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id',
        supportsAllDrives: true,
    });
    const id = created.data.id;
    _folderCache.set(cacheKey, id);
    return id;
}

async function moveFile(drive, fileId, fromParent, toParent) {
    await drive.files.update({
        fileId,
        addParents: toParent,
        removeParents: fromParent,
        fields: 'id, parents',
        supportsAllDrives: true,
    });
}

(async function main() {
    const mode = GO ? '🚚 LIVE MOVE' : '🔎 DRY RUN (no changes — pass --go to move)';
    console.log('='.repeat(70));
    console.log(`SLGP Drive sweep — ${mode}`);
    console.log(`Root folder: ${ROOT_ID}`);
    if (LIMIT !== Infinity) console.log(`Limit: first ${LIMIT} matching file(s)`);
    console.log('='.repeat(70));

    const drive = authDrive();

    let rootFiles;
    try {
        rootFiles = await listRootVideos(drive);
    } catch (e) {
        console.error('❌ Failed to list root files:', e.message);
        process.exit(1);
    }

    console.log(`Found ${rootFiles.length} loose video file(s) at root.\n`);

    const plan = [];
    const skipped = [];
    for (const f of rootFiles) {
        const m = f.name.match(NAME_RE);
        if (!m) {
            skipped.push({ name: f.name, reason: 'filename does not match Driver_VIN_Type_..._timestamp pattern' });
            continue;
        }
        const [, driver, vin, type, ts] = m;
        const dateFolder = dateFolderFromTs(ts);
        const typeFolder = typeFolderName(type);
        plan.push({ file: f, driver, vin, type, dateFolder, typeFolder });
    }

    if (skipped.length) {
        console.log(`⏭  Skipping ${skipped.length} file(s) that don't match the pattern (left untouched):`);
        for (const s of skipped.slice(0, 20)) console.log(`     • ${s.name}`);
        if (skipped.length > 20) console.log(`     … and ${skipped.length - 20} more`);
        console.log('');
    }

    if (!plan.length) {
        console.log('✅ Nothing to move — no loose, parseable videos at root.');
        return;
    }

    // Group the plan by destination for a readable summary
    const byDest = {};
    for (const p of plan) {
        const key = `${p.dateFolder}/${p.typeFolder}`;
        (byDest[key] = byDest[key] || []).push(p);
    }
    console.log(`📋 Plan — ${plan.length} file(s) → ${Object.keys(byDest).length} folder(s):\n`);
    for (const dest of Object.keys(byDest).sort()) {
        console.log(`  📁 ${dest}/  (${byDest[dest].length} file${byDest[dest].length === 1 ? '' : 's'})`);
        for (const p of byDest[dest]) {
            console.log(`       ← ${p.driver} (VIN ${p.vin})  [${p.file.name}]`);
        }
    }
    console.log('');

    if (!GO) {
        console.log('🔎 DRY RUN complete. No files moved.');
        console.log('   Re-run with --go to perform these moves:');
        console.log('     node sweep_drive_videos.js --go');
        return;
    }

    // LIVE: perform the moves
    let moved = 0, failed = 0, count = 0;
    for (const p of plan) {
        if (count >= LIMIT) break;
        count++;
        try {
            const dayId  = await findOrCreateFolder(drive, ROOT_ID, p.dateFolder, false);
            const typeId = await findOrCreateFolder(drive, dayId, p.typeFolder, false);
            await moveFile(drive, p.file.id, ROOT_ID, typeId);
            moved++;
            console.log(`  ✅ moved ${p.driver} (VIN ${p.vin}) → ${p.dateFolder}/${p.typeFolder}/`);
        } catch (e) {
            failed++;
            console.error(`  ❌ failed ${p.file.name}: ${e.message}`);
        }
    }

    console.log('');
    console.log('='.repeat(70));
    console.log(`Done. Moved: ${moved}  |  Failed: ${failed}  |  Skipped (unparseable): ${skipped.length}`);
    console.log('='.repeat(70));
})().catch(e => {
    console.error('💥 Sweep error:', e.message);
    process.exit(1);
});
