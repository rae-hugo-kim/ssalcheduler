// Tests for gates/estimate.mjs — the estimate-vs-actual helpers review-gate imports
// (seed 20260918-023000-e5a1, AC3/AC4). Pure functions: no git, no filesystem.
//
// Run: node --test .omp/extensions/harness/tests/estimate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEstimate, countFailsSince, buildEstimateEvent, ESTIMATE_MAGIC } from '../gates/estimate.mjs';

const VALID = [ESTIMATE_MAGIC, 'medium', 3, 'high', 'claude-fable-5-1', 'high', '2026-09-18T02:00:00Z'];

test('parseEstimate: a valid tuple yields named fields', () => {
  const { fields, problems } = parseEstimate(JSON.stringify(VALID));
  assert.deepEqual(problems, []);
  assert.deepEqual(fields, { risk: 'medium', files: 3, depth: 'high', model: 'claude-fable-5-1', effort: 'high', ts: '2026-09-18T02:00:00Z' });
});

test('parseEstimate: effort may be null, files may be 0', () => {
  const t = [...VALID]; t[2] = 0; t[5] = null;
  const { fields, problems } = parseEstimate(JSON.stringify(t));
  assert.deepEqual(problems, []);
  assert.equal(fields.effort, null);
  assert.equal(fields.files, 0);
});

// AC4: every malformed shape is rejected with a named problem and no fields — the caller turns
// this into exactly one warning and leaves the file on disk.
test('parseEstimate: malformed records are rejected, never partially accepted', () => {
  const cases = [
    ['not json', 'garbage', /not valid JSON/],
    ['object form', JSON.stringify({ risk: 'high' }), /not a JSON array/],
    ['wrong arity', JSON.stringify(VALID.slice(0, 6)), /wrong arity/],
    ['wrong magic', JSON.stringify(['omp-estimate/v0', ...VALID.slice(1)]), /element 0/],
    ['risk enum', JSON.stringify([VALID[0], 'severe', ...VALID.slice(2)]), /element 1/],
    ['files float', JSON.stringify([VALID[0], VALID[1], 2.5, ...VALID.slice(3)]), /element 2/],
    ['files negative', JSON.stringify([VALID[0], VALID[1], -1, ...VALID.slice(3)]), /element 2/],
    ['depth enum', JSON.stringify([...VALID.slice(0, 3), 'medium', ...VALID.slice(4)]), /element 3/],
    ['model empty', JSON.stringify([...VALID.slice(0, 4), ' ', ...VALID.slice(5)]), /element 4/],
    ['effort number', JSON.stringify([...VALID.slice(0, 5), 3, VALID[6]]), /element 5/],
    ['ts junk', JSON.stringify([...VALID.slice(0, 6), 'yesterday']), /element 6/],
    ['ts year only', JSON.stringify([...VALID.slice(0, 6), '2026']), /element 6/],
    ['ts epoch string', JSON.stringify([...VALID.slice(0, 6), '0']), /element 6/],
    ['ts prose', JSON.stringify([...VALID.slice(0, 6), 'September 18, 2026']), /element 6/],
    ['ts no zone', JSON.stringify([...VALID.slice(0, 6), '2026-09-18T02:00:00']), /element 6/],
    ['ts calendar overflow', JSON.stringify([...VALID.slice(0, 6), '2026-02-30T00:00:00Z']), /element 6/],
    ['ts month 13', JSON.stringify([...VALID.slice(0, 6), '2026-13-01T00:00:00Z']), /element 6/],
  ];
  for (const [name, text, re] of cases) {
    const { fields, problems } = parseEstimate(text);
    assert.equal(fields, null, `${name}: fields must be null`);
    assert.ok(problems.some((p) => re.test(p)), `${name}: expected a problem matching ${re}, got ${JSON.stringify(problems)}`);
  }
});

const line = (o) => JSON.stringify(o) + '\n';
const LOG =
  line({ ts: '2026-09-18T01:00:00.000Z', kind: 'test', type: 'test', result: 'FAIL' }) +   // before
  line({ ts: '2026-09-18T02:00:00.000Z', kind: 'test', type: 'test', result: 'FAIL' }) +   // equal — not after
  line({ ts: '2026-09-18T02:00:01.000Z', kind: 'test', type: 'test', result: 'PASS' }) +
  line({ ts: '2026-09-18T02:30:00.000Z', kind: 'test', type: 'lint', result: 'FAIL' }) +   // after
  line({ ts: '2026-09-18T02:40:00.000Z', kind: 'commit', result: 'FAIL', cmd: 'git commit' }) + // not a test
  'this line is not json "FAIL"\n' +
  line({ ts: '2026-09-18T03:00:00.000Z', kind: 'test', type: 'build', result: 'FAIL' });   // after

test('countFailsSince: counts only test-kind FAIL entries strictly after ts', () => {
  assert.equal(countFailsSince(LOG, '2026-09-18T02:00:00Z'), 2);
  assert.equal(countFailsSince(LOG, '2026-09-18T00:00:00Z'), 4);
  assert.equal(countFailsSince(LOG, '2026-09-18T04:00:00Z'), 0);
});

test('countFailsSince: empty/unknown inputs count zero', () => {
  assert.equal(countFailsSince('', '2026-09-18T02:00:00Z'), 0);
  assert.equal(countFailsSince(LOG, 'not-a-date'), 0);
  assert.equal(countFailsSince(undefined, '2026-09-18T02:00:00Z'), 0);
});

test('countFailsSince: a partial window drops its cut leading line, a whole window keeps it', () => {
  const first = line({ ts: '2026-09-18T02:10:00.000Z', kind: 'test', type: 'test', result: 'FAIL' });
  const second = line({ ts: '2026-09-18T02:20:00.000Z', kind: 'test', type: 'test', result: 'FAIL' });
  // The gate hands over a byte window: a fragment of `first` plus all of `second`, flagged partial.
  assert.equal(countFailsSince(first.slice(20) + second, '2026-09-18T02:00:00Z', true), 1);
  // A window that starts exactly on a line boundary is still flagged partial by the reader (start>0),
  // and the caller pays one dropped whole line — but a whole-file window (partial=false) keeps all.
  assert.equal(countFailsSince(first + second, '2026-09-18T02:00:00Z', true), 1);
  assert.equal(countFailsSince(first + second, '2026-09-18T02:00:00Z', false), 2);
});

test('buildEstimateEvent: audit convention with predicted/actual/fails', () => {
  const predicted = { risk: 'medium', files: 3, depth: 'high', model: 'm', effort: null, ts: '2026-09-18T02:00:00Z' };
  const risk = { level: 'high', reason: '142+ lines of code changed', files: ['a.mjs', 'b.mjs'], diffSize: 142 };
  const ev = buildEstimateEvent(predicted, risk, 1, 'tester');
  assert.equal(ev.event, 'estimate_vs_actual');
  assert.equal(ev.actor, 'tester');
  assert.ok(!Number.isNaN(Date.parse(ev.ts)));
  assert.deepEqual(ev.meta, {
    predicted,
    actual: { risk: 'high', diffSize: 142, files: 2, reason: '142+ lines of code changed' },
    fails_since_estimate: 1,
  });
});

test('buildEstimateEvent: tolerates a risk result without diffSize/files', () => {
  const ev = buildEstimateEvent({}, { level: 'unknown', reason: 'git diff failed' }, 0, 'x');
  assert.deepEqual(ev.meta.actual, { risk: 'unknown', diffSize: null, files: null, reason: 'git diff failed' });
});
