import sys
j="index.js"; t=open(j,encoding="utf-8").read()
A="""async function assembleAndProcessSession(session, sessionId, source, providedJobId) {
    // Defense-in-depth: never assemble a session that's missing chunks, even if a"""
B="""const _assemblingNow = new Set();
async function assembleAndProcessSession(session, sessionId, source, providedJobId) {
    if (_assemblingNow.has(sessionId)) throw new Error('Assembly already in progress for this session');
    _assemblingNow.add(sessionId);
    try {
    // Defense-in-depth: never assemble a session that's missing chunks, even if a"""
if t.count(A)!=1: print("ABORT lock-open",t.count(A)); sys.exit(1)
t=t.replace(A,B)
C="""    if (!enqueued) logger.warn(`${source} job ${jobId} rejected \u2014 queue full`);
    return { jobId, fileSizeMB };
}"""
D="""    if (!enqueued) logger.warn(`${source} job ${jobId} rejected \u2014 queue full`);
    return { jobId, fileSizeMB };
    } finally { _assemblingNow.delete(sessionId); }
}"""
if t.count(C)!=1: print("ABORT lock-close",t.count(C)); sys.exit(1)
t=t.replace(C,D)
E="// \u2500\u2500 Chunk session cleanup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
F="""let _autoFinishBusy = false;
setInterval(async () => {
    if (_autoFinishBusy) return;
    _autoFinishBusy = true;
    try {
        const finishable = scanRecoverableSessions().filter(x => x.finishable);
        for (const item of finishable) {
            const sess = restoreChunkSession(item.sessionId);
            if (!sess || missingChunks(sess).length > 0) continue;
            try {
                logger.info('AutoFinish: ' + item.driverName + ' VIN:' + item.vin + ' (' + item.totalChunks + ' chunks)');
                await assembleAndProcessSession(sess, item.sessionId, 'auto-finish');
            } catch (e) {
                if (!/already in progress/.test(e.message)) logger.error('Auto-finish failed ' + item.sessionId + ': ' + e.message);
            }
            await new Promise(r => setTimeout(r, 15000));
        }
    } catch (e) { logger.error('Auto-finish sweep error: ' + e.message); }
    finally { _autoFinishBusy = false; }
}, 2 * 60 * 1000);

""" + E
if t.count(E)!=1: print("ABORT timer",t.count(E)); sys.exit(1)
t=t.replace(E,F,1)
open(j,"w",encoding="utf-8").write(t)
print("OK index.js patched: claim-lock + auto-finish timer")
