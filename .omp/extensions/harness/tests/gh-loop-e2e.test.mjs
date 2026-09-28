// End-to-end COMPOSITION test for the autonomy loop (analysis Q1-Q3). It wires the four gh-loop
// helpers output->input — breadcrumb -> detect(findings/plan) -> issue payload -> runner(start) ->
// controller(pool/assign) — to prove they COMPOSE, not just that each works in isolation. The unit
// suites already cover each helper; this guards the SEAMS between them that a per-file test cannot
// see: the dedup marker round-trip, the label-gating handoff (detect's labels must satisfy the
// runner's gate), and the issue->task mapping the controller consumes.
//
// gh/git/spawn stay seams: the GitHub round-trip is modelled by feeding a created issue's
// {number,title,body,labels} back as `existing` (the live throwaway-repo run validated that the real
// `gh issue create`/`gh issue list --json body` preserves the marker + labels verbatim). NOTE the
// model assumes `gh issue list` is immediately authoritative; the live run found it is NOT —
// `gh issue list` is eventually-consistent, so a re-list right after create can miss the new issue
// (within a run, planIssues' batch dedup covers this; see gh-loop SKILL Stage-1 consistency caveat).
//
// Run: node --test .omp/extensions/harness/tests/gh-loop-e2e.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBreadcrumb, planIssues } from '../gh-loop-detect.mjs';
import { decideRun } from '../gh-loop-runner.mjs';
import { planPool, assign, desiredWorkers } from '../gh-loop-controller.mjs';

const BOT = 'gh-loop-bot';

// Model `gh issue create` + `gh issue list --json number,title,body,labels`: a created issue carries
// the plan payload verbatim (body keeps the dedup marker) and gh returns labels as {name} objects.
function createIssues(plan, startNo = 100) {
  let n = startNo;
  return plan.filter((p) => p.action === 'create').map((p) => ({
    number: n++, title: p.payload.title, body: p.payload.body,
    labels: p.payload.labels.map((name) => ({ name })),
  }));
}

test('compose: breadcrumb -> findings -> plan (each FAIL -> a create; PASS/OK/scope are not findings)', () => {
  const breadcrumb = [
    { kind: 'commit', hash: 'abc1234', cmd: 'git commit -m feat', ts: 't0' },   // commit OK -> no finding
    { kind: 'test', type: 'node-test', result: 'PASS', ts: 't1' },              // pass    -> no finding
    { kind: 'test', type: 'node-test', result: 'FAIL', ts: 't2' },              // FAIL    -> finding
    { kind: 'commit', result: 'FAIL', cmd: 'git commit -m wip', ts: 't3' },     // FAIL    -> finding
    { kind: 'scope', file: 'docs/harness/current-scope.md', ts: 't4' },         // scope   -> no finding
  ];
  const findings = fromBreadcrumb(breadcrumb);
  assert.equal(findings.length, 2);
  const plan = planIssues(findings, { existing: [], cap: 5 });
  const creates = plan.filter((p) => p.action === 'create');
  assert.equal(creates.length, 2);
  for (const c of creates) {
    assert.ok(c.payload.labels.includes('gh-loop'), 'issue carries gh-loop label for runner gating');
    assert.ok(c.payload.labels.includes('failing-check'));
    assert.match(c.payload.body, /<!-- gh-loop:finding:[0-9a-f]{8} -->/, 'dedup marker embedded in body');
  }
});

test('compose: dedup is driven by the MARKER, not the title — survives a human title edit', () => {
  const findings = fromBreadcrumb([
    { kind: 'test', type: 'node-test', result: 'FAIL', ts: 't1' },
    { kind: 'commit', result: 'FAIL', cmd: 'git commit -m wip', ts: 't2' },
  ]);
  const open = createIssues(planIssues(findings, { existing: [], cap: 5 }));
  // a human renamed both issues; the body marker is now the ONLY link back to the finding. If dedup
  // leaned on the title (not the marker), this would wrongly create duplicates — so a skip here proves
  // the marker survived `gh issue create` -> `gh issue list --json body` and is what drives the dedup.
  const renamed = open.map((i, n) => ({ ...i, title: `triaged: unrelated ${n}` }));
  const plan2 = planIssues(findings, { existing: renamed, cap: 5 });
  assert.ok(plan2.every((p) => p.action === 'skip'), 'marker dedup must survive a title edit');
  assert.deepEqual(plan2.map((p) => p.dup).sort((a, b) => a - b), [100, 101]);
});

