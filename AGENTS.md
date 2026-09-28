# AGENTS.md (Agent Rules - Layered)

This file is **always-on** agent policy. Keep it short.

## Navigation

- Start here, then use indexes:
  - `INDEX.md`
  - Harness rules: the `harness-*` rulebook (listed in every prompt; body via `rule://harness-<name>`, files under `.omp/rules/`). The always-on core is `rule://harness-core`.
  - `checklists/INDEX.md`
  - `templates/INDEX.md`

## Scope

- This policy applies to this repo/workspace when the agent is active.
- If a linked module conflicts with this file, **this file wins**.
- **This policy complements user-global rules** (OMP also discovers `~/.claude/CLAUDE.md` and OMC skills/agents) — it does not replace them.

## Ownership, precedence and jurisdiction

- `owner: global-harness` → enforced mechanically by the OMP harness extension. `owner: local-policy` → enforced by this repository's policy docs and review process. A `MUST` without an owner tag is `local-policy`.
- Conflict order: 1) system/developer/user instructions 2) global-harness requirements 3) repository-local policy 4) advisory guidance (`SHOULD`/`MAY`). When local policy and a global harness rule diverge, follow the harness rule and document the deviation.
- Jurisdiction: `.omp/rules/harness-*.md` are behavioral rails for how the agent works (all work in this repo); `docs/rules/` are output contracts for the mission/seed workflow (kickoff·startdev·closeout, only inside that workflow).

## Consumer extension points

This file, `.omp/rules/harness-*.md`, `checklists/`, `templates/`, `.omp/extensions/harness/`, the harness skills, and the four harness agents are **harness-owned**: `harness-check` overwrites them (remote wins) on every sync; directory entries are `rm -rf` + copy, and `.omp/rules/harness-*.md` is a file glob (stale `harness-*` files pruned, siblings untouched). A project built from this template keeps its own policy in the places the sync never touches:

|Need|Put it in|How OMP loads it|
|---|---|---|
|Project rules (prompting conventions, domain constraints)|`.omp/rules/<name>.md` — any name **not** starting with `harness-`|Native rule file: `alwaysApply: true` injects it every session; `globs`/`description` list it in the rulebook (`rule://<name>`); `condition` makes it a TTSR stream rule. Same medium as the harness rules, so the same visibility.|
|Short hard requirements that must stay visible in long sessions|`.omp/RULES.md`|Sticky rule converted to an always-apply rule named `RULES`. **Shadowed** when the user has `~/.omp/agent/RULES.md`: both sticky files carry the fixed name `RULES` and the user file wins the dedup (`omp://context-files.md`; 18.3.0 re-measured 2026-09-24 as coexisting on one machine, but portability is not guaranteed) — for requirements that must load on every machine use a project `.omp/rules/<name>.md` with `alwaysApply: true`, which is how the harness ships `harness-core`.|
|Project background and the project's own module index|`.omp/rules/<project>-context.md` with `alwaysApply: true`|Always-apply rule; coexists with this file. **Never create `.omp/AGENTS.md`** — the native provider (priority 100) *replaces* this `AGENTS.md` at the same depth (any non-empty file, even a lone newline — measured on omp 18.1.14/18.2.5, 2026-09-23 and re-measured on 18.3.0, 2026-09-24), so every harness MUST silently drops out of the session. The session-start probe emits `HARNESS POLICY SHADOWED` (once per 24h, `--force` to repeat) while the file exists.|
|Custom agents / skills|`.omp/agents/<custom>.md`, `.omp/skills/<custom>/`|Discovered like the harness ones; the sync lists harness agents and skills per file/dir and does not sweep siblings.|

Precedence: a project rule in `.omp/rules/` or `.omp/RULES.md` is the **local specialization** of this policy and wins over a linked module on the same topic; only this file's MUSTs (safety, gates, verification) are not overridable that way. Never name a project rule `harness-*` and never add project files under `.omp/agents/` harness names or the harness skill directories — they are deleted or overwritten on the next sync.

## Harness Enforcement (OMP)

