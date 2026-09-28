---
description: "Commit message and PR body discipline, review evidence expectations"
---
# Commit & PR Discipline

## SHOULD: commit in small, reviewable units

- Prefer small commits that reviewers can understand quickly.
- If applicable, avoid mixing large refactors with behavior changes.

## MUST: verification before landing

- Do not declare completion without stating what verification was performed.
- If verification was skipped, state why and what the risk is.

## SHOULD: PR body includes essentials

At minimum:

- Change summary (1–3 bullets)
- Verification performed (tests/evals/manual steps)
- Risk and rollback (if non-trivial)
- Assumptions/decisions (if relevant)

## Template

- PR description: `../../templates/pr_body.md`




