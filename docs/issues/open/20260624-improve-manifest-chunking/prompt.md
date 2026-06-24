# Improve: Split manifest into 1000-file chunks to speed up writes

**Issue:** Manifest write on finalize is slow for medium/large vaults (1,000-10,000 files = 300KB-3MB uploads)

**Goal:** Split manifest into chunks of ~1000 files each, so only changed chunks are uploaded.

**Scope:**
- Chunk assignment by `hash(path) % N` (stable across insertions/deletions)
- Small `manifest-index.json` to track which chunks exist and their hashes
- Parallel chunk fetches during read phase
- Atomic merge in finalize (use index to detect which chunks changed)

**Expected benefit:** 
- Write only changed chunks (e.g., 3 files edited → upload 1 chunk instead of 5)
- Parallel reads improve latency
- Better mobile experience (smaller uploads/downloads per chunk)

**Constraints:**
- Must maintain concurrent-device safety (re-check still works)
- Backward compatible with single-manifest vaults
- No extra complexity burden during pull/push phases
