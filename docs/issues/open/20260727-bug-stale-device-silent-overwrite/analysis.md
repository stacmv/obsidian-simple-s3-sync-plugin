# Analysis: Stale device silently overwrites newer content

## Real-world incident (2026-07-27)

- `Home.md` in the Obsidian vault is regenerated every morning by a headless
  Claude job on the `desktop` device (single writer — no human edits it).
- 05:54 — job wrote the fresh `Home.md` (27.07 / "Неделя 31"). It reached S3
  and the peer obsidian-git remote correctly (06:16 git commit shows 27.07).
- ~08:36–08:56 — the phone `pova3`, offline all weekend and holding a stale
  26.07-era vault, ran its sync and **uploaded the stale content to S3**
  (manifest: `Home.md` → `lastSyncedBy: pova3`, `version: 149`, 26.07 sha;
  `@Calendar/week31.ics` marked `deleted: true` by `pova3`).
- 09:04 — `desktop`'s next sync pulled `pova3`'s stale entries and overwrote the
  local working tree (Home.md/calendar back to 26.07; week31.ics and a
  15-lessons session log deleted). obsidian-git then committed the regression.
- **No `.conflict-*` copies were created** — the overwrite went through a silent
  code path, not the keep-both conflict path.

Devices observed in the manifest: `office` (908 files), `desktop` (504),
`pova3` (150). `office` was powered off for the weekend and is not involved.

## Root cause

Winner selection is based on a **scalar per-file `version` counter with
last-writer-wins**, and there is **no wall-clock recency tiebreak for
live-vs-live content**. `mtimeMs` / `lastSyncedAt` exist in the manifest
(`manifest.ts`) but are used only for the mtime pre-filter, tombstone GC, and
the tombstone-vs-resurrection tiebreak — never to decide which of two *live*
versions of a file is newer.

Concretely:

1. **Pull skips by counter, not content** — `sync.ts:413`
   (`if (remoteVersion <= cachedVersion) continue;`). If a device's cached
   version counter for a file is `>=` the remote counter, the pull phase skips
   the file without ever looking at its content.

2. **Push bumps the counter and stamps ownership** — `sync.ts:536` / `sync.ts:555`
   (`version: existing.version + 1`, `lastSyncedBy: deviceName`). Whoever pushes
   last wins the counter regardless of whose content is actually newer in time.

3. **Conflict path was not taken.** The true-conflict branch
   (`localChanged && remoteChanged`, `sync.ts:434`) routes to `resolveConflict`
   → 3-way merge → keep-both, which *would* preserve both sides as a
   `.conflict-*` copy. The absence of any conflict copy proves the stale write
   went through a silent branch instead — the stale device never recognized a
   conflict; it treated its stale copy as authoritative.

Two silent branches produce the exact observed end state (which one `pova3` took
cannot be determined from `desktop`-side data — it depends on the phone's own
cached manifest):

- **(a) Version-skip → push:** phone's `cachedVersion >= remote.version`, so pull
  skips (`sync.ts:413`); push then sees local sha ≠ manifest sha and uploads the
  stale content with `version + 1`.
- **(b) Torn-cache push:** phone's cache says the new sha but its disk still holds
  the old content (`localChanged && !remoteChanged`, `sync.ts:485`), so the old
  content is pushed as a normal update.

## Why mobile is the trigger

Obsidian mobile syncs are frequently interrupted (the OS suspends/kills the
backgrounded app). The sync writes intermediate cached-manifest checkpoints
mid-run (`buildCheckpointSnapshot` / `saveCachedData`, `sync.ts:317`, `:494`).
An interrupted sync can leave the cached version counter out of step with the
actual on-disk content — precisely the state that trips branch (a) or (b). A
device that woke stale after a long offline period is the most exposed.

## Reproduction (conceptual)

1. Device A (single writer) updates `note.md` and syncs → S3 has version N.
2. Device B holds an older `note.md` and a cached manifest whose counter for
   `note.md` is `>= N` (reachable via a prior interrupted sync on B, or a
   counter that advanced without B incorporating A's content).
3. Device B syncs: it skips the pull (counter says "not newer") and pushes its
   older content as version `N+1`.
4. Device A's next sync pulls B's older content. No conflict copy is created;
   A's newer content is silently lost.

A deterministic unit/integration reproduction should construct the manifests in
(2) directly rather than trying to race real interrupted mobile syncs.

## Impact

**Severity:** Critical (silent data loss).

- Newer content is overwritten across all devices with older content, invisibly.
- Worst case is high-churn single-writer files (daily-regenerated dashboards),
  but it also hits genuinely hand-edited multi-master files (calendar, weekly
  notes were in the same rollback) where the data is not regenerable.
- The user only discovered it by chance; there is no signal (no conflict copy,
  no notice, no log) that a live file was overwritten with older content.

## Resolution strategy (to be refined in spec/impl-plan)

Ordered by importance:

1. **Causal guard against stale overwrite (core fix).** A device must never push
   content for a file when the remote `version` is ahead of the version that
   device has actually incorporated (its cached version) — in that situation the
   only valid actions are pull or merge, never blind overwrite. This closes both
   silent branches (a) and (b). Revisit the `remoteVersion <= cachedVersion`
   skip at `sync.ts:413`: skipping the pull must not later license an
   overwriting push of un-incorporated content.

2. **Recency tiebreak for live-vs-live.** When counters cannot decide safely,
   prefer the entry with the newer `lastSyncedAt` / `mtimeMs`. Must account for
   cross-device clock skew (bound the trust window; fall back to keep-both when
   ambiguous) — wall-clock alone is not authoritative.

3. **Visibility.** On any silent overwrite of a live file, emit a `Notice` and a
   log line. Overwrites of user content should never be invisible.

4. **Optional — single-writer / pull-only semantics.** A per-path "generated /
   single-writer" designation, or per-device pull-only role, so fan-out files
   (desktop-generated, read on the phone) are delivered without the phone ever
   being able to push them back. Note: a plain `excludePatterns` entry is *not*
   an acceptable substitute here — the user reads `Home.md` on the phone, so it
   must still be delivered there; it just must never be pushed back.

## Files likely affected

- `sync.ts` — pull/push decision logic (`:413`, `:434`, `:485`, `:536`, `:555`),
  conflict resolution, added visibility.
- `plan.ts` — mirror decision logic in `computeSyncPlan` (`:144`, `:155`).
- `manifest.ts` — possibly surface recency fields / a single-writer marker.
- `settings.ts` — possible per-device role / per-path mode (if option 4 pursued).
