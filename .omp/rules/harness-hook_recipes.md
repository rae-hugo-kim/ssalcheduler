---
description: "Ready-to-use OMP extension recipes for automatic quality enforcement"
---
# Hook Recipes

<!-- Inspired by ECC hooks system. Complements harness-harness_integration_contract.md (verification gates) with creation guidance and ready-to-use recipes. -->

## Purpose

Concrete, ready-to-use OMP extension recipes for enforcing code quality automatically. Adapt commands to your project's actual toolchain (see `harness-repo_command_discovery.md`).

An OMP extension is a TypeScript module under `.omp/extensions/` that exports a default function receiving the extension API (`pi`) and subscribes to events with `pi.on(...)`.

---

## Event Types

| Event | When | Can Block? | Use For |
|------|------|------------|---------|
| `tool_call` | Before a tool executes | Yes (`return { block: true, reason }`) | Prevent dangerous operations |
| `tool_result` | After a tool completes (success or `isError: true`) | No | Analyze output, auto-format, warn |
| `before_agent_start` | User prompt submitted, before the agent runs | No (may inject a message) | Detect patterns, inject reminders |
| `session_start` | Session begins | No | Load context, detect environment |

**Blocking**: only a `tool_call` handler can block, by returning `{ block: true, reason: "..." }`. Handlers for other events return advisory output (or nothing).

**Event payload** (`tool_call` / `tool_result`):

```ts
{
  toolName: "edit" | "write" | "bash" | "read" | ...,
  input: { command?, file_path?, content?, ... },
  isError?: boolean,  // tool_result only: true when the TOOL failed — bash reports a non-zero command exit via details.exitCode with isError still false
  details?: object    // tool_result only: structured result data (e.g. bash details.exitCode)
}
```

Handlers also receive a context object (`ctx`) with `ctx.cwd` and optional UI access.

---

## Recipe 1: Block large file creation (tool_call)

Prevents creating files over 800 lines. Enforces the file size limit from `harness-coding_standards.md`.

```ts
export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "write") return;
    const lines = String(event.input?.content ?? "").split("\n").length;
    if (lines > 800) {
      return { block: true, reason: `BLOCKED: file exceeds 800 lines (${lines}). Split into smaller, focused modules.` };
    }
  });
}
```

## Recipe 2: Warn on TODO/FIXME additions (tool_result)

Non-blocking warning when new TODO/FIXME comments are added.

```ts
export default function (pi) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit" || event.isError) return;
    const patch = String(event.input?.input ?? event.input?.content ?? "");
    if (/TODO|FIXME|HACK/.test(patch)) {
      pi.logger?.warn?.("New TODO/FIXME added - consider creating an issue");
    }
  });
}
```

## Recipe 3: Test file reminder for new source files (tool_result)

Reminds to create tests when adding new source files without a corresponding test file.

```ts
import { existsSync } from "node:fs";

export default function (pi) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "write" || event.isError) return;
    const p = String(event.input?.file_path ?? "");
    if (!/src\/.*\.(ts|js|py)$/.test(p) || /\.test\.|\.spec\./.test(p)) return;
    const ext = p.match(/\.(ts|js|py)$/)![0];
    const testPath = p.replace(new RegExp(`${ext.replace(".", "\\.")}$`), `.test${ext}`);
    if (!existsSync(testPath)) {
      pi.logger?.warn?.(`No test file for: ${p} (expected: ${testPath})`);
    }
  });
}
```

## Recipe 4: Auto-format after edits (tool_result)

Template — replace the formatter command with your project's tool.

```ts
import { execFileSync } from "node:child_process";

export default function (pi) {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "edit" || event.isError) return;
    const p = String(event.input?.file_path ?? "");
    if (/\.(ts|tsx|js|jsx)$/.test(p)) {
      try { execFileSync("npx", ["prettier", "--write", p], { stdio: "pipe" }); } catch {}
    }
  });
}
```

## Recipe 5: Block dev server outside tmux (tool_call)

Prevents running dev servers directly — they should run in tmux for log access.

```ts
export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const cmd = String(event.input?.command ?? "");
    if (/npm run dev|yarn dev|pnpm dev|next dev/.test(cmd) && !process.env.TMUX) {
      return { block: true, reason: 'BLOCKED: run dev servers inside tmux. Use: tmux new-session -d -s dev "npm run dev"' };
    }
  });
}
```

---

## Writing Custom Extensions

1. Create a TypeScript module under `.omp/extensions/` exporting a default function that receives `pi`.
2. Subscribe with `pi.on("tool_call" | "tool_result" | "before_agent_start" | "session_start", handler)`.
3. Inspect `event.toolName` and `event.input` fields.
4. Block by returning `{ block: true, reason }` from a `tool_call` handler; warn via `pi.logger.warn` or `ctx.ui.notify`.
5. Never fail closed on adapter bugs — wrap handlers in try/catch so an extension error doesn't block tool calls.

**Gate-style stdin CLIs remain an option**: instead of inlining logic in the extension, keep each check as a standalone stdin-JSON script (exit 0 = allow, exit 2 = block) and spawn it from a thin adapter — the pattern used by this repo's harness (`.omp/extensions/harness/index.ts` spawning `gates/*.mjs` via `runGate(...)`). This keeps gates independently testable from the CLI.

See `harness-harness_integration_contract.md` for the project's existing verification gates.
