---
name: pf-impl-plan
description: Create the implementation plan (implementation_plan.md) for the active issue, mapped to test cases
version: 3.0.0
---

Determine the active issue from `docs/issues/open/`. Check prerequisites: `test_plan.md` must exist. If not, stop: "Test plan is required. Run /pf-test-plan first."
If `implementation_plan.md` already exists, stop and inform the user — IMPL_PLAN stage is already complete.

Read `docs/issues/open/[ISSUE-ID]/brd.md`, `specs.md` (if present), and `test_plan.md`. Specs are approved, test plan is ready. Now we need an implementation plan.

## Your Task

Create a detailed implementation plan that maps to the test cases.

### Step 1: Analyze Test Cases

For each test case (TC-NNN):
- What functionality must exist?
- What files need to be created/modified?
- What dependencies are needed?

### Step 2: Create Task Breakdown

Group test cases into implementation tasks:

```markdown
## Implementation Plan: [Feature Name]

### Overview
[Brief description]

### Files to Create/Modify
[List all files]

### Implementation Tasks

#### Task 1: [Name]
**Mapped Test Cases:** TC-001, TC-002, TC-003
**Files:**
- `path/to/file1` - [description]
- `path/to/file2` - [description]

**Implementation Notes:**
- [Key detail 1]
- [Key detail 2]

**Acceptance Criteria:**
- [ ] TC-001 passes
- [ ] TC-002 passes
- [ ] TC-003 passes
```

### Step 3: Identify Dependencies

- What order should tasks be implemented?
- Any external dependencies?

### Step 4: Estimate Complexity

- Simple: 1-2 tasks, straightforward
- Medium: 3-5 tasks, some complexity
- Complex: 6+ tasks, significant work

Save the implementation plan to `docs/issues/open/[ISSUE-ID]/implementation_plan.md`.

Every test case must map to a task. Tasks should be completable in one session.

Where [ISSUE-ID] means: scan docs/issues/open/ and use the active issue folder name.
