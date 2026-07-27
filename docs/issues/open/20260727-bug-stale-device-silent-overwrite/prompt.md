# Bug: A stale device silently overwrites newer content on other devices

**Issue:** When a device comes online holding an outdated copy of the vault, its
sync can push that stale content back to S3 and win, silently overwriting a
newer version another device had already synced — with no conflict copy and no
notification.

**Expected behavior:** The device with the *newer* content wins, or — when that
cannot be determined safely — a conflict copy is created so nothing is lost
silently. A device that is behind (has not incorporated the current remote
version of a file) must never overwrite that remote with older content.

**Actual behavior:** "Newer" is decided purely by a scalar per-file `version`
counter with last-writer-wins semantics; real-world recency is never consulted.
A behind device whose counter is not behind re-uploads its stale content
(`version + 1`), and it propagates to every other device. No `.conflict-*` copy
is produced — the overwrite is invisible.

**Real incident (2026-07-27):** `Home.md` (regenerated daily by a headless job
on the `desktop`) plus ~22 other files were rolled back on `desktop` from the
27.07 version to the 26.07 version. The winning entries were `lastSyncedBy:
pova3` (a phone that had been offline over the weekend and woke mid-morning).
No conflict copies were created. Newer content was recoverable only from the
separate obsidian-git history.
