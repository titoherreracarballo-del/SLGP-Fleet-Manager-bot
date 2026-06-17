import sys, re
j = "index.js"
t = open(j, encoding="utf-8").read()

# Remove the misplaced "Record driver quality metrics" block from the _retry
# handler. It references keyframes/videoMetadata/damageReport which do NOT exist
# in the retry closure (the retry path re-uploads a saved file; it never runs the
# analysis pipeline that produces them). It has thrown into its own catch on every
# retry since it was written, recording nothing. Safe to delete.
# Match the whole try{...}catch(qErr){...} block, anchored on its leading comment.

pat = re.compile(
    r"\n        // Record driver quality metrics\n"
    r"        try \{\n"
    r"            const blurCount  = keyframes\.filter\(f => f\.isBlurred\)\.length;\n"
    r".*?"
    r"        \} catch\(qErr\) \{ logger\.warn\('Quality record failed:', qErr\.message\); \}\n",
    re.DOTALL
)

matches = pat.findall(t)
if len(matches) != 1:
    print("ABORT: quality-metrics block matched", len(matches), "times (expected 1). No write.")
    sys.exit(1)

# safety: the matched block must reference all three undefined vars
blk = matches[0]
for needle in ("keyframes", "videoMetadata", "damageReport", "recordDriverSubmission"):
    if needle not in blk:
        print(f"ABORT: matched block missing '{needle}' - refusing"); sys.exit(1)

t = pat.sub("\n", t, count=1)
open(j, "w", encoding="utf-8").write(t)
print("OK index.js patched: removed dead quality-metrics block from retry handler")
