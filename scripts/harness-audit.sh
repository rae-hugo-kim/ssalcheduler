#!/usr/bin/env bash
# scripts/harness-audit.sh [--root PATH] [--terse]
#
# Deterministic 7-category quality audit of a harness layout.
# Each category scores 0..10 by checking file presence and content patterns.
# Total range: 0..70.
#
# Used by the harness-check skill to track quality over time.
# Output:
#   default — human-readable per-category breakdown + TOTAL line
#   --terse — TOTAL + one line per category, machine-parseable
#
# Categories (10 each):
#   tool_coverage          — agents, hooks, scripts, routing, model selection
#   context_efficiency     — context budget rules, session persistence, compaction
#   quality_gates          — review policy, verification, gate hooks
#   memory_persistence     — auto-memory, session state, summarization
#   eval_coverage          — eval templates, checklist, EDD content
#   security_guardrails    — security rules, destructive guard, mcp gate
#   cost_efficiency        — cost rules, model routing, token budget guidance

set -euo pipefail

# Rubric version: bump whenever scoring rules change (new category, threshold
# shift, weighting change). Consumers (e.g. harness-version-bump.sh) tag each
# stored audit row with this so series can be split on rule evolution.
RUBRIC_VERSION="3"

ROOT="$(pwd)"
TERSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      [[ $# -ge 2 ]] || { echo "Missing argument for --root" >&2; exit 2; }
      ROOT="$2"; shift 2;;
    --terse) TERSE=1; shift;;
    --rubric-version) echo "$RUBRIC_VERSION"; exit 0;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "Unknown flag: $1" >&2; exit 2;;
  esac
done

[[ -d "$ROOT" ]] || { echo "Root not a directory: $ROOT" >&2; exit 2; }

# --- helpers (read-only, deterministic) ---

# Returns 0 if path exists relative to ROOT.
exists() { [[ -e "$ROOT/$1" ]]; }

# Returns 0 if file contains pattern (fixed string, no regex).
has_pattern() {
  local file="$1" pat="$2"
  [[ -f "$ROOT/$file" ]] && grep -qF -- "$pat" "$ROOT/$file"
}

# Counts regular files in a directory (0 if absent).
count_files() {
  local dir="$ROOT/$1"
  [[ -d "$dir" ]] || { echo 0; return; }
  find "$dir" -type f 2>/dev/null | wc -l | tr -d ' '
}

# Greps a pattern across a glob, returns 0 if any match.
grep_any() {
  local pattern="$1"; shift
  local f
  for f in "$@"; do
    [[ -f "$f" ]] && grep -qF -- "$pattern" "$f" && return 0
  done
  return 1
}

# --- per-category check tables ---
# Each function appends "+N name" lines to a shared array DETAIL_<cat>
# and writes the integer score into SCORE_<cat>.

declare -a DETAIL_tool_coverage DETAIL_context_efficiency DETAIL_quality_gates
declare -a DETAIL_memory_persistence DETAIL_eval_coverage DETAIL_security_guardrails
declare -a DETAIL_cost_efficiency

SCORE_tool_coverage=0
SCORE_context_efficiency=0
SCORE_quality_gates=0
SCORE_memory_persistence=0
SCORE_eval_coverage=0
SCORE_security_guardrails=0
SCORE_cost_efficiency=0

award() {
  local cat="$1" pts="$2" label="$3"
  local -n score_ref="SCORE_$cat"
  local -n detail_ref="DETAIL_$cat"
  score_ref=$(( score_ref + pts ))
  detail_ref+=("+$pts $label")
}

skip() {
  local cat="$1" label="$2"
  local -n detail_ref="DETAIL_$cat"
  detail_ref+=("+0 $label (missing)")
}

emit_category() {
  local cat="$1"
  local -n score_ref="SCORE_$cat"
  local -n detail_ref="DETAIL_$cat"
  echo "## ${cat//_/ } : ${score_ref}/10"
  local line
  for line in "${detail_ref[@]}"; do
    echo "  $line"
  done
  echo ""
}

