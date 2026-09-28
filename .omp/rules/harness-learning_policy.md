---
description: "How lessons from sessions are captured and promoted into durable rules"
---
# Learning Policy

<!-- Inspired by ECC continuous-learning-v2, which captures atomic "instincts"
     with confidence scoring, domain tagging, and scope (project vs global).
     That system promotes instincts to global when the same pattern appears in
     2+ projects with confidence >= 0.8. This policy governs when and how
     to capture learnings in this repo without requiring the full instinct system. -->

## MUST: capture learnings when any of these occur

- A debugging session resolves a non-obvious root cause
- A new pattern is discovered that contradicts prior assumptions
- The user explicitly corrects the agent's approach
- The same mistake occurs more than once

## MUST: good learning criteria — each learning MUST be

- **Atomic**: one insight, one trigger, one action
- **Evidence-based**: cite the source (file path + line, command output, or user correction)
- **Domain-tagged**: e.g., `[testing]`, `[git]`, `[typescript]`, `[debugging]`
- **Actionable**: a future agent can act on it without additional context

## SHOULD: choose the right storage tier

| Scope | Where to store |
|-------|---------------|
| Session-specific (ephemeral) | Session retro (`templates/session_retro.md`) |
| Cross-session, project-level | `MEMORY.md` in the repo root |
| Policy-level (recurring rule) | `.omp/rules/harness-*.md` (harness source repo) or a project `.omp/rules/<name>.md` — propose a rule update or new rule file |

## MUST NOT: capture anti-pattern learnings

- **Vague**: "things are complex", "be more careful" — too generic to act on
- **Unverified**: assumptions not confirmed by evidence or reproduction
- **Duplicate**: content already covered by existing docs — link instead of repeating

## Self-Check

- [ ] Is this learning specific enough that future-me can act on it without re-reading the whole session?
- [ ] Is there concrete evidence I can cite?
- [ ] Is it already captured elsewhere?
