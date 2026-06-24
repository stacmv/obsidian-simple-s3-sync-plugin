# Planning Framework Configuration

**Project:** [Project Name]
**Framework Version:** 2.0
**Last Updated:** YYYY-MM-DD

---

## Overview

This project uses Planning Framework v2.0 for tracking development work across AI agent sessions.

**Framework Benefits:**
- ✅ Issue-based workflow prevents file growth
- ✅ Branch-specific issues prevent merge conflicts
- ✅ Minimal global files, execution details in issues
- ✅ Multi-agent support (Claude/Gemini/Qwen)
- ✅ Built-in QA workflow

---

## Quick Reference

**Core Files:**
- `PLANNING.md` - This file (framework instructions)
- `.qa-workflow.md` - Quality assurance checklist
- `docs/planning/implementation-plan.md` - Roadmap & active issues
- `docs/planning/session-log.md` - Session timeline
- `docs/planning/decisions.md` - Architectural decisions
- `docs/issues/open/` - Active issues
- `docs/issues/closed/` - Completed issues

---

## Starting a New Session

### Step 1: Read Global Context
**Read in this order:**
1. **This file (PLANNING.md)** - Framework instructions
2. **`docs/planning/implementation-plan.md`** - Current roadmap & active issues
3. **`docs/planning/session-log.md`** (last 20 lines) - Recent activity

### Step 2: If Working on an Issue
**Read issue files in order:**
1. `docs/issues/open/{issue-id}/prompt.md` - Original request
2. `docs/issues/open/{issue-id}/analysis.md` - Understanding & approach
3. `docs/issues/open/{issue-id}/implementation-plan.md` - Task breakdown
4. `docs/issues/open/{issue-id}/session-log.md` - Progress history
5. `docs/issues/open/{issue-id}/decisions.md` - (if exists) Issue decisions

### Step 3: Read Project Context
1. **`docs/planning/decisions.md`** - Architectural decisions
2. **`.qa-workflow.md`** - Quality requirements

**Context Restored!** You're ready to work.

---

## Issue Workflow

### Issue Naming Convention

**Format:** `YYYYMMDD-{type}-{slug}`

**Example:** `20240127-feat-add-authentication`

**Issue Types (Customizable):**
- `feat` - New feature
- `bug` - Fix existing functionality
- `improve` - Enhance existing feature

[Add custom types here if needed]

### Issue Lifecycle

```
1. CREATE      → User requests work
2. ANALYZE     → Understand problem, propose solution
3. PLAN        → Break down into tasks
4. IMPLEMENT   → Execute plan, track progress
5. QA          → Run quality assurance workflow
6. CLOSE       → Merge, archive, integrate
```

### 1. Create Issue

**When to create:**
- Non-trivial work (>15 minutes)
- Multi-file changes
- New features
- Bug fixes requiring investigation

**Agent behavior:**
- For non-trivial work: Ask user "Should I create issue for this?"
- For ad-hoc work: Ask user or work directly (log in global session-log)

**Steps:**
```bash
# Create issue folder
mkdir docs/issues/open/YYYYMMDD-type-slug/

# Create files from templates
prompt.md          # Original user request
analysis.md        # Understanding & approach
```

### 2. Analyze & Plan

**Steps:**
1. Fill out `analysis.md` with YAML frontmatter
2. Create `implementation-plan.md` with task breakdown
3. Optional: Create `definition-of-done.md` if helpful

**Analysis should cover:**
- Problem understanding
- Proposed solution
- Technical considerations
- Risks & mitigations
- Success criteria

### 3. Implement

**Steps:**
```bash
# Commit current changes
git add . && git commit -m "..."

# Create issue branch
git checkout -b issue/YYYYMMDD-type-slug

# Work through tasks in implementation-plan.md
# Update session-log.md after each session
# Create decisions.md if architectural decisions made
```

**Rules:**
- ✅ ONE issue per session (focused work)
- ✅ Update session-log.md after each session
- ✅ Check off tasks in implementation-plan.md
- ✅ Document blockers immediately
- ✅ Commit frequently with clear messages

### 4. Quality Assurance

**Run QA workflow from `.qa-workflow.md`**

**Must pass before closing:**
- [ ] Linting/formatting passes
- [ ] All existing tests pass
- [ ] New tests added
- [ ] Documentation updated
- [ ] (Bugs) Failing test → fix → passing test

**If QA fails:**
- Fix issues
- Retry QA workflow
- Don't close until all checks pass

### 5. Close Issue

**Prerequisites:**
- [ ] QA workflow passes
- [ ] User confirms completion
- [ ] No outstanding blockers

