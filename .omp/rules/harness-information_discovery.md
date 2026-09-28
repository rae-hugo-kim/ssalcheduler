---
description: "Breadth-first discovery of prior summaries, docs, decisions before concluding an artifact is absent"
---
# Information Discovery (Breadth-First)

The twin of [`harness-repo_command_discovery.md`](harness-repo_command_discovery.md): that file governs discovering **commands**; this one governs discovering **information artifacts** — prior summaries, docs, decisions, past work, "where is X / do we have any X".

## MUST: don't conclude from a narrow guess

A false negative is as wrong as a fabrication. Do **not** assert "there's no record of X", "we don't have X", or "X isn't documented" after checking only one likely spot. That is acting on insufficient search — the same failure as inventing a path, in the other direction.

## Decide: known path vs. class of artifact

- **Known single path** (the user named it, or you have a verified path) → just `read` it. No sweep needed.
- **A class/set, or path uncertain** ("all session summaries", "anything about X", "where did we decide Y") → you do **not** know the location. Run a breadth-first sweep *before* concluding.

The failure mode is treating the second case like the first: forming a hypothesis ("probably in `<dir>`"), checking only there, and stopping.

## MUST: breadth-first sweep order

When the target is a class or the path is uncertain:

1. **Global content grep** — `grep -rin "<keyword>" .` (ripgrep searches all text, incl. markdown/docs). Vary the keyword if the first term is a guess.
2. **Convention directories** — `ls` the places this repo keeps such artifacts: `docs/sum/` (session summaries), `docs/`, `claudedocs/`, `docs/architecture/`, `.omp/rules/`, `checklists/`, `templates/`.
3. **Filename/glob** — `find . -iname '*<term>*'` when you expect a name pattern, not body text.
4. Only after the sweep comes up empty may you state the artifact is absent — and then say *what you searched* (per [`harness-anti_hallucination.md`](harness-anti_hallucination.md) Exception Protocol).

## Delegate when the sweep is broad

For a sweep spanning many locations or naming conventions, delegate to the `Explore` agent (read-only, breadth-tuned) rather than burning main-context on serial greps.

## Self-Check

- [ ] Is the target a known path, or a class/uncertain location? (If the latter, did I sweep?)
- [ ] Before claiming "no X exists", did I run a global grep **and** check convention dirs?
- [ ] If still absent, did I state what I searched rather than just "not found"?
