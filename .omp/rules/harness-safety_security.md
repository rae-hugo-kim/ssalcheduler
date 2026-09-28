---
description: "Hard rails: actions that always need explicit user approval (secrets, destructive ops, prod)"
---
# Safety & Security (Hard Rails)

## MUST: explicit approval before risky/irreversible actions

Do not propose or execute any of the following without explicit user approval:

- Mass deletion or sweeping changes across the repo
- History rewrite, force push, reflog rewriting, destructive rebases
- Destructive database migrations/changes without a rollback plan
- Direct production changes or operating on production data
- Handling secrets/keys/credentials (creation, rotation, storage, logging)

## MUST: secret handling

- Treat `.env`, tokens, API keys, credentials as sensitive.
- Do not paste secrets into chat, PR descriptions, issues, commit messages, logs, or screenshots.
- If a secret is required for demonstration, use **redaction** and **minimal exposure** (show only structure, never the full value).

## SHOULD: least privilege + minimize blast radius

- Prefer read-only operations when exploring.
- Keep changes scoped to the smallest set of files needed.
- Prefer reversible changes; include rollback notes when impact is non-trivial.