This repo ships its own enforcement layer as an **OMP extension**. The following are enforced automatically:

|What|How|Location|
|---|---|---|
|Pre-edit file read|`context-gate` + `read-tracker` + `write-tracker` gates|`.omp/extensions/harness/gates/`|
|Commit acceptance criteria|`acceptance-gate` (via `commit-gates` dispatcher, run by `.githooks/pre-commit`)|`.omp/extensions/harness/gates/`, `.githooks/`|
|Backpressure on failures|`backpressure-gate` + trackers|`.omp/extensions/harness/gates/`|
|Risky review threshold|`review-gate` (via `commit-gates` dispatcher, run by `.githooks/pre-commit`)|`.omp/extensions/harness/gates/`, `.githooks/`|
|Destructive command warnings|`destructive-guard`|`.omp/extensions/harness/gates/`|
|New work detection|`kickoff-detector`|`.omp/extensions/harness/gates/`|
|Code changes review/verification|`reviewer` / `verifier` agents via the `task` tool|`.omp/agents/`|
|Session breadcrumb capture (non-blocking)|`breadcrumb-tracker` + `breadcrumb-surface`|`.omp/extensions/harness/gates/`|
|Mermaid syntax in saved `.md` (non-blocking)|in-process `mermaid-check` via OMP bundled parser|`.omp/extensions/harness/mermaid-check.ts`|
|Local archive leak prevention (commit BLOCK / push BLOCK)|`archive-guard` (via `commit-gates`) + `.githooks/pre-push` + `compush`/`compr` pre-push checks|`.omp/extensions/harness/gates/`, `.githooks/`|
|Commit-gate bypass declaration|`commitBypassTripwire` in `index.ts` (`--no-verify`/`-n`, `core.hooksPath`, `--git-dir`/`--work-tree`, retargeting `GIT_*`)|`.omp/extensions/harness/gates/git-commit-detect.mjs`|
|Ungated-commit observation (non-blocking)|`.githooks/post-commit` + `.githooks/post-merge` advisories|`.githooks/`|

Commit enforcement runs at git's own boundary: **`.githooks/pre-commit`** invokes the `commit-gates`
dispatcher in hook mode, so the four commit gates judge the staged index of the repo actually being
committed to — for every spelling, and for human commits as well as agent ones. `core.hooksPath` must
point at `.githooks` (bootstrap/migrate set it). The command layer keeps only the bypass tripwire above.
Integration paths (merge auto-commits, cherry-pick, revert, rebase) are deliberately not blocked — they
move commits that were already gated at their origin — and the post-commit/post-merge advisories observe
them. Every other gate is wired by `.omp/extensions/harness/index.ts` (OMP events: `tool_call`,
`tool_result`, `before_agent_start`, `session_start`). Gates require `node` on PATH; the pre-commit hook
**fails closed** without it (`OMP_NODE_BIN` is the escape hatch for nvm/GUI/cron environments), while the
in-process mermaid check needs no node. Known residuals (sparse-checkout, `stash`, `--no-verify`,
out-of-jurisdiction repos) are enumerated in `rule://harness-harness_integration_contract` ([`.omp/rules/harness-harness_integration_contract.md`](.omp/rules/harness-harness_integration_contract.md)).

OMC relationship: OMC agents and skills installed under `~/.claude` are discovered by OMP and usable via the `task` tool; OMC's hook automation (magic keywords, system-reminder injection) does **not** run under OMP — this extension replaces it for repo-level gating.

**What this file adds**: Project-specific constraints, evidence standards, and documentation requirements.

## Terminology (RFC 2119)

- **MUST**: required. If you cannot comply, follow the Exception Protocol.
- **SHOULD**: default expectation; may be skipped with a short rationale.
- **MAY**: optional.

## Priority Order (Conflict Resolution)

1) **Safety & Security**
2) **Repo Truth** (lockfiles / manifests / CI / repo docs)
3) **Verification** (tests/evals/replicable steps)
4) **Change Control** (minimal change, scoped diffs)
5) **Maintainability** (readability, tidy refactors)

