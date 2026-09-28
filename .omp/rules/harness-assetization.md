---
description: "Record spec, decision log and retro for non-trivial changes (spec -> implement -> retro)"
---
# Assetization (Spec → Implement → Retro)

## SHOULD: leave a lightweight spec for non-trivial changes

For any non-trivial change, record:

- Goal and success criteria
- Scope and non-goals
- Assumptions/constraints
- Verification plan

This can live in an issue/PR description.

## Team agreement: PRD/overview as SST + optional TL;DR (no separate 1-pager by default)

- **SST**: During development, the **source of truth is the long-form PRD/overview** (not a separate 1-pager file).
- **Default**: Do **not** create a separate 1-pager document “for insurance” by default.
- **If needed**: Add a short **TL;DR (1-pager summary) section at the top of the PRD/overview** instead of creating a new file.
  - Template: `../../templates/prd_tldr_header.md`
- **Triggers to add TL;DR** (examples):
  - PRD becomes too long to onboard quickly
  - Scope drift debates repeat during implementation
  - PRD changes frequently and the team needs a stable summary snapshot at the top

## SHOULD: record decisions (why)

When a decision is not obvious, record:

- The decision
- Alternatives considered (and why each was rejected)
- Evidence
- Trade-offs
- Revisit triggers (the conditions under which the decision should be re-examined)

Home: `docs/decisions/` (ADR files `NNN-slug.md`, 3-digit sequence; the body is immutable
once settled — later changes go under `## Amendment (YYYY-MM-DD)`) or the PR Decision Log
(`templates/decision_log.md`) for lighter decisions. Create a file only for decisions whose
rejected alternatives will be questioned again, that overturn an existing rule's premise, or
that were promoted from a session close-out.

`docs/` is consumer project space and is not synced by the harness, so this rule carries
the convention inline instead of linking a `docs/decisions/README.md` that consumer repos
do not have (#27).

## SHOULD: retro for repeated failures

If a failure mode repeats:

- Capture what happened
- Add a trigger-based rule/checklist item to prevent recurrence

## Templates

- Assumptions: `../../templates/assumptions.md`
- Decision log: `../../templates/decision_log.md`
- Retro: `../../templates/retro.md`


