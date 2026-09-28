# gh-loop autonomous runtime (option A) — setup & instantiate-once

`gh-loop.yml` here is a **template**, not a live workflow. The harness ships it via `templates/` sync;
your project instantiates it once and then owns it. The reusable, **tested** decision logic lives in
`.omp/extensions/harness/gh-loop-runner.mjs` (synced wholesale); the workflow is thin glue.

Authoring (this template + helper + the gh-loop skill + guard policy) comes from the harness. The
**runtime is per-project** — you provide the runner, secrets, agent CLI, and a few decisions below.

## 1. Instantiate-once

Copy the template into your repo (do this ONCE; force-sync never touches your `.github/` copy):

```bash
mkdir -p .github/workflows
cp templates/github-workflows/gh-loop.yml .github/workflows/gh-loop.yml
```

(`init`/`migrate` may do this copy for you; after that the file is yours to tune.)

## 2. Self-hosted runner (required)

An autonomous agent with repo write **must not** run on GitHub-hosted runners. Provision a
self-hosted runner you control and set the job's `runs-on:` to its label(s). See GitHub's
"Adding self-hosted runners" docs.

## 3. Secrets & variables (per-project — never shipped by the harness)

| Kind | Name | Purpose |
|---|---|---|
| secret | `GH_TOKEN` | repo-scoped token (issues / PRs / contents) the loop acts with |
| secret | your model key(s) | e.g. `ANTHROPIC_API_KEY` for your agent CLI |
| var | `GH_LOOP_BOT_LOGIN` | the login your agent commits/comments as — used for **self-exclusion** so the loop never reacts to its own events |

## 4. Agent CLI (the one `INSTANTIATE:` hole)

The workflow's last step is a placeholder. Replace it with your **headless OMP/Claude-family agent
CLI** invocation — the agent must understand the gh-loop skill (it uses `issue://` and other OMP
resources). It reads `issue://<n>`, runs the chosen stage, and **never auto-merges**.

## 5. Per-project decisions

- **Trigger scope**: the template fires on `issues: [opened, labeled]` and `issue_comment: [created]`.
  Narrow if you only want resume automation (drop the `issues` trigger).
- **Permission threshold**: the helper requires **write+** (write/maintain/admin) to drive the loop.
  Tighten to maintain+/owner by editing `gh-loop-runner.mjs`'s `WRITE_PLUS` if your repo needs it.
- **Concurrency**: serialized per issue (`concurrency.group`) so events don't double-act — keep this.

## Safety (do not weaken)

- **Never auto-merge.** The decision helper returns only `start`/`resume`/`ignore`; the workflow has no
  `gh pr merge`. Merge stays human-approved inside the agent run (`.omp/skills/gh-loop/SKILL.md`).
- **Self-exclusion** via `GH_LOOP_BOT_LOGIN` + the agent's `<!-- gh-loop:* -->` comment marker prevents
  self-triggering loops.
- Untrusted event fields (comment body, labels) reach the helper via `env:`, never inlined into `run:`.

## Verify before relying on it

`gh-loop-runner.mjs` is unit-tested (`.omp/extensions/harness/tests/gh-loop-runner.test.mjs`). The **workflow itself runs only
on your runner** — the harness cannot live-verify it. Do a dry exercise on a throwaway private repo
(label a test issue, comment as a non-bot write+ user) before trusting it on a real repo.
