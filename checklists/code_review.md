# Code Review Checklist

Quick-reference for code reviews. Full policy: [`.omp/rules/harness-code_review_policy.md`](../.omp/rules/harness-code_review_policy.md)

**Confidence gate**: only report findings you are >=80% confident are real problems. Put lower-confidence observations in a Notes section.

## Security (CRITICAL — block on any finding)

- [ ] No hardcoded credentials, API keys, tokens, or secrets
- [ ] No SQL injection (parameterized queries, not string concatenation)
- [ ] No XSS (user input not rendered as raw HTML without sanitization)
- [ ] No path traversal (user-controlled paths sanitized)
- [ ] Auth checks present on all protected routes/endpoints
- [ ] No sensitive data (passwords, tokens, PII) written to logs

## Logic (HIGH)

- [ ] Edge cases handled (empty input, null/undefined, zero, negative)
- [ ] No off-by-one errors in loops and index operations
- [ ] Null/undefined safety (no implicit derefs without guard)
- [ ] Conditionals correct (not accidentally negated, missing else branch)

## Error handling (HIGH)

Includes silent-failure patterns — see [`.omp/rules/harness-code_review_policy.md`](../.omp/rules/harness-code_review_policy.md#silent-failures-high) for full table.

- [ ] No unhandled promise rejections or unguarded async calls (missing `await` / `.catch`)
- [ ] No empty catch blocks (`catch {}` / `except: pass`) that silently swallow failures
- [ ] No swallowed exceptions returning `null`/`undefined` without a caller-checked contract
- [ ] No dangerous fallbacks (returning `[]`, cached dummy, or default on failure without staleness signal)
- [ ] No lost stack traces (re-thrown errors preserve `cause` / original stack)
- [ ] No shell scripts that print error then `exit 0` (use `set -e` or explicit non-zero exit)
- [ ] User-facing errors are clear and do not leak internal details
- [ ] Failure paths are tested or at minimum reachable
- [ ] Every catch/except block: re-throws, logs+returns typed failure, or has a "why safe" comment

## Performance (HIGH)

- [ ] No N+1 query patterns (data fetching inside loops)
- [ ] No unbounded loops or queries without limits on user-facing paths
- [ ] No obvious memory leaks (event listeners removed, subscriptions cleaned up)
- [ ] No blocking/synchronous I/O in async contexts

## Naming (MEDIUM)

- [ ] Names are clear and unambiguous at the call site
- [ ] Naming is consistent with the domain and existing conventions
- [ ] No single-letter variables outside trivial loop counters
- [ ] No magic numbers (use named constants)

## Tests (MEDIUM)

- [ ] New logic paths have corresponding tests
- [ ] Changed behavior reflected in updated tests
- [ ] No debug logging (`console.log`, etc.) left in production paths

## Complexity thresholds (MEDIUM — flag if exceeded)

- [ ] Functions <= 50 lines
- [ ] Files <= 800 lines
- [ ] Nesting depth <= 4 levels
- [ ] Cyclomatic complexity reasonable (~10 or fewer branches per function)

---

After review, record verdict:

```
| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL |       |        |
| HIGH     |       |        |
| MEDIUM   |       |        |
| LOW      |       |        |

Verdict: [APPROVE / WARNING / BLOCK]
```
