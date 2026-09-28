// Unit tests for acceptance-gate.mjs (PreToolUse: Bash, git commit).
//
// Run: node --test .omp/extensions/harness/tests/acceptance-gate.test.mjs
//
// Focus: PR-1 of the closeout/freshen design — a CLOSED seed (`status: done` =
// completed via closeout, `status: superseded` = replaced) carries no ACTIVE
// acceptance criteria, so its AC must NOT gate new/unrelated commits. Regression
// guards keep an `approved` (active) seed enforcing, and the stale-safe warn+pass
// when AC are defined but no current-scope.md tracking file exists.
//
// Most cases read files only (a plain temp dir suffices); the closeout-landing cases (#48-1)
// initialize a real, hermetic git repo because the gate inspects the index / HEAD there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'acceptance-gate.mjs');

const AC_BLOCK = 'acceptance_criteria:\n  - id: AC1\n    title: do the thing\n';

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'acc-gate-'));
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'docs', 'harness', rel), content);
  }
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function runGate(dir, command = 'git commit -m x', env = {}) {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_input: { command }, session_state: { cwd: dir } }),
    cwd: dir,
    encoding: 'utf-8',
    // HERMETIC: drop inherited GIT_* so a session-injected GIT_DIR/GIT_CONFIG_* cannot
    // change what the gate sees (test-attack C-5).
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))), ...env },
  });
}

const UNCHECKED_SCOPE = '# Scope\n\n## Acceptance Criteria\n\n- [ ] not done yet\n';

// --- closed seed (done / superseded) -> no active AC -> allow ---

test('seed status:done -> allow even with an unchecked current-scope (closed task)', () => {
  withDir({ 'seed.yaml': `status: done\ncompleted: 2026-05-21\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

test('seed status:superseded -> allow (replaced task, AC obsolete)', () => {
  withDir({ 'seed.yaml': `status: superseded\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

test('quoted status ("done") is recognized as closed -> allow', () => {
  withDir({ 'seed.yaml': `status: "done"\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

// --- regression: an ACTIVE (approved) seed still enforces ---

test('seed status:approved + unchecked current-scope -> BLOCK (active task still gated)', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 2);
  });
});

// --- WIP bypass: an in-progress commit may pass unmet AC (still warns) ---

test('approved + unchecked + `wip:` message -> allow (WIP bypass), still warns', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    const r = runGate(dir, 'git commit -m "wip: partway through"');
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WIP commit/i);
  });
});

test('approved + unchecked + `[wip]` tag (bundled -am) -> allow', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir, 'git commit -am "[wip] checkpoint"').status, 0);
  });
});

test('approved + unchecked + a NON-wip message -> BLOCK (bypass is marker-gated)', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir, 'git commit -m "feat: done for real"').status, 2);
  });
});

test('precedence: a closed (done) seed + wip message exits via the closed-seed path, not wip', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    const r = runGate(dir, 'git commit -m "wip: x"');
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /WIP commit/i);   // closed-seed early-exit precedes the wip bypass
  });
});

test('seed status:approved + all AC checked -> allow', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': '## Acceptance Criteria\n\n- [x] done\n' }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

// --- stale-safe: AC defined but no current-scope.md -> warn + pass (not block) ---

test('approved seed with AC but no current-scope.md -> warn + allow (no false block)', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}` }, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no current-scope\.md/i);
  });
});

// --- non-commit and no-context cases ---

test('not a git commit -> allow', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir, 'git status').status, 0);
  });
});

test('acceptance-done flag overrides a blocking active task', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE, 'acceptance-done': '' }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

// --- parser contract: only a top-level, uncommented status closes the seed ---

