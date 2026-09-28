// Unit tests for breadcrumb-surface.mjs (seed AC3) — session_start surfaces recent docs/sum.
// Run: node --test .omp/extensions/harness/tests/breadcrumb-surface.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'breadcrumb-surface.mjs');

function run(dir) {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({ session_state: { cwd: dir } }),
    encoding: 'utf-8',
  });
}
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'surface-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('surfaces recent docs/sum/*.md in the session_start note', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'docs', 'sum'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'sum', 'session_a.md'), '# a');
    writeFileSync(join(dir, 'docs', 'sum', 'session_b.md'), '# b');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /docs\/sum/);
    assert.match(r.stdout, /session_a\.md|session_b\.md/);
  });
});

test('no docs/sum -> no output, exit 0', () => {
  withDir((dir) => {
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

test('empty docs/sum -> no output, exit 0', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'docs', 'sum'), { recursive: true });
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

test('bad input -> exit 0, no crash', () => {
  const r = spawnSync('node', [GATE], { input: 'not json', encoding: 'utf-8' });
  assert.equal(r.status, 0);
});
