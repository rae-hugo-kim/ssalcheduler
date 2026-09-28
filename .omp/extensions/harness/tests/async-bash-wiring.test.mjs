// async-bash-wiring.test.mjs — backgrounded bash results carry no verdict (#40).
//
// omp 18.3.0 (measured 2026-09-24): `async: true` or bash.autoBackground returns a
// background-START tool_result — isError false, no exitCode, details.async.state
// "running" — and the job's real outcome arrives through onUpdate, never as a
// tool_result. Routing that start result to a backpressure tracker recorded a
// failing `node --test` as PASS and cleared backpressure-last-fail.
//
// The extension entry point does not export its handlers, so (matching
// drift-recheck-wiring.test.mjs) these are source-level checks on the bash branch:
// the pending guard must sit BEFORE any backpressure tracker spawn and before the
// commit-success guard, exit the branch, and pass `pending: true` to the breadcrumb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');
const src = readFileSync(INDEX_TS, 'utf-8');

function bashBranch() {
  const start = src.indexOf('pi.on("tool_result"');
  assert.notEqual(start, -1, 'index.ts must register a tool_result handler');
  const handler = src.slice(start, src.indexOf('pi.on(', start + 1));
  const bash = handler.indexOf('if (event.toolName === "bash")');
  assert.notEqual(bash, -1, 'tool_result must keep a dedicated bash branch');
  const end = handler.indexOf('isEditToolName(event.toolName)', bash);
  return handler.slice(bash, end === -1 ? handler.length : end);
}

const PENDING_GUARD = /if\s*\(\s*event\.details\?\.async\?\.state\s*===\s*"running"\s*\)\s*\{/;

// The pending branch: from the guard to its `return;` (the object literals inside contain
// `}` so a brace scan is not a usable boundary).
function pendingBranch() {
  const bash = bashBranch();
  const guard = bash.search(PENDING_GUARD);
  assert.notEqual(guard, -1, 'the bash branch must test details.async.state === "running" exactly');
  const ret = bash.indexOf('return;', guard);
  assert.notEqual(ret, -1, 'the pending branch must return — nothing below it may run');
  return { bash, guard, ret, body: bash.slice(guard, ret) };
}

test('bash tool_result: a background-start result (details.async.state "running") exits before any backpressure tracker', () => {
  const { bash, ret, body } = pendingBranch();
  assert.doesNotMatch(body, /backpressure/, 'the pending branch must not touch backpressure state');
  for (const tracker of ['backpressure-tracker.mjs', 'backpressure-failure-tracker.mjs']) {
    const at = bash.indexOf(tracker);
    assert.notEqual(at, -1, `the success/failure routing must still spawn ${tracker}`);
    assert.ok(at > ret, `${tracker} must be spawned only AFTER the pending branch returned`);
  }
});

test('bash tool_result: the pending branch records a breadcrumb with pending: true (never failed)', () => {
  const { body } = pendingBranch();
  assert.match(body, /runGate\(\s*"breadcrumb-tracker\.mjs"\s*,\s*\{[^}]*tool_input:\s*\{\s*command\s*,\s*pending:\s*true\s*\}/,
    'the pending branch must record the breadcrumb through breadcrumb-tracker.mjs with pending: true');
});

test('bash tool_result: the commit-success guard (drift recheck + cycle note) sits behind the pending guard', () => {
  const { bash, ret } = pendingBranch();
  const commit = bash.search(/if \(landed\) \{/);
  assert.notEqual(commit, -1, 'the commit-success guard must still exist');
  assert.ok(commit > ret, 'a backgrounded `git commit` is not a commit yet — no drift recheck, no cycle-boundary note');
});
