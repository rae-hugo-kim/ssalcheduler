// Tests for scripts/docs-drift hardening (audit P2 #8).
//
// Run: node --test .omp/extensions/harness/tests/docs-drift.test.mjs
//
// Covers the two behaviour changes plus an in-situ regression lock:
//   (1) computeReachableHooks — orphan detection by reachability over the hook
//       reference graph, so the commit-gates dispatcher's delegated gates and
//       imported helper modules are NOT false-flagged as orphans, while a
//       genuinely dead hook still is. (PR #43 introduced the false positives.)
//   (2) refDocStaleSeverity — a mirror that claims `status: synced` while its
//       stamped hash lags AGENTS.md is a hard FAIL; an explicit `status: stale`
//       is an accepted escape hatch.
//   (3) on the real repo, the six previously-flagged hooks resolve as reachable
//       and the whole pipeline exits 0.

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const driftPath = resolve(repoRoot, 'scripts/docs-drift');
// scripts/docs-drift is source-repo-only (not on the harness-sync whitelist, by design —
// see .githooks/pre-push). This suite ships to consumers with the gates (#17), so in a
// consumer tree it must skip, not fail: a missing auditor is the expected state there.
const SOURCE_ONLY_SKIP = existsSync(driftPath) ? false : 'scripts/docs-drift is source-repo-only; not present in consumer repos';
const test = SOURCE_ONLY_SKIP ? (name, fn) => nodeTest(name, { skip: SOURCE_ONLY_SKIP }, fn) : nodeTest;
const { computeReachableHooks, getHookScriptRootPaths, refDocStaleSeverity, getRegisteredHookPaths, closeoutConsistency } =
  SOURCE_ONLY_SKIP ? {} : require(driftPath);

const HOOK_PREFIX = '.omp/extensions/harness/gates';
const hookPath = (name) => `${HOOK_PREFIX}/${name}`;

// Build a temporary hooks directory with the given { filename: source } map.
function withHooksDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'docs-drift-hooks-'));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(dir, name), source);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- (1) computeReachableHooks: reachability over import/spawn edges ---

test('reachability: seeds, spawn-literal, import, transitive are live; dead is orphan', () => {
  const files = {
    // registered dispatcher: spawns gate-a by filename, imports git-helper
    'dispatcher.mjs': `const GATES = ['gate-a.mjs'];\nimport { x } from './git-helper.mjs';\n`,
    // gate spawned by dispatcher, imports a deeper helper (transitive edge)
    'gate-a.mjs': `import { r } from './deep-helper.mjs';\n`,
    'git-helper.mjs': `export const x = 1;\n`,
    'deep-helper.mjs': `export const r = 2;\n`,
    // registered standalone tracker referencing nothing
    'tracker.mjs': `export default null;\n`,
    // genuinely dead: not registered, nothing references it
    'dead.mjs': `export const gone = true;\n`,
  };

  withHooksDir(files, (dir) => {
    const seeds = new Set([hookPath('dispatcher.mjs'), hookPath('tracker.mjs')]);
    const reachable = computeReachableHooks(seeds, dir);

    assert.ok(reachable.has(hookPath('dispatcher.mjs')), 'seed dispatcher');
    assert.ok(reachable.has(hookPath('tracker.mjs')), 'seed tracker');
    assert.ok(reachable.has(hookPath('gate-a.mjs')), 'spawn-literal edge');
    assert.ok(reachable.has(hookPath('git-helper.mjs')), 'import edge');
    assert.ok(reachable.has(hookPath('deep-helper.mjs')), 'transitive import edge');
    assert.ok(!reachable.has(hookPath('dead.mjs')), 'dead file must stay orphan');
  });
});

test('reachability: a self-referencing unregistered file is still an orphan', () => {
  const files = {
    'seed.mjs': `export default 1;\n`,
    // mentions its own name in a literal -> self-edge must be ignored, and it is
    // not seeded nor referenced by anyone else, so it must remain unreachable.
    'lonely.mjs': `const me = 'lonely.mjs';\n`,
  };
  withHooksDir(files, (dir) => {
    const reachable = computeReachableHooks(new Set([hookPath('seed.mjs')]), dir);
    assert.ok(reachable.has(hookPath('seed.mjs')));
    assert.ok(!reachable.has(hookPath('lonely.mjs')), 'self-reference must not make a file reachable');
  });
});

