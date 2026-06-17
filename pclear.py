import sys
j = "index.js"
t = open(j, encoding="utf-8").read()

# Insert a pending-entry "complete" update inside assembleAndProcessSession,
# right after the chunk dir is consumed and the in-memory session dropped.
# This makes ALL callers (phone /upload/complete, manual finish-on-server,
# auto-finish sweep) clear the dashboard "Needs Retry" entry uniformly.
# Anchored on the exact two lines that consume the session (pure ASCII).

ANCHOR = """    // Chunk dir is consumed - remove it and drop the in-memory session
    try { fs.rmSync(session.sessionDir, { recursive: true }); } catch(_) {}
    _chunkSessions.delete(sessionId);"""

# The on-disk file uses an em-dash in that comment ("consumed -"), so match flexibly:
import re
m = re.search(r"    // Chunk dir is consumed.*?\n    try \{ fs\.rmSync\(session\.sessionDir, \{ recursive: true \}\); \} catch\(_\) \{\}\n    _chunkSessions\.delete\(sessionId\);", t)
if not m:
    print("ABORT: session-consume anchor not found"); sys.exit(1)
# ensure it's unique
if len(re.findall(r"_chunkSessions\.delete\(sessionId\);", t)) < 1:
    print("ABORT: delete line missing"); sys.exit(1)

block = m.group(0)
ADD = block + """

    // Mark the dashboard "pending/Needs-Retry" entry for this upload as complete,
    // so the Pending-Uploads tab reflects reality once the video is assembled.
    // Without this, an auto-finished (or manually finished) upload lands in Drive
    // but lingers forever as a ghost "stuck" row. Match by driver+VIN+type; only
    // flip entries not already complete. (Fixes the manual path too, which
    // previously set 'retrying' here and never cleared.)
    try {
        const _pend = readPendingSubs();
        const _upd = _pend.map(p =>
            (p.driverName === session.driverName && p.vin === session.vin &&
             p.inspectionType === session.inspectionType && p.status !== 'complete')
                ? { ...p, status: 'complete', completedAt: new Date().toISOString() }
                : p
        );
        writePendingSubs(_upd);
    } catch(_) {}"""

if t.count(block) != 1:
    print("ABORT: anchor not unique:", t.count(block)); sys.exit(1)
t = t.replace(block, ADD)
open(j, "w", encoding="utf-8").write(t)
print("OK index.js patched: assembleAndProcessSession now clears dashboard pending entry (all callers)")
