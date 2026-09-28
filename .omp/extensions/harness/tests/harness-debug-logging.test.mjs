// Tests for HARNESS_DEBUG-gated hook logging (audit item #8a).
//
// Run: node --test .omp/extensions/harness/tests/harness-debug-logging.test.mjs
//
// Every harness hook's log() now no-ops unless process.env.HARNESS_DEBUG is set, so the default
// (no env var) produces NO .omp/harness-state/hook-debug.log noise. This must NOT change any gate's
// blocking behavior — only whether the debug log is written.
//
// Spawn-based, isolated temp cwd (see memory: feedback_shell_test_cwd_isolation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates');
const CONTEXT_GATE = join(HARNESS, 'context-gate.mjs');

// Every hook that emits a debug trace to hook-debug.log — all must be HARNESS_DEBUG-gated.
// (read-tracker/write-tracker write read-log.txt, kickoff-detector uses stderr, and
// harness-version-check only rotates the log — none of those write hook-debug.log via log().)
const DEBUG_LOGGING_HOOKS = [
  'acceptance-gate', 'backpressure-gate', 'backpressure-invalidator', 'backpressure-tracker',
  'backpressure-failure-tracker', 'review-gate', 'context-gate', 'destructive-guard', 'mcp-gate',
];

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hdbg-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function logPath(cwd) {
  return join(cwd, '.omp', 'harness-state', 'hook-debug.log');
}

// HARNESS_DEBUG explicitly OFF (empty string is falsy) so the test is independent of the outer env.
function runHook(hook, payload, cwd, debug) {
  return spawnSync('node', [hook], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, HARNESS_DEBUG: debug ? '1' : '' },
  });
}

test('no hook-debug.log is written when HARNESS_DEBUG is unset', () => {
  withTmp((cwd) => {
    const r = runHook(CONTEXT_GATE, { tool_input: {}, session_state: { cwd } }, cwd, false);
    assert.equal(r.status, 0);
    assert.equal(existsSync(logPath(cwd)), false, 'debug log must not exist without HARNESS_DEBUG');
  });
});

test('hook-debug.log IS written when HARNESS_DEBUG is set', () => {
  withTmp((cwd) => {
    runHook(CONTEXT_GATE, { tool_input: {}, session_state: { cwd } }, cwd, true);
    assert.equal(existsSync(logPath(cwd)), true, 'debug log present with HARNESS_DEBUG=1');
    assert.match(readFileSync(logPath(cwd), 'utf-8'), /context-gate/, 'log contains hook entries');
  });
});

test('gate still BLOCKS with logging off (behavior is independent of HARNESS_DEBUG)', () => {
  withTmp((cwd) => {
    const target = join(cwd, 'unread.ts');
    writeFileSync(target, 'export const x = 1;\n');   // exists, never read -> must block
    const r = runHook(CONTEXT_GATE, { tool_input: { file_path: target }, session_state: { cwd } }, cwd, false);
    assert.equal(r.status, 2, 'context-gate must still block an unread file with logging off');
    assert.equal(existsSync(logPath(cwd)), false, 'and still writes no debug log');
    assert.match(r.stderr, /HARNESS BLOCK/, 'the block message goes to stderr (not the debug log)');
  });
});

test('every debug-logging hook gates log() behind HARNESS_DEBUG (all 9, not just context-gate)', () => {
  // Static guard: proves the env check is present in EACH hook, so a missing guard in any one of
  // them fails here (the single-hook runtime tests above could not catch that).
  for (const name of DEBUG_LOGGING_HOOKS) {
    const src = readFileSync(join(HARNESS, `${name}.mjs`), 'utf-8');
    assert.match(src, /function log\(msg\) \{\s+if \(!process\.env\.HARNESS_DEBUG\) return;/,
      `${name}: log() must early-return unless HARNESS_DEBUG is set`);
  }
});

test('no debug-logging hook writes hook-debug.log when HARNESS_DEBUG is off (all 9)', () => {
  // Runtime complement: a generic benign payload reaches each hook's logging path; with logging
  // off, none may create hook-debug.log. (Other state files like backpressure-status are fine —
  // we assert only on the debug log.)
  for (const name of DEBUG_LOGGING_HOOKS) {
    withTmp((cwd) => {
      const payload = { tool_input: { command: 'ls -la', file_path: join(cwd, 'readme.md') }, session_state: { cwd } };
      runHook(join(HARNESS, `${name}.mjs`), payload, cwd, false);
      assert.equal(existsSync(logPath(cwd)), false, `${name} must not write hook-debug.log when off`);
    });
  }
});