test('reachability: a quoted .mjs inside a comment does not revive a dead hook', () => {
  const files = {
    // The seed names dead-gate.mjs only inside comments — a line comment and a
    // block comment, both with the quoted literal. Comments are stripped before
    // edge extraction, so neither creates an edge and dead-gate stays an orphan.
    'seed.mjs': `// removed the call to 'dead-gate.mjs'\n/* was: spawn("dead-gate.mjs") */\nexport default 1;\n`,
    'dead-gate.mjs': `export default 2;\n`,
  };
  withHooksDir(files, (dir) => {
    const reachable = computeReachableHooks(new Set([hookPath('seed.mjs')]), dir);
    assert.ok(!reachable.has(hookPath('dead-gate.mjs')), 'comment-only mention must not create an edge');
  });
});

test('reachability: an external import sharing a basename with a harness file is not an edge', () => {
  const files = {
    // The literal resolves outside the hooks dir; it must not revive the
    // same-named dead harness file victim.mjs.
    'seed.mjs': `import { z } from '../../other/victim.mjs';\nexport default 1;\n`,
    'victim.mjs': `export const z = 9;\n`,
  };
  withHooksDir(files, (dir) => {
    const reachable = computeReachableHooks(new Set([hookPath('seed.mjs')]), dir);
    assert.ok(!reachable.has(hookPath('victim.mjs')), 'same-basename external path must not create an edge');
  });
});

// --- (2) refDocStaleSeverity: synced-but-stale is FAIL, marked-stale is allowed ---

test('refDocStaleSeverity: matching hash is clean (null)', () => {
  assert.equal(
    refDocStaleSeverity({ sourceCommitHash: 'abc', currentSourceHash: 'abc', status: 'synced' }),
    null,
  );
});

test('refDocStaleSeverity: synced + hash mismatch is FAIL', () => {
  assert.equal(
    refDocStaleSeverity({ sourceCommitHash: 'abc', currentSourceHash: 'def', status: 'synced' }),
    'FAIL',
  );
});

test('refDocStaleSeverity: the exact token "stale" is the accepted escape hatch (null)', () => {
  for (const status of ['stale', '  stale  ', 'STALE', 'Stale']) {
    assert.equal(
      refDocStaleSeverity({ sourceCommitHash: 'abc', currentSourceHash: 'def', status }),
      null,
      `status ${JSON.stringify(status)} should opt out`,
    );
  }
});

test('refDocStaleSeverity: a status that merely contains "stale" still FAILs (no over-match)', () => {
  // The old /\bstale\b/ derivation let these slip the FAIL — they must not.
  for (const status of ['synced # not stale', 'not stale', 'synced/stale', 'was stale, now synced', '']) {
    assert.equal(
      refDocStaleSeverity({ sourceCommitHash: 'abc', currentSourceHash: 'def', status }),
      'FAIL',
      `status ${JSON.stringify(status)} must not be a valid opt-out`,
    );
  }
});

// --- (3) in-situ regression lock on the real repo ---

test('real repo: commit-gates delegated gates + imported helpers are reachable', () => {
  const indexSource = readFileSync(join(repoRoot, '.omp/extensions/harness/index.ts'), 'utf8');
  // Two enforcement entry points since the gates moved into .githooks/pre-commit: the
  // extension AND the git hooks. Seeding from index.ts alone would report the whole
  // commit-gate subtree as orphaned (test-attack C-3).
  const seeds = [...getRegisteredHookPaths(indexSource), ...getHookScriptRootPaths(repoRoot)];
  const reachable = computeReachableHooks(seeds, join(repoRoot, '.omp/extensions/harness/gates'));

  const previouslyFalseOrphans = [
    'acceptance-gate.mjs',
    'backpressure-gate.mjs',
    'review-gate.mjs',
    'risk-assess.mjs',
    'git-commit-detect.mjs',
    'backpressure-patterns.mjs',
  ];
  for (const name of previouslyFalseOrphans) {
    assert.ok(reachable.has(hookPath(name)), `${name} should be reachable (delegated/imported), not an orphan`);
  }
});

