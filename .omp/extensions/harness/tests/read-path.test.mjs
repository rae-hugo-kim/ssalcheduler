// read-path.test.mjs — readTarget / READ_SELECTOR (the path index.ts feeds read-tracker).
//
// Regression F1: the old READ_SELECTOR only stripped `:range:raw`, not the
// documented `:raw:range` order, so `read foo.ts:raw:2-4` logged the phantom
// path "foo.ts:raw" and a later edit of "foo.ts" falsely failed context-gate.

import test from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { readTarget, localFileTarget, READ_SELECTOR, resolvedAstEditFiles, searchTrackTargets } from '../gates/read-path.mjs';

const CWD = '/work';
const BARE = resolve(CWD, 'src/foo.ts');
const T = (p) => readTarget({ path: p }, CWD);

test('strips every documented selector form (range / raw-trailing / L-prefix / .. / multi)', () => {
  for (const sel of [
    'src/foo.ts:50-100',
    'src/foo.ts:raw',
    'src/foo.ts:conflicts',
    'src/foo.ts:50',
    'src/foo.ts:50-',
    'src/foo.ts:50+150',
    'src/foo.ts:5-16,960-973',
    'src/foo.ts:2-4:raw',
    'src/foo.ts:L50',
    'src/foo.ts:L50-L100',
    'src/foo.ts:50..',
    'src/foo.ts:5..16',
  ]) {
    assert.equal(T(sel), BARE, `selector not stripped: ${sel}`);
  }
});

test('strips raw-LEADING selectors — :raw:range (the F1 fix)', () => {
  assert.equal(T('src/foo.ts:raw:2-4'), BARE);
  assert.equal(T('src/foo.ts:raw:50-100'), BARE);
  assert.equal(T('src/foo.ts:raw:5-16,960-973'), BARE);
});

test('leaves a bare path (no selector) untouched — no over-strip', () => {
  assert.equal(T('src/foo.ts'), BARE);
  assert.equal(readTarget({ path: 'src/report-2024.md' }, CWD), resolve(CWD, 'src/report-2024.md'));
  assert.equal(readTarget({ path: 'src/v2.ts' }, CWD), resolve(CWD, 'src/v2.ts'));
});

test('returns "" for web URLs and internal URIs (not local files to track)', () => {
  for (const p of ['https://example.com', 'http://x.y/a', 'skill://foo', 'omp://x.md', 'memory://m', 'artifact://1']) {
    assert.equal(T(p), '', `should not track: ${p}`);
  }
});

test('returns "" for missing / empty / non-string path', () => {
  assert.equal(readTarget({}, CWD), '');
  assert.equal(readTarget({ path: '' }, CWD), '');
  assert.equal(readTarget(undefined, CWD), '');
  assert.equal(readTarget({ path: 42 }, CWD), '');
});

test('READ_SELECTOR matches raw in EITHER order, plain/multi ranges; not a bare path', () => {
  for (const s of ['x:raw', 'x:raw:2-4', 'x:2-4:raw', 'x:5-16,960-973', 'x:conflicts', 'x:L9-L20']) {
    assert.match(s, READ_SELECTOR, `should match: ${s}`);
  }
  for (const s of ['x', 'src/v2.ts', 'src/report-2024.md', 'x:notaselector']) {
    assert.doesNotMatch(s, READ_SELECTOR, `should NOT match: ${s}`);
  }
});

// #42 (omp 18.2.9–18.3.0, measured 2026-09-24): `:img` is the mandatory selector for SVG
// rendering. Unstripped, `logo.svg:img` landed in read-log and a later edit of `logo.svg`
// false-blocked in context-gate. Standalone only — read.md documents no range combination,
// and the selector regex mirrors that grammar EXACTLY.
test('strips the :img selector (standalone only) — the F1 phantom class for SVG reads', () => {
  assert.equal(T('assets/logo.svg:img'), resolve(CWD, 'assets/logo.svg'));
  assert.match('x:img', READ_SELECTOR);
  assert.doesNotMatch('x:image', READ_SELECTOR);
  assert.equal(T('src/img'), resolve(CWD, 'src/img'), 'a path component named img is not a selector');
});

// `:-N` (last N lines) is advertised by the read tool and accepted live (omp 18.3.0, 2026-09-24:
// `read current-scope.md:-3` returned the tail AND logged the phantom `current-scope.md:-3`).
test('strips the :-N tail selector — the same phantom class', () => {
  assert.equal(T('docs/harness/current-scope.md:-3'), resolve(CWD, 'docs/harness/current-scope.md'));
  assert.equal(T('src/foo.ts:-60'), BARE);
  assert.equal(T('src/foo.ts:raw:-60'), BARE, ':raw:-N is accepted live (omp 18.3.0)');
  assert.equal(T('src/foo.ts:-60:raw'), BARE);
  assert.match('x:-60', READ_SELECTOR);
  assert.doesNotMatch('x:-', READ_SELECTOR);
  assert.equal(T('src/a-b:-c'), resolve(CWD, 'src/a-b:-c'), 'a non-numeric tail is a path, not a selector');
});

