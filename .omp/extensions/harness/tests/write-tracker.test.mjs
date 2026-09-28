// Integration tests for write-tracker.mjs (PostToolUse: Edit|Write).
//
// Run: node --test .omp/extensions/harness/tests/write-tracker.test.mjs
//
// Verifies the audit's F1 fix: a file CREATED via Write in this session can be Edited
// afterward WITHOUT context-gate's read-before-edit block forcing a redundant Read —
// while the read-before-edit invariant for genuinely-unread files is preserved.
//
// These are spawn-based (the hook's behavior is fs side-effects on read-log.txt, not a
// pure function). All state is isolated under a per-test temp dir passed via
// session_state.cwd, so the real repo's .omp/harness-state is never touched
// (see memory: feedback_shell_test_cwd_isolation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates');
const WRITE_TRACKER = join(HARNESS, 'write-tracker.mjs');
const READ_TRACKER = join(HARNESS, 'read-tracker.mjs');
const CONTEXT_GATE = join(HARNESS, 'context-gate.mjs');
const INDEX_TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

function run(hook, payload, cwd) {
  return spawnSync('node', [hook], { input: JSON.stringify(payload), cwd, encoding: 'utf-8' });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function readLog(cwd) {
  const p = join(cwd, '.omp', 'harness-state', 'read-log.txt');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

test('records a written file path in read-log', () => {
  withTmp((cwd) => {
    const target = join(cwd, 'new-file.ts');
    writeFileSync(target, 'export const x = 1;\n');
    const r = run(WRITE_TRACKER, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readLog(cwd).split('\n').includes(target), 'written path should be logged');
  });
});

test('end-to-end: Write then Edit is NOT blocked by context-gate (F1 fix)', () => {
  withTmp((cwd) => {
    const target = join(cwd, 'created.ts');
    writeFileSync(target, 'export const x = 1;\n');           // a Write created the file
    run(WRITE_TRACKER, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    const g = run(CONTEXT_GATE, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(g.status, 0, `context-gate should allow editing a session-written file; stderr: ${g.stderr}`);
  });
});

test('regression: context-gate still BLOCKS an unread file (no read-log)', () => {
  withTmp((cwd) => {
    const target = join(cwd, 'preexisting.ts');
    writeFileSync(target, 'export const x = 1;\n');           // on disk, but never Written/Read via tools
    const g = run(CONTEXT_GATE, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(g.status, 2, 'context-gate must still block an unread existing file');
  });
});

test('regression: context-gate BLOCKS an unread file even when OTHER files were logged', () => {
  withTmp((cwd) => {
    const logged = join(cwd, 'logged.ts');
    const target = join(cwd, 'unread.ts');
    writeFileSync(logged, '1\n');
    writeFileSync(target, '2\n');
    run(WRITE_TRACKER, { tool_input: { file_path: logged }, session_state: { cwd } }, cwd);
    // Prove write-tracker actually recorded `logged`, so the block below is about ABSENCE of
    // `target` — not about a missing/empty read-log (which would pass even if the tracker broke).
    assert.ok(readLog(cwd).split('\n').includes(logged), 'logged file must be present in read-log');
    const g = run(CONTEXT_GATE, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(g.status, 2, 'a file absent from a non-empty read-log must still be blocked');
  });
});

test('no file_path is a no-op (exit 0, no log written)', () => {
  withTmp((cwd) => {
    const r = run(WRITE_TRACKER, { tool_input: {}, session_state: { cwd } }, cwd);
    assert.equal(r.status, 0);
    assert.equal(readLog(cwd), '');
  });
});

test('invalid JSON input does not crash (exit 0)', () => {
  withTmp((cwd) => {
    const r = spawnSync('node', [WRITE_TRACKER], { input: 'not json', cwd, encoding: 'utf-8' });
    assert.equal(r.status, 0);
  });
});

test('dedup: a second write of the same path is idempotent (log does not grow)', () => {
  // Mirrors read-tracker: on Linux filePath===normalizedPath, so a single call appends
  // the path twice; the invariant that matters is that REPEAT calls add nothing more.
  withTmp((cwd) => {
    const target = join(cwd, 'dup.ts');
    writeFileSync(target, '1\n');
    run(WRITE_TRACKER, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    const afterFirst = readLog(cwd);
    run(WRITE_TRACKER, { tool_input: { file_path: target }, session_state: { cwd } }, cwd);
    assert.equal(readLog(cwd), afterFirst, 'a repeat write must not append the path again');
  });
});

test('index.ts wires the lifecycle this fix depends on', () => {
  // The fix is safe only because context-gate gates the edit/write tool_call BEFORE
  // write-tracker logs it at tool_result (success-only). A logic test cannot observe the
  // registration, so a regression that dropped write-tracker (or context-gate) from
  // the OMP extension entry point would pass silently. Assert the wiring directly:
  // a quoted runGate("<gate>.mjs") literal in index.ts IS the registration.
  const src = readFileSync(INDEX_TS, 'utf-8');
  assert.match(src, /runGate\("context-gate\.mjs"/,
    'context-gate must gate edit/write at tool_call');
  assert.match(src, /runGate\("write-tracker\.mjs"/,
    'write-tracker must record edit/write at tool_result');
  assert.match(src, /runGate\("breadcrumb-tracker\.mjs"/,
    'breadcrumb-tracker must record breadcrumbs at tool_result');
  assert.match(src, /runGate\("breadcrumb-surface\.mjs"/,
    'breadcrumb-surface must surface docs/sum at session_start');
});

test('index.ts records ast_edit only on the real apply, not the preview (F2, v17 라우팅)', () => {
  // v17: ast_edit rides the xd:// device transport; preview/apply classification lives in
  // read-path.mjs mutationRoute (behavior unit-tested in xdev-dispatch.test.mjs). The wiring
  // contract here: index.ts must route mutating tool_results through mutationRoute, run ONLY
  // backpressure-invalidator on "preview", feed "read-anchors" to read-tracker, and share the
  // full tracking chain (write-tracker + invalidator + breadcrumb) on apply/files.
  const src = readFileSync(INDEX_TS, 'utf-8');
  assert.match(
    src,
    /mutationRoute\(event\.toolName, event\.input, event\.details, textChunks\(event\.content\), ctx\.cwd\)/,
    'tool_result mutations must be classified via mutationRoute',
  );
  const previewBranch = src.match(/route\.kind === "preview"[\s\S]*?return;/);
  assert.ok(previewBranch, 'a preview branch must exist and return early');
  assert.match(previewBranch[0], /backpressure-invalidator\.mjs/,
    'preview must invalidate backpressure');
  assert.doesNotMatch(previewBranch[0], /write-tracker\.mjs|breadcrumb-tracker\.mjs/,
    'preview must NOT write-track or breadcrumb (deferred to the apply)');
  const anchorsBranch = src.match(/route\.kind === "read-anchors"[\s\S]*?return;/);
  assert.ok(anchorsBranch, 'xd search dispatches must have a read-anchors branch');
  assert.match(anchorsBranch[0], /read-tracker\.mjs/,
    'read-anchors must be recorded via read-tracker');
});

test('parity: write-tracker normalizes paths identically to read-tracker', () => {
  // context-gate matches EITHER tracker's entry, so write-tracker MUST normalize exactly like
  // read-tracker. Use a Windows-style raw path (drive letter + backslashes) that the shared
  // transform rewrites to `/proj/mod.ts`, and compare write-tracker's full log output to
  // read-tracker's for the same input. They must be byte-identical AND must contain the
  // normalized form — so the test fails if write-tracker's normalization drifts or is dropped
  // (it is non-tautological precisely because the raw and normalized spellings differ).
  // Trackers don't stat the path, so this synthetic path need not exist on disk.
  const winPath = 'C:\\proj\\mod.ts';
  const viaWrite = withTmp((cwd) => {
    run(WRITE_TRACKER, { tool_input: { file_path: winPath }, session_state: { cwd } }, cwd);
    return readLog(cwd);
  });
  const viaRead = withTmp((cwd) => {
    run(READ_TRACKER, { tool_input: { file_path: winPath }, session_state: { cwd } }, cwd);
    return readLog(cwd);
  });
  assert.equal(viaWrite, viaRead, 'write-tracker must produce the same log entries as read-tracker');
  assert.ok(viaWrite.split('\n').includes('/proj/mod.ts'),
    'the normalized form must be present (proves normalization actually ran, not just raw passthrough)');
});
