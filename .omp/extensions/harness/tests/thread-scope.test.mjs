// Unit tests for thread-scope.mjs (P2 iteration helper, seed AC4/AC7).
//
// Run: node --test .omp/extensions/harness/tests/thread-scope.test.mjs
//
// Covers: regen current-scope.md from an ACTIVE seed (+ thread_opened audit with provenance),
// --ac subset selection, refusal on a closed seed (terminal, reopen deferred), missing seed,
// and close (thread_closed verdict). No git; THREAD_SCOPE_CWD/THREAD_ID are test seams.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'thread-scope.mjs');

// Richer schema with nested must/verify sub-bullets — guards against counting them as AC.
const AC = [
  'acceptance_criteria:',
  '  - id: AC1',
  '    title: first thing',
  '    must:',
  '      - sub bullet a',
  '      - sub bullet b',
  '    verify:',
  '      - check a',
  '  - id: AC2',
  '    title: second thing',
  '    must:',
  '      - sub bullet c',
  '',
].join('\n');

function withSeed(seedBody, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'thread-scope-'));
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  if (seedBody !== null) writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), seedBody);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir, args, env = {}) {
  return spawnSync('node', [HELPER, ...args], {
    cwd: dir, encoding: 'utf-8', env: { ...process.env, THREAD_SCOPE_CWD: dir, ...env },
  });
}
const scope = (dir) => readFileSync(join(dir, 'docs', 'harness', 'current-scope.md'), 'utf-8');
const audit = (dir) => readFileSync(join(dir, 'docs', 'harness', 'audit.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);

test('open: active (approved) seed -> regen scope (all AC) + thread_opened provenance', () => {
  withSeed(`name: x\nstatus: approved\nversion: 2\ntask_id: "T1"\n${AC}`, (dir) => {
    const r = run(dir, ['open'], { THREAD_ID: 'T-test-1' });
    assert.equal(r.status, 0);
    const s = scope(dir);
    assert.match(s, /\*\*Thread-ID\*\*: T-test-1/);
    assert.match(s, /task_id T1, v2/);
    assert.equal((s.match(/- \[ \]/g) || []).length, 2);
    assert.match(s, /AC1 — first thing/);
    const ev = audit(dir).find((e) => e.event === 'thread_opened');
    assert.ok(ev, 'thread_opened event present');
    assert.equal(ev.meta.thread_id, 'T-test-1');
    assert.equal(ev.meta.seed_version, 2);
    assert.deepEqual(ev.meta.ac_targeted, ['AC1', 'AC2']);
  });
});

test('open --ac subset -> only selected AC in scope', () => {
  withSeed(`status: draft\nversion: 1\ntask_id: "T1"\n${AC}`, (dir) => {
    const r = run(dir, ['open', '--ac', 'AC2'], { THREAD_ID: 'T-test-2' });
    assert.equal(r.status, 0);
    const s = scope(dir);
    assert.equal((s.match(/- \[ \]/g) || []).length, 1);
    assert.match(s, /AC2 — second thing/);
    assert.doesNotMatch(s, /AC1/);
  });
});

test('open: no seed -> exit 1', () => {
  withSeed(null, (dir) => {
    assert.equal(run(dir, ['open']).status, 1);
  });
});

test('close: records thread_closed verdict with thread id parsed from scope', () => {
  withSeed(`status: approved\nversion: 1\ntask_id: "T1"\n${AC}`, (dir) => {
    run(dir, ['open'], { THREAD_ID: 'T-test-5' });
    const r = run(dir, ['close', '--verdict', 'PASS']);
    assert.equal(r.status, 0);
    const ev = audit(dir).find((e) => e.event === 'thread_closed');
    assert.ok(ev, 'thread_closed event present');
    assert.equal(ev.meta.thread_id, 'T-test-5');
    assert.equal(ev.meta.verdict, 'PASS');
  });
});

// --- parseAC robustness (findings C/D): undercount is the exact failure this tool guards ---

test('open: a column-0 comment between AC items does not truncate the block (C)', () => {
  const seed = [
    'status: approved', 'version: 1', 'task_id: "T1"',
    'acceptance_criteria:',
    '  - id: AC1',
    '    title: first',
    '# a stray top-level comment',
    '  - id: AC2',
    '    title: second',
    '',
  ].join('\n');
  withSeed(seed, (dir) => {
    const r = run(dir, ['open'], { THREAD_ID: 'T-c' });
    assert.equal(r.status, 0);
    assert.equal((scope(dir).match(/- \[ \]/g) || []).length, 2);
    assert.match(scope(dir), /AC2/);
  });
});

test('open: a real top-level key after the block still terminates it (no over-collect)', () => {
  const seed = [
    'status: approved', 'version: 1', 'task_id: "T1"',
    'acceptance_criteria:',
    '  - id: AC1',
    '    title: first',
    'decisions:',
    '  foo: bar',
    '',
  ].join('\n');
  withSeed(seed, (dir) => {
    const r = run(dir, ['open'], { THREAD_ID: 'T-k' });
    assert.equal(r.status, 0);
    assert.equal((scope(dir).match(/- \[ \]/g) || []).length, 1);
  });
});

test('open: tab-indented items are normalized, no sibling dropped (D)', () => {
  const seed = 'status: approved\nversion: 1\ntask_id: "T1"\nacceptance_criteria:\n\t- id: AC1\n\t  title: first\n  - id: AC2\n    title: second\n';
  withSeed(seed, (dir) => {
    const r = run(dir, ['open'], { THREAD_ID: 'T-d' });
    assert.equal(r.status, 0);
    assert.equal((scope(dir).match(/- \[ \]/g) || []).length, 2);
  });
});

// --- slice-2: closed-seed reopen (in-place edit; SSOT stays one living doc) ---

test('open: a closed (done) seed is REOPENED in place (status->approved, v+1, seed_reopened)', () => {
  withSeed(`name: x\nstatus: done\ncompleted: 2026-05-21\nversion: 2\ntask_id: "T1"\n${AC}`, (dir) => {
    const r = run(dir, ['open'], { THREAD_ID: 'T-reopen' });
    assert.equal(r.status, 0);
    const seedAfter = readFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), 'utf-8');
    assert.match(seedAfter, /^status: approved$/m);
    assert.match(seedAfter, /^version: 3$/m);
    assert.doesNotMatch(seedAfter, /completed:/);
    const ev = audit(dir);
    const reopened = ev.find((e) => e.event === 'seed_reopened');
    assert.ok(reopened, 'seed_reopened event present');
    assert.equal(reopened.meta.from_version, 2);
    assert.equal(reopened.meta.to_version, 3);
    assert.ok(ev.find((e) => e.event === 'thread_opened'), 'thread_opened after reopen');
    assert.equal((scope(dir).match(/- \[ \]/g) || []).length, 2);
  });
});
