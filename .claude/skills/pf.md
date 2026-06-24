---
name: pf
description: Planning Framework orchestrator — shows active issue, completed stages, and next step
version: 3.0.0
---

You are the Planning Framework v3.0 orchestrator. When invoked as `/pf`, perform the following steps exactly.

## Step 1: Read installed version

Read the file `.claude/skills/pf.md` and extract the value of the `version:` field from its YAML frontmatter. This is the installed version to display. If the file cannot be read, display "unknown".

## Step 2: Scan for open issues

List the contents of `docs/issues/open/` (if it exists). Collect all subdirectories whose names match the pattern `YYYYMMDD-TYPE-SLUG` where TYPE is one of `feat`, `improve`, or `bug` and YYYYMMDD is an 8-digit date.

## Step 3: Handle zero or multiple issues

**No issue folders found:**
Output:
```
Planning Framework v<VERSION>
No open issues found.

To create an issue:
  mkdir docs/issues/open/YYYYMMDD-type-slug/
  # then add prompt.md describing the task
```
Stop here.

**Multiple issue folders found:**
Output:
```
Planning Framework v<VERSION>
Multiple open issues found:
  1. <ISSUE-ID-1>
  2. <ISSUE-ID-2>
  ...

Which issue would you like to work on?
```
Stop here and wait for the user to specify.

## Step 4: Single active issue — detect type

For the single issue folder found, extract TYPE from the folder name:
- Folder starts with `YYYYMMDD-feat-` → type is **feat**
- Folder starts with `YYYYMMDD-improve-` → type is **improve**
- Folder starts with `YYYYMMDD-bug-` → type is **bug**

## Step 5: Detect completed stages

Check which documents exist inside the issue folder (`docs/issues/open/<ISSUE-ID>/`):

| Document present | Stage completed |
|---|---|
| `prompt.md` | CREATE |
| `brd.md` | BRD |
| `specs.md` | SPEC |
| `analysis.md` | ANALYSIS (bug type only) |
| `test_plan.md` | TEST_PLAN |
| `implementation_plan.md` | IMPL_PLAN |

List all completed stages in order.

## Step 6: Determine next step

Use the type-specific workflow below. The "current position" is the last completed stage.

### feat workflow
```
CREATE → /pf-brd → BRD → /pf-spec → SPEC → /pf-check → (check passes) → /pf-test-plan → TEST_PLAN → /pf-check → (check passes) → /pf-impl-plan → IMPL_PLAN → /pf-check → (check passes) → /pf-execute
```

| Last completed stage | Next step |
|---|---|
| CREATE only | `/pf-brd` |
| BRD | `/pf-spec` |
| SPEC | `/pf-check` |
| SPEC + check passed (no blocking issues noted) | `/pf-test-plan` |
| TEST_PLAN | `/pf-check` |
| TEST_PLAN + check passed | `/pf-impl-plan` |
| IMPL_PLAN | `/pf-check` |
| IMPL_PLAN + check passed | `/pf-execute` |

### improve workflow
```
CREATE → /pf-brd → BRD → /pf-check → (check passes) → /pf-test-plan → TEST_PLAN → /pf-check → (check passes) → /pf-impl-plan → IMPL_PLAN → /pf-execute
```

| Last completed stage | Next step |
|---|---|
| CREATE only | `/pf-brd` |
| BRD | `/pf-check` |
| BRD + check passed | `/pf-test-plan` |
| TEST_PLAN | `/pf-check` |
| TEST_PLAN + check passed | `/pf-impl-plan` |
| IMPL_PLAN | `/pf-execute` |

### bug workflow
```
CREATE → (write analysis.md manually) → ANALYSIS → /pf-check → (check passes) → /pf-test-plan → TEST_PLAN → /pf-check → (check passes) → /pf-impl-plan → IMPL_PLAN → /pf-execute
```

| Last completed stage | Next step |
|---|---|
| CREATE only (no analysis.md) | Write `analysis.md` manually inside the issue folder describing root cause |
| ANALYSIS present | `/pf-check` |
| ANALYSIS + check passed | `/pf-test-plan` |
| TEST_PLAN | `/pf-check` |
| TEST_PLAN + check passed | `/pf-impl-plan` |
| IMPL_PLAN | `/pf-execute` |

**Note on "check passed":** A check is considered passed when `test_plan.md` or `implementation_plan.md` exists at the stage where a check would have produced them. If the next document in sequence is already present, treat the check as having passed.

## Step 7: Output

Print the status block:

```
Planning Framework v<VERSION>
Active issue: <ISSUE-ID>  (type: feat/improve/bug)
Completed stages: <STAGE1>, <STAGE2>, ...
Next step: /<next-command>
```

If no stages are completed yet (only the folder exists with no documents), show:
```
Planning Framework v<VERSION>
Active issue: <ISSUE-ID>  (type: feat/improve/bug)
Completed stages: (none)
Next step: Add prompt.md to the issue folder to begin
```
