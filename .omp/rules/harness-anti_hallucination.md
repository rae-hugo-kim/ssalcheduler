---
description: "No guessing: find evidence or ask; cite file paths and command output for claims"
---
# Anti-Hallucination & Evidence

## MUST: do not guess

Do not invent:

- Versions, commands, scripts, CI steps
- APIs/options/flags/config keys
- File paths, directories, existing symbols

If something is unknown, either find evidence or ask clarifying questions.

## MUST: evidence ladder (in order)

For version-sensitive decisions or “what command do we run” questions, establish evidence in this order:

1) **Lockfiles / manifests / tool config**
2) **CI configuration** (actual executed steps)
3) **Repo docs** (README, CONTRIBUTING, ADRs)
4) **Official docs / library source** (direct doc reads, `librarian` agent) when external/library behavior matters

## MUST: cite evidence for key claims

When asserting any of the following, include evidence (file path + excerpt or command output):

- “We use X version”
- “The correct command is …”
- “This option is supported/deprecated”
- “This API exists”

## MUST: when blocked, follow Exception Protocol

If you cannot find evidence quickly:

- State what you checked
- Provide 2–3 safe next steps
- Ask for confirmation if any step increases risk

## Self-Check
- [ ] Did I cite evidence (file path / command output) for every key claim?
- [ ] Did I check the evidence ladder before asserting a version or command?


