---
name: harness-check
argument-hint: "[--dry-run] [--audit]"
description: Check harness version drift and auto-sync from the source remote. Use when the user says "harness-check", "harness version", "하네스 버전", or wants to retrofit/update harness files from the source repo.
---

# Harness Check - Version Drift + Auto-Sync

## Goal

One command that both **reports drift** and **resolves it** by overwriting local harness files from the source remote. Remote wins unconditionally.

## Inputs

- `$ARGUMENTS` — the user-provided argument (appended as `User: <args>`):
  - (empty) — check + sync (default)
  - `--dry-run` — show what would be overwritten, no changes
  - `--audit` — also run a deterministic 7-category quality audit after sync

## Constraints

| Rule | Rationale |
|------|-----------|
| Source repo self-skip | If `origin` remote matches `rae-hugo-kim/omp`, this IS the source — nothing to do |
| Remote wins | Local tuning is explicitly out of scope; overwrite without merge |
| Whitelist only | Only harness asset paths are overwritten — user code (`docs/`, `src/`, etc.) is never touched |
| Preserve `bootstrapped_at` | Keep the original first-registration timestamp |

## Process

### 1. Detect mode

```bash
cat .omp/extensions/harness/harness-meta.json 2>/dev/null || echo "missing"
git remote get-url origin
```

| Mode | Condition |
|------|-----------|
| **source repo** | `origin` URL matches `rae-hugo-kim/omp` |
| **unregistered** | meta has no `source_remote` field (and origin doesn't match source) |
| **registered** | meta has `source_remote` field |

### 2. Run the sync script

```bash
bash scripts/harness-sync.sh [--dry-run]
```

The script:
- Self-skips in the source repo
- Falls back to `git@github.com:rae-hugo-kim/omp.git` if no `source_remote` (unregistered case)
- Fetches the latest `harness/*` tag from remote
- Shallow-clones that tag into a temp dir, then **hands execution to that tag's own `scripts/harness-sync.sh`** (#24) so the whitelist applied is the target version's, not the consumer's stale copy — a new whitelist entry lands on the first sync
- Overwrites whitelist paths (`.omp/rules/harness-*.md` (file glob — stale `harness-*` files pruned, other `.omp/rules/` files kept), `checklists/`, `templates/`, `AGENTS.md`, `.omp/extensions/harness/`, the four harness agents in `.omp/agents/` (per file — consumer agents next to them are kept), `.githooks/*`, `scripts/harness-*.sh`, harness skill dirs)
- Retires the legacy `rules/` directory (ADR 002): removes only files whose blob matches the previous synced tree (`refs/harness/<prev>`), keeps consumer-edited/added files with an advisory, and removes nothing when no previous tree is recorded — the advisory tells you to fix project docs that link `rules/<name>.md` (→ `.omp/rules/harness-<name>.md`, see the migrate skill)
- Rewrites `harness-meta.json` with new version/SHA + preserved `bootstrapped_at`
- Sets `core.hooksPath=.githooks` when `.githooks/` exists and git is not already pointing at it (idempotent). This is local git config that no file sync can carry, so a repo registered before `bootstrap` gained the step is otherwise disarmed forever (#26) — the `HARNESS HOOKS INACTIVE` session/turn notice from `harness-version-check.mjs` routes here.
- Clears the `harness-version-check` and `harness-hooks-check` caches

### 3. Report

| Outcome | Report |
|---------|--------|
| Source repo | "Source harness repo — no sync needed" |
| Unregistered → synced | "Retrofitted to harness/<version> from default source" |
| Registered, up to date | "Harness was already at latest (harness/<version>) — files re-synced anyway" |
| Registered, drift → synced | "Synced local <old> → remote <new>" |
| `--dry-run` | List of paths that would be overwritten (+ `RETIRE rules/` when a legacy copy would be retired) |
| Network failure | "Could not reach remote. Check `source_remote` URL and network" |

## Verification

```bash
cat .omp/extensions/harness/harness-meta.json
git config --get core.hooksPath   # → .githooks
git status --short
node --test .omp/extensions/harness/tests/*.test.mjs   # gate tests ship with the gates (#17)
```

Confirm `version`, `commit_sha`, `updated` reflect the remote's latest; review changes before committing.

### 4. Quality audit (when `--audit` flag passed)

After sync (or instead of it, if invoked separately), run the deterministic quality scorer:

```bash
bash scripts/harness-audit.sh           # full breakdown
bash scripts/harness-audit.sh --terse   # one-line per category + TOTAL
```

Outputs 7 categories × 0..10 (total 0..70):
- `tool_coverage`, `context_efficiency`, `quality_gates`, `memory_persistence`,
  `eval_coverage`, `security_guardrails`, `cost_efficiency`

Use the score to track harness quality across versions and to surface concrete gaps (each missing item is listed with its category).

## Error Handling

| Condition | Action |
|-----------|--------|
| `git clone` fails | Report network/auth error; do not touch local files |
| No `harness/*` tags on remote | Report error; do not touch local files |
| Source repo detected | Self-skip, exit 0 |
| Dry-run flag | Show paths, exit before any write |

## Notes

- This skill does **not** commit the synced files. After sync, review with `git status` and commit when ready.
- For scheduled drift detection (no sync), the `session_start` gate `harness-version-check.mjs` (run by the harness extension) continues to report drift at session start without acting.