## Core Principles

### 1. Think Before Coding
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- → Detail: `rule://harness-anti_hallucination`

### 2. Simplicity First
- No features beyond what was asked. No abstractions for single-use code.
- If you write 200 lines and it could be 50, rewrite it.
- Self-check: "Would a senior engineer say this is overcomplicated?"
- → Detail: `rule://harness-change_control`

### 3. Surgical Changes
- Edit only lines that trace directly to the user's request.
- Match existing style. Don't "improve" adjacent code.
- If you notice unrelated issues, mention them — don't fix them.
- → Detail: `rule://harness-change_control`

### 4. Goal-Driven Execution
- Transform vague tasks into verifiable goals with success criteria.
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- Each step should have: [action] → verify: [check]
- → Detail: `rule://harness-verification_tests_and_evals`, `rule://harness-tdd_policy`

## Non-Negotiables (MUST)

The behavioral MUSTs that must survive long sessions — no guessing, risky-action approval, evidence citation, scope self-detection, cycle intake, the human-facing writing register — are carried by the always-on rule `rule://harness-core` ([`.omp/rules/harness-core.md`](.omp/rules/harness-core.md)) and detailed in the rulebook. This file adds the repo-specific ones:

- **Repo commands**: do not guess build/test/lint/typecheck/e2e/eval commands. Discover them (`rule://harness-repo_command_discovery`).
- **Verification**: every user-impacting change must include at least one reproducible verification artifact (`rule://harness-verification_tests_and_evals`).
- **Docs/policy-only mode**: for pure markdown/policy/template edits, follow the docs-only verification path in `rule://harness-verification_tests_and_evals` and include its required evidence format.
- **Reference doc sync (source repo only)**: in the omp source repo, update `claudedocs/CLAUDEKR.md` (Korean mirror of this file) in the same PR or explicitly mark it as stale. `source_commit_hash` is the last commit that touched AGENTS.md, so re-stamp the mirror to `status: synced` in a follow-up commit that does not touch AGENTS.md (the same commit can never match). Consumer repos have no such mirror (`claudedocs/` is not synced; an older `init` may have left a stale copy — delete it, it is not maintained).
- **Scope self-detection (L1)** and **Cycle intake (L1)**: see `rule://harness-core`; contracts in [`docs/rules/scope_self_detect_policy.md`](docs/rules/scope_self_detect_policy.md) and `rule://harness-cycle_definition` (mechanical backstop = `acceptance-gate`).

## Completion Contract (MUST)

A "done" report carries the three sections defined in `rule://harness-core`: applied rules/checklists, evidence (file paths + excerpts or command output), verification (what was run and the results). Independent completion verification is delegated to the `verifier` agent (`.omp/agents/verifier.md`) via the `task` tool; declare done only after its verdict has arrived.

## Exception Protocol (MUST when blocked)

If you cannot comply with any MUST:

1) State **why** (what constraint prevents compliance).
2) Provide **2–3 alternatives** (safe options only).
3) Ask for **explicit confirmation** if any alternative is risky or irreversible.

## MCP Server Policy (Trigger-based)

- See `rule://harness-mcp_policy` for full policies on all MCP servers. Servers are registered in OMP's MCP config (`omp://mcp-config.md`).
- **External library/API truth**: use the `librarian` agent (source-reading) or direct official-doc reads. (Context7 policy retired 2026-08-26 — see `rule://harness-mcp_policy`.)
- **Supabase**: MUST use migrations for DDL; MAY use direct SQL for queries.
- **Web Search**: SHOULD use for current events, errors, latest docs.

## Agent Routing Policy (Trigger-based)

- See `rule://harness-agent_routing` for full routing rules
  (incl. the 2026-06 retirement of the unused MCP delegation matrix).
