---
description: "What to review, severity classification and output format for code reviews"
---
# Code Review Policy

<!-- Harness: code-reviewer agent enforces this automatically -->

## Scope

This policy applies to all code reviews in this repo, whether performed by an agent or a human reviewer. It defines what to review, what to skip, how to classify findings, and what output format to use.

## MUST: confidence gating

- **MUST** only report a finding if you are >=80% confident it is a real problem.
- Low-confidence observations (50–79% confidence) MAY go in a separate **Notes** section and MUST be clearly labeled as speculative.
- **MUST NOT** flood a review with noise. Consolidate similar issues (e.g., "4 functions missing error handling" as one finding, not four).
- **MUST NOT** report issues in unchanged code unless they are CRITICAL security issues.
- **MUST NOT** report stylistic preferences already enforced by a formatter (whitespace, quote style, trailing commas).

## MUST: review scope

### In scope

- **Logic correctness** — edge cases, off-by-one errors, null/undefined safety, incorrect conditionals
- **Security** — injection, credential exposure, auth gaps, input validation, data leakage
- **Error handling** — unhandled rejections, swallowed exceptions, missing user-facing fallbacks
- **Naming** — clarity, consistency, domain appropriateness
- **Tests** — presence and adequacy of test coverage for changed code paths
- **Complexity** — function length, file length, nesting depth, cyclomatic complexity (see thresholds below)
- **Performance** — N+1 queries, unbounded loops, memory leaks, blocking I/O in async contexts

### Out of scope

- Stylistic preferences already handled by project formatters (Prettier, ESLint auto-fix rules)
- Unchanged code, unless a CRITICAL issue directly touches changed code
- Speculative future requirements not stated in the task

## Severity classification

| Severity | Definition | Merge gate |
|----------|------------|------------|
| **CRITICAL** | Security vulnerability, potential data loss, crashes in normal use, exposed secrets | Block — must fix before merge |
| **HIGH** | Definite bugs, performance regressions, missing error handling on failure paths | Warn — should fix before merge |
| **MEDIUM** | Maintainability problems, readability gaps, missing tests for new paths | Note — fix in follow-up acceptable |
| **LOW** | Minor suggestions, naming improvements, TODOs without tickets | Optional |

**Approval criteria:**

- **Approve**: no CRITICAL or HIGH findings
- **Warning**: HIGH findings only — may merge with documented caution
- **Block**: any CRITICAL finding — must resolve before merge

## Quantitative complexity thresholds

Exceeding any threshold is a **HIGH** finding unless a documented exception exists.

| Metric | Threshold | Guidance |
|--------|-----------|----------|
| Function length | 50 lines | Split into smaller, single-responsibility functions |
| File length | 800 lines | Extract modules by responsibility |
| Nesting depth | 4 levels | Use early returns, extract helpers, flatten conditionals |
| Cyclomatic complexity | ~10 per function | Functions with many independent paths are hard to test and reason about; break them apart |

Cyclomatic complexity is not always directly measurable; use judgment when a function has many branching paths (if/else chains, switch cases, nested loops).

## CRITICAL: security findings

Flag immediately — these can cause real damage:

- Hardcoded credentials, API keys, tokens, or connection strings in source
- SQL injection via string concatenation instead of parameterized queries
- XSS via unescaped user input rendered as HTML
- Path traversal via user-controlled file paths without sanitization
- CSRF on state-changing endpoints without CSRF protection
- Missing authentication or authorization checks on protected routes
- Sensitive data (tokens, passwords, PII) written to logs
- Known-vulnerable dependency versions

## HIGH: code quality findings

- Functions exceeding 50 lines — split by responsibility
- Files exceeding 800 lines — extract modules
- Nesting depth exceeding 4 levels — flatten with early returns or extracted helpers
- Debug logging (`console.log`, `print`, etc.) left in production paths
- Dead code: commented-out blocks, unused imports, unreachable branches
- Missing tests for new logic paths

### Silent failures (HIGH)

Errors that fail without an observable signal cause hidden data loss and untraceable bugs. Flag every instance. Authoring guidance counterpart: [`harness-coding_standards.md` §Explicit error handling](harness-coding_standards.md#must-explicit-error-handling).

| Pattern | Example | Why it matters |
|---|---|---|
| Empty catch | `try { ... } catch {}` / `except: pass` | Error fully swallowed; caller proceeds as if success |
| Swallowed exceptions | `catch (e) { return null }` without a documented null-vs-error contract | Failure becomes indistinguishable from "no result" |
| Dangerous fallback | DB unavailable → return `[]`; API failure → cached dummy without staleness signal | Silent data corruption or stale state propagation |
| Lost stack trace | `catch (e) { throw new Error('failed') }` (drops `e.cause`/original stack) | Root cause unrecoverable in logs |
| Unawaited promise | async function calling another async without `await` or `.catch` | Unhandled rejection; error never surfaces |
| Shell `exit 0` after error | script prints error then `exit 0`, or omits `set -e` | CI sees green; failure invisible |

Rule of thumb: every catch/except block must either (a) re-throw (preserving cause), (b) log AND return a typed failure result with a contract the caller checks, or (c) include a comment explaining why suppression is safe in this specific path.

## MEDIUM: maintainability findings

- Mutation of inputs where immutable alternatives exist
- Missing or inadequate test coverage for changed paths
- Naming that is unclear, inconsistent with the domain, or misleading
- Magic numbers without named constants
- TODOs/FIXMEs without issue references

## LOW: minor suggestions

- Non-blocking naming improvements
- Missing JSDoc for exported functions (when project convention requires it)
- Minor structural suggestions that do not affect correctness

## Output format

Each finding MUST follow this format:

```
[SEVERITY] Brief title
Location: path/to/file.ts:line
Description: What the problem is and why it matters.
Suggestion: Concrete fix or approach.
```

Example:

```
[CRITICAL] Hardcoded API key in source
Location: src/api/client.ts:42
Description: API key "sk-abc..." is hardcoded. It will be committed to git history and is irrecoverable once pushed.
Suggestion: Move to an environment variable (process.env.API_KEY) and add the key to .env.example with a placeholder.
```

Group findings by severity (CRITICAL first, LOW last). End every review with a summary table:

```
## Review Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0     | pass   |
| HIGH     | 1     | warn   |
| MEDIUM   | 2     | info   |
| LOW      | 0     | note   |

Verdict: WARNING — 1 HIGH issue should be resolved before merge.
```

If low-confidence observations exist, append them after the summary under a **Notes** heading, clearly labeled as speculative.

## SHOULD: project-specific conventions

When project conventions exist in `AGENTS.md` or linked rules, SHOULD check for adherence. Examples:

- Immutability requirements (spread over mutation)
- Database migration patterns
- Custom error classes or error boundary patterns
- State management conventions

When in doubt, match what the existing codebase does.

## SHOULD: AI-generated code addendum

When reviewing AI-generated changes, also check:

- Behavioral regressions and edge-case handling that AI commonly misses
- Security assumptions and trust boundaries
- Hidden coupling or accidental architecture drift
- Unnecessary complexity that increases cognitive load without benefit

## Self-check

- [ ] Confidence gate applied — no findings below 80% confidence
- [ ] Stylistic preferences excluded (formatter handles them)
- [ ] Findings consolidated (no duplicate same-category issues)
- [ ] Summary table included
- [ ] Verdict clearly stated
