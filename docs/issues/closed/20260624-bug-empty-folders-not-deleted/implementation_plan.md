# Implementation Plan: Implicit Folder Deletion via File Tombstones

## Overview

Add automatic cleanup of empty folders after file deletions during the sync finalize phase. Folders are deleted implicitly when all synced files under a path become deleted (have deletion tombstones in the manifest). This requires:

1. **Helper functions** to detect empty folders and evaluate cleanup conditions
2. **Main cleanup function** to recursively delete folders
3. **Integration into finalize phase** (Step 6 of sync) to execute cleanup after file operations
4. **Unit and integration tests** to cover all scenarios

The implementation maintains backward compatibility (manifest schema unchanged) and respects filters and excluded files.

---

## Files to Create/Modify

| File | Change | Purpose |
|------|--------|---------|
| `src/sync.ts` | Modify | Add folder cleanup functions and integrate into finalize phase |
| `test/sync.test.ts` | Modify | Add unit + integration tests for folder cleanup |

---

## Implementation Tasks

### Task 1: Implement folder cleanup helper functions
**Mapped Test Cases:** Unit Tests (folder cleanup logic, filter interaction)  
**Complexity:** Simple (3 pure functions, no dependencies)

**Files:**
- `src/sync.ts` — Add three helper functions before `runSync()`

**Implementation Details:**

```typescript
// Helper 1: Check if all files under a folder path have deletion tombstones
async function isAllFilesDeleted(
  folderPath: string,
  manifest: SyncManifest,
  settings: S3SyncSettings
): Promise<boolean>
```
- Iterate all manifest entries
- Return true if every entry under `folderPath/` has `deleted: true`
- Exclude entries that don't match includePatterns
- Handle empty folder (no entries under path) → return true

```typescript
// Helper 2: Get list of empty folders (paths with zero synced files)
async function getEmptyFolders(
  app: App,
  folderPath: string,
  manifest: SyncManifest,
  settings: S3SyncSettings
): Promise<string[]>
```
- Get all folders from local vault under `folderPath`
- Filter out folders that contain synced (non-excluded) files
- Use `shouldSyncFile()` to ignore excluded files
- Return list of truly empty folder paths

```typescript
// Helper 3: Evaluate whether a folder should be cleaned up
async function shouldCleanupFolder(
  folderPath: string,
  manifest: SyncManifest,
  app: App,
  settings: S3SyncSettings
): Promise<boolean>
```
- All synced files under path are deleted: `isAllFilesDeleted()`
- No synced subfolders with active files exist
- Folder path itself matches includePatterns filter
- Return true only if all conditions are met

**Acceptance Criteria:**
- [ ] `isAllFilesDeleted()` correctly identifies when all entries under a path are deleted
- [ ] `isAllFilesDeleted()` handles excluded files (ignores them)
- [ ] `getEmptyFolders()` returns only folders with zero synced files
- [ ] `getEmptyFolders()` treats excluded-only folders as empty
- [ ] `shouldCleanupFolder()` combines all conditions correctly
- [ ] Unit tests pass for nested paths (a/b/c respects parent state)

---

### Task 2: Implement main folder cleanup execution
**Mapped Test Cases:** Unit Tests (cleanup execution, error handling), Scenario 1, 4, 5, 6  
**Complexity:** Medium (recursive deletion, error handling, logging)

**Files:**
- `src/sync.ts` — Add main cleanup function

**Implementation Details:**

```typescript
// Main cleanup function
async function cleanupEmptyFolders(
  app: App,
  manifest: SyncManifest,
  settings: S3SyncSettings,
  onProgress?: SyncProgressCallback,
  result?: SyncResult
): Promise<void>
```

**Algorithm:**
1. Start with deleted files from latest sync operation
2. For each deleted file, extract parent folder path: `a/b/c/file.txt` → `a/b/c`
3. Check if parent folder should be cleaned: `shouldCleanupFolder('a/b/c', ...)`
4. If yes: delete the folder using `app.vault.delete()`
5. Then check grandparent: `shouldCleanupFolder('a/b', ...)`
6. Repeat until reaching a folder with active files or root
7. Catch errors per folder and log them; don't throw
8. Handle race conditions: if folder doesn't exist, skip silently