- **reviewer**: SHOULD delegate for **high/critical-risk** changes (per `risk-assess`: security/auth/migration files touched, or >100 changed lines of code). Low/medium-risk changes need self-review only — no extra spawn. 3-pass adversarial (self + heterogeneous adversary + code-reviewer, all three defined in `.omp/agents/` — no external plugin required; the reviewer nest-spawns Pass 2/3 via its `spawns:` frontmatter). This matches what `review-gate` enforces: machine evidence is a strict JSON tuple sidecar (`docs/reviews/review-<ts>.json`, `["omp-review-evidence/v1", <hash>, <verdict>, <models|null>, <human|null>, <reviewer>]` — the gate never parses markdown), with second-perspective evidence (a MEASURED >=2-family models array, or a human identity) required only for high/critical commits; the only bypass is an audited override (`docs/harness/review-skip` with `["omp-review-override/v1", <reason>, <approved_by>, <hash>]`, recorded to `docs/harness/audit.jsonl` and consumed). **Dispatch preflight (MUST)**: before spawning the reviewer, verify your own depth and `task`-tool availability — the reviewer needs the `task` tool for Pass 2/3 (recursion cap: depth <= 1), and a session without the `task` tool must not run the review in-session (entry-point priority: `rule://harness-agent_routing`).
- **verifier**: MUST delegate before claiming task completion when AC exists. The `task` spawn is non-blocking (async job delivery) — **spawning is not completing; declare done only after the verifier's verdict has actually arrived.**

## Linked Modules

Each harness rule is a rulebook entry (`rule://harness-<name>`) and a file (`.omp/rules/harness-<name>.md`; e.g. [`.omp/rules/harness-writing_style.md`](.omp/rules/harness-writing_style.md)).

- Core rails: `harness-safety_security`, `harness-agent_security`, `harness-anti_hallucination`, `harness-repo_command_discovery`, `harness-information_discovery`
- Quality rails: `harness-coding_standards`, `harness-verification_tests_and_evals`, `harness-change_control`, `harness-tdd_policy`, `harness-code_review_policy`, `harness-quality_gates`, `harness-writing_style`, `harness-prompt_engineering`, `harness-design_contract`
- Tool rails: `harness-mcp_policy`, `harness-hook_recipes`
- Process rails: `harness-assetization`, `harness-commit_and_pr`, `harness-cycle_definition`, `harness-harness_integration_contract`, `harness-adversarial_review`, `harness-agent_routing`
- Operational rails: `harness-context_management`, `harness-session_persistence`, `harness-cost_awareness`, `harness-learning_policy`
- Optional: `harness-documentation_policy`, `harness-doc_standards`

- Artifact roles (seed/scope/audit 3-tier): [`docs/rules/artifact_roles_contract.md`](docs/rules/artifact_roles_contract.md)
- Scope self-detect policy (L1): [`docs/rules/scope_self_detect_policy.md`](docs/rules/scope_self_detect_policy.md)

## Checklists (Use as needed)

- Planning: [`checklists/plan.md`](checklists/plan.md)
- Verification: [`checklists/verify.md`](checklists/verify.md)
- Risky actions: [`checklists/risky_actions.md`](checklists/risky_actions.md)
- Bugfix protocol: [`checklists/bugfix.md`](checklists/bugfix.md)
- PR body: [`checklists/pr.md`](checklists/pr.md)
- Code review: [`checklists/code_review.md`](checklists/code_review.md)
- Quality gate: [`checklists/quality_gate.md`](checklists/quality_gate.md)
- Eval (EDD): [`checklists/eval.md`](checklists/eval.md)
- Research before implement: [`checklists/research_before_implement.md`](checklists/research_before_implement.md)

## Templates

- Assumptions: [`templates/assumptions.md`](templates/assumptions.md)
- Change log: [`templates/decision_log.md`](templates/decision_log.md)
- PR description: [`templates/pr_body.md`](templates/pr_body.md)
- Retro note: [`templates/retro.md`](templates/retro.md)
- Eval definition: [`templates/eval_definition.md`](templates/eval_definition.md)
- Eval report: [`templates/eval_report.md`](templates/eval_report.md)
- Session retro: [`templates/session_retro.md`](templates/session_retro.md)