test('status:done with no space still closes the seed -> allow', () => {
  withDir({ 'seed.yaml': `status:done\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

test('done seed with NO current-scope.md (the actual repo dogfood shape) -> allow', () => {
  withDir({ 'seed.yaml': `status: done\ncompleted: 2026-05-21\n${AC_BLOCK}` }, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

test('commented / indented status does NOT close an active seed (fail-closed)', () => {
  // A `# status: done` comment or a nested/indented status must not disable the gate;
  // only the real top-level `status: approved` counts -> still blocks unchecked AC.
  withDir({ 'seed.yaml': `# status: done\nstatus: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 2);
  });
  withDir({ 'seed.yaml': `meta:\n  status: done\nstatus: approved\n${AC_BLOCK}`, 'current-scope.md': UNCHECKED_SCOPE }, (dir) => {
    assert.equal(runGate(dir).status, 2);
  });
});

// --- L2 backstop (seed AC6): a CODE change with no active acceptance criteria must not
// pass silently. Risk is injected via TEST_RISK_LEVEL (test seam); real runs use assessRisk. ---

test('backstop: closed (done) seed + CODE change (no scope) -> BLOCK', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}` }, (dir) => {
    const r = runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HARNESS BACKSTOP/);
  });
});

test('backstop: closed seed + DOCS-only change -> allow (no friction)', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}` }, (dir) => {
    assert.equal(runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'low' }).status, 0);
  });
});

test('backstop: closed seed + CODE + `wip:` -> allow (intentional checkpoint)', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}` }, (dir) => {
    assert.equal(runGate(dir, 'git commit -m "wip: x"', { TEST_RISK_LEVEL: 'medium' }).status, 0);
  });
});

test('backstop: NO seed at all + CODE change -> allow (no tracking intent)', () => {
  withDir({}, (dir) => {
    assert.equal(runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'high' }).status, 0);
  });
});

test('backstop: approved seed with AC but no current-scope + CODE -> BLOCK', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}` }, (dir) => {
    const r = runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HARNESS BACKSTOP/);
  });
});

test('backstop: unknown risk (cannot assess) -> allow (fail-open)', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}` }, (dir) => {
    assert.equal(runGate(dir, 'git commit -m x').status, 0);
  });
});

test('backstop: acceptance-done flag overrides before backstop', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}`, 'acceptance-done': 'x' }, (dir) => {
    assert.equal(runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'critical' }).status, 0);
  });
});

// --- backstop recovery-message branch (finding B + slice-2 reopen): a closed seed now offers
// `thread-scope open` (which REOPENS the closed seed) plus a /kickoff hint for genuinely new work. ---

test('backstop: closed-seed block offers seed reopen (thread-scope) and /kickoff', () => {
  withDir({ 'seed.yaml': `status: done\n${AC_BLOCK}` }, (dir) => {
    const r = runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /thread-scope/);
    assert.match(r.stderr, /kickoff/);
  });
});

test('backstop: active-seed (no current-scope) block suggests thread-scope open', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}` }, (dir) => {
    const r = runGate(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /thread-scope/);
  });
});

// --- #48-1: closeout landing. closeout_contract.md §3 lands the seed `approved -> done`
// transition, the scope retirement and the `task_closed` audit row in the SAME commit as the
// completing code; the seed on disk is already `done` at pre-commit, so the closed-seed branch
// must read the commit's own content to tell a closeout from new code on a long-dead seed — and
// ALL THREE closeout parts must be there (a seed flip alone must not "close" unmet AC).
// Repo-backed: the detection reads the index / HEAD. ---

import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';

const HERMETIC = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const CLOSED_ROW = '{"ts":"2026-09-26T00:00:00Z","event":"task_closed","actor":"assistant","meta":{"task_id":"t1"}}\n';

