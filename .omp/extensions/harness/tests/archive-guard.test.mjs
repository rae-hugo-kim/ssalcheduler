// Behavior tests for archive-guard.mjs — the commit-time guard that keeps LOCAL ARCHIVE
// paths (docs/sum, docs/reviews, docs/brainstorming) out of commits — plus its two
// boundaries: the commit-gates.mjs dispatcher (4th child) and the .githooks/pre-push
// backstop for legacy-tracked files.
//
// Run: node --test .omp/extensions/harness/tests/archive-guard.test.mjs
//
// Contracts under test (not implementation restatement):
//   BLOCK  (exit 2): staged archive file; `-a` sweep of a tracked+modified archive;
//                    unverifiable form (pathspec) with a tracked+modified archive.
//   WARN   (exit 0): tracked archive that this commit does NOT capture (plain commit,
//                    --amend with no modification) — push boundary is the backstop.
//   SILENT (exit 0): non-commit command, malformed stdin, non-git cwd (fail-open).
//   pre-push: tracked archive anywhere in the repo → exit 1 with cleanup guidance;
//             clean repo (and no scripts/docs-drift) → exit 0.
// Isolated temp git repos with explicit cwd (memory: feedback_shell_test_cwd_isolation);
// GIT_CONFIG_GLOBAL/SYSTEM neutralized so user config (gpgsign, hooks) can't leak in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GATE = join(ROOT, '.omp', 'extensions', 'harness', 'gates', 'archive-guard.mjs');
const DISPATCHER = join(ROOT, '.omp', 'extensions', 'harness', 'gates', 'commit-gates.mjs');
const PRE_PUSH = join(ROOT, '.githooks', 'pre-push');

// Neutralize user/system git config so fixture commits are deterministic (no gpgsign,
// no global core.hooksPath). Local repo config still applies. HERMETIC: inherited GIT_*
// is dropped — a launcher that exports GIT_DIR/GIT_CONFIG_* into the session would
// otherwise point fixture git at the wrong repo (test-attack C-5).
const INHERITED_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
);
const GIT_ENV = { ...INHERITED_ENV, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
}

function makeRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ag-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFiles(dir, files);
  return dir;
}

