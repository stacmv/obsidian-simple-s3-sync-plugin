# Session Log

**Project:** [Project Name]
**Version:** 2.0
**Started:** YYYY-MM-DD
**Last Updated:** YYYY-MM-DD

---

## Purpose

Lightweight session history tracking. This log captures:
- When issues are closed (one-line entries with links)
- Ad-hoc work not tied to specific issues
- High-level progress over time

**Note:** Detailed session work is tracked in issue folders. This is just a summary.

---

## Format

**Issue Closure:**
```
[Agent Name] ✓ [issue-id](link-to-closed-issue) - Brief description
```

**Ad-hoc Work:**
```
[Agent Name] YYYY-MM-DD: Brief description of non-issue work
```

**Example Entries:**
```
[Claude Code] ✓ [20240127-feat-add-auth](../issues/closed/20240127-feat-add-auth/) - Added JWT authentication system
[Gemini CLI] 2024-01-28: Updated dependencies, fixed linting issues
[Claude Code] ✓ [20240129-bug-login-redirect](../issues/closed/20240129-bug-login-redirect/) - Fixed redirect after login
```

---

## Entries

### 2024-01

[Claude Code] YYYY-MM-DD: [Initial project setup, created planning structure]

---

### 2024-02

[Entries will be added as work progresses]

---

### 2024-03

[Entries will be added as work progresses]

---

### 2026-07

[Claude Code] 2026-07-27: Filed [20260727-bug-stale-device-silent-overwrite](../issues/open/20260727-bug-stale-device-silent-overwrite/) — a stale device silently overwrites newer content on other devices (real incident: phone `pova3` rolled back `desktop`'s daily-generated `Home.md` + ~22 files, no conflict copy). Root cause: scalar `version` last-writer-wins with no recency tiebreak.

[Claude Code] 2026-07-28: Ad-hoc hotfix for phantom deletions by stale devices (real incident: `pova3` tombstoned 9 files it never had — today's photo-job output + meal-plan notes; `desktop` auto-sync then silently trashed them locally mid-diagnosis; recovered via vault git + cache rebuild). Fixes: cached manifest now records only disk-reconciled entries (was: full remote manifest incl. re-check merges, failed downloads, filter-excluded paths); 404 downloads are loud errors; push never tombstones paths absent from the cached manifest; auto-sync runs with `applyDeletions: false` (deferred to manual sync review); new "Reset local sync state" command. Related open issue: 20260727-bug-stale-device-silent-overwrite (causal-guard core fix still pending).

---

## Statistics

**Total Issues Closed:** X
**Total Sessions:** ~X
**Contributors:** [List of agents/people who've worked on project]

**Breakdown by Type:**
- Features: X closed
- Bugs: X closed
- Improvements: X closed

**Breakdown by Agent:**
- Claude Code: X issues
- Gemini CLI: X issues
- Qwen Code: X issues

---

## Monthly Summary Template

```markdown
### YYYY-MM

**Milestone:** [Active milestone this month]
**Focus:** [What was the main focus]

**Issues Closed:** X
**Major Achievements:**
- Achievement 1
- Achievement 2

**Entries:**
[Agent] ✓ [issue-id](link) - Description
[Agent] YYYY-MM-DD: Ad-hoc work
```

---

## How to Use This File

**For AI Agents:**
1. Add one-line entry when closing an issue
2. Add dated entry for significant ad-hoc work
3. Keep entries chronological
4. Tag entries with your agent name
5. Link to closed issue folders

**When to Update:**
1. After closing an issue (always)
2. After significant ad-hoc work session (optional)
3. End of month for monthly summary (optional)

**Keep This File Lightweight:**
- Just one line per issue closure
- Just one line per ad-hoc session
- Detailed work tracked in issue folders
- This is a high-level timeline only

---

## Notes

**Why This Format?**
- Prevents unbounded file growth (unlike v1.0)
- Easy to scan for recent activity
- Links preserve full context in closed issues
- Agent tracking helps debug issues
- Monthly summaries provide milestones

**What Goes in Issue session-log.md vs Here?**
- **Issue session-log:** Detailed work, decisions, blockers per session
- **Global session-log:** One-line summary when issue closes

---

**Version:** 2.0
**Started:** YYYY-MM-DD
**Last Updated:** YYYY-MM-DD
