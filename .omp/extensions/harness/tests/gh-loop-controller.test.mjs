// Unit tests for gh-loop-controller.mjs — the multisession fan-out controller DECISION logic
// (autonomy Q3). No processes/network: tasks/state/issues are injected (git/spawn/gh are seams).
//
// Run: node --test .omp/extensions/harness/tests/gh-loop-controller.test.mjs
//
// Focus: pool shaping under a cap, dynamic scale up/down/hold, and claim-based assignment (no two
// workers grab the same issue).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planPool, nextScale, assign, desiredWorkers } from '../gh-loop-controller.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gh-loop-controller.mjs');
function runCli(args) {
  try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf-8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('desiredWorkers: fix=1; review scales by changed files; high-risk review +1', () => {
  assert.equal(desiredWorkers({ id: 1, kind: 'fix' }), 1);
  assert.equal(desiredWorkers({ id: 1, kind: 'review', changedFiles: 20 }), 3); // ceil(20/8)
  assert.equal(desiredWorkers({ id: 1, kind: 'review', changedFiles: 8, risk: 'high' }), 2); // 1 + heterogeneous
  assert.equal(desiredWorkers(null), 0);
});

test('planPool: one worker per fix task, bounded by cap; overflow queued', () => {
  const tasks = [1, 2, 3, 4].map((id) => ({ id, kind: 'fix' }));
  const p = planPool(tasks, { cap: 3 });
  assert.equal(p.workers.length, 3);
  assert.equal(p.queued.length, 1);
  assert.equal(p.cap, 3);
});

test('planPool: review task scales reviewers by changed files (within cap)', () => {
  const p = planPool([{ id: 9, kind: 'review', changedFiles: 16 }], { cap: 5 });
  assert.equal(p.workers.length, 2); // ceil(16/8)
  assert.ok(p.workers.every((w) => w.role === 'reviewer'));
});

test('planPool: empty/idless tasks -> empty plan; default cap 3', () => {
  assert.deepEqual(planPool([], {}).workers, []);
  assert.deepEqual(planPool([{ kind: 'fix' }], {}).workers, []); // no id -> skipped
  assert.equal(planPool([{ id: 1, kind: 'fix' }]).cap, 3);
});

test('nextScale: backlog + room -> up (delta capped to cap-running)', () => {
  assert.deepEqual(nextScale({ running: 1, backlog: 5, idle: [] }, { cap: 3 }), { action: 'up', delta: 2 });
});

test('nextScale: backlog but at cap -> hold', () => {
  assert.deepEqual(nextScale({ running: 3, backlog: 5, idle: [] }, { cap: 3 }), { action: 'hold' });
});

test('nextScale: no backlog + idle workers -> down (drain idle)', () => {
  const d = nextScale({ running: 2, backlog: 0, idle: ['w1', 'w2'] }, { cap: 3 });
  assert.equal(d.action, 'down');
  assert.deepEqual(d.retire, ['w1', 'w2']);
});

test('nextScale: steady (no backlog, no idle) and empty state -> hold', () => {
  assert.deepEqual(nextScale({ running: 2, backlog: 0, idle: [] }, { cap: 3 }), { action: 'hold' });
  assert.deepEqual(nextScale({}, { cap: 3 }), { action: 'hold' });
});

test('assign: unclaimed -> assignable; claimed (number or {number}) or in-progress label -> skip', () => {
  const r = assign(
    [{ number: 1 }, { number: 2 }, { number: 3, labels: [{ name: 'gh-loop:in-progress' }] }, { number: 4, labels: [{ name: 'gh-loop' }] }],
    { claimed: [2] },
  );
  assert.deepEqual(r.assignable.map((a) => a.issue), [1, 4]); // 2 claimed, 3 in-progress
  assert.deepEqual(r.skipped.map((s) => s.issue), [2, 3]);
  // {number} form in claimed also works
  assert.equal(assign([{ number: 7 }], { claimed: [{ number: 7 }] }).skipped.length, 1);
});

test('CLI: plan/scale/assign emit decision JSON; bad mode exits 1; invalid json -> error', () => {
  assert.equal(JSON.parse(runCli(['plan', '--tasks-json', '[{"id":1,"kind":"fix"}]', '--cap', '3']).out).workers.length, 1);
  assert.deepEqual(JSON.parse(runCli(['scale', '--state-json', '{"running":1,"backlog":5}', '--cap', '3']).out), { action: 'up', delta: 2 });
  assert.equal(JSON.parse(runCli(['assign', '--issues-json', '[{"number":1}]', '--claimed-json', '[1]']).out).skipped.length, 1);
  assert.equal(runCli(['frobnicate']).code, 1);
  assert.match(JSON.parse(runCli(['plan', '--tasks-json', 'notjson']).out).error, /tasks-json/);
});

test('fractional/sub-1 cap is floored to an integer ceiling (never exceeded)', () => {
  const p = planPool([1, 2, 3].map((id) => ({ id, kind: 'fix' })), { cap: 2.5 });
  assert.equal(p.workers.length, 2); // floor(2.5)
  assert.equal(p.cap, 2);
  assert.deepEqual(nextScale({ running: 1, backlog: 5, idle: [] }, { cap: 2.5 }), { action: 'up', delta: 1 });
});

test('assign: a duplicate issue in the input list is NOT double-assigned', () => {
  const r = assign([{ number: 20 }, { number: 20 }], { claimed: [] });
  assert.equal(r.assignable.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /duplicate/);
});

test('assign: string-vs-number claimed id still matches (cross-source type drift)', () => {
  assert.equal(assign([{ number: 1 }], { claimed: ['1'] }).assignable.length, 0);
});

test('planPool: a huge changedFiles cannot allocate unbounded slots (clamped to cap)', () => {
  const p = planPool([{ id: 1, kind: 'review', changedFiles: 1e9 }], { cap: 3 });
  assert.equal(p.workers.length, 3);
  assert.equal(p.queued.length, 0); // per-task clamp prevents the 125M-slot DoS
});