# --- 1. Tool Coverage ---
score_tool_coverage() {
  local agents
  agents=$(count_files ".omp/agents")
  # Rubric v2: the >=5 threshold encoded the retired MCP delegation matrix
  # (researcher/db-worker/refactorer/full-context, removed 2026-06 after zero
  # measured delegations). Full credit now means the verification pair
  # (reviewer + verifier) is present.
  if (( agents >= 2 )); then
    award tool_coverage 3 ".omp/agents/ has $agents agents (>=2; verification pair)"
  elif (( agents > 0 )); then
    award tool_coverage 1 ".omp/agents/ has $agents agents (<2)"
  else
    skip tool_coverage ".omp/agents/"
  fi

  if exists ".omp/extensions/harness/gates"; then
    award tool_coverage 2 ".omp/extensions/harness/gates/ present"
  else
    skip tool_coverage ".omp/extensions/harness/gates/"
  fi

  if (( $(count_files "scripts") >= 3 )); then
    award tool_coverage 2 "scripts/ has 3+ files"
  elif exists "scripts"; then
    award tool_coverage 1 "scripts/ exists, <3 files"
  else
    skip tool_coverage "scripts/"
  fi

  if exists ".omp/rules/harness-agent_routing.md"; then
    award tool_coverage 1 ".omp/rules/harness-agent_routing.md"
  else
    skip tool_coverage ".omp/rules/harness-agent_routing.md"
  fi

  if has_pattern "AGENTS.md" "model_routing" || has_pattern "AGENTS.md" "model routing"; then
    award tool_coverage 2 "AGENTS.md model_routing block"
  else
    skip tool_coverage "AGENTS.md model_routing block"
  fi
}

# --- 2. Context Efficiency ---
score_context_efficiency() {
  if exists ".omp/rules/harness-context_management.md"; then
    award context_efficiency 3 ".omp/rules/harness-context_management.md"
  else
    skip context_efficiency ".omp/rules/harness-context_management.md"
  fi

  if exists ".omp/rules/harness-session_persistence.md"; then
    award context_efficiency 2 ".omp/rules/harness-session_persistence.md"
  else
    skip context_efficiency ".omp/rules/harness-session_persistence.md"
  fi

  if grep -rqF ".omp/state" "$ROOT/AGENTS.md" "$ROOT/.omp/rules" 2>/dev/null; then
    award context_efficiency 2 ".omp/state referenced in .omp/rules/ or AGENTS.md"
  else
    skip context_efficiency ".omp/state reference"
  fi
}

# --- 3. Quality Gates ---
score_quality_gates() {
  if exists ".omp/rules/harness-code_review_policy.md"; then
    award quality_gates 2 ".omp/rules/harness-code_review_policy.md"
  else
    skip quality_gates ".omp/rules/harness-code_review_policy.md"
  fi

  if exists "checklists/code_review.md"; then
    award quality_gates 1 "checklists/code_review.md"
  else
    skip quality_gates "checklists/code_review.md"
  fi

  if compgen -G "$ROOT/.omp/extensions/harness/gates/acceptance-gate.*" >/dev/null 2>&1; then
    award quality_gates 2 "acceptance-gate gate"
  else
    skip quality_gates "acceptance-gate gate"
  fi

  if compgen -G "$ROOT/.omp/extensions/harness/gates/backpressure-gate.*" >/dev/null 2>&1; then
    award quality_gates 2 "backpressure-gate gate"
  else
    skip quality_gates "backpressure-gate gate"
  fi

  if exists ".omp/rules/harness-quality_gates.md"; then
    award quality_gates 1 ".omp/rules/harness-quality_gates.md"
  else
    skip quality_gates ".omp/rules/harness-quality_gates.md"
  fi

  if exists ".omp/rules/harness-verification_tests_and_evals.md"; then
    award quality_gates 2 ".omp/rules/harness-verification_tests_and_evals.md"
  else
    skip quality_gates ".omp/rules/harness-verification_tests_and_evals.md"
  fi
}

# --- 4. Memory Persistence ---
score_memory_persistence() {
  if exists ".omp/rules/harness-session_persistence.md"; then
    award memory_persistence 2 ".omp/rules/harness-session_persistence.md"
  else
    skip memory_persistence ".omp/rules/harness-session_persistence.md"
  fi

  if has_pattern "AGENTS.md" "auto memory" \
    || has_pattern "AGENTS.md" "MEMORY.md" \
    || has_pattern "AGENTS.md" "memory system"; then
    award memory_persistence 3 "AGENTS.md auto-memory references"
  else
    skip memory_persistence "AGENTS.md auto-memory reference"
  fi

  if grep -rqF ".omp/state/sessions" "$ROOT/AGENTS.md" "$ROOT/.omp/rules" 2>/dev/null; then
    award memory_persistence 2 ".omp/state/sessions referenced"
  else
    skip memory_persistence ".omp/state/sessions reference"
  fi

  # 'sum' skill mentioned in AGENTS.md or rules
  if grep -rqwF "sum" "$ROOT/AGENTS.md" 2>/dev/null \
    || grep -rqwF "sum" "$ROOT/.omp/rules" 2>/dev/null; then
    award memory_persistence 3 "sum skill referenced"
  else
    skip memory_persistence "sum skill reference"
  fi
}

