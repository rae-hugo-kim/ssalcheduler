// Unit tests for gh-loop-issue.mjs — the finding/decision -> `gh issue create` DECISION used by
// the gh-loop skill (autonomy Q2, seed AC3/AC4). No live GitHub: `existing` is injected.
//
// Run: node --test .omp/extensions/harness/tests/gh-loop-issue.test.mjs
//
// Focus: dedup (marker + normalized title), throttle (per-run cap = loop-safety), dedup-before-
// throttle precedence, label assembly by kind, and a fail-safe block on empty title.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideIssue, normalizeTitle, dedupMarker, assembleLabels,
} from '../gh-loop-issue.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'gh-loop-issue.mjs');
function runCli(args) {
  try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf-8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
}

test('new finding -> create with gh-loop label and embedded marker', () => {
  const d = decideIssue({ kind: 'finding', title: 'Flaky retry in worker', existing: [] });
  assert.equal(d.action, 'create');
  assert.equal(d.payload.title, 'Flaky retry in worker');
  assert.deepEqual(d.payload.labels, ['gh-loop']);
  assert.ok(d.payload.body.includes(d.marker), 'body carries the dedup marker');
});

test('decision kind -> needs-decision label (HITL question issue, AC2)', () => {
  const d = decideIssue({ kind: 'decision', title: 'Merge auth refactor PR #12?', existing: [] });
  assert.equal(d.action, 'create');
  assert.deepEqual(d.payload.labels, ['gh-loop', 'needs-decision']);
});

test('dedup by normalized title (case/whitespace-insensitive) -> skip', () => {
  const existing = [{ number: 7, title: 'flaky   RETRY in worker', labels: ['gh-loop'], body: 'x' }];
  const d = decideIssue({ kind: 'finding', title: 'Flaky retry in worker', existing });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /#7/);
});

test('dedup by marker survives a human-edited title -> skip', () => {
  const marker = dedupMarker('finding', 'Flaky retry in worker');
  const existing = [{ number: 9, title: 'totally different wording now', body: `note\n${marker}` }];
  const d = decideIssue({ kind: 'finding', title: 'Flaky retry in worker', existing });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /#9/);
});

test('throttle: created >= cap -> block; created < cap -> create', () => {
  assert.equal(decideIssue({ title: 'new one', cap: 3, created: 3, existing: [] }).action, 'block');
  assert.equal(decideIssue({ title: 'new one', cap: 3, created: 2, existing: [] }).action, 'create');
});

test('dedup takes precedence over throttle (a re-seen finding never consumes budget)', () => {
  const existing = [{ number: 1, title: 'new one', body: 'x' }];
  const d = decideIssue({ title: 'new one', cap: 1, created: 5, existing });
  assert.equal(d.action, 'skip', 'duplicate is skip even when over cap');
});

test('empty / whitespace title -> fail-safe block', () => {
  assert.equal(decideIssue({ title: '', existing: [] }).action, 'block');
  assert.equal(decideIssue({ title: '   ', existing: [] }).action, 'block');
  assert.equal(decideIssue({ existing: [] }).action, 'block');
});

test('body already carrying the marker is not double-appended', () => {
  const marker = dedupMarker('finding', 'X');
  const d = decideIssue({ title: 'X', body: `pre\n${marker}`, existing: [] });
  assert.equal(d.action, 'create');
  assert.equal(d.payload.body.split(marker).length - 1, 1, 'marker appears exactly once');
});

test('assembleLabels: kind base + extras, unique, order-stable', () => {
  assert.deepEqual(assembleLabels('finding', ['bug', 'gh-loop', 'bug']), ['gh-loop', 'bug']);
  assert.deepEqual(assembleLabels('decision', ['p1']), ['gh-loop', 'needs-decision', 'p1']);
});

test('normalizeTitle + dedupMarker are stable and kind-keyed', () => {
  assert.equal(normalizeTitle('  A  B '), 'a b');
  assert.equal(dedupMarker('finding', 'A B'), dedupMarker('finding', 'a   b'), 'stable across case/space');
  assert.notEqual(dedupMarker('finding', 'A'), dedupMarker('decision', 'A'), 'kind-keyed');
});

test('throttle backstop: OPEN-issue count reaching cap blocks even when created=0', () => {
  const existing = [{ title: 'a', body: 'x' }, { title: 'b', body: 'y' }];
  const d = decideIssue({ title: 'brand new finding', cap: 2, created: 0, existing });
  assert.equal(d.action, 'block', 'observed open count is a backstop independent of --created');
  assert.match(d.reason, /open issues 2\/2/);
});

test('non-array labels / non-string body do not throw (API-misuse hardening)', () => {
  const d = decideIssue({ title: 'X', body: 12345, labels: 'bug', existing: [] });
  assert.equal(d.action, 'create');
  assert.ok(d.payload.body.includes(d.marker), 'coerced body still carries marker');
  assert.deepEqual(d.payload.labels, ['gh-loop'], 'string label is ignored, not spread into chars');
});

