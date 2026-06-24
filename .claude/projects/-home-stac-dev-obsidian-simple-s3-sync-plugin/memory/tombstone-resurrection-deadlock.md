---
name: tombstone-resurrection-deadlock
description: The recurring "file keeps getting deleted / nothing to sync" bug class and its root cause
metadata:
  type: project
---

The "24.md content disappears, then nothing-to-sync / divergent copies" bug (v0.4.2–0.4.4 all failed to fully fix it) is a **stale-tombstone vs peer-resurrection** problem, fixed 2026-06-08 on `develop`.

Root cause: `runSync` (sync.ts) re-derives every action independently and does NOT consume the plan — so fixing only `plan.ts` changes the modal text but not behavior. The data loss lives in sync.ts.

Two sync.ts sites poison state when a device's cache holds a tombstone (`cached.deleted`) but remote was resurrected live by a peer (`remote.version > cached.version`):
1. Pull phase `if (!localFile) { if (cached) continue }` — skipped downloading the resurrection.
2. Push delete-loop — re-tombstoned the live manifest entry (the `alreadyCached` guard only suppressed the redundant S3 softDelete, NOT the manifest tombstone write), pushing a fresh tombstone that peers then `trash()`.

Fix rule: **a cached tombstone OLDER than a live remote is superseded — download/adopt it, never re-delete.** Applied in pull phase, push delete-loop (defensive `continue`), and mirrored in plan.ts.

**Why:** a tombstone is indistinguishable from a legit deletion except by version; the only safe discriminator is `remote.version > cached.version`.

**How to apply:** any future change touching deletion/resurrection must keep sync.ts and plan.ts in lockstep AND be covered by a `runSync`-level test (plan-level tests miss sync.ts regressions). Two operational caveats: (1) ALL devices must update before next sync or one stale device re-runs the poison; (2) the fix is steady-state only — it cannot retroactively tell a currently-tombstoned file was bogus, so users in the broken state must back up content before syncing.