# --- 5. Eval Coverage ---
score_eval_coverage() {
  if exists "templates/eval_definition.md"; then
    award eval_coverage 2 "templates/eval_definition.md"
  else
    skip eval_coverage "templates/eval_definition.md"
  fi

  if exists "templates/eval_report.md"; then
    award eval_coverage 2 "templates/eval_report.md"
  else
    skip eval_coverage "templates/eval_report.md"
  fi

  if exists "checklists/eval.md"; then
    award eval_coverage 2 "checklists/eval.md"
  else
    skip eval_coverage "checklists/eval.md"
  fi

  if has_pattern ".omp/rules/harness-verification_tests_and_evals.md" "Eval-Driven Development" \
    || has_pattern ".omp/rules/harness-verification_tests_and_evals.md" "EDD"; then
    award eval_coverage 2 "EDD section in verification rule"
  else
    skip eval_coverage "EDD section"
  fi

  if exists "eval"; then
    award eval_coverage 2 "eval/ runner directory"
  else
    skip eval_coverage "eval/ runner directory"
  fi
}

# --- 6. Security Guardrails ---
score_security_guardrails() {
  if exists ".omp/rules/harness-safety_security.md"; then
    award security_guardrails 2 ".omp/rules/harness-safety_security.md"
  else
    skip security_guardrails ".omp/rules/harness-safety_security.md"
  fi

  if exists ".omp/rules/harness-agent_security.md"; then
    award security_guardrails 2 ".omp/rules/harness-agent_security.md"
  else
    skip security_guardrails ".omp/rules/harness-agent_security.md"
  fi

  if compgen -G "$ROOT/.omp/extensions/harness/gates/destructive-guard.*" >/dev/null 2>&1; then
    award security_guardrails 3 "destructive-guard gate"
  else
    skip security_guardrails "destructive-guard gate"
  fi

  if compgen -G "$ROOT/.omp/extensions/harness/gates/mcp-gate.*" >/dev/null 2>&1; then
    award security_guardrails 2 "mcp-gate gate"
  else
    skip security_guardrails "mcp-gate gate"
  fi

  if grep -rqiF "secret" "$ROOT/.omp/rules" 2>/dev/null \
    || grep -rqiF "credential" "$ROOT/.omp/rules" 2>/dev/null; then
    award security_guardrails 1 "secret/credential keyword in .omp/rules/"
  else
    skip security_guardrails "secret/credential keyword"
  fi
}

# --- 7. Cost Efficiency ---
score_cost_efficiency() {
  if exists ".omp/rules/harness-cost_awareness.md"; then
    award cost_efficiency 3 ".omp/rules/harness-cost_awareness.md"
  else
    skip cost_efficiency ".omp/rules/harness-cost_awareness.md"
  fi

  if has_pattern "AGENTS.md" "model_routing" || has_pattern "AGENTS.md" "model routing"; then
    award cost_efficiency 3 "AGENTS.md model routing"
  else
    skip cost_efficiency "AGENTS.md model routing"
  fi

  if exists ".omp/rules/harness-context_management.md"; then
    award cost_efficiency 2 ".omp/rules/harness-context_management.md"
  else
    skip cost_efficiency ".omp/rules/harness-context_management.md"
  fi

  if grep -rqiF "token budget" "$ROOT/.omp/rules" 2>/dev/null \
    || grep -rqiF "token budget" "$ROOT/AGENTS.md" 2>/dev/null \
    || grep -rqiF "token-budget" "$ROOT/.omp/rules" 2>/dev/null; then
    award cost_efficiency 2 "token budget guidance"
  else
    skip cost_efficiency "token budget guidance"
  fi
}

score_tool_coverage
score_context_efficiency
score_quality_gates
score_memory_persistence
score_eval_coverage
score_security_guardrails
score_cost_efficiency

CATS=(tool_coverage context_efficiency quality_gates memory_persistence \
      eval_coverage security_guardrails cost_efficiency)

TOTAL=0
for cat in "${CATS[@]}"; do
  var="SCORE_$cat"
  TOTAL=$(( TOTAL + ${!var} ))
done

# --- output ---
if (( TERSE )); then
  for cat in "${CATS[@]}"; do
    var="SCORE_$cat"
    echo "  $cat: ${!var}/10"
  done
  echo "TOTAL: $TOTAL/70"
else
  echo "===== Harness Audit ====="
  echo "Root: $ROOT"
  echo ""
  for cat in "${CATS[@]}"; do
    emit_category "$cat"
  done
  echo "========================="
  echo "TOTAL: $TOTAL/70"
fi
