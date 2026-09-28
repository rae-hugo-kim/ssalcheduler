// cycle-boundary-wiring.test.mjs — cycle-boundary nudge wiring in index.ts.
//
// The extension entry point does not export its event handlers, so (matching
// drift-recheck-wiring.test.mjs) these are source-level checks. The wiring
// contract: (a) a SUCCESSFUL non-WIP `git commit` bash result gets the
// CYCLE_BOUNDARY_NOTE appended to the existing tool-result content, (b) `wip:`
// checkpoint commits stay quiet (mid-implementation is exactly when
// context_management.md says not to break), (c) the note rides the SAME
// append-only content patch as the drift note — never replacing tool output,
// and (d) the note names the rule it re-arms (.omp/rules/harness-cycle_definition.md) and
// the /clear handoff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
const src = readFileSync(INDEX_TS, 'utf-8');

function handlerBlock(name) {
  const start = src.indexOf(`pi.on("${name}"`);
  assert.notEqual(start, -1, `index.ts must register a ${name} handler`);
  const next = src.indexOf('pi.on(', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

function bashBranch() {
  const handler = handlerBlock('tool_result');
  const start = handler.indexOf('if (event.toolName === "bash")');
  assert.notEqual(start, -1, 'tool_result must keep a dedicated bash branch');
  return handler.slice(start);
}

test('CYCLE_BOUNDARY_NOTE names the rule and the /clear handoff', () => {
  const m = src.match(/const CYCLE_BOUNDARY_NOTE =([\s\S]*?);/);
  assert.ok(m, 'index.ts must define CYCLE_BOUNDARY_NOTE');
  assert.match(m[1], /cycle_definition\.md/,
    'the nudge must point the agent at .omp/rules/harness-cycle_definition.md');
  assert.match(m[1], /\/clear/,
    'the nudge must carry the /clear handoff so the boundary actually ends the session');
});

test('isWipCommit is imported from git-commit-detect (same lexer as the gates)', () => {
  // The intent is provenance: WIP detection must come from the gate lexer, not a local regex.
  // The assertion deliberately does NOT pin the other named imports — the same module also
  // exports commitBypassTripwire, and enumerating the whole brace list made an unrelated
  // import addition fail this test (merged 2026-07-31 with the hook-boundary enforcement work).
  const imp = src.match(/import \{([^}]*)\} from "\.\/gates\/git-commit-detect\.mjs"/);
  assert.ok(imp, 'index.ts must import from ./gates/git-commit-detect.mjs');
  assert.match(imp[1], /\bisWipCommit\b/,
    'WIP detection must reuse the gate lexer, not a local regex');
});

test('bash tool_result: nudge sits behind the commit-success guard and skips WIP commits', () => {
  const bash = bashBranch();
  const guard = bash.search(/if \(landed\) \{/);
  assert.notEqual(guard, -1, 'the nudge must share the commit-success guard with the drift recheck');
  const wipGuarded = bash.search(/if \(!isWipCommit\(command\)\) notes\.push\(CYCLE_BOUNDARY_NOTE\)/);
  assert.notEqual(wipGuarded, -1,
    'the nudge must be pushed ONLY for non-WIP commits — wip: checkpoints stay quiet');
  assert.ok(wipGuarded > guard, 'the WIP-guarded push must sit inside the commit-success branch');
});

test('bash tool_result: nudge rides the append-only content patch', () => {
  const bash = bashBranch();
  const push = bash.search(/notes\.push\(CYCLE_BOUNDARY_NOTE\)/);
  const patch = bash.search(/content:\s*\[\s*\.\.\.\s*\(\s*event\.content\s*\?\?\s*\[\]\s*\)\s*,\s*\{\s*type:\s*"text"\s*,\s*text:/);
  assert.notEqual(patch, -1,
    'the patch must spread the original event.content and append ONE text part — never replace');
  assert.ok(patch > push, 'the content patch must be built after the note is queued');
});
