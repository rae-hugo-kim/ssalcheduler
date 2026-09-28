---
description: "RED -> GREEN -> TIDY cycle for all implementation work"
---
# TDD Policy

## MUST: Test-Driven Development for implementation

All implementation work follows the RED → GREEN → TIDY cycle.

## Cycle

### 1. RED (test first)
- Write a failing test that captures the requirement
- Test MUST fail before writing implementation
- One test at a time

### 2. GREEN (minimal pass)
- Write minimal code to make the test pass
- No extra features
- No premature optimization
- No unrelated changes

### 3. TIDY (clean touched code only)
- Rename unclear variables/functions
- Remove obvious duplication in new code
- Fix formatting inconsistencies
- Do NOT restructure existing code
- Do NOT add features

Repeat until the user story is complete.

## Coverage

- **Target**: 80–100% for new/changed code
- **Measure**: Use repo's coverage tool (discover via `repo_command_discovery`)
- **Report**: Include coverage in completion summary

## E2E Test Checklist

For each epic/feature, produce a human-testable checklist:

**Location**: `checklists/e2e_<feature>.md`

**Format**:
```markdown
# E2E Checklist: <Feature>

## Prerequisites
- [ ] <setup step>

## Test cases

### <User Story 1 title>
**Given** <precondition>
**When** <action>
**Then** <expected>

- [ ] Step 1
- [ ] Step 2
- [ ] Verify: <what to check>

### <User Story 2 title>
...

## Edge cases
- [ ] <edge case>

## Known limitations
- <limitation>
```

## Exception Protocol

If TDD is not feasible:
1. State why (no test infra, legacy constraint, etc.)
2. Propose alternative verification (manual steps, smoke test)
3. Get explicit approval before proceeding without TDD