// #42: 18.3.0 job/service control (`write proc://<id>/kill`, `proc://<name>/mode`, `read proc://`)
// and write-only `conflict://` must never enter the ledgers — in the canonical `://` form OR the
// single-slash form the event plumbing has been observed to emit for xd (`xd:/retain`).
test('proc:// and conflict:// are virtual in both slash forms — never a ledger path', () => {
  for (const p of ['proc://', 'proc://bg_1', 'proc:/', 'proc:/bg_1/kill', 'proc:/web/mode', 'conflict://src/a.ts', 'conflict:/src/a.ts']) {
    assert.equal(readTarget({ path: p }, CWD), '', `read must not track: ${p}`);
    assert.equal(localFileTarget(p, CWD), null, `write must not track: ${p}`);
  }
});

test('resolvedAstEditFiles extracts apply file paths from a resolve result', () => {
  // upstream shape: details.sourceResultDetails.files is string[]
  assert.deepEqual(
    resolvedAstEditFiles({ sourceResultDetails: { files: ['src/a.ts', 'src/b.ts'] } }, CWD),
    [resolve(CWD, 'src/a.ts'), resolve(CWD, 'src/b.ts')],
  );
  // defensive: object entries carrying a path/file field
  assert.deepEqual(
    resolvedAstEditFiles({ sourceResultDetails: { files: [{ path: 'x.ts' }, { file: 'y.ts' }] } }, CWD),
    [resolve(CWD, 'x.ts'), resolve(CWD, 'y.ts')],
  );
  // absent / misshaped -> [] (caller records nothing for that apply)
  assert.deepEqual(resolvedAstEditFiles(undefined, CWD), []);
  assert.deepEqual(resolvedAstEditFiles({}, CWD), []);
  assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: {} }, CWD), []);
  assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: { files: 'nope' } }, CWD), []);
  // empty / non-path entries are skipped
  assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: { files: ['', null, 42, {}] } }, CWD), []);
});

test('searchTrackTargets: details.files is the trusted primary source', () => {
  // absolute entries (the shape measured on omp 16.3.12) pass through; relative
  // entries resolve against cwd; duplicates collapse; text is IGNORED when the
  // structured list is present.
  assert.deepEqual(
    searchTrackTargets({ files: ['/abs/a.ts', 'rel/b.ts', '/abs/a.ts'] }, '[ignored.ts#AB12]\n*1:x', CWD),
    ['/abs/a.ts', resolve(CWD, 'rel/b.ts')],
  );
  // internal URIs / non-strings / empties are skipped
  assert.deepEqual(
    searchTrackTargets({ files: ['omp://doc.md', 'skill://x/f.ts', '', 42, null, '/ok.ts'] }, '', CWD),
    ['/ok.ts'],
  );
  // an EMPTY array is trusted as "nothing anchored" — no text fallback kicks in
  assert.deepEqual(searchTrackTargets({ files: [] }, '[foo.ts#AB12]\n*1:x', CWD), []);
});

test('searchTrackTargets: bracketed-header fallback when details.files is absent/misshaped', () => {
  const text = '[src/foo.ts#1A2B]\n*42:hit\n 43:context\n\n[/abs/bar.ts#FFFF]\n*1:hit';
  const expected = [resolve(CWD, 'src/foo.ts'), '/abs/bar.ts'];
  assert.deepEqual(searchTrackTargets(undefined, text, CWD), expected);
  assert.deepEqual(searchTrackTargets({}, text, CWD), expected);
  assert.deepEqual(searchTrackTargets({ files: 'nope' }, text, CWD), expected);
});

test('searchTrackTargets: fallback is fail-strict — grouped trees and URIs track nothing', () => {
  // Grouped multi-file output uses `#`-tree headers, NOT bracketed ones. Reconstructing
  // paths from the tree is format-coupled and a wrong join would track the WRONG file
  // (loosening context-gate), so the fallback deliberately extracts nothing from it.
  const grouped = '# /tmp/scope/\n## a.ts#0168\n*1:export const alpha = 1;\n## sub/\n### b.ts#8274\n*1:export const beta = 2;';
  assert.deepEqual(searchTrackTargets(undefined, grouped, CWD), []);
  // internal-URI headers, headerless text, and non-string text track nothing
  assert.deepEqual(searchTrackTargets(undefined, '[omp://doc.md#AB12]\n*1:x', CWD), []);
  assert.deepEqual(searchTrackTargets(undefined, 'No matches found', CWD), []);
  assert.deepEqual(searchTrackTargets(undefined, undefined, CWD), []);
});
