# Research Before Implement

<!-- Inspired by ECC development-workflow.md. Run before any net-new implementation. -->

## Purpose

Avoid reinventing the wheel. Before writing new code, verify that no existing solution covers the requirement.

---

## Checklist

- [ ] **GitHub code search**: Run `gh search code` or `gh search repos` for existing implementations of the pattern/feature.
- [ ] **Package registries**: Search npm / PyPI / crates.io / Go modules for utility libraries that solve the problem.
- [ ] **Documentation search**: Use the `librarian` agent, official docs, or web search for prior art, official examples, or recommended patterns.
- [ ] **80% evaluation**: Does an existing solution cover 80%+ of the requirement? If yes, prefer adopting/adapting over writing net-new.
- [ ] **Source attribution**: If adopting external code, note the source URL and license.
- [ ] **Rejection rationale**: If writing net-new, document briefly why existing solutions were insufficient.

---

## When to Use

- Before implementing any non-trivial feature (>50 lines of new code).
- Before adding a new dependency (verify it's the right one).
- Before creating a new utility/helper (check if one exists in the codebase or ecosystem).

## When to Skip

- Trivial changes (rename, one-liner fix, config update).
- The solution is already known and confirmed by the user.
