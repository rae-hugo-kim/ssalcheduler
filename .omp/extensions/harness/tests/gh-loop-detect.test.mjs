// Unit tests for gh-loop-detect.mjs — auto-detect gh-loop findings + plan issues (autonomy Q2.7-4).
// No live GitHub: source entries / existing issues are injected.
//
// Run: node --test .omp/extensions/harness/tests/gh-loop-detect.test.mjs
//
// Focus: breadcrumb FAIL extraction with FAIL->later-PASS suppression, and batch planning that
// reuses decideIssue (dedup against existing + within the batch, throttle via cap).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fromBreadcrumb, planIssues } from '../gh-loop-detect.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gh-loop-detect.mjs');
function runCli(args) {
  try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf-8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('fromBreadcrumb: an unresolved test FAIL becomes a finding', () => {
  const f = fromBreadcrumb([{ kind: 'test', type: 'node-test', result: 'FAIL', ts: 't1' }]);
  assert.equal(f.length, 1);
  assert.match(f[0].title, /Verification failing: node-test/);
});

test('fromBreadcrumb: no coarse-type suppression — every FAIL emits (dedup/cap/triage handle the rest)', () => {
  // breadcrumb `type` is coarse (test/lint/build); a later PASS cannot prove a DIFFERENT failing suite
  // was fixed, so masking would drop real failures. Emit; planIssues dedups repeats.
  const f = fromBreadcrumb([
    { kind: 'test', type: 'node-test', result: 'FAIL' },
    { kind: 'test', type: 'node-test', result: 'PASS' },
  ]);
  assert.equal(f.length, 1, 'FAIL still emits even with a later same-type PASS');
});

test('fromBreadcrumb: repeated same-type FAILs share a title (so planIssues dedups to one issue)', () => {
  const f = fromBreadcrumb([
    { kind: 'test', type: 'node-test', result: 'FAIL' },
    { kind: 'test', type: 'node-test', result: 'FAIL' },
  ]);
  assert.equal(f.length, 2);
  assert.equal(f[0].title, f[1].title);
});

test('fromBreadcrumb: commit FAIL/BLOCKED -> finding; PASS/edit/scope/UNVERIFIED/PENDING -> nothing', () => {
  assert.equal(fromBreadcrumb([{ kind: 'commit', result: 'FAIL', cmd: 'git commit -m x' }]).length, 1);
  // #48-6: a gate-blocked commit (target repo recorded no commit) is a failed commit too.
  assert.equal(fromBreadcrumb([{ kind: 'commit', result: 'BLOCKED', cmd: 'git commit -m x' }]).length, 1);
  assert.equal(fromBreadcrumb([
    { kind: 'commit', result: 'UNVERIFIED', cmd: 'cd x && git commit' },
    { kind: 'commit', result: 'PENDING', cmd: 'git commit -m z' },
    { kind: 'test', type: 'test', result: 'BLOCKED' },
  ]).length, 0);
  assert.equal(fromBreadcrumb([
    { kind: 'test', type: 'node-test', result: 'PASS' },
    { kind: 'edit', file: 'a.ts' },
    { kind: 'scope', file: 'current-scope.md' },
    { kind: 'commit', hash: 'abc123', cmd: 'git commit -m y' },
  ]).length, 0);
});

test('planIssues: new findings -> create', () => {
  const plan = planIssues([{ title: 'A', body: 'a' }], { existing: [] });
  assert.equal(plan[0].action, 'create');
});

test('planIssues: two identical findings in one batch -> create then skip (batch dedup)', () => {
  const plan = planIssues([{ title: 'Same finding' }, { title: 'Same finding' }], { existing: [] });
  assert.deepEqual(plan.map((p) => p.action), ['create', 'skip']);
});

test('planIssues: cap throttles after N creates', () => {
  const plan = planIssues([{ title: 'A' }, { title: 'B' }, { title: 'C' }], { existing: [], cap: 2 });
  assert.deepEqual(plan.map((p) => p.action), ['create', 'create', 'block']);
});

test('planIssues: dedups against pre-existing open issues', () => {
  const plan = planIssues([{ title: 'dupe' }], { existing: [{ number: 9, title: 'dupe', body: 'x' }] });
  assert.equal(plan[0].action, 'skip');
});

test('CLI --from breadcrumb reads a JSONL log and plans creates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghdetect-'));
  const log = join(dir, 'session-log.jsonl');
  writeFileSync(log, [
    JSON.stringify({ kind: 'test', type: 'node-test', result: 'FAIL' }),
    JSON.stringify({ kind: 'edit', file: 'a.ts' }),
  ].join('\n') + '\n');
  const r = runCli(['detect', '--from', 'breadcrumb', '--log', log]);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.equal(out.creates, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI --from json plans from a generic findings list (lint/review extension)', () => {
  const r = runCli(['detect', '--from', 'json', '--findings-json', JSON.stringify([{ title: 'lint: no-unused-vars', body: 'x' }])]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).creates, 1);
});

test('CLI: a SUPPLIED but unparseable --existing-json fails CLOSED (empty plan)', () => {
  const r = runCli(['detect', '--from', 'json', '--findings-json', '[{"title":"X"}]', '--existing-json', 'not json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.plan, []);
  assert.match(out.error, /existing-json/);
});

test('CLI: omitting --cap defaults to a finite throttle (5), not unbounded (flood guard)', () => {
  const findings = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ title: `F${i}` })));
  const r = runCli(['detect', '--from', 'json', '--findings-json', findings]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).creates, 5);
});

test('CLI: a SUPPLIED but unparseable --findings-json fails CLOSED (error, empty plan)', () => {
  const r = runCli(['detect', '--from', 'json', '--findings-json', 'not json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.deepEqual(out.plan, []);
  assert.match(out.error, /findings-json/);
});
