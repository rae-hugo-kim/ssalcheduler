#!/usr/bin/env bash
# harness-sync.sh [--dry-run]
# Overwrites local harness files from the source remote's latest harness/* tag.
# Used by /harness-check to retrofit unregistered projects or sync drifted ones.
# Policy: remote wins unconditionally. Local tuning is not preserved.

set -euo pipefail

# --- 0. Re-exec from a private temp copy (self-overwrite safety) ---
# Step 6 below overwrites whitelist PATHS in-place, and PATHS includes this
# script (scripts/harness-sync.sh). `cp` truncates the destination inode in
# place, so a shell still reading this file mid-run would execute garbage and
# the sync would fail or partially complete (recurring every harness-check
# because meta is never updated). Running from a throwaway copy makes the
# in-place overwrite of the on-disk script harmless to the live process, and
# still lets the script self-update in consumer repos.
#
# When we are the FETCHED script (step 4b handed off to us with
# _HARNESS_SYNC_FETCHED=1), we already run from the temp clone outside
# REPO_ROOT, so no self-copy is needed.
if [[ -z "${_HARNESS_SYNC_REEXEC:-}" && -z "${_HARNESS_SYNC_FETCHED:-}" ]]; then
  _self="$(mktemp)"
  trap 'rm -f "$_self"' EXIT   # cover the pre-exec window before _cleanup is registered
  cp "$0" "$_self"
  _HARNESS_SYNC_REEXEC=1 _HARNESS_SYNC_SELF="$_self" exec bash "$_self" "$@"
fi

