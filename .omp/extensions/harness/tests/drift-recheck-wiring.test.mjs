// drift-recheck-wiring.test.mjs — mid-session drift recheck wiring in index.ts.
//
// The extension entry point does not export its event handlers, so (matching
// edit-targets-wiring.test.mjs) these are source-level checks. The wiring
// contract: (a) turn-start and post-commit rechecks share ONE 1h freshness
// window constant, (b) before_agent_start surfaces gate stdout to the AGENT as
// a harness-reminder message, and (c) a SUCCESSFUL `git commit` bash result
// gets the drift note APPENDED to the existing tool-result content — never
// replacing it, never firing on failed commits.

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
  const end = handler.indexOf('if (EDIT_TOOL_NAMES', start);
  return handler.slice(start, end === -1 ? handler.length : end);
}

// The recheck call shape both mid-session paths must share: the gate script by
// name, plus the 1h window passed as max_age_ms.
const RECHECK_CALL = /runGate\(\s*"harness-version-check\.mjs"\s*,\s*\{\s*session_state\s*,\s*max_age_ms:\s*DRIFT_RECHECK_MAX_AGE_MS\s*\}/;

test('DRIFT_RECHECK_MAX_AGE_MS is defined as one hour', () => {
  assert.match(src, /const\s+DRIFT_RECHECK_MAX_AGE_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000\s*;/,
    'mid-session rechecks must share a single 1h freshness-window constant');
});

test('before_agent_start rechecks drift with the 1h window and returns a harness-reminder message', () => {
  const block = handlerBlock('before_agent_start');
  const call = block.search(RECHECK_CALL);
  assert.notEqual(call, -1,
    'turn start must invoke harness-version-check.mjs with max_age_ms: DRIFT_RECHECK_MAX_AGE_MS');
  assert.match(block, /\.stdout/,
    'the gate STDOUT is the drift note — the handler must consume it');
  const reminder = block.indexOf('customType: "harness-reminder"');
  assert.ok(reminder > call,
    'the drift note must flow into a harness-reminder message returned AFTER the gate call');
});

test('bash tool_result: recheck is gated on a successful git commit', () => {
  const bash = bashBranch();
  const guard = bash.search(/if \(landed\) \{/);
  assert.notEqual(guard, -1,
    'recheck must gate on the landed predicate (HEAD moved in the target repo, exit code only as fallback) — blocked/failed commits stay quiet');
  const call = bash.search(RECHECK_CALL);
  assert.notEqual(call, -1,
    'post-commit path must reuse the SAME 1h-window gate call as turn start');
  assert.ok(call > guard, 'the gate call must sit behind the commit-success guard');
});

test('bash tool_result: drift note is APPENDED to the existing event content, not a replacement', () => {
  const bash = bashBranch();
  const patch = bash.search(/content:\s*\[\s*\.\.\.\s*\(\s*event\.content\s*\?\?\s*\[\]\s*\)\s*,\s*\{\s*type:\s*"text"\s*,\s*text:/);
  assert.notEqual(patch, -1,
    'the patch must spread the original event.content and append ONE text part carrying the note');
  const call = bash.search(RECHECK_CALL);
  assert.ok(patch > call, 'the content patch must be built from the gate call result');
  assert.match(bash, /\.stdout/, 'the appended note must come from the gate stdout');
});

test('session_start keeps the gate default window (no max_age_ms override)', () => {
  const block = handlerBlock('session_start');
  assert.ok(block.includes('harness-version-check.mjs'), 'session start still runs the version gate');
  assert.ok(!/max_age_ms/.test(block),
    'session start must rely on the gate default (24h) — the 1h recheck window is mid-session only');
});
