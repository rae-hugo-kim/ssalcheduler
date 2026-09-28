---
description: "Mechanisms for saving and restoring session state across compaction and session boundaries"
---
# Session Persistence

<!-- Inspired by ECC longform guide session storage patterns. Complements harness-context_management.md (WHEN/WHAT to compact) with HOW/WHERE to persist and restore. -->

## Purpose

Concrete mechanisms for saving and restoring session state across compaction events and session boundaries. `harness-context_management.md` governs when to compact and what to preserve; this file governs how to persist and where to store it.

---

## Persistence channels (what actually persists, and where)

Session state in this harness persists through three channels. Do **not** hand-author ad-hoc session-state files — that practice was never operationalized and the paths it named are owned by the runtime.

- **Durable narrative → `sum` skill → `docs/sum/`.** The intentional, human-judged session summary: decisions, fixes/troubleshooting, what worked, what failed, what remains. Manual (see Decision below). This is the primary "resume context" artifact.
- **Runtime state → OMP-owned session storage.** OMP persists full session history (messages, tool calls, resume state) under `~/.omp/agent/sessions/` automatically. That is OMP's namespace — do not write into it. Our harness's own state lives under `.omp/harness-state/` (see `harness-harness_integration_contract.md`).
- **Cross-session facts → auto-memory.** Durable user/project/feedback knowledge lives in the memory system, not in transient session files.

When capturing a phase boundary, fold the worked/failed/remaining detail into the `sum` summary — not a separate file.

---

## Decision: summarization stays manual (no compaction/turn-end auto-save)

We deliberately do **not** auto-summarize sessions **with an LLM** on compaction or turn end. Decided 2026-05-27 (Claude Code `PreCompact`/`Stop` era). **Correction (2026-06)**: OMP *does* expose these lifecycle events (`session.compacting` / `turn_end` / `session_shutdown`) — feasibility was never the blocker. The decision now rests purely on value-vs-noise: a full **LLM** auto-summary stays manual (Q1.4 — no event encodes "this thread is done *and* worth keeping"), while the **lightweight breadcrumb** mentioned below is now implemented (`breadcrumb-tracker`, no-LLM).

- **Compaction rarely happens.** In our usage a session seldom fills even ~50% of the context window, so a compaction-triggered save would almost never run — low value for the maintenance cost.
- **Session end is not machine-detectable.** Only the user decides when a coherent thread of work is "done." A turn-end trigger fires when the assistant finishes a turn, not when the user closes out a session, so turn-based auto-summary would misfire constantly.
- **The `sum` skill is manual by design.** Its value is the troubleshooting/decision narrative that is *not* already in git or the PR body; capturing that well requires the user's judgment about when the thread is complete.
- **Git-event triggers (push/merge) were considered and deferred.** `merge` is the only git event that means "this unit of work is accepted," but sessions and PRs are many-to-many, so a merge-triggered full summary would fragment or duplicate. **Update (2026-06)**: the lightweight breadcrumb alternative is now built — `breadcrumb-tracker` appends no-LLM breadcrumbs (commits, test PASS/FAIL, edited files) on `tool_result`, and `breadcrumb-surface` surfaces recent `docs/sum/` at `session_start`. The full LLM summary remains manual `sum`, now seeded by the breadcrumb.

If this is revisited, see `claudedocs/ecc_harness_analysis.md` (the original PreCompact proposal, Claude Code era) and `docs/architecture/harness-architecture.md` §4.3 G7/G8.

---

## SHOULD: Session-start context loading

The harness's `session_start` event surfaces relevant prior context: `harness-version-check.mjs` reports harness drift at session start, and OMP itself can resume a prior session from `~/.omp/agent/sessions/`. If resuming a specific thread, point yourself at the relevant `docs/sum/` summary rather than expecting an auto-loaded state file.

Keep loaded context minimal — only what's needed to resume, not full history.

---

## MAY: Dynamic system prompt injection

For mode-specific workflows, inject targeted context at session start:

```bash
# Load review-focused context (appended after the default prompt)
omp --append-system-prompt .omp/contexts/review.md

# Load research-focused context
omp --append-system-prompt .omp/contexts/research.md
```

Context files should be small (<100 lines) and focused on the specific workflow.

---

## MAY: Context aliases

Maintain named context profiles for common workflows:

| Alias | Context File | Use For |
|-------|-------------|---------|
| `dev` | `.omp/contexts/dev.md` | Active development (file paths, architecture) |
| `review` | `.omp/contexts/review.md` | Code review (standards, checklist refs) |
| `research` | `.omp/contexts/research.md` | Research mode (search patterns, MCP refs) |

---

## Relationship to Other Rules

- **`harness-context_management.md`**: Governs WHEN to compact and WHAT to preserve. This file governs HOW and WHERE.
- **`harness-learning_policy.md`**: Governs capturing reusable learnings. Session persistence covers the transient narrative (`sum` → `docs/sum/`); durable cross-session facts go to auto-memory.
- **`harness-hook_recipes.md`**: Provides the extension/gate mechanism; this file describes what to persist from those handlers.

---

## Self-Check

Before ending a session or compacting:

- [ ] Key decisions and file paths captured somewhere durable (not just in conversation memory)?
- [ ] Reusable facts pushed to auto-memory if they outlive this session?
- [ ] If the work thread is complete, run `/skill:sum` to write the worked/failed/remaining narrative to `docs/sum/` (manual — see Decision above)?
