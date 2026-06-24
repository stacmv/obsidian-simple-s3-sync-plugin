# Definition of Done: [Issue Title]

**Issue:** YYYYMMDD-type-slug
**Type:** feat | bug | improve
**Created:** YYYY-MM-DD

---

## Purpose

Clear, testable criteria for when this issue is truly complete. This checklist ensures nothing is forgotten before closing the issue.

---

## Functional Completeness

**Core Functionality:**
- [ ] Feature/fix works as described in prompt.md
- [ ] All requirements from prompt.md satisfied
- [ ] Edge cases handled appropriately
- [ ] Error handling implemented

**User-Facing (if applicable):**
- [ ] UI/UX matches requirements
- [ ] User feedback/validation obtained
- [ ] Accessibility considerations addressed

---

## Code Quality

**Implementation:**
- [ ] Code follows project conventions
- [ ] No debug code or console.logs left in
- [ ] No commented-out code blocks
- [ ] No TODO comments (or documented as future issues)
- [ ] Code is self-documenting or well-commented

**Architecture:**
- [ ] Follows patterns established in decisions.md
- [ ] Integrates cleanly with existing codebase
- [ ] No architectural violations introduced

---

## Testing (from .qa-workflow.md)

**Automated Tests:**
- [ ] All existing tests still pass
- [ ] New unit tests added for new functionality
- [ ] New integration tests added (if applicable)
- [ ] Test coverage meets project standards
- [ ] Edge cases covered in tests

**Bug Issues Only:**
- [ ] Failing test created that reproduces bug
- [ ] Test now passes after fix
- [ ] Regression test added

**Manual Testing:**
- [ ] Manually tested happy path
- [ ] Manually tested error cases
- [ ] Tested in relevant environments/browsers

---

## Documentation

**Code Documentation:**
- [ ] Public APIs documented (JSDoc, etc.)
- [ ] Complex logic explained in comments
- [ ] Function/class signatures clear

**Project Documentation:**
- [ ] README.md updated (if needed)
- [ ] API documentation updated (if applicable)
- [ ] User documentation updated (if user-facing)
- [ ] Migration guide updated (if breaking changes)

**Issue Documentation:**
- [ ] implementation-plan.md tasks all checked off
- [ ] session-log.md updated with final session
- [ ] Significant decisions documented

---

## Quality Assurance

**QA Workflow (from .qa-workflow.md):**
- [ ] Linting/formatting passes
- [ ] Security check passes (no obvious vulnerabilities)
- [ ] Performance acceptable (no major regressions)
- [ ] No console errors or warnings

**Integration:**
- [ ] Works with existing features
- [ ] No breaking changes (or properly documented)
- [ ] Database migrations tested (if applicable)

---

## Git & Process

**Version Control:**
- [ ] All changes committed
- [ ] Commit messages clear and descriptive
- [ ] No unrelated changes included
- [ ] Branch up to date with parent branch

**Issue Workflow:**
- [ ] QA workflow from .qa-workflow.md passes
- [ ] User confirmed issue is complete
- [ ] No outstanding blockers
- [ ] Branch ready to merge

---

## Feature-Specific Criteria

[Add issue-specific completion criteria here]

**Example for a feature:**
- [ ] Users can [specific action]
- [ ] System handles [specific scenario]
- [ ] Performance meets [specific metric]

**Example for a bug:**
- [ ] Bug no longer reproduces
- [ ] Original error message gone
- [ ] Related issues checked (no other instances)

---

## Cleanup

**Before Closing:**
- [ ] Temporary files removed
- [ ] Debug configurations removed
- [ ] Test data cleaned up
- [ ] No leftover artifacts

**Issue Closure Tasks:**
- [ ] Update global session-log.md
- [ ] Promote significant decisions to global decisions.md
- [ ] Update global implementation-plan.md
- [ ] Merge branch to parent
- [ ] Move issue folder to closed/

---

## Acceptance

**Final Checks:**
- [ ] All checkboxes above completed
- [ ] User/stakeholder approval obtained
- [ ] Agent confirms all criteria met
- [ ] Ready to close issue

---

## Notes

[Any notes about what "done" means for this specific issue]

[Any exceptions or special considerations]

---

**Created:** YYYY-MM-DD
**Last Updated:** YYYY-MM-DD
