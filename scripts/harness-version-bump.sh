#!/usr/bin/env bash
# harness-version-bump.sh [--dry-run]
#
# DELIBERATE harness version bump — run ONCE after a harness change lands on main
# (e.g. right after merging a harness PR), NOT as a per-commit hook. Bumps the
# version a single time for everything that changed since the last harness/* tag
# reachable from HEAD, so one logical change = one version (no per-commit churn).
#
# Idempotent: if no harness asset changed since that tag, it does nothing. Safe
# to run repeatedly.
#
# What it does (unless --dry-run): updates harness-meta.json, makes a dedicated
# `chore(harness): bump ...` commit (only the meta file), creates an annotated
# harness/<version> tag, and appends an audit-score row. It does NOT push — run
# `git push --follow-tags` yourself after reviewing.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown argument: $arg (only --dry-run is supported)" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
META_FILE="$REPO_ROOT/.omp/extensions/harness/harness-meta.json"

# Harness asset paths that warrant a version bump. Keep ALIGNED with the synced
# set in scripts/harness-sync.sh (PATHS): a change to anything consumers receive
# should produce a new version. Entries ending in "/" are directory prefixes;
# others are exact file paths. (Excludes docs-drift — not synced.)
HARNESS_PATHS=(
  "checklists/"
  "templates/"
  # aligned with harness-sync.sh: harness rulebook files in consumer-space .omp/rules sync by
  # prefix glob (ADR 002 §1) — dir exact, basename glob, never across "/".
  ".omp/rules/harness-*.md"
  "AGENTS.md"
  "INDEX.md"
  "EXAMPLES.md"
  ".omp/extensions/harness/"
  ".githooks/"
  "scripts/harness-version-bump.sh"
  "scripts/harness-sync.sh"
  "scripts/harness-audit.sh"
  "scripts/test-harness-audit.sh"
  ".omp/skills/"
  ".omp/agents/"
  # aligned with harness-sync.sh: docs/rules contracts sync as individual files;
  # the dir prefix here just makes ANY contract change trigger a version bump.
  "docs/rules/"
  "docs/prompt-writing-handbook.md"
  # kickoff/init 계약 템플릿·체크리스트 — harness-sync.sh에 개별 파일로 등재 (#35-7).
  "docs/templates/"
  "docs/checklists/"
)

# Literal path match (no regex): exact for file entries, prefix for "dir/" entries, and
# for glob entries the directory must match exactly while only the basename is a pattern.
is_harness_path() {
  local f="$1" p
  for p in "${HARNESS_PATHS[@]}"; do
    if [[ "$p" == */ ]]; then
      [[ "$f" == "$p"* ]] && return 0
    elif [[ "$p" == *[\*\?]* ]]; then
      [[ "${f%/*}" == "${p%/*}" && "${f##*/}" == ${p##*/} ]] && return 0
    else
      [[ "$f" == "$p" ]] && return 0
    fi
  done
  return 1
}

# --- 1. Comparison base: the latest harness/* tag REACHABLE FROM HEAD ---
# --merged HEAD avoids picking a higher tag that lives on a diverged branch.
last_tag="$(git -C "$REPO_ROOT" tag -l 'harness/*' --merged HEAD --sort=-v:refname | head -n1)"
if [[ -n "$last_tag" ]]; then
  base="$(git -C "$REPO_ROOT" rev-list -n1 "$last_tag")"
else
  base="$(git -C "$REPO_ROOT" hash-object -t tree /dev/null)" # empty tree: count initial content
fi

# --- 2. Did any harness asset change since the base? ---
changed_files="$(git -C "$REPO_ROOT" diff --name-only "$base" HEAD 2>/dev/null || true)"
changed=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if is_harness_path "$f"; then changed=1; break; fi
done <<< "$changed_files"

if [[ $changed -eq 0 ]]; then
  echo "Harness unchanged since ${last_tag:-the initial tree}; nothing to bump."
  exit 0
fi

# --- 3. Compute the new version from the BASE TAG (not the meta file) ---
# Sequencing off the tag keeps the version monotonic with the tags even if
# harness-meta.json was reverted/rewritten (e.g. by harness-sync). Fall back to
# the meta version only when there is no reachable tag.
if [[ -n "$last_tag" ]]; then
  base_version="${last_tag#harness/}"
else
  base_version="$(grep '"version"' "$META_FILE" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
fi
base_year="${base_version%%.*}"
base_seq="${base_version##*.}"
this_year="$(date +%Y)"
if [[ "$this_year" != "$base_year" ]]; then
  new_version="${this_year}.1"
else
  new_version="${base_year}.$((base_seq + 1))"
fi
tag_name="harness/${new_version}"
today="$(date +%Y-%m-%d)"

# --- 3a. Pre-flight: never mutate if the target tag already exists ---
if git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/${tag_name}" >/dev/null 2>&1; then
  echo "Tag ${tag_name} already exists; refusing to bump (resolve version drift first)." >&2
  exit 1
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "--- Dry run ---"
  echo "Base:            ${last_tag:-<empty tree>} (${base:0:9})"
  echo "Changed harness files since base:"
  while IFS= read -r f; do
    [[ -n "$f" ]] && is_harness_path "$f" && echo "  $f"
  done <<< "$changed_files"
  echo "Would bump:      ${base_version} -> ${new_version} (tag: ${tag_name})"
  exit 0
fi

# --- 4. Update harness-meta.json (version always increments -> never an empty commit) ---
sed -i \
  -e "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"version\": \"${new_version}\"/" \
  -e "s/\"updated\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"updated\": \"${today}\"/" \
  "$META_FILE"

# --- 5. Dedicated commit (meta file only — does not sweep other staged changes) ---
git -C "$REPO_ROOT" add "$META_FILE"
git -C "$REPO_ROOT" commit -m "chore(harness): bump version to ${new_version}" -- "$META_FILE"

# --- 6. Annotated tag (so `git push --follow-tags` picks it up) ---
git -C "$REPO_ROOT" tag -a "$tag_name" -m "harness ${new_version}"

echo "harness version bumped: ${base_version} -> ${new_version} (tag: ${tag_name})"
echo "Now push:  git push --follow-tags"

# --- 7. Append audit-score row (best-effort; failure must not block) ---
# Issue #11: track audit results over time, one row per harness/* version.
{
  scores_file="$REPO_ROOT/.omp/state/harness-scores.jsonl"
  mkdir -p "$(dirname "$scores_file")"
  audit_out="$(bash "$REPO_ROOT/scripts/harness-audit.sh" --root "$REPO_ROOT" --terse 2>/dev/null)"
  rubric_version="$(bash "$REPO_ROOT/scripts/harness-audit.sh" --rubric-version 2>/dev/null)"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s' "$audit_out" | TS="$ts" VERSION="$new_version" RUBRIC="$rubric_version" python3 -c '
import json, os, re, sys
total = None
by_cat = {}
for line in sys.stdin.read().splitlines():
    m = re.match(r"^\s*TOTAL:\s+(\d+)/\d+\s*$", line)
    if m:
        total = int(m.group(1)); continue
    m = re.match(r"^\s+(\w+):\s+(\d+)/10\s*$", line)
    if m:
        by_cat[m.group(1)] = int(m.group(2))
print(json.dumps({"ts": os.environ["TS"], "version": os.environ["VERSION"],
                  "rubric_version": os.environ["RUBRIC"], "total": total, "by_cat": by_cat}))
' >> "$scores_file"
  echo "harness audit recorded -> ${scores_file}"
} || true