// A tracked, in-flight task at HEAD: approved seed, scope with the given checkboxes, an audit log.
function gitRepoWithTask(dir, { seed = `status: approved\n${AC_BLOCK}`, scope = '# S\n\n## Acceptance Criteria\n\n- [x] done\n' } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: HERMETIC });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), seed);
  writeFileSync(join(dir, 'docs', 'harness', 'current-scope.md'), scope);
  writeFileSync(join(dir, 'docs', 'harness', 'audit.jsonl'), '{"event":"thread_opened"}\n');
  writeFileSync(join(dir, 'a.js'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return git;
}
// The full §3 closeout in the worktree: seed done, scope deleted, audit row appended, plus code.
function closeoutInWorktree(dir) {
  writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `status: done\ncompleted: 2026-09-26\n${AC_BLOCK}`);
  unlinkSync(join(dir, 'docs', 'harness', 'current-scope.md'));
  writeFileSync(join(dir, 'docs', 'harness', 'audit.jsonl'), '{"event":"thread_opened"}\n' + CLOSED_ROW);
  writeFileSync(join(dir, 'a.js'), 'y\n');
}
function runGateHermetic(dir, command = 'git commit -m x', env = {}) {
  return runGate(dir, command, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env });
}

test('closeout landing: full §3 closeout STAGED with code -> allow (same-commit closeout)', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    git('add', '-A');
    const r = runGateHermetic(dir, 'git commit -m "feat: done"', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /closeout landing/);
  });
});

test('closeout landing: hook mode (staged index) is recognized the same way', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    git('add', '-A');
    const r = spawnSync('node', [GATE], {
      input: JSON.stringify({ mode: 'hook', hook: 'pre-commit', session_state: { cwd: dir } }),
      cwd: dir, encoding: 'utf-8', env: { ...HERMETIC, TEST_RISK_LEVEL: 'medium' },
    });
    assert.equal(r.status, 0, r.stderr);
  });
});

test('closeout landing: color.ui/color.diff=always and diff.external cannot break the detection', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    git('config', 'color.ui', 'always');
    git('config', 'color.diff', 'always');
    git('config', 'diff.external', '/bin/false');
    closeoutInWorktree(dir);
    git('add', '-A');
    assert.equal(runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' }).status, 0);
  });
});

test('closeout landing: a seed flip ALONE (scope still committed, or no task_closed row) is NOT a closeout -> BLOCK', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir, { scope: UNCHECKED_SCOPE });
    // flip + code, scope left in place, no audit row: unmet AC must not be "closed" this way
    writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `status: done\n${AC_BLOCK}`);
    writeFileSync(join(dir, 'a.js'), 'y\n');
    git('add', '-A');
    let r = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HARNESS BACKSTOP/);
    assert.match(r.stderr, /incomplete: docs\/harness\/current-scope\.md is still in the commit/, 'the block names the missing §3 part');
    // scope deleted but no audit row -> still incomplete, and the hint moves to §3c
    unlinkSync(join(dir, 'docs', 'harness', 'current-scope.md'));
    git('add', '-A');
    r = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /incomplete: no task_closed row/);
  });
});

test('dead seed: done at HEAD (untouched) + staged CODE -> still BACKSTOP BLOCK', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir, { seed: `status: done\n${AC_BLOCK}` });
    unlinkSync(join(dir, 'docs', 'harness', 'current-scope.md'));
    git('add', '-A');
    git('commit', '-q', '-m', 'closed earlier');
    writeFileSync(join(dir, 'a.js'), 'y\n');
    git('add', '-A');
    const r = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HARNESS BACKSTOP/);
  });
});

test('closeout landing: closeout present in the WORKTREE but NOT staged -> plain commit still blocks; -a sees it', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    writeFileSync(join(dir, 'a.js'), 'y\n');
    git('add', 'a.js');
    closeoutInWorktree(dir); // unstaged (deletion + edits are tracked, so -a captures them)
    const plain = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(plain.status, 2);
    assert.match(plain.stderr, /incomplete: docs\/harness\/seed\.yaml approved -> done is in the worktree but not staged/);
    assert.equal(runGateHermetic(dir, 'git commit -am x', { TEST_RISK_LEVEL: 'medium' }).status, 0);
  });
});

