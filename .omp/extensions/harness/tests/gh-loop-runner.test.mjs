// Unit tests for gh-loop-runner.mjs — the option-A runtime decision (start/resume/ignore) that the
// workflow template calls. No live GitHub: event/labels/permission are injected (the workflow's gh seam).
//
// Run: node --test .omp/extensions/harness/tests/gh-loop-runner.test.mjs
//
// Focus: the EXECUTABLE guard policy — bot self-exclusion, write+ permission, label gating, event
// routing, and the no-auto-merge invariant (the runner never decides to merge).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decideRun } from '../gh-loop-runner.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gh-loop-runner.mjs');
function runCli(args) {
  try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf-8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

const base = { state: 'open', actor: 'alice', actorPermission: 'write', botLogin: 'gh-loop-bot' };

test('resume: authorized comment on a needs-decision gh-loop issue', () => {
  const d = decideRun({ ...base, event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'] });
  assert.equal(d.action, 'resume');
});

test('start: gh-loop issue opened/labeled by an authorized actor', () => {
  assert.equal(decideRun({ ...base, event: 'issues', action: 'labeled', labels: ['gh-loop'] }).action, 'start');
  assert.equal(decideRun({ ...base, event: 'issues', action: 'opened', labels: [{ name: 'gh-loop' }] }).action, 'start');
});

test('bot self-exclusion: the loop never acts on its own events (no self-trigger)', () => {
  const d = decideRun({ ...base, actor: 'gh-loop-bot', event: 'issues', action: 'opened', labels: ['gh-loop'] });
  assert.equal(d.action, 'ignore');
  assert.match(d.reason, /self/);
});

test('marker self-exclusion: a comment carrying the agent gh-loop marker is ignored', () => {
  const d = decideRun({ ...base, event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'], commentBody: 'Decision?\n<!-- gh-loop:decision:abcd1234 -->' });
  assert.equal(d.action, 'ignore');
});

test('permission guard: triage/read/none are ignored; write+ proceeds', () => {
  for (const p of ['read', 'triage', 'none', '']) {
    const d = decideRun({ ...base, actorPermission: p, event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'] });
    assert.equal(d.action, 'ignore', `perm ${p || 'empty'} must be ignored`);
    assert.match(d.reason, /permission/);
  }
  for (const p of ['write', 'maintain', 'admin', 'ADMIN']) {
    const d = decideRun({ ...base, actorPermission: p, event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'] });
    assert.equal(d.action, 'resume', `perm ${p} must proceed`);
  }
});

test('label gating: non-gh-loop issue, closed issue, and comment without needs-decision -> ignore', () => {
  assert.equal(decideRun({ ...base, event: 'issues', action: 'opened', labels: ['bug'] }).action, 'ignore');
  assert.equal(decideRun({ ...base, state: 'closed', event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'] }).action, 'ignore');
  assert.equal(decideRun({ ...base, event: 'issue_comment', action: 'created', labels: ['gh-loop'] }).action, 'ignore'); // no needs-decision
});

test('no-auto-merge invariant: decideRun NEVER returns a merge action (AC6)', () => {
  const samples = [
    { event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'], commentBody: 'merge it now please' },
    { event: 'issues', action: 'labeled', labels: ['gh-loop'] },
    { event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'], commentBody: 'approve & merge' },
  ];
  for (const s of samples) {
    const d = decideRun({ ...base, ...s });
    assert.ok(['start', 'resume', 'ignore'].includes(d.action), `action must be start/resume/ignore, got ${d.action}`);
  }
});

test('CLI decide emits JSON; non-decide exits 1', () => {
  const r = runCli(['decide', '--event', 'issue_comment', '--action', 'created', '--labels', 'gh-loop,needs-decision', '--state', 'open', '--actor', 'alice', '--permission', 'write', '--bot-login', 'bot']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).action, 'resume');
  assert.equal(runCli(['frobnicate']).code, 1);
});

test('CLI: a comment by the bot login is ignored (self)', () => {
  const r = runCli(['decide', '--event', 'issue_comment', '--action', 'created', '--labels', 'gh-loop,needs-decision', '--state', 'open', '--actor', 'bot', '--permission', 'write', '--bot-login', 'bot']);
  assert.equal(JSON.parse(r.out).action, 'ignore');
});

test('fail-closed: unset/empty botLogin refuses to run (no self-trigger on misconfig)', () => {
  for (const bl of ['', undefined]) {
    const d = decideRun({ event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'], state: 'open', actor: 'bot', actorPermission: 'write', botLogin: bl });
    assert.equal(d.action, 'ignore', `botLogin=${JSON.stringify(bl)} must fail closed`);
    assert.match(d.reason, /bot identity/);
  }
  // even an authorized human comment is ignored until bot identity is configured
  assert.equal(decideRun({ event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'], state: 'open', actor: 'alice', actorPermission: 'write', botLogin: '' }).action, 'ignore');
});

test('marker self-exclusion is case-insensitive (GH-LOOP / gh-loop / no-space)', () => {
  for (const m of ['<!-- gh-loop:decision:abcd1234 -->', '<!-- GH-LOOP:decision:abcd1234 -->', '<!--gh-loop:x-->']) {
    const d = decideRun({ ...base, event: 'issue_comment', action: 'created', labels: ['gh-loop', 'needs-decision'], commentBody: `Q?\n${m}` });
    assert.equal(d.action, 'ignore', `marker ${m} must self-exclude`);
  }
});
