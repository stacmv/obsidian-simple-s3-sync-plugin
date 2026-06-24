---
name: pf-test-plan
description: Generate a comprehensive test plan for the active issue based on BRD/specs or analysis
version: 3.0.0
---

Determine the active issue from `docs/issues/open/`. Check prerequisites:
- For feat/improve issues: `brd.md` must exist. If not, stop: "BRD is required. Run /pf-brd first."
- For bug issues: `analysis.md` must exist. If not, stop: "Write analysis.md (root cause analysis) before creating the test plan."
If `test_plan.md` already exists, stop and inform the user — TEST_PLAN stage is already complete.

Read `docs/issues/open/[ACTIVE-ISSUE-ID]/brd.md` and (if present) `specs.md`. For bug issues, read `analysis.md` instead.

Create a comprehensive test plan that will verify the implementation matches the specs.

### Step 1: Identify Test Scenarios

Based on the specs:
- Happy path flows
- Error conditions
- Edge cases
- State transitions
- Responsive behavior
- Accessibility requirements

### Step 2: Create Test Cases

For each scenario, create detailed test cases:

```markdown
### TC-NNN: [Test Name]

**Description:** [What this test verifies]

**Preconditions:**
- [Required state before test]
- [Required data]

**Steps:**

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | [Action to take] | [What should happen] |
| 2 | [Action to take] | [What should happen] |

**Test Data:**
- Field 1: `value`
- Field 2: `value`

**Expected Outcome:** [Final verification]

**Priority:** Critical / High / Medium / Low
```

### Step 3: Organize by Category

Group test cases:

- Functional tests
- UI/UX tests
- Validation tests
- Integration tests (if applicable)
- Edge case tests

### Step 4: Create Status Tracker

```markdown
## Status Tracker

| TC     | Test Case | Priority | Status | Remarks |
| ------ | --------- | -------- | ------ | ------- |
| TC-001 | [Name]    | High     | [ ]    |         |
```

### Step 5: Add Known Issues Section

```markdown
## Known Issues

| Issue | Description | TC Affected | Steps to Reproduce | Severity |
| ----- | ----------- | ----------- | ------------------ | -------- |
|       |             |             |                    |          |
```

Save the test plan to `docs/issues/open/[ACTIVE-ISSUE-ID]/test_plan.md`.

Include: overview and objectives, prerequisites, test cases (10-20 typically), status tracker, known issues section.
