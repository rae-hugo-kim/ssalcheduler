---
description: "Optional module for teams maintaining substantial docs: navigation and consistency rules"
---
# Documentation Policy (Optional Module)

This module is for teams that maintain substantial documentation and want consistent AI navigation.

## Language policy (token-efficient + human-readable)

### SHOULD: language split by audience

- Human-facing product docs (intent, behavior, user stories): **Korean**
- AI navigation / technical guidelines / index pages: **English**
- Code comments: **English**

### MUST: no emojis in markdown docs (if adopted)

- Do not add emojis to markdown documents.

## README.md vs INDEX.md

- `README.md`: for humans (purpose, usage, overview)
- `INDEX.md`: for AI (structure/navigation, what exists where)

## Encoding

- **UTF-8 (NO-BOM)** for docs by default.
- **.ps1** may use BOM when required by Windows tooling.
- Rationale: prevent commit message corruption and handle Korean text consistently across Windows tools.

## “latest-only” documentation policy (optional)

If adopted by the team:

- Keep docs strictly current; remove deprecated conventions and legacy guidance.
- When conventions change, you SHOULD record rationale in a Decision Log / ADR (so intent remains searchable).
- Rely on Git history for past versions instead of maintaining backward-compat notes in-docs.




