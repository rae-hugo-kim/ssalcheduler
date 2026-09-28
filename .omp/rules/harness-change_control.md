---
description: "Minimal scoped diffs, no drive-by refactors, how to report unrelated issues"
---
# Change Control (Scope, Minimal Change, Tidy)

<!-- Harness: context-gate (read-before-edit); scope is via Surgical Changes + PR review -->

## MUST: minimal change first

- Prefer the smallest change that meets the stated goal.
- Avoid adding new abstractions unless needed for the change at hand.

## MUST: prevent scope creep

If you notice additional issues beyond the requested scope:

- Note them explicitly
- Propose follow-up work separately
- Do not silently expand the change set

## SHOULD: tidy refactors are separate and reversible

- Prefer keeping refactors small and obviously behavior-preserving.
- If a refactor is non-trivial, propose separating it (or commit separation if applicable).

## Trigger-based: Tidy First (STRUCTURAL vs BEHAVIORAL)

When both structure cleanup and behavior change are needed:

- **SHOULD** do STRUCTURAL first (behavior-preserving refactor), then BEHAVIORAL (feature/bug change).
- **SHOULD** separate commits when the repo uses commits as review units.
- If separation is not feasible (single-commit workflows), you MUST clearly delineate sections in the diff/PR description.

STRUCTURAL examples:

- Renames, extraction, reformatting, moving code without behavior changes
- Test scaffolding that does not change production behavior

BEHAVIORAL examples:

- Changing logic, APIs, outputs, business rules, side effects

## SHOULD: method guidance (TDD / Tidy First) is situational

- If test infrastructure exists and the change is code logic, prefer test-first or add a regression test early.
- If tests are not feasible in the repo context, provide a deterministic alternative verification artifact.

## Self-Check
- [ ] Does every changed line trace directly to the user's request?
- [ ] Would a senior engineer say this change is overcomplicated?