test('closeout landing: -a with an UNTRACKED current-scope.md leftover and a trailing YAML comment on status still lands', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `status: done  # closed 2026-09-26\n${AC_BLOCK}`);
    git('add', '-A');
    writeFileSync(join(dir, 'docs', 'harness', 'current-scope.md'), '# untracked leftover\n');
    assert.equal(runGateHermetic(dir, 'git commit -am x', { TEST_RISK_LEVEL: 'medium' }).status, 0);
  });
});

test('closeout landing: a draft -> done edit is NOT a closeout (approved -> done only); a suffixed state never matches', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir, { seed: `status: draft\n${AC_BLOCK}` });
    closeoutInWorktree(dir);
    git('add', '-A');
    assert.equal(runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' }).status, 2);
  });
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `status: done-later\n${AC_BLOCK}`);
    git('add', '-A');
    assert.equal(runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' }).status, 2);
  });
});

// --- #48-4: a post-commit AC ("open PR", "tag") circles with this gate. No marker syntax —
// .omp/rules/harness-cycle_definition.md says such items are not AC; the block message must say so. ---

test('block message points post-commit items at cycle_definition.md (not a marker syntax)', () => {
  withDir({ 'seed.yaml': `status: approved\n${AC_BLOCK}`, 'current-scope.md': '# S\n\n## Acceptance Criteria\n\n- [ ] commit and open the PR\n' }, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /true only AFTER this commit/);
    assert.match(r.stderr, /cycle_definition\.md/);
  });
});

// --- adversary pass (2026-09-26): scalar boundary, intent-to-add, JSON whitespace ---

test('closeout landing: `done#closed`, `"done`, `approved#pending` are not the exact states -> BLOCK', () => {
  for (const [head, committed] of [['status: approved', 'status: done#closed'], ['status: approved', 'status: "done'], ['status: approved#pending', 'status: done']]) {
    withDir({}, (dir) => {
      const git = gitRepoWithTask(dir, { seed: `${head}\n${AC_BLOCK}` });
      closeoutInWorktree(dir);
      writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `${committed}\n${AC_BLOCK}`);
      git('add', '-A');
      assert.equal(runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' }).status, 2, `${head} -> ${committed}`);
    });
  }
});

test('closeout landing: an intent-to-add (`git add -N`) scope for the NEXT task is not in the committed tree -> allow', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    git('add', '-A');
    writeFileSync(join(dir, 'docs', 'harness', 'current-scope.md'), '# next task\n');
    git('add', '-N', 'docs/harness/current-scope.md');
    const r = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 0, r.stderr);
  });
});

test('closeout landing: a hand-formatted audit row (`"event" : "task_closed"`) counts', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    writeFileSync(join(dir, 'docs', 'harness', 'audit.jsonl'), '{"event":"thread_opened"}\n{"ts":"2026-09-26T00:00:00Z", "event" : "task_closed", "actor":"assistant"}\n');
    git('add', '-A');
    assert.equal(runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' }).status, 0);
  });
});

test('closeout landing (-a): a seed whose deletion is staged with an untracked done copy left behind is NOT a closeout', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    git('add', '-A');
    git('rm', '-q', '--cached', 'docs/harness/seed.yaml'); // deletion staged; the done copy is now untracked
    assert.equal(runGateHermetic(dir, 'git commit -am x', { TEST_RISK_LEVEL: 'medium' }).status, 2);
  });
});

test('closeout landing: an UNSTAGED worktree edit after staging a complete closeout (seed flipped back for the next task) still lands', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    git('add', '-A');
    writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `status: approved\n${AC_BLOCK}`); // unstaged, next task
    const r = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /closeout landing/);
  });
});

test('closeout landing: a malformed staged state (`done-later` on disk and staged) gets NO "not staged" hint', () => {
  withDir({}, (dir) => {
    const git = gitRepoWithTask(dir);
    closeoutInWorktree(dir);
    writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), `status: done-later\n${AC_BLOCK}`);
    git('add', '-A');
    const r = runGateHermetic(dir, 'git commit -m x', { TEST_RISK_LEVEL: 'medium' });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /not staged/);
  });
});