function withRepo(files, fn) {
  const dir = makeRepo(files);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Run a gate script the way the hook runtime does: JSON on stdin, cwd in session_state.
function runGate(script, dir, command, { input, env } = {}) {
  return spawnSync('node', [script], {
    input: input ?? JSON.stringify({ tool_input: { command }, session_state: { cwd: dir } }),
    cwd: dir,
    encoding: 'utf-8',
    env: { ...GIT_ENV, ...env },
  });
}

// Commit everything currently written, so archive files become TRACKED (legacy state).
function commitAll(dir, msg = 'legacy') {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

// ---------------------------------------------------------------- BLOCK paths

test('staged archive file blocks a plain commit (exit 2, HARNESS BLOCK, path + unstage guidance)', () => {
  withRepo({ 'docs/sum/x.md': '# session narrative\n' }, (dir) => {
    git(dir, ['add', 'docs/sum/x.md']);
    const r = runGate(GATE, dir, 'git commit -m "add notes"');
    assert.equal(r.status, 2, 'a staged archive file must block the commit');
    assert.match(r.stderr, /HARNESS BLOCK/, 'block marker surfaces on stderr');
    assert.match(r.stderr, /docs\/sum\/x\.md/, 'the offending path is named');
    assert.match(r.stderr, /restore --staged/, 'unstage remediation is offered');
  });
});

test('`git commit -a` sweep: tracked archive with unstaged modification blocks (exit 2)', () => {
  withRepo({ 'docs/reviews/r.md': 'v1\n' }, (dir) => {
    commitAll(dir);
    writeFileSync(join(dir, 'docs/reviews/r.md'), 'v2\n'); // tracked, modified, NOT staged
    const r = runGate(GATE, dir, 'git commit -am "sweep"');
    assert.equal(r.status, 2, '-a would capture the modified tracked archive → block');
    assert.match(r.stderr, /HARNESS BLOCK/);
    assert.match(r.stderr, /docs\/reviews\/r\.md/, 'the swept path is named');
  });
});

test('unverifiable pathspec form with tracked+modified archive blocks (exit 2)', () => {
  withRepo({ 'docs/sum/x.md': 'v1\n' }, (dir) => {
    commitAll(dir);
    writeFileSync(join(dir, 'docs/sum/x.md'), 'v2\n');
    // Pathspec commits can capture tracked changes the index never saw; exclusion is
    // unprovable statically, so a modified tracked archive must block this form.
    const r = runGate(GATE, dir, 'git commit docs/sum/x.md -m "narrative"');
    assert.equal(r.status, 2, 'pathspec commit of a modified tracked archive must block');
    assert.match(r.stderr, /HARNESS BLOCK/);
    assert.match(r.stderr, /docs\/sum\/x\.md/);
  });
});

test('staged ordinary files only: commit passes silently (exit 0, no stderr)', () => {
  withRepo({ 'src/a.ts': 'export const a = 1;\n' }, (dir) => {
    git(dir, ['add', '-A']);
    const r = runGate(GATE, dir, 'git commit -m "feat: a"');
    assert.equal(r.status, 0, 'a normal commit must not be gated');
    assert.equal(r.stderr, '', 'no warning/block noise on a clean commit');
  });
});

// ----------------------------------------------------------------- WARN paths

test('tracked archive NOT captured by this commit: plain commit warns but passes (exit 0)', () => {
  withRepo({ 'docs/brainstorming/b.md': 'ideas\n', 'src/a.ts': 'export const a = 1;\n' }, (dir) => {
    commitAll(dir);
    writeFiles(dir, { 'src/b.ts': 'export const b = 2;\n' });
    git(dir, ['add', 'src/b.ts']); // a real commit-in-waiting that does not touch archives
    const r = runGate(GATE, dir, 'git commit -m "feat: b"');
    assert.equal(r.status, 0, 'legacy-tracked archive outside this commit must not block');
    assert.match(r.stderr, /HARNESS WARNING/, 'cleanup guidance is surfaced');
    assert.doesNotMatch(r.stderr, /HARNESS BLOCK/, 'warn must not escalate to a block');
  });
});

test('--amend with tracked but UNMODIFIED archive: warn only, no over-block (exit 0)', () => {
  withRepo({ 'docs/sum/x.md': 'v1\n', 'src/a.ts': 'export const a = 1;\n' }, (dir) => {
    commitAll(dir);
    // Unverifiable form, but nothing modified: blocking every --amend in a legacy repo
    // adds no safety (the push boundary is the backstop) — must stay a warning.
    const r = runGate(GATE, dir, 'git commit --amend -m "reword"');
    assert.equal(r.status, 0, '--amend over an unmodified legacy archive must pass');
    assert.match(r.stderr, /HARNESS WARNING/);
    assert.doesNotMatch(r.stderr, /HARNESS BLOCK/);
  });
});

// ----------------------------------------------------- SILENT fail-open paths

test('non-commit command is silent even with a tracked archive present (exit 0)', () => {
  withRepo({ 'docs/sum/x.md': 'v1\n' }, (dir) => {
    commitAll(dir);
    const r = runGate(GATE, dir, 'git status');
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'no warning/block noise outside commits');
  });
});

test('malformed stdin is silent (exit 0, fail-open)', () => {
  withRepo({}, (dir) => {
    const r = runGate(GATE, dir, '', { input: 'not json' });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });
});

test('non-git cwd is silent (exit 0, fail-open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-nogit-'));
  try {
    const r = runGate(GATE, dir, 'git commit -m "x"', {
      env: { GIT_CEILING_DIRECTORIES: tmpdir() }, // guarantee no ancestor repo is found
    });
    assert.equal(r.status, 0, 'guard must never block when it cannot assess');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- dispatcher integration

// Backpressure PASS + no scope file + low-risk docs files: the other three gates all
// allow (same fixture recipe as commit-gates.test.mjs), isolating archive-guard's verdict.
function setStatus(dir, status) {
  const sd = join(dir, '.omp', 'harness-state');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'backpressure-status'), status);
}