test('compose: a detect-created issue drives the runner to START (authorized), with guards intact', () => {
  const plan = planIssues(fromBreadcrumb([{ kind: 'test', type: 'node-test', result: 'FAIL' }]), { existing: [], cap: 5 });
  const [issue] = createIssues(plan);
  const ev = (over) => decideRun({ event: 'issues', action: 'opened', state: 'open', labels: issue.labels, actor: 'alice', actorPermission: 'write', botLogin: BOT, ...over });
  assert.equal(ev().action, 'start', 'authorized human opening a gh-loop issue starts the loop');
  const botSelf = ev({ actor: BOT });
  assert.equal(botSelf.action, 'ignore'); assert.match(botSelf.reason, /self/);          // bot self-exclusion
  const readOnly = ev({ actorPermission: 'read' });
  assert.equal(readOnly.action, 'ignore'); assert.match(readOnly.reason, /permission/);  // permission guard
  const noBot = ev({ botLogin: '' });
  assert.equal(noBot.action, 'ignore'); assert.match(noBot.reason, /fail-closed/);        // bot id unset
});

test('compose: runner START -> controller pool + assignment for that issue', () => {
  const plan = planIssues(fromBreadcrumb([{ kind: 'commit', result: 'FAIL', cmd: 'git commit -m wip' }]), { existing: [], cap: 5 });
  const [issue] = createIssues(plan);
  const decision = decideRun({ event: 'issues', action: 'opened', state: 'open', labels: issue.labels, actor: 'alice', actorPermission: 'admin', botLogin: BOT });
  assert.equal(decision.action, 'start');
  const task = { id: issue.number, kind: 'fix' };                     // a failing-check finding is a fix task
  const pool = planPool([task], { cap: 3 });
  assert.equal(pool.workers.length, 1);
  assert.equal(pool.workers[0].taskId, issue.number);
  assert.equal(pool.workers[0].role, 'fixer');
  assert.deepEqual(assign([issue], { claimed: [] }).assignable, [{ issue: issue.number }]);
  assert.equal(assign([issue], { claimed: [issue.number] }).assignable.length, 0); // claimed -> not re-assigned
  const busy = { ...issue, labels: [...issue.labels, { name: 'gh-loop:in-progress' }] };
  assert.equal(assign([busy], { claimed: [] }).skipped[0].reason, 'already claimed'); // in-progress label too
});

test('compose: throttle survives the full pipe — many findings, small cap', () => {
  const breadcrumb = Array.from({ length: 6 }, (_, i) => ({ kind: 'commit', result: 'FAIL', cmd: `git commit -m fix-${i}` }));
  const plan = planIssues(fromBreadcrumb(breadcrumb), { existing: [], cap: 2 });
  assert.equal(plan.filter((p) => p.action === 'create').length, 2);
  assert.equal(plan.filter((p) => p.action === 'block').length, 4);
});

test('compose: a review task fans out by changed files, bounded by cap (no unbounded queue)', () => {
  const task = { id: 7, kind: 'review', changedFiles: 40, risk: 'high' };
  assert.equal(desiredWorkers(task), 6);            // ceil(40/8)=5, +1 heterogeneous reviewer (high risk)
  const pool = planPool([task], { cap: 3 });
  assert.equal(pool.workers.length, 3);             // clamped to cap
  assert.equal(pool.queued.length, 0);              // per-task clamp -> no DoS queue
});

test('compose: full chain — one breadcrumb FAIL flows to exactly one assigned worker', () => {
  const findings = fromBreadcrumb([{ kind: 'test', type: 'node-test', result: 'FAIL', ts: 't' }]);
  const [issue] = createIssues(planIssues(findings, { existing: [], cap: 5 }));
  const run = decideRun({ event: 'issues', action: 'opened', state: 'open', labels: issue.labels, actor: 'alice', actorPermission: 'write', botLogin: BOT });
  assert.equal(run.action, 'start');
  const pool = planPool([{ id: issue.number, kind: 'fix' }], { cap: 3 });
  const a = assign([issue], { claimed: [] });
  assert.equal(pool.workers[0].taskId, issue.number);   // the issue detect planned ...
  assert.equal(a.assignable[0].issue, issue.number);    // ... is exactly the one the controller assigns
});
