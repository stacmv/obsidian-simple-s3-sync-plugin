# Analysis: Empty folders are not deleted

## Reproduction Steps

1. Create a folder with files
2. Synchronize → folder with files appears in S3 and on other devices
3. Delete the folder with files locally
4. Synchronize → on other devices, files are deleted but the empty folder remains

## Root Cause Hypothesis

Folders are tracked separately from files in the sync system. When files are deleted, the folder structure itself is not being removed because:
- The sync plan (`plan.ts`) likely only tracks individual files, not folders as first-class entities
- Folder deletion is not explicitly handled in the sync logic (`sync.ts`)
- Empty folders have no manifest entries (only files do), so they don't trigger cleanup

The system needs to explicitly delete empty directories after file deletions are complete.

## Impact

**Severity:** Critical
- Sync leaves orphaned empty folders on all devices after folder deletion
- Creates clutter and divergence from the source state
- Users expect deleted folders to be fully removed, not just emptied
- Can cause confusion about what's actually synced

## Resolution Strategy

**Key principle:** Delete folders implicitly — infer folder deletion from file deletions. When all synced files under a folder are deleted, the folder cleanup is a side effect, not a new deletion event.

**Why implicit, not explicit:**
- System cannot reliably distinguish "user deleted folder" from "user deleted files one-by-one"
- Both produce the same state: folder present in cached manifest, now empty locally
- Solution: follow the file deletions; folder cleanup is a natural consequence

**Implementation approach:**

1. **Infer folder deletion from file deletions:**
   - During pull phase: if all files under `folder/` are marked deleted in remote manifest, infer folder deletion
   - During push phase: if all files under `folder/` are deleted locally (and no new files added), push deletion
   - Folder cleanup is automatic, not a separate tracking mechanism

2. **Folder cleanup conditions (must all be true):**
   - All synced files under the folder path are deleted (or have deletion tombstones)
   - No synced subfolders contain active files
   - Excluded files/folders are ignored (don't count as active)
   - The folder path itself matches the includePatterns filter

3. **Keep manifest schema stable (backward compatible):**
   - Do NOT add a new `folders` record to manifest
   - Folder deletion is implicit: inferred when all child file entries are deleted
   - Old clients (v0.4.x) will see files deleted, won't auto-cleanup folders (status quo for them), but will sync correctly
   - New clients will auto-cleanup after inferring folder deletion from file tombstones

4. **Propagate folder state via file deletions:**
   - When user deletes `folder/file.txt`, create a file tombstone
   - When all files in `folder/` have tombstones, other devices infer the folder is gone
   - Each device cleans up independently based on its local state + remote file tombstones

**Scope:**
- **Pull phase (step 4):** Check if all files under a path are marked deleted → schedule folder for cleanup
- **Push phase (step 5):** No new logic needed; file deletions propagate naturally
- **Finalize phase (step 6):** Execute folder cleanup after all file operations complete
- **Filter interaction:** Folder cleanup respects the same includePatterns/excludePatterns as files

**Files affected:**
- `sync.ts` — add `cleanupEmptyFolders()` function; call during finalize phase after file operations
- `plan.ts` — (no changes needed; folder detection emerges from file deletion analysis)
- `manifest.ts` — (no changes; schema stays stable)
- `filter.ts` — (no changes; reuse existing filter logic for folder path matching)