test('CLI decide: create emits the decision JSON on stdout (exit 0)', () => {
  const r = runCli(['decide', '--kind', 'finding', '--title', 'pool exhausted', '--label', 'bug']);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.equal(d.action, 'create');
  assert.deepEqual(d.payload.labels, ['gh-loop', 'bug']);
});

test('CLI decide: SUPPLIED but unparseable --existing-json -> fail-CLOSED block', () => {
  const r = runCli(['decide', '--kind', 'finding', '--title', 'X', '--existing-json', 'not json']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).action, 'block', 'corrupt existing list must NOT create — dedup/throttle would be silently disabled');
});

test('CLI decide: a BARE --existing-json flag (no value) -> fail-CLOSED block', () => {
  const r = runCli(['decide', '--kind', 'finding', '--title', 'X', '--existing-json']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).action, 'block', 'a supplied-but-valueless flag must not silently disable dedup');
});

test('CLI decide: OMITTED --existing-json is fine (empty list -> create)', () => {
  const r = runCli(['decide', '--kind', 'finding', '--title', 'X']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).action, 'create');
});

test('CLI: a non-decide subcommand exits 1 (usage)', () => {
  assert.equal(runCli(['frobnicate']).code, 1);
});

test('CLI --out writes action/title/body.md/labels for the skill (node-only, no jq); hostile title stays literal', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.tmp-ghloop-out-test');
  rmSync(dir, { recursive: true, force: true });
  const r = runCli(['decide', '--kind', 'finding', '--title', 'X $(touch /tmp/pwn)', '--body', 'b', '--label', 'bug', '--out', dir]);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dir, 'action'), 'utf-8').trim(), 'create');
  assert.equal(readFileSync(join(dir, 'title'), 'utf-8').trim(), 'X $(touch /tmp/pwn)', 'title persisted as literal data');
  assert.ok(readFileSync(join(dir, 'body.md'), 'utf-8').includes('<!-- gh-loop:'), 'body.md carries marker');
  assert.deepEqual(readFileSync(join(dir, 'labels'), 'utf-8').split('\n').filter(Boolean), ['gh-loop', 'bug']);
  rmSync(dir, { recursive: true, force: true });
});

test('kind is the MARKER, not the needs-decision STATE label (finding vs decision dedup)', () => {
  // a finding (no decision marker) must NOT dedup a decision of the same title:
  const finding = [{ number: 5, title: 'Merge auth PR #12?', labels: [{ name: 'gh-loop' }], body: 'x' }];
  assert.equal(decideIssue({ kind: 'decision', title: 'Merge auth PR #12?', existing: finding }).action, 'create');
  // a real decision issue (carries the decision marker) DOES dedup a decision:
  const decision = [{ number: 6, title: 'Merge auth PR #12?', body: 'q\n<!-- gh-loop:decision:deadbeef -->' }];
  assert.equal(decideIssue({ kind: 'decision', title: 'Merge auth PR #12?', existing: decision }).action, 'skip');
  // a PAUSED finding (needs-decision label = transient STATE) must NOT be read as a decision:
  const paused = [{ number: 7, title: 'Merge auth PR #12?', labels: [{ name: 'needs-decision' }], body: 'f\n<!-- gh-loop:finding:cafef00d -->' }];
  assert.equal(decideIssue({ kind: 'decision', title: 'Merge auth PR #12?', existing: paused }).action, 'create');
});

test('labels with CR/LF are collapsed, not split into extra --label args', () => {
  const d = decideIssue({ title: 'X', labels: ['security\nneeds-decision'], existing: [] });
  assert.equal(d.action, 'create');
  assert.ok(d.payload.labels.every((l) => !/[\r\n]/.test(l)), 'no label carries a newline');
  assert.deepEqual(d.payload.labels, ['gh-loop', 'security needs-decision']);
});

test('skip exposes the duplicate issue number (dup) for the skill to comment on', () => {
  const d = decideIssue({ kind: 'finding', title: 'flaky retry', existing: [{ number: 42, title: 'flaky retry', body: 'x' }] });
  assert.equal(d.action, 'skip');
  assert.equal(d.dup, 42);
});

test('CLI --out on skip writes action+reason+dup (skill skip branch needs the dup #)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.tmp-ghloop-skip-test');
  rmSync(dir, { recursive: true, force: true });
  const existing = JSON.stringify([{ number: 7, title: 'dupe finding', body: 'x' }]);
  const r = runCli(['decide', '--kind', 'finding', '--title', 'dupe finding', '--existing-json', existing, '--out', dir]);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(dir, 'action'), 'utf-8').trim(), 'skip');
  assert.equal(readFileSync(join(dir, 'dup'), 'utf-8').trim(), '7');
  assert.match(readFileSync(join(dir, 'reason'), 'utf-8'), /#7/);
  rmSync(dir, { recursive: true, force: true });
});
