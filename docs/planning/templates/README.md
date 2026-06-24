# Planning Framework v2.0 Templates

This folder contains templates for setting up Planning Framework v2.0 in your project.

---

## Template Categories

### 1. Issue Templates (`issue/`)
Templates for files in each issue folder (`docs/issues/open/YYYYMMDD-type-slug/`):

**Required:**
- `prompt.md` - Original user request
- `analysis.md` - Problem understanding and approach (with YAML frontmatter)
- `implementation-plan.md` - Detailed task breakdown
- `session-log.md` - Session-by-session progress

**Optional:**
- `decisions.md` - Issue-specific architectural decisions
- `definition-of-done.md` - Completion criteria checklist

### 2. Global Planning Templates (`global/`)
Templates for project-wide planning files (`docs/planning/`):

- `implementation-plan.md` - High-level roadmap with issue links
- `session-log.md` - One-line entries when issues close
- `decisions.md` - Global architectural decision records (ADRs)

### 3. Config Templates (`config/`)
Templates for framework configuration:

- `PLANNING.md` - Main framework config (goes at repo root)
- `.qa-workflow.md` - Quality assurance checklist (goes at repo root)

---

## How to Use These Templates

### Option 1: Interactive Setup Script (Recommended)
```bash
./scripts/setup-planning-v2.sh
```
The script will:
- Ask configuration questions
- Create folder structure
- Copy and customize templates
- Initialize planning files

### Option 2: Manual Setup

**1. Create folder structure:**
```bash
mkdir -p docs/issues/open
mkdir -p docs/issues/closed
mkdir -p docs/planning
```

**2. Copy config files to repo root:**
```bash
cp docs/planning/templates/config/PLANNING.md ./
cp docs/planning/templates/config/.qa-workflow.md ./
```

**3. Copy global planning files:**
```bash
cp docs/planning/templates/global/implementation-plan.md docs/planning/
cp docs/planning/templates/global/session-log.md docs/planning/
cp docs/planning/templates/global/decisions.md docs/planning/
```

**4. Customize the files:**
- Replace `[Project Name]` with your project name
- Replace `[Project Name]` placeholders
- Customize issue types in PLANNING.md
- Customize QA commands in .qa-workflow.md
- Update dates to current date

**5. Create your first issue using issue templates when needed**

---

## Template Customization

### Issue Types
Default: `feat`, `bug`, `improve`

To add custom types, edit `PLANNING.md`:
```markdown
**Issue Types:**
- `feat` - New feature
- `bug` - Fix existing functionality
- `improve` - Enhance existing feature
- `refactor` - Code restructuring
- `docs` - Documentation only
- `test` - Testing improvements
- `chore` - Maintenance tasks
```

### QA Workflow
Customize `.qa-workflow.md` for your project:
- Add project-specific checks
- Update commands for your build system
- Set coverage requirements
- Define performance budgets

### Global Planning Files
Adjust to your team's needs:
- Change milestone structure
- Add custom sections
- Modify progress tracking format

---

## Examples

### Example: Creating First Issue Manually

```bash
# 1. Create issue folder
mkdir docs/issues/open/20240127-feat-user-auth

# 2. Copy templates
cp docs/planning/templates/issue/*.md docs/issues/open/20240127-feat-user-auth/

# 3. Fill out the templates
# - prompt.md: Paste user request
# - analysis.md: Analyze problem, update YAML frontmatter
# - implementation-plan.md: Break down into tasks
# - session-log.md: Add first session entry

# 4. Create branch
git checkout -b issue/20240127-feat-user-auth

# 5. Start working!
```

### Example: Project-Specific Template

Some teams want extra files in each issue:
```bash
# Add to templates/issue/
security-review.md  # Security considerations
performance.md      # Performance benchmarks
```

Update PLANNING.md to document custom files.

---

## Template Maintenance

**Updating templates:**
1. Edit templates in this folder
2. Update version number in PLANNING.md
3. Document changes in CHANGELOG.md
4. Existing projects can adopt changes incrementally

**Versioning:**
- Templates are versioned with framework (v2.0, v2.1, etc.)
- Breaking changes get major version bump
- New templates or minor changes get minor version bump

---

## Migration from v1.0

If you have a v1.0 project:
1. Use `scripts/migrate-v1-to-v2.sh`
2. See `docs/planning/MIGRATION-GUIDE.md`
3. Templates will be applied automatically

---

## Help & Support

**Questions:**
- See `docs/planning/FRAMEWORK.md` for complete guide
- See `docs/planning/QUICKSTART.md` for quick start
- Open issue on GitHub: https://github.com/[your-org]/planning-framework

**Contributing:**
- Suggest template improvements via GitHub issues
- Share your customized templates
- Help improve documentation

---

**Framework Version:** 2.0
**Templates Updated:** YYYY-MM-DD