# Initialize tmp empty BEFORE registering the trap: otherwise _cleanup's
# `rm -rf "${tmp:-}"` would expand an inherited lowercase `tmp` ENV var and
# delete it on an early exit (e.g. the self-skip path, where tmp is never
# assigned). The temp self-copy lives outside REPO_ROOT, so step 6's in-place
# overwrite never touches the running process.
tmp=""
tmp_owned=0
# Cleanup is deliberately conservative — it only removes paths THIS process
# created. $tmp is removed only when this process made it (tmp_owned=1; a
# hand-off child NEVER owns it — review 2026-09-05 M1/M2); the temp self-copy is
# removed only when _HARNESS_SYNC_SELF equals $0 (true after our own re-exec,
# where $0 IS the temp copy). That stops any forged environment from turning
# cleanup into an arbitrary `rm -rf` on self-skip / dry-run / any exit.
_cleanup() {
  [[ -n "${tmp:-}" && "$tmp_owned" == 1 ]] && rm -rf -- "$tmp"
  # The self-copy is only ever a mktemp file OUTSIDE the repository; a forged
  # _HARNESS_SYNC_SELF naming the tracked script must never delete it.
  if [[ -n "${_HARNESS_SYNC_SELF:-}" && "$_HARNESS_SYNC_SELF" == "$0" && -n "${REPO_ROOT:-}" ]]; then
    case "$(_realfile "$0" 2>/dev/null)/" in
      "$(_realdir "$REPO_ROOT" 2>/dev/null)"/*) : ;;   # inside the repo: refuse
      *) rm -f -- "$_HARNESS_SYNC_SELF" ;;
    esac
  fi
  return 0
}
trap _cleanup EXIT

# Portable canonical path (readlink -f is GNU-only; macOS < 13 lacks it).
_realdir() { (cd -- "$1" 2>/dev/null && pwd -P); }
_realfile() { local d; d="$(_realdir "$(dirname -- "$1")")" || return 1; printf '%s/%s\n' "$d" "$(basename -- "$1")"; }

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# --- 0b. Fetched-script fast path (#24) ---
# The local copy of this script resolved the remote, cloned the target tag, and
# then exec'd THIS file out of that clone (step 4b). Everything up to the clone is
# already done and handed over in the environment; the point of the hand-off is
# that the PATHS list below is the target tag's list, not the consumer's stale one.
#
# The environment is NOT trusted for cleanup: `tmp` (which the EXIT trap rm -rf's)
# is adopted only when this very script is running FROM inside it — i.e. $0 is
# <tmp>/scripts/harness-sync.sh and <tmp> is a git checkout of the named tag. A
# forged _HARNESS_SYNC_TMP pointing anywhere else fails the check and we exit
# without touching it (review 2026-09-05, M1).
if [[ -n "${_HARNESS_SYNC_FETCHED:-}" ]]; then
  _tmp_claim="${_HARNESS_SYNC_TMP:-}"
  latest_tag="${_HARNESS_SYNC_TAG:-}"
  target_sha="${_HARNESS_SYNC_SHA:-}"
  source_remote="${_HARNESS_SYNC_SOURCE:-}"
  REPO_ROOT="${_HARNESS_SYNC_REPO_ROOT:-}"
  _self_real="$(_realfile "$0" || true)"
  _tmp_real="$(_realdir "$_tmp_claim" || true)"
  _root_real="$(_realdir "$REPO_ROOT" || true)"
  if [[ -z "$_tmp_real" || -z "$_root_real" || "$_tmp_real" == "$_root_real" \
        || "$_self_real" != "$_tmp_real/scripts/harness-sync.sh" \
        || -z "$latest_tag" || -z "$target_sha" ]] \
     || ! git -C "$_root_real" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
     || [[ "$(git -C "$_tmp_real" rev-parse HEAD 2>/dev/null || true)" != "$target_sha" ]]; then
    echo "Error: fetched-script hand-off context is inconsistent; refusing to run (nothing removed)" >&2
    exit 1
  fi
  tmp="$_tmp_real"          # read-only for us: the parent process owns and removes it
  REPO_ROOT="$_root_real"
  META_FILE="$REPO_ROOT/.omp/extensions/harness/harness-meta.json"
  echo "Running harness/$latest_tag's own sync script"
fi

if [[ -z "${_HARNESS_SYNC_FETCHED:-}" ]]; then

REPO_ROOT="$(git rev-parse --show-toplevel)"
META_FILE="$REPO_ROOT/.omp/extensions/harness/harness-meta.json"
DEFAULT_SOURCE="git@github.com:rae-hugo-kim/omp.git"
# Anchor to a host/path boundary so e.g. `notrae-hugo-kim/omp.git` does NOT
# match and wrongly self-skip sync (codex review nit).
SOURCE_MATCH_RE='(^|[:/])rae-hugo-kim/omp(\.git)?$'

# --- 1. Detect source repo (self-skip) ---
origin_url=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)
if [[ "$origin_url" =~ $SOURCE_MATCH_RE ]]; then
  echo "This IS the source harness repo. Nothing to sync."
  exit 0
fi

# --- 2. Resolve source_remote (fallback to default if unregistered) ---
source_remote=""
if [[ -f "$META_FILE" ]]; then
  source_remote=$(grep -o '"source_remote"[[:space:]]*:[[:space:]]*"[^"]*"' "$META_FILE" \
    | sed 's/.*"source_remote"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
fi
if [[ -z "$source_remote" ]]; then
  echo "No source_remote in meta. Treating as unregistered — using default: $DEFAULT_SOURCE"
  source_remote="$DEFAULT_SOURCE"
fi
echo "Source: $source_remote"

# --- 3. Find latest harness/* tag on remote ---
latest_tag=$(git ls-remote --tags "$source_remote" 'refs/tags/harness/*' 2>/dev/null \
  | awk '{ print $2 }' \
  | sed 's|refs/tags/harness/||; s|\^{}$||' \
  | { grep -E '^[0-9]{4}\.[0-9]+$' || true; } \
  | sort -u -t. -k1,1n -k2,2n \
  | tail -1)

if [[ -z "$latest_tag" ]]; then
  echo "Error: no harness/* tags on $source_remote" >&2
  exit 1
fi
echo "Target: harness/$latest_tag"

# --- 4. Shallow clone the target tag into temp ---
tmp=$(mktemp -d); tmp_owned=1
# (removed by the _cleanup EXIT trap of THIS process — also after a hand-off child returns)
# Containment: a TMPDIR inside the repo (e.g. under checklists/) would let step 6 sweep the
# clone mid-copy and leave a partial sync (review 2026-09-05 r3).
case "$(_realdir "$tmp")/" in
  "$(_realdir "$REPO_ROOT")"/*) echo "Error: TMPDIR resolves inside the repository ($tmp); set TMPDIR outside it" >&2; exit 1 ;;
esac
git clone --quiet --depth 1 --branch "harness/$latest_tag" "$source_remote" "$tmp"
target_sha=$(git -C "$tmp" rev-parse HEAD)

# --- 4b. Hand off to the target tag's own copy of this script (#24) ---
# The whitelist PATHS below is versioned WITH the payload. Running the consumer's
# local (older) copy applies the OLD list to the NEW tag, so a whitelist entry
# added upstream lands one sync late — and meta is stamped current meanwhile, so
# the drift probe goes quiet about it. The fetched script is the same repo asset
# we are about to copy into place anyway; executing it a moment earlier widens no
# trust boundary. Guards: a fetched script never hands off again
# (_HARNESS_SYNC_FETCHED); a tag whose script predates this protocol (no fast
# path marker) is NOT exec'd — it would re-clone and leak $tmp — so we simply
# apply our own PATHS to it, exactly as before.
fetched="$tmp/scripts/harness-sync.sh"
if [[ -f "$fetched" ]] && ! cmp -s "$fetched" "$0" && grep -q '_HARNESS_SYNC_FETCHED' "$fetched"; then
  # Run the fetched script as a CHILD, not via exec: this process keeps owning $tmp and
  # the self-copy, so both are removed by our EXIT trap whether the child succeeds,
  # fails, or refuses its context — the child never deletes anything it did not make.
  _HARNESS_SYNC_FETCHED=1 _HARNESS_SYNC_TMP="$tmp" _HARNESS_SYNC_TAG="$latest_tag" \
  _HARNESS_SYNC_SHA="$target_sha" _HARNESS_SYNC_SOURCE="$source_remote" \
  _HARNESS_SYNC_REPO_ROOT="$REPO_ROOT" _HARNESS_SYNC_SELF="" _HARNESS_SYNC_REEXEC="" \
    bash "$fetched" "$@"
  exit $?
fi

fi  # end of local-script preamble (skipped on the fetched fast path)
# --- 5. Paths to overwrite (harness assets only — never user code) ---
# Directory entries are `rm -rf` + copy: ONLY harness-owned directories may appear as a
# directory (checklists/, templates/, .omp/extensions/harness, the harness skill
# dirs). Consumer extension points — .omp/rules/, .omp/RULES.md, custom .omp/agents/*.md,
# custom .omp/skills/<name>, docs/ — must never be swept, so anything living in a shared
# directory is listed file by file, or as a FILE GLOB with a literal harness- prefix
# (ADR 002 §1): every file matching the pattern is replaced (stale matches pruned first),
# siblings that do not match are never touched. Guarded by harness-wiring W3.
PATHS=(
  "checklists"
  "templates"
  # .omp/rules is consumer space (ADR 001 §3): harness rulebook files sync by prefix only.
  ".omp/rules/harness-*.md"
  "AGENTS.md"
  "INDEX.md"
  "EXAMPLES.md"
  ".omp/extensions/harness"
  ".githooks/pre-commit"
  ".githooks/post-commit"
  ".githooks/post-merge"
  ".githooks/pre-push"
  "scripts/harness-version-bump.sh"
  "scripts/harness-sync.sh"
  "scripts/harness-audit.sh"
  "scripts/test-harness-audit.sh"
  ".omp/skills/bootstrap"
  ".omp/skills/init"
  ".omp/skills/migrate"
  ".omp/skills/kickoff"
  ".omp/skills/startdev"
  ".omp/skills/sum"
  ".omp/skills/compr"
  ".omp/skills/compush"
  ".omp/skills/harness-check"
  ".omp/skills/receiving-code-review"
  ".omp/skills/brainstorm"
  ".omp/skills/design-mockup"
  ".omp/skills/grepai-search"
  ".omp/skills/gh-loop"
  ".omp/skills/gh-fanout"
  # .omp/agents — INDIVIDUAL FILES: consumers add their own agents next to these.
  ".omp/agents/adversary.md"
  ".omp/agents/code-reviewer.md"
  ".omp/agents/reviewer.md"
  ".omp/agents/verifier.md"
  # docs/rules harness contracts — INDIVIDUAL FILES on purpose: docs/ is consumer
  # project space, and a directory entry would rm -rf consumer-custom files there.
  # A new docs/rules contract in the source repo MUST be added here explicitly.
  "docs/rules/artifact_roles_contract.md"
  "docs/rules/closeout_contract.md"
  "docs/rules/glossary_policy.md"
  "docs/rules/kickoff_output_contract.md"
  "docs/rules/scope_self_detect_policy.md"
  "docs/rules/seed_contract.md"
  "docs/rules/seed_evolution_policy.md"
  "docs/rules/startdev_seed_contract.md"
  # 실전 절차 핸드북 — 원리 룰(.omp/rules/harness-prompt_engineering.md)의 짝. 개별 파일 등재 (docs/는 소비 레포 공간).
  "docs/prompt-writing-handbook.md"
  # kickoff/init 계약 템플릿·체크리스트 (#35-7) — .omp/skills/kickoff, init이 직접 참조하는 파일.
  # docs/rules와 같은 이유로 개별 파일 등재 (docs/templates·docs/checklists는 소비 레포 공간).
  "docs/templates/seed.template.yaml"
  "docs/templates/rubric-report.template.md"
  "docs/templates/kickoff-summary.template.md"
  "docs/templates/glossary.template.yaml"
  "docs/checklists/kickoff_rubric_checklist.md"
)
# Directories the harness used to ship as a whole and no longer does (ADR 002: rules/ became
# .omp/rules/harness-*.md). Step 7c retires a consumer's copy — only files provably ours.
RETIRED_DIRS=(rules)

# A glob entry is expanded against a tree root (nullglob). Output is NUL-framed: a consumer
# file whose NAME contains a newline would otherwise split into extra lines and the prune
# loop would rm -f whatever those lines spell (3-pass review 2026-09-26, high).
# Source side (default): regular files only, and the name must be plain [A-Za-z0-9._/-] —
# the manifest is serialised by awk on whitespace and the names are harness-authored, so a
# stray one is refused loudly rather than indexed wrongly.
# Prune side (mode "prune"): regular files AND symlinks of any kind (dangling, to a file, to
# a directory) — `rm -f` removes the link itself, never what it points at. A real directory
# is never emitted; the copy loop refuses to write into one.
# bash 3.2-safe on purpose (macOS consumers): no mapfile; `read -r -d ''` is 3.2 syntax.
is_glob() { [[ "$1" == *[\*\?\[]* ]]; }
plain_name() { [[ "$1" != *[!A-Za-z0-9._/-]* ]]; }
glob_expand() {  # glob_expand <root> <pattern> [prune|warn]  ->  NUL-separated relative paths
  ( cd "$1" 2>/dev/null || exit 0; shopt -s nullglob
    for f in $2; do
      if [[ "${3:-}" == prune ]]; then
        [[ -L "$f" || -f "$f" ]] && printf '%s\0' "$f"
      elif [[ -f "$f" && ! -L "$f" ]]; then
        if plain_name "$f"; then printf '%s\0' "$f"
        elif [[ "${3:-}" == warn ]]; then echo "warning: $f — name is not plain [A-Za-z0-9._/-]; not synced" >&2
        fi
      fi
    done; exit 0 )
}
# The consumer-side directory a glob entry lives in must resolve INSIDE the repo through
# real directories only (the leaf, every ancestor, and — when it does not exist yet — the
# nearest existing ancestor mkdir -p would build under). Through any symlink the prune/copy
# would act outside the checkout; a dangling link would abort the sync half way (set -e).
glob_dir_ok() {  # glob_dir_ok <root> <pattern>
  local root="$1" d="$1/${2%/*}" root_real
  root_real="$(_realdir "$root")" || return 1
  while [[ ! -e "$d" && ! -L "$d" && "$d" != "$root" && "$d" != "/" ]]; do d="$(dirname -- "$d")"; done
  [[ -d "$d" && ! -L "$d" ]] || return 1
  local d_real; d_real="$(_realdir "$d")" || return 1
  [[ "$d_real" == "$root_real" || "$d_real" == "$root_real"/* ]]
}

# Expanded whitelist (glob entries resolved against the source tree) — the single list the
# provenance tree AND the manifest are built from, so both always agree file for file.
# The two git calls that consume it run with `--literal-pathspecs`: an expanded name is a
# path, never a pattern (a literal "*" in a name must not re-glob inside git). The global
# option, not `:(literal)` magic — an ambient GIT_LITERAL_PATHSPECS=1 would take the magic
# prefix itself literally and record nothing — and the four GIT_*_PATHSPECS variables are
# cleared on those calls, since git refuses `--literal-pathspecs` next to an ambient
# GIT_GLOB_PATHSPECS / GIT_ICASE_PATHSPECS (rounds 3-4 review, measured).
git_literal() { GIT_LITERAL_PATHSPECS= GIT_GLOB_PATHSPECS= GIT_NOGLOB_PATHSPECS= GIT_ICASE_PATHSPECS= git --literal-pathspecs "$@"; }
present=()
for p in "${PATHS[@]}"; do
  if is_glob "$p"; then
    # `warn` here only: this is the one expansion pass that reports refused source names.
    while IFS= read -r -d '' f; do present+=("$f"); done < <(glob_expand "$tmp" "$p" warn)
  else
    [[ -e "$tmp/$p" ]] && present+=("$p")
  fi
done

if [[ $DRY_RUN -eq 1 ]]; then
  echo "--- Dry run: paths that would be overwritten ---"
  for p in "${PATHS[@]}"; do
    if is_glob "$p"; then
      if [[ -z "$(glob_expand "$tmp" "$p" | tr -d '\0')" ]]; then
        echo "  SKIP   $p (not in source)"
      elif ! glob_dir_ok "$REPO_ROOT" "$p"; then
        echo "  SKIP   $p (${p%/*} does not resolve to a plain directory inside this repo — not followed)"
      else
        while IFS= read -r -d '' f; do echo "  WRITE  $f"; done < <(glob_expand "$tmp" "$p")
        # PRUNE = present in the consumer but not among the ACCEPTED source matches (a refused
        # source name is pruned by the real run too).
        while IFS= read -r -d '' f; do
          [[ -f "$tmp/$f" && ! -L "$tmp/$f" ]] && plain_name "$f" || echo "  PRUNE  $f (no longer in source)"
        done < <(glob_expand "$REPO_ROOT" "$p" prune)
      fi
    elif [[ -e "$tmp/$p" ]]; then
      echo "  WRITE  $p"
    else
      echo "  SKIP   $p (not in source)"
    fi
  done
  for d in "${RETIRED_DIRS[@]}"; do
    [[ -d "$REPO_ROOT/$d" && ! -L "$REPO_ROOT/$d" && ! -e "$tmp/$d" ]] || continue
    echo "  RETIRE $d/ (files matching the previous synced harness tree, if one is recorded, are removed; others are kept with an advisory)"
  done
  exit 0
fi

# --- 5.6 Capture bootstrapped_at BEFORE the copy overwrites META_FILE ---
# Step 6 replaces .omp/extensions/harness/ wholesale, and META_FILE lives
# inside it. The source repo's meta has no bootstrapped_at (source self-skips
# sync), so reading after the copy always hits the date fallback and resets
# the first-registration timestamp on every sync.
bootstrapped_at=""
if [[ -f "$META_FILE" ]]; then
  bootstrapped_at=$(grep -o '"bootstrapped_at"[[:space:]]*:[[:space:]]*"[^"]*"' "$META_FILE" \
    | sed 's/.*"bootstrapped_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || true)
fi
[[ -z "$bootstrapped_at" ]] && bootstrapped_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# --- 6. Copy (remote wins) ---
for p in "${PATHS[@]}"; do
  if is_glob "$p"; then
    # Glob entry: skipped entirely when the source has no match (same as an absent directory
    # entry — never prune on an empty source); otherwise stale matches in the consumer go
    # first so a rule renamed or removed upstream does not linger as an orphan rulebook.
    [[ -n "$(glob_expand "$tmp" "$p" | tr -d '\0')" ]] || continue
    if ! glob_dir_ok "$REPO_ROOT" "$p"; then
      echo "warning: ${p%/*} does not resolve to a plain directory inside this repo (symlink or dangling link on the path) — skipping $p" >&2
      continue
    fi
    while IFS= read -r -d '' f; do rm -f "$REPO_ROOT/$f"; done < <(glob_expand "$REPO_ROOT" "$p" prune)
    while IFS= read -r -d '' f; do
      if [[ -d "$REPO_ROOT/$f" ]]; then
        echo "warning: $f is a directory in this repo — not replaced" >&2
        continue
      fi
      mkdir -p "$(dirname "$REPO_ROOT/$f")"
      cp "$tmp/$f" "$REPO_ROOT/$f"
    done < <(glob_expand "$tmp" "$p")
    continue
  fi
  [[ -e "$tmp/$p" ]] || continue
  mkdir -p "$(dirname "$REPO_ROOT/$p")"
  if [[ -d "$tmp/$p" ]]; then
    rm -rf "$REPO_ROOT/$p"
    cp -r "$tmp/$p" "$REPO_ROOT/$p"
  else
    cp "$tmp/$p" "$REPO_ROOT/$p"
    # `cp` PRESERVES an existing destination's mode, so a hook that is already present and
    # non-executable stays non-executable — and git skips non-executable hooks WITHOUT a
    # warning, silently disarming the only blocking surface (review round 2, measured).
    case "$p" in
      .githooks/*) chmod +x "$REPO_ROOT/$p" ;;
    esac
  fi
done

# --- 7. Rewrite harness-meta.json (bootstrapped_at captured in step 5.6) ---

src_desc=$(grep -o '"description"[[:space:]]*:[[:space:]]*"[^"]*"' "$tmp/.omp/extensions/harness/harness-meta.json" \
  | sed 's/.*"description"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo "")
today=$(date +%Y-%m-%d)

cat > "$META_FILE" <<EOF
{
  "version": "$latest_tag",
  "updated": "$today",
  "description": "$src_desc",
  "source_remote": "$source_remote",
  "commit_sha": "$target_sha",
  "bootstrapped_at": "$bootstrapped_at"
}
EOF

# --- 7b. Provenance: the synced tree in this repo's object store + a manifest ---
# Commit gates must not trust a worktree file for the sync exemption (review
# 2026-09-05, H1: a forged manifest could exempt any path). The AUTHORITY is a tree
# object written into THIS repo's object store from the tag checkout — exactly the
# whitelisted paths, with the tag's blobs and modes — and pinned by the ref
# refs/harness/<ver>. (A tag fetch is not usable here: the temp clone is shallow and
# git refuses to fetch shallow roots.) risk-assess.mjs compares a staged blob+mode
# against `git ls-tree refs/harness/<ver>`; forging that means writing blob/tree
# objects and moving the ref by hand — deliberate. The manifest below is an index
# for humans; the gate re-verifies its tree_sha against the ref before using it,
# and only accepts the HIGHEST refs/harness/* version, so a stale manifest cannot
# re-arm an older tree (downgrade). Exactly two refs are kept: the version just
# synced and the one before it (the gate needs the previous tree to recognise an
# upstream file removal). refs/harness/* is outside refs/tags, so
# `git push --follow-tags` never publishes it.
synced_tree=""
if gitdir="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir 2>/dev/null)"; then
  idx="$(mktemp)"; rm -f -- "$idx"
  # present[] was expanded above (step 5): glob entries are already concrete files.
  # GIT_WORK_TREE is pinned to the checkout: a consumer `core.worktree` must not
  # redirect what gets hashed (review 2026-09-05).
  if [[ ${#present[@]} -gt 0 ]] \
     && GIT_DIR="$gitdir" GIT_WORK_TREE="$tmp" GIT_INDEX_FILE="$idx" git_literal -C "$tmp" add -f -- "${present[@]}" 2>/dev/null \
     && synced_tree="$(GIT_DIR="$gitdir" GIT_WORK_TREE="$tmp" GIT_INDEX_FILE="$idx" git -C "$tmp" write-tree 2>/dev/null)" \
     && git -C "$REPO_ROOT" update-ref "refs/harness/$latest_tag" "$synced_tree" 2>/dev/null; then
    # Keep only the newest two versions (this one + the previous), drop the rest.
    while IFS= read -r ref; do
      [[ -n "$ref" ]] && git -C "$REPO_ROOT" update-ref -d "$ref" 2>/dev/null || true
    done < <(git -C "$REPO_ROOT" for-each-ref --format='%(refname)' 'refs/harness/' \
               | sed 's|^refs/harness/||' | grep -E '^[0-9]{4}\.[0-9]+$' | sort -t. -k1,1n -k2,2n \
               | awk '{ a[NR] = $0 } END { for (i = 1; i <= NR - 2; i++) print "refs/harness/" a[i] }')
  else
    synced_tree=""
    echo "warning: could not record the synced tree locally — sync commits will be scored without the provenance exemption" >&2
  fi
  rm -f -- "$idx"
fi
MANIFEST_FILE="$REPO_ROOT/.omp/extensions/harness/harness-manifest.json"
{
  printf '{\n  "version": "%s",\n  "commit_sha": "%s",\n  "ref": "refs/harness/%s",\n  "tree_sha": "%s",\n  "files": {\n' \
    "$latest_tag" "$target_sha" "$latest_tag" "$synced_tree"
  # Same expanded list as the provenance tree — a raw pathspec would let "*" cross "/" and
  # index files the tree does not carry (review 2026-09-26, medium).
  { [[ ${#present[@]} -gt 0 ]] && git_literal -C "$tmp" ls-files -s -- "${present[@]}" 2>/dev/null || true; } \
    | awk 'BEGIN { n = 0 } { printf "%s    \"%s\": \"%s\"", (n++ ? ",\n" : ""), $4, $2 }'
  printf '\n  }\n}\n'
} > "$MANIFEST_FILE"
# Retroactive init cleanup (#26): an init-created consumer still carries source-only
# assets that a sync never removes (they are outside the whitelist). Advise, never delete.
# Judged by SPECIFIC source files, never by directory: a consumer may keep its own notes
# under claudedocs/ or tests/, and those must not be flagged. `tests/harness-wiring.test.mjs`
# marks a copied harness test tree (the gate tests now live under .omp/extensions/harness/tests).
for stale in scripts/docs-drift claudedocs/CLAUDEKR.md claudedocs/CLAUDE_original.md \
             claudedocs/bootstrap_oh_my_claudecode.md claudedocs/agreements.md tests/harness-wiring.test.mjs; do
  [[ -e "$REPO_ROOT/$stale" ]] || continue
  echo "advisory: $stale exists — source-repo-only file copied by an older init; remove it (see .omp/skills/init Phase 2, step 5)"
done

# --- 7c. Retire directories the whitelist dropped (ADR 002: rules/ -> .omp/rules/harness-*.md) ---
# A directory the harness USED to ship is not swept any more once its entry leaves PATHS, so
# a consumer keeps an orphan copy. Remove only what the PREVIOUS synced tree proves was ours —
# files whose blob (hashed WITHOUT clean filters: a filter could make an edited file hash-equal;
# an autocrlf checkout therefore keeps its files and gets the advisory, never a wrong delete)
# equals that tree's blob — never a consumer-edited or consumer-added file, never through a
# symlink anywhere on the path, and never without that proof (advisory instead).
prev_ref=""
if [[ -n "$synced_tree" ]]; then
  prev_ref="$(git -C "$REPO_ROOT" for-each-ref --format='%(refname)' 'refs/harness/' \
    | sed 's|^refs/harness/||' | { grep -E '^[0-9]{4}\.[0-9]+$' || true; } | { grep -Fvx "$latest_tag" || true; } \
    | sort -t. -k1,1n -k2,2n | tail -n1)"
fi
for d in "${RETIRED_DIRS[@]}"; do
  [[ -d "$REPO_ROOT/$d" && ! -L "$REPO_ROOT/$d" ]] || continue
  [[ -e "$tmp/$d" ]] && continue   # still shipped by this tag: not retired
  removed=0
  if [[ -n "$prev_ref" ]] && git -C "$REPO_ROOT" rev-parse -q --verify "refs/harness/$prev_ref:$d" >/dev/null 2>&1; then
    # ls-tree -z entry: "<mode> <type> <sha>\t<path>" NUL-terminated (no C-quoting of odd names).
    while IFS=$'\t' read -r -d '' meta path; do
      sha="${meta##* }"; f="$REPO_ROOT/$path"
      [[ -f "$f" && ! -L "$f" ]] || continue
      [[ "$(_realfile "$f")" == "$REPO_ROOT/$path" ]] || continue   # an intermediate symlink: not ours to touch
      if [[ "$(git -C "$REPO_ROOT" hash-object --no-filters -- "$f")" == "$sha" ]]; then rm -f -- "$f"; removed=$((removed + 1)); fi
    done < <(git_literal -C "$REPO_ROOT" ls-tree -r -z "refs/harness/$prev_ref" -- "$d")
    find "$REPO_ROOT/$d" -depth -type d -empty -delete 2>/dev/null || true
    if [[ -d "$REPO_ROOT/$d" ]]; then
      echo "advisory: $d/ is no longer a harness directory (its rules now sync as .omp/rules/harness-*.md); $removed harness file(s) removed, the remaining files are not from a synced harness tree — review and remove them by hand. Project docs linking $d/<name>.md should point at .omp/rules/harness-<name>.md (see .omp/skills/migrate)."
    else
      echo "retired $d/: $removed harness file(s) removed (now .omp/rules/harness-*.md)"
    fi
  else
    echo "advisory: $d/ is not a harness directory any more (its rules sync as .omp/rules/harness-*.md) and no earlier synced harness tree attributes its files — if it is the harness copy from before that move, remove it by hand; if it is your own, ignore this. Project docs linking $d/<name>.md should point at .omp/rules/harness-<name>.md (see .omp/skills/migrate)."
  fi
done

# --- 8. Activate the synced hooks (#26) ---
# core.hooksPath is LOCAL git config: the copy in step 6 ships the hook files but
# cannot point git at them, so a consumer registered before bootstrap grew this
# step stays disarmed forever. Idempotent. Success is judged on the EFFECTIVE value
# git reports afterwards (a per-worktree override under extensions.worktreeConfig
# out-ranks the repo-local scope and would otherwise keep the hooks dead while we
# claim activation — review 2026-09-05).
hooks_status="hooksPath unchanged"
if [[ -d "$REPO_ROOT/.githooks" ]]; then
  current_hooks=$(git -C "$REPO_ROOT" config --get core.hooksPath 2>/dev/null || true)
  if [[ "$current_hooks" != ".githooks" ]]; then
    git -C "$REPO_ROOT" config core.hooksPath .githooks
    effective=$(git -C "$REPO_ROOT" config --get core.hooksPath 2>/dev/null || true)
    if [[ "$effective" == ".githooks" ]]; then
      hooks_status="hooksPath=.githooks (was: ${current_hooks:-unset})"
    else
      origin=$(git -C "$REPO_ROOT" config --show-origin --get core.hooksPath 2>/dev/null | cut -f1 || true)
      hooks_status="hooksPath STILL ${effective} (overridden by ${origin:-a higher-precedence scope}) — hooks are NOT active; fix that scope"
      echo "warning: $hooks_status" >&2
    fi
  fi
fi

# --- 9. Clear stale check caches ---
for cache in "$REPO_ROOT/.omp/state/harness-version-check.json" "$REPO_ROOT/.omp/state/harness-hooks-check.json"; do
  [[ -f "$cache" ]] && rm -f "$cache"
done

echo "Synced to harness/$latest_tag (SHA: ${target_sha:0:7}); $hooks_status"
