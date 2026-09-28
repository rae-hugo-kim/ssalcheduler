# Quality Gate Checklist

Use this checklist at the appropriate trigger level. Only run the gates required for your current stage (see `.omp/rules/harness-quality_gates.md` for the trigger table).

## Discovery

- [ ] Discovered FORMAT command from repo (package.json scripts, Makefile, CI config, etc.)
- [ ] Discovered LINT command from repo
- [ ] Discovered TYPECHECK command from repo
- [ ] Discovered TEST command from repo
- [ ] Discovered BUILD command from repo
- [ ] Discovered EVAL command from repo (or confirmed not applicable)

## Gates

- [ ] FORMAT gate passed
- [ ] LINT gate passed
- [ ] TYPECHECK gate passed
- [ ] TEST gate passed
- [ ] BUILD gate passed
- [ ] EVAL gate passed (if applicable)

## Failure Handling

- [ ] All failures addressed at root cause (not suppressed)
- [ ] Any skipped gates listed with rationale (e.g., "gate unavailable — no tool found")
- [ ] Any new suppression annotations include an explanatory comment

---

Notes:

- Automated hooks (e.g., `quality-gate.js`) may enforce FORMAT and LINT after file edits. If present, those checks run automatically — still verify the output.
- "EVAL applicable" = change affects LLM output, ranking, visual output, or performance baseline. See `.omp/rules/harness-verification_tests_and_evals.md`.
