---
description: "Never guess build/test/lint commands: discover them from the repo (multi-repo safe default)"
---
# Repo Command Discovery (Multi-Repo Safe Default)

## MUST: never guess commands

Do not guess or invent repo commands for:

- build, test, lint, typecheck, e2e, eval, format

## MUST: discovery order (sources of truth)

Discover commands using concrete repo evidence in this order:

1) `package.json` → `scripts` (JS/TS)
2) `Makefile` / `justfile` / `taskfile.yml`
3) Python: `pyproject.toml` (tool config), `tox.ini`, `noxfile.py`, Poetry/uv configs
4) CI config (`.github/workflows/*`, `gitlab-ci.yml`, etc.) actual steps
5) README / CONTRIBUTING

## SHOULD: fast gate first

If the repo provides fast gates (`test:fast`, `test:unit`, `test:smoke`, `lint`, `typecheck`), run them first.

If only a full suite exists:

- Propose the smallest verification (single test / smoke subset) **but**
- Execute only commands that the repo already provides.

## If no commands exist

- You MAY propose adding standard scripts/targets.
- You MUST NOT add/invent scripts without explicit user approval.




