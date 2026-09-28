# INDEX.md (omp-template)

This folder contains a layered agent policy set (entry + modules + checklists + templates).

**Designed for**: Oh My Pi (OMP) environment (harness gates wired by the OMP extension `.omp/extensions/harness/index.ts`; OMC agents available via OMP's task tool).

## Quick Reference

- Principles & examples: [`EXAMPLES.md`](EXAMPLES.md)

## Entry points

- Agent policy (English): [`AGENTS.md`](AGENTS.md)
- Source-repo-only references (`claudedocs/` is not synced to consumer repos and `init` removes it; paths are plain text so consumers do not inherit dead links):
  - Korean mirror of the agent policy (reference only, marked stale): `claudedocs/CLAUDEKR.md`
  - Original long-form candidate (verbatim, reference only): `claudedocs/CLAUDE_original.md`
  - Bootstrap guide (legacy, see `/skill:bootstrap`): `claudedocs/bootstrap_oh_my_claudecode.md`

## Policy sync process

Run policy sync whenever `AGENTS.md` changes (same PR) and refresh both reference docs or explicitly mark them stale.

- Checklist: [`templates/policy_sync_checklist.md`](templates/policy_sync_checklist.md)
- References to sync (source repo only): `claudedocs/CLAUDEKR.md`, `claudedocs/CLAUDE_original.md`

## Navigation

- Rules: `.omp/rules/harness-*.md` (rulebook `rule://harness-<name>`; always-on core `rule://harness-core`)
- Checklists: [`checklists/INDEX.md`](checklists/INDEX.md)
- Templates: [`templates/INDEX.md`](templates/INDEX.md)
- Consumer extension points (survive `harness-check` sync): `.omp/rules/<name>.md` not named `harness-*` (native rule files, `alwaysApply`/`globs`), `.omp/RULES.md` (sticky; shadowed by a user-level `~/.omp/agent/RULES.md` — prefer an `alwaysApply` rule file), `.omp/agents/<custom>.md`, `.omp/skills/<custom>/` — see AGENTS.md "Consumer extension points". Never `.omp/AGENTS.md` (any non-empty file replaces the root policy at the same depth).
- Source repo only: project-specific examples `claudedocs/INDEX.md`, agreements / notes `claudedocs/agreements.md`


