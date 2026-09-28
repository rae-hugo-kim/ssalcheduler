// Hook-level tests for the backpressure STATE WRITERS — the three hooks that
// produce what backpressure-gate consumes. The gate's own tests seed status
// files manually, so before this file the writers had no behavioral coverage:
// a regression in any of them (e.g. the invalidator no longer resetting on a
// code edit) would silently neutralize the whole backpressure system.
//
//   backpressure-tracker.mjs          PostToolUse(Bash):        PASS + history + last-fail unlink
//   backpressure-invalidator.mjs      PostToolUse(Edit|Write):  reset to UNKNOWN on code edits
//   backpressure-failure-tracker.mjs  PostToolUseFailure(Bash): FAIL + last-fail
//
// Run: node --test .omp/extensions/harness/tests/backpressure-writers.test.mjs
//
// Spawn-based with an EXPLICIT throwaway cwd passed via session_state.cwd —
// the writers only touch <cwd>/.omp/harness-state, no git involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates');
const TRACKER = join(HOOKS, 'backpressure-tracker.mjs');
const INVALIDATOR = join(HOOKS, 'backpressure-invalidator.mjs');
const FAILURE = join(HOOKS, 'backpressure-failure-tracker.mjs');

const stateDir = (dir) => join(dir, '.omp', 'harness-state');
const statusOf = (dir) => {
  const f = join(stateDir(dir), 'backpressure-status');
  return existsSync(f) ? readFileSync(f, 'utf-8').trim() : null;
};
const lastFailOf = (dir) => {
  const f = join(stateDir(dir), 'backpressure-last-fail');
  return existsSync(f) ? readFileSync(f, 'utf-8').trim() : null;
};
const historyOf = (dir) => {
  const f = join(stateDir(dir), 'test-history.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null;
};
const seed = (dir, name, content) => {
  mkdirSync(stateDir(dir), { recursive: true });
  writeFileSync(join(stateDir(dir), name), content);
};

function runHook(hook, dir, toolInput) {
  return spawnSync('node', [hook], {
    input: JSON.stringify({ tool_input: toolInput, session_state: { cwd: dir } }),
    cwd: dir,
    encoding: 'utf-8',
  });
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-writers-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- backpressure-tracker: the PASS path -------------------------------------

test('tracker: reliable verification success -> PASS + history + last-fail cleared', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'FAIL');
    seed(dir, 'backpressure-last-fail', 'test: npm test');
    const r = runHook(TRACKER, dir, { command: 'npm test' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'PASS');
    assert.equal(lastFailOf(dir), null, 'last-fail must be unlinked on a fresh PASS');
    const h = historyOf(dir);
    assert.equal(h.lastResult, 'PASS');
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].result, 'PASS');
    assert.equal(h.runs[0].cmd, 'npm test');
  });
});

test('tracker: unreliable success (piped) records NOTHING — no false PASS', () => {
  // A piped verification can mask the real exit code; recording PASS here would
  // clear protection the gate relies on (the passReliable=false design). Seed a
  // RED state to also pin that FAIL and last-fail survive an unreliable "pass".
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'FAIL');
    seed(dir, 'backpressure-last-fail', 'test: npm test');
    const r = runHook(TRACKER, dir, { command: 'npm test | tail -5' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'FAIL', 'status must not flip to PASS');
    assert.equal(lastFailOf(dir), 'test: npm test', 'last-fail must survive');
    assert.equal(historyOf(dir), null, 'no history entry for an unreliable run');
  });
});

test('tracker: non-verification command writes nothing', () => {
  withDir((dir) => {
    const r = runHook(TRACKER, dir, { command: 'ls -la' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), null);
    assert.equal(historyOf(dir), null);
  });
});

test('tracker: corrupt history JSON is recovered, not crashed on', () => {
  withDir((dir) => {
    seed(dir, 'test-history.json', '{not json');
    const r = runHook(TRACKER, dir, { command: 'npm test' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'PASS');
    assert.equal(historyOf(dir).runs.length, 1, 'fresh history after corruption');
  });
});

test('tracker: history accumulates across runs; long commands are truncated', () => {
  withDir((dir) => {
    runHook(TRACKER, dir, { command: 'npm test' });
    const long = 'npm test -- --grep ' + 'x'.repeat(80);
    runHook(TRACKER, dir, { command: long });
    const h = historyOf(dir);
    assert.equal(h.runs.length, 2);
    assert.equal(h.runs[1].cmd.length, 53, '50 chars + "..."');
    assert.ok(h.runs[1].cmd.endsWith('...'));
  });
});

test('tracker: invalid stdin JSON exits 0 without writing', () => {
  withDir((dir) => {
    const r = spawnSync('node', [TRACKER], { input: '{nope', cwd: dir, encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), null);
  });
});

// --- backpressure-invalidator: the UNKNOWN reset ------------------------------

test('invalidator: a code-file edit resets PASS -> UNKNOWN', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    const r = runHook(INVALIDATOR, dir, { file_path: join(dir, 'src/app.ts') });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'UNKNOWN');
  });
});

test('invalidator: creates the state dir and writes UNKNOWN when nothing exists yet', () => {
  // First code edit of a session: no .omp/harness-state yet — the hook must
  // create it and leave UNKNOWN, not crash or silently skip.
  withDir((dir) => {
    const r = runHook(INVALIDATOR, dir, { file_path: join(dir, 'src/app.ts') });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'UNKNOWN');
  });
});