**Key behaviors:**
- Recursive deletion stops at first non-empty folder (parent folders not deleted if they have other content)
- Excluded files are transparent (don't block cleanup, but folder/excluded-file is deleted with the folder)
- Errors are logged but don't interrupt cleanup of other folders
- Progress callback optional (for user feedback)

**Pseudocode:**
```
for each deleted_file in recent_deletions:
  current_path = parent_directory(deleted_file)
  while current_path is not empty string:
    if should_cleanup_folder(current_path, manifest, vault, settings):
      try:
        delete current_path from vault
        log success
      catch error:
        log error
        break (stop going up, parent might have other files)
    else:
      break (folder has active files, stop)
    current_path = parent_directory(current_path)
```

**Acceptance Criteria:**
- [ ] Folders are deleted recursively up the tree
- [ ] Cleanup stops at first non-empty folder
- [ ] Errors are caught and logged per folder
- [ ] Race condition handled: folder already gone → skip
- [ ] Progress callback works (if provided)
- [ ] Result.errors accumulates folder deletion errors

---

### Task 3: Integrate folder cleanup into finalize phase
**Mapped Test Cases:** Scenario 2, 3, E2E 2 (concurrent sync with re-check)  
**Complexity:** Simple (single function call in the right place)

**Files:**
- `src/sync.ts` — Modify `runSync()` Step 6 (Finalize)

**Implementation Details:**

Call `cleanupEmptyFolders()` **after** the manifest merge/re-check in finalize phase:

```typescript
// --- Step 6: Finalize ---
onProgress?.(6, "Writing manifest...", result);
checkAborted(signal);

// Re-check for concurrent changes
const recheckManifest = await s3.getManifest(client, bucket, prefix);
// ... existing merge logic ...

// NEW: Cleanup empty folders after manifest is finalized
onProgress?.(6, "Cleaning up empty folders...", result);
await cleanupEmptyFolders(app, updatedManifest, settings, onProgress, result);

// Write final manifest
await s3.putManifest(client, bucket, prefix, updatedManifest);
await saveCachedData({ manifest: updatedManifest });
```

**Why this placement:**
- Happens after manifest merge/re-check (concurrent changes handled)
- Happens before manifest is written to S3 (cleanup is deterministic)
- Respects the final state of the manifest (no cleanup if concurrent adds detected)

**Acceptance Criteria:**
- [ ] `cleanupEmptyFolders()` called in Step 6 after manifest re-check
- [ ] Progress callback shows cleanup progress
- [ ] Cleanup respects the final merged manifest (concurrent changes honored)
- [ ] All deletions logged to result.errors
- [ ] Sync completes successfully with cleanup done

---

### Task 4: Write unit tests for helper functions
**Mapped Test Cases:** Unit Tests sections  
**Complexity:** Medium (mock vault, manifest entries)

**Files:**
- `test/sync.test.ts` — Add test suite

**Test structure:**

```typescript
describe("Folder cleanup helpers", () => {
  describe("isAllFilesDeleted", () => {
    it("returns true when all entries under path are deleted", () => {
      // TC-001
    })
    it("returns true for empty folder (no entries)", () => {
      // TC-002
    })
    it("returns false when some entries are alive", () => {
      // TC-003
    })
    it("ignores excluded files", () => {
      // TC-004
    })
  })
  
  describe("getEmptyFolders", () => {
    it("returns folders with zero synced files", () => {
      // TC-005
    })
    it("treats excluded-only folders as empty", () => {
      // TC-006
    })
    it("handles nested paths correctly", () => {
      // TC-007
    })
  })
  
  describe("shouldCleanupFolder", () => {
    it("returns true only if all conditions met", () => {
      // TC-008
    })
    it("returns false if folder has active files", () => {
      // TC-009
    })
    it("respects includePatterns filter", () => {
      // TC-010
    })
  })
})
```

**Mocking pattern (existing test setup):**
- Create mock TFile/TFolder instances
- Mock `app.vault.getAbstractFileByPath()` to return folders
- Create manifest entries with `deleted: true/false`
- Use `vi.mock()` to stub filter logic if needed

**Acceptance Criteria:**
- [ ] All helper functions have unit test coverage
- [ ] Tests validate edge cases (empty, nested, excluded)
- [ ] Tests verify filter interaction
- [ ] All unit tests pass

---

### Task 5: Write integration tests for cleanup scenarios
**Mapped Test Cases:** Scenario 1-6, E2E tests  
**Complexity:** Complex (multi-device simulation, mocked S3)

**Files:**
- `test/sync.test.ts` — Add integration test suite

**Test structure:**

```typescript
describe("Folder cleanup integration", () => {
  describe("Scenario 1: Single-device folder deletion", () => {
    it("detects all files deleted and removes folder", async () => {
      // Setup: Local folder/file.txt, cached manifest, mocked S3
      // Action: Delete file locally, run sync
      // Assert: folder/ removed, tombstone in manifest
    })
  })
  
  describe("Scenario 2: Multi-device deletion", () => {
    it("Device A deletes and cleanup, Device B pulls and cleanups", async () => {
      // Multi-device simulation
    })
  })
  
  describe("Scenario 3: Conflict avoidance", () => {
    it("doesn't cleanup folder if concurrent device has files", async () => {
      // Manifest merge during re-check detects concurrent file
      // Cleanup should skip
    })
  })
  
  describe("Scenario 4: Nested folders", () => {
    it("recursively deletes a/b/c/ → a/b/ → a/", async () => {
      // Nested structure, verify all empty levels deleted
    })
  })
  
  describe("Scenario 5: Excluded files", () => {
    it("ignores excluded files, still cleans up folder", async () => {
      // folder/file.txt (synced, deleted) + folder/.obsidian (excluded)
      // Should delete folder/
    })
  })
  
  describe("Scenario 6: Manual file deletion", () => {
    it("folder cleanup happens on implicit file deletion too", async () => {
      // User manually deletes file → sync sees it's gone → cleanup infers
    })
  })
  
  describe("E2E: Concurrent sync with re-check", () => {
    it("respects manifest re-check during finalize", async () => {
      // A starts cleanup, B adds file to same folder
      // Re-check detects B's file, cleanup skips
    })
  })
})
```

**Mocking pattern:**
- Mock `app.vault.delete()` to track deleted paths
- Create full sync scenarios with mocked S3 state
- Verify cleanup function behavior in isolation and integrated

**Acceptance Criteria:**
- [ ] Scenario 1-6 tests pass
- [ ] E2E re-check test passes
- [ ] All integration tests validate proper cleanup + no data loss
- [ ] Tests verify error handling (folder already gone)
- [ ] Tests verify folder cleanup respects filter patterns

---

### Task 6: Add regression tests
**Mapped Test Cases:** Regression Tests section  
**Complexity:** Medium (mostly existing tests, add folder-related checks)

**Files:**
- `test/sync.test.ts` — Add/enhance existing tests

**Test coverage:**

- [ ] Existing file sync unaffected (add folder cleanup to sync flow, verify file sync unchanged)
- [ ] Conflict resolution unaffected (run conflict scenario, add folder cleanup, verify still works)
- [ ] Lock cycle with folder cleanup (test lock/unlock doesn't deadlock with cleanup)
- [ ] Manifest re-check detects folder changes (concurrent adds/deletes of folders)
- [ ] Filter patterns work with folders (include/exclude patterns applied to folders)
- [ ] mtime pre-filter still optimizes files (folder cleanup doesn't affect optimization)
- [ ] Hash cache unaffected (cleanup doesn't corrupt cache)
- [ ] S3 soft-delete still works (file tombstones still created correctly)

**Acceptance Criteria:**
- [ ] No existing tests fail
- [ ] Folder cleanup added to integration flow doesn't break any step
- [ ] Manifest changes logged correctly
- [ ] Filter patterns consistently applied to files and folders

---

## Task Dependencies & Order

```
Task 1: Helper functions (independent)
  ↓
Task 2: Main cleanup function (depends on Task 1)
  ↓
Task 3: Integrate into finalize phase (depends on Task 2)
  ↓
Task 4: Unit tests for helpers (depends on Task 1, 2)
  ↓
Task 5: Integration tests (depends on Task 3, 4)
  ↓
Task 6: Regression tests (depends on Task 3, 5)
```

**Implementation order (sequential):**
1. Task 1: Add helpers
2. Task 4: Test helpers to verify logic
3. Task 2: Add main cleanup function
4. Task 3: Integrate into sync flow
5. Task 5: Test integrated scenarios
6. Task 6: Run regression suite

---

## Complexity Assessment

**Overall Complexity: Medium**

- **Straightforward:** Helper functions are pure logic (no I/O, no state)
- **Moderate:** Main cleanup function has error handling and recursion
- **Well-defined scope:** Integration point is clear (finalize phase, Step 6)
- **Good test coverage:** Test plan is detailed, can verify all scenarios

**Estimated effort:** 2-3 hours
- Helpers: 30 min
- Main cleanup: 45 min
- Integration: 15 min
- Testing (unit + integration + regression): 45 min

---

## Key Implementation Notes

1. **Backward compatibility:** Manifest schema unchanged. Old clients see deleted files but don't auto-cleanup folders. New clients infer folder deletion from file tombstones.

2. **Filter integration:** Use existing `shouldSyncFile()` to evaluate folder cleanup paths. Excluded files don't prevent cleanup (they're transparent).

3. **Error resilience:** Log failures per folder, don't throw. If cleanup fails, user can retry next sync. Sync completes even if one folder deletion fails.

4. **Race conditions:** Handle case where folder is deleted between checking and actual deletion (return silently if folder doesn't exist).

5. **Performance:** Cleanup only iterates parents of deleted files (not all folders), so efficient even in large vaults.

6. **Manifest re-check:** Folder cleanup happens after manifest merge, respecting concurrent changes from other devices. If re-check adds files to a folder, cleanup will correctly skip it.

---

## Acceptance Criteria (All Tests)

- [ ] All unit tests pass (helpers)
- [ ] All integration tests pass (scenarios 1-6, E2E)
- [ ] All regression tests pass (no breakage)
- [ ] Edge cases handled (nested folders, excluded files, concurrent changes)
- [ ] Error cases logged (folder already gone, permission denied)
- [ ] Code follows project style (vitest pattern, error handling)
- [ ] Progress callbacks work for user feedback
- [ ] Manifest integrity maintained throughout