**Steps:**
```bash
# 1. Merge branch to parent
git checkout develop  # or main
git merge issue/YYYYMMDD-type-slug

# 2. Move issue folder
mv docs/issues/open/YYYYMMDD-type-slug docs/issues/closed/

# 3. Update global session-log.md
echo "[Agent] ✓ [issue-id](../issues/closed/issue-id) - Description" >> docs/planning/session-log.md

# 4. Promote significant decisions to global decisions.md
# (Copy important ADRs from issue decisions.md)

# 5. Update global implementation-plan.md
# (Mark milestone task complete, update progress)

# 6. Commit
git add .
git commit -m "Close issue YYYYMMDD-type-slug: Description"
```

**Branch cleanup:**
- Branches are NOT auto-deleted
- User manually deletes when ready

---

## Session End Ritual

### If Working on Issue:
- [ ] Update issue `session-log.md` with session entry
- [ ] Check off completed tasks in `implementation-plan.md`
- [ ] Note blockers and next priorities
- [ ] Commit changes with clear message

### If Closing Issue:
- [ ] Run QA workflow (must pass)
- [ ] Merge branch to parent
- [ ] Move issue to `closed/`
- [ ] Update global `session-log.md` (one-line entry)
- [ ] Promote significant decisions to global `decisions.md`
- [ ] Update global `implementation-plan.md`
- [ ] Commit with "Close issue..." message

### If Ad-hoc Work:
- [ ] Log work in global `session-log.md`
- [ ] Format: `[Agent] YYYY-MM-DD: Description`
- [ ] Commit changes

---

## Agent Guidelines

### DO:
- ✅ **Read issue files** before starting work
- ✅ **One issue per session** (focused work)
- ✅ **Update session-log.md** after each session
- ✅ **Run QA** before closing issues
- ✅ **Tag entries** with agent name
- ✅ **Ask user** before creating issues (if unsure)
- ✅ **Document decisions** in issue decisions.md
- ✅ **Commit frequently** with clear messages

### DON'T:
- ❌ Work on multiple issues in one session
- ❌ Skip QA workflow
- ❌ Close issue without user confirmation
- ❌ Auto-delete branches
- ❌ Skip reading context files
- ❌ Make architectural decisions without documenting

---

## Multi-Agent Support

This PLANNING.md works for:
- **Claude Code** - Anthropic's CLI tool
- **Gemini CLI** - Google's CLI tool
- **Qwen Code** - Qwen's CLI tool
- **Other AI agents** - Generic instructions

**Agent Identification:**
Tag all session log entries with your agent name:
```markdown
[Claude Code] ✓ [issue-id](link) - Description
[Gemini CLI] 2024-01-27: Ad-hoc work description
[Qwen Code] ✓ [issue-id](link) - Description
```

**Git Commits:**
Include Co-Authored-By line:
```bash
git commit -m "Message

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Project-Specific Configuration

### Issue Types
[Customize issue types for your project]
```
Default: feat, bug, improve
Add more: refactor, docs, test, chore, etc.
```

### Branch Strategy
**Parent branch:** develop | main
**Issue branches:** issue/YYYYMMDD-type-slug
**Merge strategy:** merge | squash | rebase

### Custom Workflows
[Add project-specific workflows or processes here]

---

## Troubleshooting

### Q: File growth - files getting too big?
**A:** Split by topic:
- `decisions.md` → `decisions-api.md`, `decisions-database.md`, etc.
- Use issue folders for execution details, not global files

### Q: Can't find context?
**A:** Check in order:
1. Issue folder (if working on issue)
2. Global `implementation-plan.md`
3. Global `decisions.md`
4. Closed issues folder

### Q: Issue numbering conflict?
**A:** Date-based naming prevents conflicts. If needed, append `-2`, `-3` to slug.

### Q: How to handle dependencies between issues?
**A:** Document in issue `analysis.md` under "Dependencies" section.

### Q: Branch conflicts?
**A:** Issue folders are branch-specific. Global files only updated at merge (sequential).

---

## Migration from v1.0

If migrating from Planning Framework v1.0:
1. Run `scripts/migrate-v1-to-v2.sh`
2. See `docs/planning/MIGRATION-GUIDE.md` for details
3. Archive old v1.0 files in `docs/planning/v1.0-archive/`

---

## Additional Resources

**Framework Documentation:**
- `docs/planning/FRAMEWORK.md` - Complete v2.0 guide
- `docs/planning/QUICKSTART.md` - 5-minute setup guide
- `docs/planning/MIGRATION-GUIDE.md` - v1.0 to v2.0 migration

**Templates:**
- `docs/planning/templates/issue/` - Issue file templates
- `docs/planning/templates/global/` - Global planning templates
- `docs/planning/templates/config/` - Config file templates

**Project Homepage:**
https://github.com/[your-org]/planning-framework

---

## Notes

[Add project-specific notes here]

---

**Framework Version:** 2.0
**Project:** [Project Name]
**Last Updated:** YYYY-MM-DD