test('invalidator: extension matching is case-insensitive (.TS still resets)', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    runHook(INVALIDATOR, dir, { file_path: join(dir, 'src/App.TS') });
    assert.equal(statusOf(dir), 'UNKNOWN');
  });
});

test('invalidator: a prose-doc edit does NOT reset PASS', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    runHook(INVALIDATOR, dir, { file_path: join(dir, 'docs/notes.md') });
    assert.equal(statusOf(dir), 'PASS');
  });
});

test('invalidator: config files (.json/.yaml) do not reset — pinned current behavior', () => {
  // Known limitation, deliberately pinned: config edits keep a stale PASS
  // (risk-assess grades CI/build config like package.json as medium, other
  // config as low). If invalidation is ever extended to config, this pin
  // forces that to be an explicit decision, not drift.
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    runHook(INVALIDATOR, dir, { file_path: join(dir, 'package.json') });
    assert.equal(statusOf(dir), 'PASS');
    runHook(INVALIDATOR, dir, { file_path: join(dir, 'config/app.yaml') });
    assert.equal(statusOf(dir), 'PASS');
  });
});

test('invalidator: no file_path is a no-op', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    const r = runHook(INVALIDATOR, dir, {});
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'PASS');
  });
});

// --- backpressure-failure-tracker: the FAIL path ------------------------------

test('failure-tracker: failed verification -> FAIL + last-fail recorded', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    const r = runHook(FAILURE, dir, { command: 'npm test' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), 'FAIL');
    assert.equal(lastFailOf(dir), 'test: npm test');
  });
});

test('failure-tracker: capture is liberal — a chained verification still records FAIL', () => {
  // Unlike the PASS path (passReliable-gated), failure capture over-blocks on
  // purpose: a red `verify && other` must never leave a stale PASS standing.
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    runHook(FAILURE, dir, { command: 'npm test && echo done' });
    assert.equal(statusOf(dir), 'FAIL');
  });
});

test('failure-tracker: non-verification failure writes nothing', () => {
  withDir((dir) => {
    seed(dir, 'backpressure-status', 'PASS');
    runHook(FAILURE, dir, { command: 'ls /nonexistent' });
    assert.equal(statusOf(dir), 'PASS');
    assert.equal(lastFailOf(dir), null);
  });
});

test('failure-tracker: long command truncated to 80 chars in last-fail', () => {
  withDir((dir) => {
    const long = 'npm test -- --grep ' + 'y'.repeat(100);
    runHook(FAILURE, dir, { command: long });
    const lf = lastFailOf(dir);
    assert.ok(lf.startsWith('test: '));
    assert.equal(lf.length, 'test: '.length + 83, '80 chars + "..."');
  });
});

test('failure-tracker: invalid stdin JSON exits 0 without writing', () => {
  withDir((dir) => {
    const r = spawnSync('node', [FAILURE], { input: '{nope', cwd: dir, encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.equal(statusOf(dir), null);
  });
});

// --- lifecycle: FAIL -> fix -> reliable PASS clears the red state --------------

test('lifecycle: FAIL then a reliable PASS clears status AND last-fail', () => {
  withDir((dir) => {
    runHook(FAILURE, dir, { command: 'npm test' });
    assert.equal(statusOf(dir), 'FAIL');
    assert.ok(lastFailOf(dir));
    runHook(TRACKER, dir, { command: 'npm test' });
    assert.equal(statusOf(dir), 'PASS');
    assert.equal(lastFailOf(dir), null);
  });
});

// --- dispatch contract: state lands under session_state.cwd ---------------------

test('hooks write under session_state.cwd, not the spawn cwd', () => {
  // Elsewhere runHook sets both to the same dir, which would MASK a regression
  // where a hook fell back to process.cwd(). Separate them: state must land in
  // session_state.cwd and the spawn cwd must stay untouched.
  withDir((stateCwd) => {
    withDir((spawnCwd) => {
      const r = spawnSync('node', [TRACKER], {
        input: JSON.stringify({ tool_input: { command: 'npm test' }, session_state: { cwd: stateCwd } }),
        cwd: spawnCwd,
        encoding: 'utf-8',
      });
      assert.equal(r.status, 0);
      assert.equal(statusOf(stateCwd), 'PASS', 'state lands under session_state.cwd');
      assert.equal(statusOf(spawnCwd), null, 'spawn cwd untouched');
    });
  });
});

// --- wiring: index.ts registers all three on the lifecycle they assume ----

test('index.ts wires tracker/invalidator/failure-tracker to the right events', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf-8');
  // Registration = a quoted "<gate>.mjs" literal in the OMP extension entry point
  // (runGate call; the bash tool_result handler picks tracker vs failure-tracker).
  assert.ok(src.includes('"backpressure-tracker.mjs"'),
    'bash tool_result (ok) must run the PASS tracker');
  assert.ok(src.includes('"backpressure-invalidator.mjs"'),
    'edit/write tool_result must run the invalidator');
  assert.ok(src.includes('"backpressure-failure-tracker.mjs"'),
    'bash tool_result (isError) must run the failure tracker');
});
