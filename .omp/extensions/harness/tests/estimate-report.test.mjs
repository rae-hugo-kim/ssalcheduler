// Tests for estimate-report.mjs (seed 20260918-023000-e5a1, AC6): a 5-event fixture audit.jsonl
// must render the bias table and the cell table deterministically.
//
// Run: node --test .omp/extensions/harness/tests/estimate-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents, renderReport } from '../estimate-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'estimate-report.mjs');

const ev = (predicted, actual, fails) => JSON.stringify({
  ts: '2026-09-18T03:00:00.000Z', event: 'estimate_vs_actual', actor: 't',
  meta: { predicted: { model: 'fable', effort: 'high', ts: '2026-09-18T02:00:00Z', ...predicted }, actual: { reason: 'r', diffSize: 10, ...actual }, fails_since_estimate: fails },
});

const FIXTURE = [
  '{"ts":"2026-09-18T00:00:00Z","event":"kickoff_completed","actor":"assistant","meta":{}}',   // unrelated event
  ev({ risk: 'medium', files: 3, depth: 'high' }, { risk: 'high', files: 5 }, 1),
  ev({ risk: 'medium', files: 2, depth: 'low' }, { risk: 'medium', files: 2 }, 0),
  ev({ risk: 'low', files: 1, depth: 'low' }, { risk: 'low', files: 1 }, 0),
  ev({ risk: 'high', files: 8, depth: 'high', model: 'gpt' }, { risk: 'high', files: 4 }, 2),
  'not json at all',
  ev({ risk: 'high', files: 12, depth: 'high' }, { risk: 'high', files: 6 }, 0),
].join('\n') + '\n';

const EXPECTED = `# estimate-vs-actual — 5 commit(s)

## 1. Bias — predicted (rows) × measured (columns)

| predicted \\ actual | low | medium | high | total |
|--------------------|-----|--------|------|-------|
| low                | 1   | 0      | 0    | 1     |
| medium             | 0   | 1      | 1    | 2     |
| high               | 0   | 0      | 2    | 2     |

exact-level matches: 4/5
files predicted/actual — median ratio: 1.00 over 5 commit(s) with files>0

## 2. Cells — (predicted risk, depth, model)

| risk   | depth | model | commits | FAILs after estimate |
|--------|-------|-------|---------|----------------------|
| low    | low   | fable | 1       | 0                    |
| medium | high  | fable | 1       | 1                    |
| medium | low   | fable | 1       | 0                    |
| high   | high  | fable | 1       | 0                    |
| high   | high  | gpt   | 1       | 2                    |
`;

test('readEvents: keeps only well-formed estimate_vs_actual events', () => {
  const events = readEvents(FIXTURE);
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.event === 'estimate_vs_actual'));
});

test('renderReport: the 5-event fixture renders the expected tables byte-for-byte', () => {
  assert.equal(renderReport(readEvents(FIXTURE)), EXPECTED);
});

test('readEvents/renderReport: prototype-named risk strings neither pass the shape check nor corrupt the tables', () => {
  // predicted.risk outside LEVELS is dropped at readEvents.
  const badP = JSON.stringify({ event: 'estimate_vs_actual', meta: { predicted: { risk: '__proto__', files: 1, depth: 'low', model: 'm' }, actual: { risk: 'low', files: 1 } } });
  assert.equal(readEvents(FIXTURE + badP + '\n').length, 5);
  // actual.risk is a free string (risk-assess may say unknown/none): '__proto__' must render as a
  // plain extra column with a count of 1, never as inherited object members.
  const badA = ev({ risk: 'low', files: 1, depth: 'low' }, { risk: '__proto__', files: 1 }, 0);
  const out = renderReport(readEvents(FIXTURE + badA + '\n'));
  assert.match(out, /\| predicted \\ actual \| low \| medium \| high \| __proto__ \| total \|/);
  assert.match(out, /\| low +\| 1 +\| 0 +\| 0 +\| 1 +\| 2 +\|/);
  assert.doesNotMatch(out, /\[object Object\]|NaN/);
});

test('renderReport: empty input renders headers with no rows', () => {
  const out = renderReport([]);
  assert.match(out, /^# estimate-vs-actual — 0 commit\(s\)/);
  assert.match(out, /median ratio: n\/a over 0 commit/);
});

test('CLI: prints the report for a given audit path and fails on a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'estrep-'));
  const p = join(dir, 'audit.jsonl');
  writeFileSync(p, FIXTURE);
  const ok = spawnSync(process.execPath, [SCRIPT, p], { encoding: 'utf-8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, EXPECTED);
  const missing = spawnSync(process.execPath, [SCRIPT, join(dir, 'nope.jsonl')], { encoding: 'utf-8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read/);
});
