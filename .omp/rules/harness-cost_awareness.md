---
description: "Escalate model/effort tier only when the lower tier demonstrably cannot handle the task"
---
# Cost Awareness

<!-- Inspired by ECC cost-tracker hook, which logs per-session token counts and
     estimated USD cost (Haiku ~$0.8/$4.0 per 1M in/out, Sonnet ~$3/$15,
     Opus ~$15/$75) to ~/.omp/metrics/costs.jsonl. -->

## MUST: model selection — use the cheapest model that can do the job

| Tier | Model | Use for |
|------|-------|---------|
| Low | Haiku | Lookups, simple edits, formatting, grep/search, status checks |
| Mid | Sonnet | Standard implementation, debugging, feature work, code review |
| High | Opus | Complex reasoning, architectural decisions, security review, deep debugging |

Escalate to a higher tier only when the lower tier demonstrably cannot handle the task.

## SHOULD: track tokens and cost per eval run

- Note model, approximate token count, and estimated cost in eval reports.
- If a run is unexpectedly expensive, record why in the session retro.

## SHOULD: batch independent operations

- Prefer issuing multiple parallel tool calls in one response over sequential round-trips.
- Sequential calls accumulate per-request overhead; parallel calls share the same turn.

## SHOULD: avoid re-reading files already in context

- If a file was read earlier in the session, use that content rather than re-reading.
- Summarize large tool outputs before passing them to subsequent steps.

## Self-Check

- [ ] Am I using Opus for a Haiku-level task?
- [ ] Am I reading the same file multiple times in one session?
- [ ] Am I making sequential calls that could be parallelized?
