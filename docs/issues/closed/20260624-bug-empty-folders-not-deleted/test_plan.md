# Test Plan: Empty folders deletion

## Unit Tests

### Folder cleanup logic — inferred from file deletions
- [ ] `isAllFilesDeleted(folderPath, manifest)`: returns true if all entries under path have `deleted: true`
- [ ] `getEmptyFolders(folderPath, localVault, excludedPatterns)`: lists folders with zero synced files (excluded files ignored)
- [ ] `shouldCleanupFolder(path, manifest, localVault, filters)`: true if all synced files deleted AND folder matches include pattern
- [ ] Correctly handle excluded files: folder with only excluded files is considered empty
- [ ] Handle nested paths: `shouldCleanupFolder('a/b/c')` respects parent folder state too

### Folder cleanup execution
- [ ] Delete folder recursively using `app.vault.delete()`
- [ ] Delete only if all conditions met: all synced files deleted + no active synced children + folder path matches filter
- [ ] Delete recursively up the tree, stopping at first non-empty folder
- [ ] Handle cleanup after pull phase (remote file deletions inferred)
- [ ] Catch and log deletion errors (folder already gone, permission denied, etc.)
- [ ] Gracefully handle race conditions: if folder doesn't exist, skip silently

### Filter and folder interaction
- [ ] Folder cleanup respects includePatterns (don't cleanup folders excluded by patterns)
- [ ] Folder cleanup respects excludePatterns (excluded files don't prevent cleanup)

## Integration Tests (vitest with mocks)

### Scenario 1: Single-device folder deletion (inferred from file deletion)
```
Setup: 
  - Local has folder/file.txt (synced, version 1)
  - Cached manifest shows folder/file.txt
  
Action: User deletes folder/file.txt locally, sync runs
  
Expected:
  - Step 5 (push): Plan detects file missing locally, creates deletion tombstone
  - Step 6 (finalize): Cleanup detects all files under folder/ are deleted
  - Local cleanup deletes folder/ directory
  - S3 manifest updated with folder/file.txt tombstone
```

### Scenario 2: Multi-device: Delete on A, sync on B (folder cleanup inferred)
```
Setup:
  - Device A: folder/file.txt (synced)
  - Device B: folder/file.txt (same, previously synced)
  - S3: folder/file.txt (version 1)

Action:
  1. A deletes folder/file.txt locally, syncs
     → Plan marks file for delete-local
     → Sync: file deleted via trash, manifest updated with tombstone
     → Cleanup: detects all files under folder/ deleted, removes folder/
     → S3: manifest shows folder/file.txt deleted=true
  2. B syncs
     → Step 4 (pull): Remote manifest shows folder/file.txt deleted
     → File deleted via trash, cached manifest updated
     → Step 6 (cleanup): Detects all files under folder/ are deleted tombstones
     → Folder/ deleted locally
  
Expected:
  - Both devices end with folder/ removed
  - No orphaned folders on either device
```

### Scenario 3: Conflict avoidance — folder alive on one device
```
Setup:
  - Device A: folder/file.txt (will delete)
  - Device B: folder/file2.txt (NEW file, same folder, not yet synced)
  
Action:
  1. A deletes folder/file.txt locally, syncs
     → Tombstone created for folder/file.txt
     → Cleanup checks: folder/ has deletion tombstones BUT...
     → Local vault shows folder/ still exists (B will add file2.txt)
     → Don't cleanup (conservative: folder might be reused)
  2. B creates folder/file2.txt, syncs
     → Upload new file to S3
     → S3 manifest now has: folder/file.txt (deleted), folder/file2.txt (alive)
  3. B syncs again
     → Pull: folder/file.txt deletion, but local has folder/file2.txt (alive)
     → Cleanup checks: folder/ has both live and deleted files → no cleanup
     → Folder remains
  
Expected:
  - A doesn't cleanup folder prematurely
  - B's file2.txt is preserved
  - Folder remains on both devices with file2.txt
```

### Scenario 4: Nested folder deletion
```
Setup:
  - Local: a/b/c/file.txt (synced)
  - User deletes entire a/ folder
  
Expected:
  - User deletes a/ → no files under a/ locally
  - Push phase: Plan detects a/b/c/file.txt missing locally
  - Creates deletion tombstone for a/b/c/file.txt
  - Cleanup phase:
    * Check a/b/c/: all files deleted (only file.txt was there) → cleanup a/b/c/
    * Check a/b/: all files deleted (only had c/ subfolder) → cleanup a/b/
    * Check a/: all files deleted → cleanup a/
  - All three folders removed recursively
```

### Scenario 5: Excluded files don't prevent cleanup
```
Setup:
  - Local: folder/file.txt (synced) + folder/.obsidian/metadata.json (excluded)
  - User deletes folder/file.txt
  
Expected:
  - Push phase: file.txt deletion detected, tombstone created
  - Cleanup phase:
    * Check folder/: folder/file.txt is deleted (tombstone)
    * folder/.obsidian excluded (ignored for cleanup purposes)
    * Cleanup treats folder as empty (excluded files transparent)
    * Delete folder/
  - Result: folder/ and all contents removed
  
Note: Excluded files are automatically deleted when parent is deleted,
      but they don't prevent the parent from being cleaned up.
```

### Scenario 6: Empty folder (not deleted via sync) — preserve it
```
Setup:
  - Device A: folder/file.txt (synced)
  
Action:
  - User manually deletes folder/file.txt (not via sync)
  - A syncs → detects file missing locally
  
Expected:
  - Push phase: file.txt deletion tombstone created
  - Pull phase: (no remote change if B hasn't synced)
  - Cleanup phase: 
    * Detects all files under folder/ are deleted
    * Cleanup should delete folder/ 
    * (This is correct behavior: implicit cleanup from file deletion)
  
Note: System cannot distinguish "user deleted folder" from "user deleted all files."
      Both result in folder cleanup → this is the desired behavior.
```

## End-to-End Tests

### E2E 1: Real vault with multiple folders and selective deletion
- Create vault with structure: `docs/2024/file1.txt`, `docs/2025/file2.txt`, `notes/note.md`, `archive/old.txt`
- Add files to each folder, sync to S3 (all devices see this)
- Delete `docs/2024/file1.txt` on Device A, sync
- Device B syncs → verify:
  - `docs/2024/` folder is removed (no longer exists)
  - `docs/2025/`, `notes/`, `archive/` still exist with their files
  - S3 manifest shows `docs/2024/file1.txt` with deleted=true
  - No other changes

### E2E 2: Concurrent folder deletions with lock timeout
- Device A and B both have `reports/q1.txt` and `reports/q2.txt`
- Device A starts sync, acquires lock, deletes both files
- Device B tries to sync (blocked by lock)
- Device A sync completes, releases lock
- Device B acquires lock, syncs
- Lock is stale on Device B (timeout after 5 minutes) — Device B re-checks manifest
- Expected: Both devices end with `reports/` removed, consistent state

### E2E 3: Concurrent additions and deletions (resurrection)
- Device A and B both have `project/config.json`
- Device A deletes `project/config.json` locally, syncs
  - Tombstone created, cleanup removes `project/` folder
- Device B (before sync) creates `project/new-file.txt`, syncs to S3
  - New file uploaded, `project/` still exists on S3
- Device A syncs again
  - Manifest shows: `project/config.json` (deleted), `project/new-file.txt` (alive)
  - Cleanup skips `project/` (has active files)
  - Device A gets `project/new-file.txt` via download
- Expected: `project/` exists on all devices with only `new-file.txt`

### E2E 4: Large nested folder structure
- Create deeply nested: `a/b/c/d/e/file1.txt`, `a/b/c/x/file2.txt`, `a/y/file3.txt`
- Delete entire `a/b/` subtree on Device A
- Sync Device A and B
- Expected:
  - Device A: `a/y/file3.txt` remains, `a/b/` and all children removed
  - Device B: same state after sync
  - S3 manifest: `a/b/c/d/e/file1.txt` and `a/b/c/x/file2.txt` marked deleted

## Integration: Lock and Finalize Re-check

### Scenario: Concurrent sync with manifest re-check
```
Setup:
  - Device A and B both synced to version 1 of manifest
  - Device A starts sync, acquires lock
  
Action:
  1. A completes pull (step 4), begins push (step 5)
  2. B tries to sync, gets locked, waits
  3. A pushes file changes, detects a folder is now empty
  4. A acquires lock again for finalize (step 6), re-checks remote manifest
  5. During re-check, A sees Device B pushed new files to same folder
  6. A's cleanup logic sees folder has active files from B → skips cleanup
  7. Lock released
  8. B acquires lock, syncs, sees A's deletions + B's additions
  
Expected:
  - No data loss
  - Folder remains if any device has content
  - Manifest converges correctly
```

## Regression Tests

- [ ] Existing file sync still works (no folder logic breaks it)
- [ ] Conflict resolution unaffected by folder cleanup (conflicts still detected)
- [ ] Lock/unlock cycle works with folder cleanup (finalize re-check doesn't deadlock)
- [ ] Manifest re-check in finalize phase detects concurrent folder changes
- [ ] Filter patterns (include/exclude) still work correctly with folders
- [ ] mtime pre-filter still optimizes unchanged files
- [ ] Hash cache still works across pull/push phases
- [ ] Excluded paths (`.obsidian/plugins/*/data.json`) still excluded
- [ ] S3 soft-delete (trash prefix) still works for deleted files