test('real repo: docs-drift exits 0; only the pre-delivery Closeout-pending WARN is tolerated', () => {
  const result = spawnSync(process.execPath, [driftPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `docs-drift should exit 0; stdout:\n${result.stdout}`);
  // Between "all ACs checked" and delivery (compr/compush flips seed status: approved -> done),
  // the closeoutConsistency lane emits a "Closeout pending" WARNING BY CONTRACT
  // (docs/rules/closeout_contract.md 비고: PR-4 verification lane). Demanding an unconditional
  // OK here contradicted that contract. Accept a clean OK, or EXACTLY that single warning —
  // any error, any other warning, or a second warning is still drift.
  // Branch on ANY warn-ish output (not on the OK marker) so an "OK + stray warnings" regression
  // cannot slip through the OK branch: any WARN/WARNING text must be the exact single-warning form.
  if (/WARN/.test(result.stdout)) {
    assert.match(result.stdout, /\[docs:drift\] WARN \(0 errors, 1 warnings\)/,
      'only a zero-error, single-warning report is tolerated');
    assert.match(result.stdout, /1\. Closeout pending/,
      'the sole tolerated warning is the pre-delivery Closeout-pending transient');
  } else {
    assert.match(result.stdout, /\[docs:drift\] OK/, 'expected a clean OK report');
  }
  assert.ok(!/Orphan gate file/.test(result.stdout), 'no orphan-gate warnings expected');
});

// --- closeoutConsistency: the independent closeout VERIFICATION lane (PR-4) ---
// Pure check, all WARNING. Catches lapses the best-effort trigger (compr/compush) leaves.

const SCOPE_ALL_CHECKED = '## Acceptance Criteria\n\n- [x] a\n- [x] b\n';
const SCOPE_SOME_UNCHECKED = '## Acceptance Criteria\n\n- [x] a\n- [ ] b\n';

test('closeoutConsistency: no current-scope.md -> no warnings (nothing tracked)', () => {
  assert.deepEqual(closeoutConsistency('status: done\n', null), []);
  assert.deepEqual(closeoutConsistency(null, null), []);
});

test('closeoutConsistency: scope exists but no active seed -> Orphan', () => {
  const r = closeoutConsistency(null, SCOPE_SOME_UNCHECKED);
  assert.equal(r.length, 1);
  assert.match(r[0].title, /Orphan/);
});

test('closeoutConsistency: closed seed (done/superseded, incl. quoted) + lingering scope -> half-closed', () => {
  for (const seed of ['status: done\n', 'status: superseded\n', 'status: "done"\n', "status: 'done'\n"]) {
    const r = closeoutConsistency(seed, SCOPE_ALL_CHECKED);
    assert.equal(r.length, 1, seed);
    assert.match(r[0].title, /half-closed/i, seed);
  }
});

test('closeoutConsistency: approved seed + all AC checked -> Closeout pending', () => {
  const r = closeoutConsistency('status: approved\n', SCOPE_ALL_CHECKED);
  assert.equal(r.length, 1);
  assert.match(r[0].title, /Closeout pending/);
});

test('closeoutConsistency: no warning for mid-task / no-AC / zero-checkbox / draft-all-checked', () => {
  assert.deepEqual(closeoutConsistency('status: approved\n', SCOPE_SOME_UNCHECKED), []);
  assert.deepEqual(closeoutConsistency('status: approved\n', '# Scope\n\nno AC here\n'), []);
  assert.deepEqual(closeoutConsistency('status: approved\n', '## Acceptance Criteria\n\n(none)\n'), []);
  // draft is not closeout-trackable (trigger closes only `approved`) -> no pending warning:
  assert.deepEqual(closeoutConsistency('status: draft\n', SCOPE_ALL_CHECKED), []);
});
