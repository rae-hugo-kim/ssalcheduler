---
description: "When to compact long sessions, what to preserve, how to protect session-critical facts"
---
# Context Management

<!-- Inspired by ECC strategic-compact skill. Translates automated compaction triggers into agent policy. -->

## Purpose

Long sessions accumulate context that crowds out working memory. This policy governs when to compact, what to preserve, and how to protect session-critical facts — so context loss is deliberate, not accidental.

---

## Phase Transitions (when to compact)

Compact at logical boundaries, not at arbitrary size limits. The right moment is when a phase's output has been captured and its working details are no longer needed.

| Phase Transition | Action | Rationale |
|-----------------|--------|-----------|
| Exploration → Implementation | Compact exploration context | Research reads and dead-ends are bulky; the distilled output is key findings + file paths + architecture decisions |
| Implementation → Verification | Compact implementation details | What matters is what changed and what the tests expect, not the intermediate edits |
| Verification → Next task | Compact verification details | Carry forward only pass/fail results and any blockers; debug traces pollute unrelated work |
| After a failed approach | Compact dead-end reasoning | Clear the failed path before trying a new direction |
| Mid-implementation | Do NOT compact | Losing variable names, file paths, and partial state mid-task is costly |

**SHOULD** compact at phase boundaries proactively rather than waiting for auto-compaction to fire at an arbitrary point.

---

## What to Preserve During Compaction (MUST)

Before compacting, ensure the following survive — either written to a file, a notepad, or a `<remember>` tag:

- Active task description and its success criteria
- Key file paths and their roles in the change
- Architecture decisions made this session (especially "we chose X over Y because Z")
- Error patterns encountered and their resolutions
- User preferences expressed verbally (tone, style, scope constraints)
- Current todo list state (pending and in-progress items)

---

## What Can Be Safely Dropped

The following do NOT need to survive compaction:

- Full contents of files already read and edited (the path is sufficient; re-read if needed)
- Exploration dead-ends and rejected approaches
- Verbose command output (keep the summary: pass/fail, count, key lines)
- Intermediate reasoning that led to a final decision (keep the decision, not the chain)
- Tool call history and counts
- Stack traces already resolved

---

## Context Budget Guidance

### `<remember>` tags

**SHOULD** use `<remember>` tags for facts that are session-critical and not captured in a file:

```
<remember>Auth middleware expects req.user set by validateJWT — do not skip middleware order</remember>
<remember priority>Project uses pnpm, not npm — all install commands must use pnpm</remember>
```

Use `priority` variant for facts that must survive conversation compaction long-term.

**Do NOT use** `<remember>` for progress state — that belongs in the todo list.

### Front-loading

**SHOULD** front-load important context at the start of long messages rather than burying it at the end. Compaction summarizers weight earlier content more heavily.

### Notepad persistence

**MAY** use `.omp/notepads/{plan-name}/` for cross-session persistence:

| File | Use for |
|------|---------|
| `learnings.md` | Technical discoveries and patterns found this session |
| `decisions.md` | Architecture and design choices with rationale |
| `issues.md` | Known problems and workarounds |

Write to notepads before compacting when the information needs to survive beyond the current session.

---

## Startup Context Budget

Every MCP server registered in OMP's MCP config (see `omp://mcp-config.md`) and every discovered skill (`.omp/skills/`, plus OMC skills discovered from `~/.claude`) is listed in the system prompt at session start, consuming context before any work begins. Lazy-load pattern: keep rarely-used servers and skills dormant, activate on demand.

### Scripts: `~/.claude/scripts/`

**`mcp`** — MCP server on/off (registry: `~/.claude/scripts/mcp-registry.json`)

```
mcp ls                # show active/inactive servers
mcp on/off <name>     # enable/disable in ~/.claude.json
mcp reset             # keep only defaults (exa, supabase, context7)
```

> Note: the `mcp` script toggles Claude Code's `~/.claude.json`, which OMP does **not** read. For OMP sessions, register/deregister servers in OMP's own MCP config (`omp://mcp-config.md`).

**`skill`** — Skill on/off (archive: `~/.claude/skills-archive/`) — still effective under OMP, which discovers OMC skills from `~/.claude`

```
skill ls              # show active/archived skills
skill on/off <name>   # move between ~/.claude/skills/ and archive
skill reset           # keep only defaults
```

Changes take effect next session. When user requests a dormant server or skill (e.g. "serena 연결해", "copywriting 스킬 켜줘", "새 스킬 아카이브에 추가해줘"), run the appropriate script.

---

## Self-Check

Before compacting, ask: **"Am I about to lose context that I'll need in the next 5 minutes?"**

- [ ] Is the current todo list saved (in the `todo` tool or a file)?
- [ ] Are key file paths recorded (notepad, `<remember>`, or todo description)?
- [ ] Are in-session architecture decisions captured?
- [ ] Are user preferences expressed this session written down?
- [ ] Is there any partial implementation state that would be costly to reconstruct?

If any answer is yes, write that information down first, then compact.
