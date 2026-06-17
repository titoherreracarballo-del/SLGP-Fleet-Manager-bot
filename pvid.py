import sys
v = "video.html"
s = open(v, encoding="utf-8").read()

# Anchor on the catch(chunkErr) block that does the diagnostic alert + falls
# through to the monolithic XHR. Replace its BODY with a plain re-throw so the
# failure falls into the existing catch(uploadErr) (saves to IndexedDB + shows
# "saved, will auto-upload"). The XHR fallback code below stays in place but is
# unreachable on this path. Anchored on pure-ASCII landmarks only.

START = "                } catch(chunkErr) {"
END_MARKER = "                    // Fall through to XHR below\n                }"

i = s.find(START)
if i == -1:
    print("ABORT: catch(chunkErr) start not found"); sys.exit(1)
if s.count(START) != 1:
    print("ABORT: catch(chunkErr) start matched", s.count(START)); sys.exit(1)

j = s.find(END_MARKER, i)
if j == -1:
    print("ABORT: end marker '// Fall through to XHR below' + brace not found after start"); sys.exit(1)
j_end = j + len(END_MARKER)

# sanity: the block we're about to replace must contain the diagnostic alert,
# proving we matched the right region and not some other catch.
block = s[i:j_end]
if "CHUNKED UPLOAD FAILED" not in block:
    print("ABORT: matched block does not contain the diagnostic alert - refusing"); sys.exit(1)
if "Falling back to direct upload" not in block:
    print("ABORT: matched block missing 'Falling back' text - refusing"); sys.exit(1)

NEW = """                } catch(chunkErr) {
                    // A chunk exhausted its retries (usually congested depot wifi at
                    // shift start). Do NOT restart the whole file as one monolithic
                    // upload - the chunks already on the server are retained (12-24h)
                    // and the blob is in IndexedDB. Re-throw into catch(uploadErr),
                    // which saves it for auto-resume and tells the driver it will
                    // finish automatically. When the phone hits strong signal on route,
                    // resume sends ONLY the missing chunks instead of starting over,
                    // and the server's auto-finish sweep assembles it once complete.
                    throw chunkErr;
                }"""

s = s[:i] + NEW + s[j_end:]
open(v, "w", encoding="utf-8").write(s)
print("OK video.html patched: chunk failure now re-throws to resume path (no monolithic restart)")