test('dispatcher: staged archive blocks through commit-gates.mjs (exit 2)', () => {
  withRepo({ 'docs/notes.md': '# notes\nprose\n', 'docs/sum/session.md': '# session\n' }, (dir) => {
    git(dir, ['add', '-A']);
    setStatus(dir, 'PASS');
    // Hook mode: the dispatcher's command path was retired with AC3 (enforcement is
    // .githooks/pre-commit), so the dispatcher is exercised the way the hook calls it.
    const r = runGate(DISPATCHER, dir, null, { input: JSON.stringify({ mode: 'hook', hook: 'pre-commit', session_state: { cwd: dir } }) });
    assert.equal(r.status, 2, 'archive-guard block must propagate through the dispatcher');
    assert.match(r.stderr, /HARNESS BLOCK: local archive/, 'archive-guard is the blocker');
    assert.match(r.stderr, /docs\/sum\/session\.md/);
  });
});

test('dispatcher control: same fixture without the archive file passes (exit 0)', () => {
  // Proves the previous test's block is attributable to archive-guard, not a sibling gate.
  withRepo({ 'docs/notes.md': '# notes\nprose\n' }, (dir) => {
    git(dir, ['add', '-A']);
    setStatus(dir, 'PASS');
    const r = runGate(DISPATCHER, dir, null, { input: JSON.stringify({ mode: 'hook', hook: 'pre-commit', session_state: { cwd: dir } }) });
    assert.equal(r.status, 0, 'without an archive file the same commit passes all gates');
  });
});

// ------------------------------------------------------------- pre-push backstop

function runPrePush(dir) {
  return spawnSync('bash', [PRE_PUSH], { cwd: dir, encoding: 'utf-8', env: GIT_ENV, input: '' });
}

test('pre-push: tracked archive anywhere in the repo blocks the push (exit 1 + cleanup guidance)', () => {
  withRepo({ 'docs/sum/x.md': 'v1\n', 'src/a.ts': 'export const a = 1;\n' }, (dir) => {
    commitAll(dir);
    const r = runPrePush(dir);
    assert.equal(r.status, 1, 'a tracked archive must never reach a remote');
    assert.match(r.stderr, /pre-push blocked/, 'the hook explains why');
    assert.match(r.stderr, /docs\/sum\/x\.md/, 'the tracked path is named');
    assert.match(r.stderr, /rm -r --cached/, 'cleanup remediation is offered');
  });
});

test('pre-push: clean repo with no tracked archives and no docs-drift script passes (exit 0)', () => {
  withRepo({ 'src/a.ts': 'export const a = 1;\n' }, (dir) => {
    commitAll(dir);
    const r = runPrePush(dir);
    assert.equal(r.status, 0, `clean repo must push freely (stderr: ${r.stderr})`);
  });
});

// ------------------------------------------------------------------ regressions

test('non-ASCII archive filename blocks with the raw path on stderr (quotePath regression)', () => {
  // With core.quotePath (the stock behavior, pinned here) plain `git diff --name-only`
  // octal-escapes non-ASCII paths ("docs/sum/\354\204\270…"), which slips past the
  // guard's prefix match. NUL-delimited plumbing must keep the path raw: a Korean-named
  // narrative blocks like any other, and stderr names it legibly.
  withRepo({ 'docs/sum/세션_요약.md': '# 세션 요약\n' }, (dir) => {
    git(dir, ['config', 'core.quotePath', 'true']);
    git(dir, ['add', 'docs/sum/세션_요약.md']);
    const r = runGate(GATE, dir, 'git commit -m "add notes"');
    assert.equal(r.status, 2, 'a staged Korean-named archive file must block the commit');
    assert.match(r.stderr, /HARNESS BLOCK/);
    assert.match(r.stderr, /docs\/sum\/세션_요약\.md/, 'the path surfaces as raw UTF-8, not octal-escaped');
  });
});

test('cleanup commit (git rm -r --cached + commit) passes — the prescribed remedy never self-blocks', () => {
  withRepo({ 'docs/sum/x.md': 'v1\n', 'src/a.ts': 'export const a = 1;\n' }, (dir) => {
    commitAll(dir); // legacy: archive is tracked
    git(dir, ['rm', '-r', '-q', '--cached', 'docs/sum']); // the guard's own remediation
    const r = runGate(GATE, dir, 'git commit -m "chore: untrack local archives"');
    assert.equal(r.status, 0, 'committing the staged DELETION of an archive must pass');
    assert.doesNotMatch(r.stderr, /HARNESS BLOCK/, 'the healing path must not be blocked');
  });
});
