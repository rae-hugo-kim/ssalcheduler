// search-anchor-tracking.test.mjs — grep/ast_grep [path#TAG] anchors satisfy context-gate.
//
// Run: node --test .omp/extensions/harness/tests/search-anchor-tracking.test.mjs
//
// omp's grep/ast_grep mint per-file `[path#TAG]` edit anchors backed by whole-file
// snapshots, and the edit tool accepts them ("from your latest read/search"). The
// harness only logged `read` results, so a grep-anchored edit false-blocked on
// context-gate — live-reproduced on omp 16.3.12 (2026-07-09): grep minted #6D72,
// the edit was rejected with "read it before editing". The fix routes search
// results into read-tracker via ONE batched `file_paths` spawn per result.
//
// Spawn-based like write-tracker.test.mjs: state is isolated under a per-test temp
// dir passed via session_state.cwd, so the real repo's .omp/harness-state is never
// touched (see memory: feedback_shell_test_cwd_isolation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates');
const READ_TRACKER = join(HARNESS, 'read-tracker.mjs');
const CONTEXT_GATE = join(HARNESS, 'context-gate.mjs');
const INDEX_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

function run(hook, payload, cwd) {
  return spawnSync('node', [hook], { input: JSON.stringify(payload), cwd, encoding: 'utf-8' });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sat-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function readLog(cwd) {
  const p = join(cwd, '.omp', 'harness-state', 'read-log.txt');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

test('read-tracker: a file_paths batch logs every entry in one spawn', () => {
  withTmp((cwd) => {
    const a = join(cwd, 'a.ts');
    const b = join(cwd, 'sub', 'b.ts');
    const r = run(READ_TRACKER, { tool_input: { file_paths: [a, b] }, session_state: { cwd } }, cwd);
    assert.equal(r.status, 0, r.stderr);
    const lines = readLog(cwd).split('\n');
    assert.ok(lines.includes(a), 'first batch entry must be logged');
    assert.ok(lines.includes(b), 'second batch entry must be logged');
  });
});

test('read-tracker: batch dedups against the existing log AND within itself', () => {
  withTmp((cwd) => {
    const a = join(cwd, 'a.ts');
    const b = join(cwd, 'b.ts');
    run(READ_TRACKER, { tool_input: { file_path: a }, session_state: { cwd } }, cwd);
    const afterSingle = readLog(cwd);
    run(READ_TRACKER, { tool_input: { file_paths: [a, b, b] }, session_state: { cwd } }, cwd);
    const after = readLog(cwd);
    assert.ok(after.startsWith(afterSingle), 'existing entries must be preserved, not rewritten');
    const occurrences = after.split('\n').filter((l) => l === b).length;
    // one new path appends the raw + normalized forms; on Linux they are equal -> 2 lines
    assert.equal(occurrences, 2, 'an in-batch duplicate must be appended exactly once');
    assert.equal(after.split('\n').filter((l) => l === a).length, 2, 'a re-sent known path must not grow the log');
  });
});

test('read-tracker: single file_path behavior is unchanged (back-compat)', () => {
  withTmp((cwd) => {
    const target = join(cwd, 'solo.ts');
    const r = run(READ_TRACKER, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readLog(cwd).split('\n').includes(target));
  });
});

test('read-tracker: non-string / empty batch entries are skipped, empty batch is a no-op', () => {
  withTmp((cwd) => {
    const ok = join(cwd, 'ok.ts');
    run(READ_TRACKER, { tool_input: { file_paths: ['', null, 42, ok] }, session_state: { cwd } }, cwd);
    const lines = readLog(cwd).split('\n').filter(Boolean);
    assert.deepEqual(lines, [ok, ok], 'only the valid entry (raw + normalized) may be logged');
    const before = readLog(cwd);
    run(READ_TRACKER, { tool_input: { file_paths: [] }, session_state: { cwd } }, cwd);
    assert.equal(readLog(cwd), before, 'an empty batch must write nothing');
  });
});

test('end-to-end: a search-certified file is editable without a prior read (the fix)', () => {
  withTmp((cwd) => {
    const target = join(cwd, 'found.ts');
    writeFileSync(target, 'export const x = 1;\n'); // pre-existing on disk, never read
    // grep result arrives: adapter feeds its details.files batch into read-tracker
    run(READ_TRACKER, { tool_input: { file_paths: [target] }, session_state: { cwd } }, cwd);
    const g = run(CONTEXT_GATE, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(g.status, 0, `context-gate must allow editing a search-anchored file; stderr: ${g.stderr}`);
  });
});

test('regression: a file NOT covered by the search result stays blocked', () => {
  withTmp((cwd) => {
    const anchored = join(cwd, 'anchored.ts');
    const unread = join(cwd, 'unread.ts');
    writeFileSync(anchored, '1\n');
    writeFileSync(unread, '2\n');
    run(READ_TRACKER, { tool_input: { file_paths: [anchored] }, session_state: { cwd } }, cwd);
    assert.ok(readLog(cwd).split('\n').includes(anchored), 'anchored file must be logged (guards the block below)');
    const g = run(CONTEXT_GATE, { tool_input: { file_path: unread }, session_state: { cwd } }, cwd);
    assert.equal(g.status, 2, 'read-before-edit must still hold for files the search did not certify');
  });
});

test('index.ts wires grep(및 xd 검색 디바이스) tool_result를 배치 read-tracker로', () => {
  // searchTrackTargets is imported into the TS entry point (not spawnable here), so —
  // matching write-tracker.test.mjs — the quoted accesses ARE the behavior contract.
  // v17: top-level은 grep뿐이고, ast_grep은 xd:// 디바이스로 write에 실려 도착한다 —
  // 그 경로는 mutationRoute의 "read-anchors" kind가 같은 배치 페이로드로 처리한다
  // (분류 행동은 xdev-dispatch.test.mjs가 고정).
  const src = readFileSync(INDEX_TS, 'utf-8');
  assert.match(src, /event\.toolName === "grep" && !event\.isError/,
    'a grep tool_result branch must exist');
  assert.match(src, /searchTrackTargets\(event\.details, textChunks\(event\.content\), ctx\.cwd\)/,
    'anchored files must come from searchTrackTargets (details.files first, header fallback)');
  assert.match(src, /route\.kind === "read-anchors"/,
    'xd search dispatches must be routed to read tracking');
  const batched = src.match(/tool_input: \{ file_paths: /g) || [];
  assert.ok(batched.length >= 2,
    'both the grep branch and the read-anchors branch must use ONE batched file_paths payload');
});
