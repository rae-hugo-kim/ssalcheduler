---
description: "Six named gates across the development lifecycle and what each requires"
---
# Quality Gates

<!-- Harness: quality-gate hook enforces FORMAT/LINT automatically after file edits when present -->

## Gate Definitions

Six named gates apply across the development lifecycle:

| Gate | What It Checks | Canonical Tools (examples) |
|------|---------------|---------------------------|
| FORMAT | Code is formatted to repo standard | prettier, biome, gofmt, ruff format, black |
| LINT | Linter rules pass with no violations | eslint, biome check, ruff check, golangci-lint |
| TYPECHECK | Type annotations are valid | tsc --noEmit, mypy, pyright |
| TEST | Full test suite passes | jest, vitest, pytest, go test ./... |
| BUILD | Artifact builds without errors | tsc --build, cargo build, go build, next build |
| EVAL | Eval harness passes (quality surfaces) | project-specific eval runner |

These names are canonical within this repo. When a harness or hook uses these names, the definitions above govern.

---

## Gate Discovery (MUST)

You MUST discover the repo's actual commands before running any gate. Do not guess.

Discovery order:

1. Read `package.json` → `scripts` (for JS/TS repos)
2. Read `Makefile` → targets
3. Read `pyproject.toml` / `setup.cfg` → `[tool.*]` sections
4. Read CI config (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`) → job steps
5. Read `AGENTS.md` / `CLAUDE.md` → explicit command hints
6. Check for `biome.json` / `biome.jsonc` → biome is the unified formatter+linter
7. If no discovery succeeds → report "gate unavailable" and skip; do not invent a command

---

## When Gates Apply

| Trigger | Required Gates |
|---------|---------------|
| After file edit | FORMAT, LINT |
| Before commit | FORMAT, LINT, TYPECHECK |
| Before PR | FORMAT, LINT, TYPECHECK, TEST, BUILD |
| Before merge | FORMAT, LINT, TYPECHECK, TEST, BUILD, EVAL (if applicable) |

"If applicable" for EVAL: required when the change affects a quality surface (LLM output, ranking, visual output, performance baseline). See [`harness-verification_tests_and_evals.md`](harness-verification_tests_and_evals.md).

---

## Gate Failure Protocol

When a gate fails:

1. **Stop and report**: identify the gate, the command run, and the output.
2. **Fix the root cause**: address the failure directly. Do not suppress warnings, add ignore comments, or disable rules to pass the gate.
3. **Re-run the gate**: confirm it passes after the fix.
4. **If the gate is broken (tool bug, config error)**: report it explicitly, note the gate as "skipped — tool broken", state the reason, and continue. Do not silently absorb a failing gate.
5. **Do not batch failures**: fix and re-verify each gate before proceeding to the next trigger level.

Suppression (e.g., `// eslint-disable`, `# noqa`, `// @ts-ignore`) MUST NOT be used to clear a gate unless:
- The suppression pre-existed this change, or
- A comment explains a deliberate, reviewed exception

---

## Relationship to Automated Hooks

The ECC `quality-gate.js` hook (and similar harness hooks) run FORMAT and LINT automatically after file edits, targeting the edited file. When such hooks are active:

- FORMAT and LINT enforcement is **automated** — this policy is informational for those gates at the after-edit trigger level.
- All other gates (TYPECHECK, TEST, BUILD, EVAL) and all higher trigger levels (before commit, PR, merge) remain **manual responsibilities** governed by this policy.
- If no hooks are installed, all gates at all trigger levels SHOULD be checked manually.

Whether hooks are active or not, the gate failure protocol above applies to failures surfaced by either mechanism.

---

## SHOULD: run the fastest gate first

- FORMAT before LINT (formatting errors are cheaper to fix and often cause lint noise).
- TYPECHECK before TEST (type errors often explain test failures).
- TEST before BUILD when the build step is expensive.

---

## Adversarial Verification Gates

Plan-attack, test-attack, completion-attack 게이트는 [`.omp/rules/harness-adversarial_review.md`](harness-adversarial_review.md)에서 별도 정의.

## Self-Check

- [ ] Did I discover gate commands from the repo rather than guessing?
- [ ] Did I run all required gates for the current trigger level?
- [ ] Did I fix failures rather than suppress them?
