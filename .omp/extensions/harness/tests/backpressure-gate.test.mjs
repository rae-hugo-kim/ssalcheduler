// Integration tests for backpressure-gate.mjs (PreToolUse: Bash, git commit).
//
// Run: node --test .omp/extensions/harness/tests/backpressure-gate.test.mjs
//
// Focus: audit item #7 — the UNKNOWN-status asymmetry. Previously `status=UNKNOWN` blocked a commit
// UNCONDITIONALLY (any risk level), while a MISSING status file warned on medium and only blocked
// high/critical. Both mean "no positive verification", so they must behave symmetrically. The fix
// makes UNKNOWN block only high/critical and warn on medium/below. FAIL is unchanged (always blocks).
//
// Spawn-based: the gate reads stdin JSON + state files and calls assessRisk(cwd) (which shells out
// to git). Each test uses a throwaway git repo with an EXPLICIT cwd, so the real repo is untouched
// (see memory: feedback_shell_test_cwd_isolation). Risk level is driven by the staged files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'backpressure-gate.mjs');

// Files that pin a given risk level (verified against risk-assess.mjs):
const MEDIUM = { 'src/util.ts': 'export const a = 1;\n' };                 // code, small diff
const HIGH = { 'src/big.ts': 'export const x = 1;\n'.repeat(120) };       // code, >100 lines
const CRITICAL = { 'src/auth/login.ts': 'export const login = 1;\n' };    // matches auth topic
const LOW = { 'docs/notes.md': '# notes\nprose\n' };                      // prose doc -> low

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-gate-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  for (const [rel, content] of Object.entries(files)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
  git(['add', '-A']);   // stage so assessRisk sees them via `git diff --cached`
  return dir;
}

// Write the status file AFTER staging so it stays untracked (it must not perturb assessRisk, which
// only counts staged/tracked-modified files; the gate reads it directly).
function setStatus(dir, status) {
  const sd = join(dir, '.omp', 'harness-state');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'backpressure-status'), status);
}

function runGate(dir, command = 'git commit -m x') {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_input: { command }, session_state: { cwd: dir } }),
    cwd: dir,
    encoding: 'utf-8',
  });
}

function withRepo(files, fn) {
  const dir = makeRepo(files);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A directory that is NOT a git repo — `git diff` throws, so assessRisk returns level 'unknown'.
function withNonRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-nogit-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- The fix: UNKNOWN is now risk-aware (symmetric with a missing status file) ---

test('UNKNOWN + medium risk → WARN, not block (the asymmetry fix)', () => {
  withRepo(MEDIUM, (dir) => {
    setStatus(dir, 'UNKNOWN');
    const r = runGate(dir);
    assert.equal(r.status, 0, 'medium + UNKNOWN must be allowed');
    assert.match(r.stderr, /HARNESS WARNING/, 'it should WARN');
    assert.doesNotMatch(r.stderr, /HARNESS BLOCK/, 'it must not say BLOCK');
  });
});

test('UNKNOWN + high risk → BLOCK', () => {
  withRepo(HIGH, (dir) => {
    setStatus(dir, 'UNKNOWN');
    assert.equal(runGate(dir).status, 2, 'high + UNKNOWN must block');
  });
});

test('UNKNOWN + critical risk → BLOCK', () => {
  withRepo(CRITICAL, (dir) => {
    setStatus(dir, 'UNKNOWN');
    assert.equal(runGate(dir).status, 2, 'critical + UNKNOWN must block');
  });
});

// --- Symmetry reference: a missing status file behaves identically to UNKNOWN ---

test('no status file + medium → WARN (the behavior UNKNOWN now mirrors)', () => {
  withRepo(MEDIUM, (dir) => {
    assert.equal(runGate(dir).status, 0, 'medium without a status file warns (unchanged)');
  });
});

test('no status file + critical → BLOCK', () => {
  withRepo(CRITICAL, (dir) => {
    assert.equal(runGate(dir).status, 2, 'critical without a status file blocks (unchanged)');
  });
});

// --- Unchanged branches (regression guards) ---

test('PASS + medium → allow', () => {
  withRepo(MEDIUM, (dir) => {
    setStatus(dir, 'PASS');
    assert.equal(runGate(dir).status, 0);
  });
});

test('FAIL + medium → BLOCK (FAIL is positive evidence of breakage, always blocks)', () => {
  withRepo(MEDIUM, (dir) => {
    setStatus(dir, 'FAIL');
    assert.equal(runGate(dir).status, 2, 'a recorded failure must block even at medium risk');
  });
});

test('low risk (prose doc) → allow regardless of UNKNOWN status', () => {
  withRepo(LOW, (dir) => {
    setStatus(dir, 'UNKNOWN');
    assert.equal(runGate(dir).status, 0, 'docs-only commits skip the test requirement');
  });
});

test('backpressure-skip overrides a blocking case and is consumed', () => {
  withRepo(CRITICAL, (dir) => {
    setStatus(dir, 'UNKNOWN');
    const skip = join(dir, 'docs', 'harness', 'backpressure-skip');
    mkdirSync(dirname(skip), { recursive: true });
    writeFileSync(skip, '');
    assert.equal(runGate(dir).status, 0, 'skip flag allows the commit');
    assert.equal(existsSync(skip), false, 'skip flag must be consumed (unlinked)');
  });
});

test('non-commit command is ignored (exit 0)', () => {
  withRepo(CRITICAL, (dir) => {
    setStatus(dir, 'UNKNOWN');
    assert.equal(runGate(dir, 'git status').status, 0, 'only git commit is gated');
  });
});

// --- Risk assessment failure (git error) must fail CLOSED ---

test('risk assessment failure (non-git dir) → BLOCK, fail-closed', () => {
  withNonRepo((dir) => {
    setStatus(dir, 'UNKNOWN');
    const r = runGate(dir);
    assert.equal(r.status, 2, 'unassessable risk must fail closed (block)');
    assert.match(r.stderr, /HARNESS BLOCK/);
  });
});

test('risk assessment failure + skip flag → allow (skip still overrides)', () => {
  withNonRepo((dir) => {
    setStatus(dir, 'UNKNOWN');
    const skip = join(dir, 'docs', 'harness', 'backpressure-skip');
    mkdirSync(dirname(skip), { recursive: true });
    writeFileSync(skip, '');
    assert.equal(runGate(dir).status, 0, 'skip overrides an unassessable risk');
  });
});
