# Sync Progress Modal

## Problem

When user triggers manual sync, the `computeSyncPlan()` phase runs with no
visible feedback (only a status-bar update that is invisible on mobile). The
user has no idea what is happening, how long it will take, or what comes next.
They may even edit files while the plan is being computed, making the plan stale.

## Solution

Replace the current two-step flow (silent plan computation → SyncPlanModal →
silent sync execution) with a **single modal** that opens immediately and
covers the full sync lifecycle.

## Modal States & Steps

| # | Step              | Modal state  | Detail                                       |
|---|-------------------|-------------|-----------------------------------------------|
| 1 | Checking changes  | `planning`  | Spinner; fetch manifest + hash local files    |
| 2 | Preview / Confirm | `confirming`| Show plan entries; Confirm / Cancel buttons   |
| 3 | Acquire lock      | `syncing`   | Brief spinner                                 |
| 4 | Pull changes      | `syncing`   | Spinner + "Pulling X / Y" sub-progress        |
| 5 | Push changes      | `syncing`   | Spinner + "Pushing X / Y" sub-progress        |
| 6 | Finalize          | `syncing`   | Write manifest, release lock                  |
| — | Done / Error      | `done`      | All checkmarks or error message; Close button |

Visual rules:
- Current step → spinner + bold text
- Completed steps → checkmark + normal text
- Future steps → muted/dimmed text
- Steps 4–5 show `X / Y` sub-line when active
- Cancel button present throughout; becomes Close when done

## Implementation Tasks

- [x] 1. `modal.ts` — Add `SyncProgressModal` class with planning/confirming/syncing/done states
- [x] 2. `sync.ts` — Add `AbortSignal` param; pre-count files; update callback to `(step, detail, result)`
- [x] 3. `main.ts` — New `doSync()` opens modal immediately; modal orchestrates plan + sync
- [x] 4. `styles.css` — Step state classes + spinner animation
- [x] 5. Remove `SyncPlanModal` — replaced by SyncProgressModal (old class removed)

## Files Changed

| File       | Change                                                             |
|------------|--------------------------------------------------------------------|
| modal.ts   | Add SyncProgressModal; possibly remove SyncPlanModal               |
| sync.ts    | AbortSignal, pre-count, new callback signature                     |
| main.ts    | Merge doSyncWithPreview + doSyncDirect into doSync; keep auto path |
| styles.css | Step state classes, spinner animation                              |

## Unchanged

- plan.ts, merge.ts, s3.ts, filter.ts, hash.ts — untouched
- Auto-sync interval — still silent, status-bar only
