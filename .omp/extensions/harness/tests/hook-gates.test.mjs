// tests/hook-gates.test.mjs — hook-mode dispatcher + child gates (seed 20260729-132948-e510, AC6/AC1)
//
// Contract under test: the commit-gates dispatcher accepts a HOOK-MODE payload
// ({mode:"hook", hook:"pre-commit", session_state:{cwd}}) with NO command string,
// runs all child gates against the staged index of session_state.cwd, and renders
// the same verdict semantics as the tool_call path (exit 2 = block, stderr contract
// "HARNESS BLOCK:"). Isolation contract (test-plan v2 C-7): every case runs in a
// mkdtemp fixture; hermetic env (inherited GIT_* stripped — C-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(here, '..', 'gates', 'commit-gates.mjs');

// C-5 hermetic: strip inherited GIT_*; fixtures add intentional vars only.
function hermeticEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra };
}

function sh(cwd, cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', env: hermeticEnv(extraEnv) });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hookmode-'));
  sh(dir, 'git', ['init', '-q']);
  sh(dir, 'git', ['config', 'user.email', 't@example.com']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'seed']);
  return dir;
}

function runHookDispatcher(dir, payload = {}, extraEnv = {}) {
  return spawnSync(process.execPath, [DISPATCHER], {
    cwd: dir,
    input: JSON.stringify({ mode: 'hook', hook: 'pre-commit', session_state: { cwd: dir }, ...payload }),
    encoding: 'utf-8',
    env: hermeticEnv(extraEnv),
    timeout: 20_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
}

// U2: unchecked ACs + non-wip staged change -> hook-mode dispatcher must BLOCK (exit 2)
// with the HARNESS BLOCK stderr contract. This is the existence proof that children
// actually RUN in hook mode — the legacy dispatcher early-exits 0 on an empty command.
test('U2: hook-mode blocks on unchecked acceptance criteria (HARNESS BLOCK contract)', () => {
  const dir = makeRepo();
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 fixture criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', '-A']);
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 2, `expected block, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /HARNESS BLOCK/);
});

// ---- cycle 2: review-gate hook mode (U3 / U3n) ----------------------------------------

import { execSync } from 'node:child_process';

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function bigCodeFile() {
  let s = '// fixture high-risk module\n';
  for (let i = 0; i < 130; i++) s += `export function f${i}(x) { return x + ${i}; }\n`;
  return s;
}

// A scope file with every AC checked lets acceptance-gate pass, isolating review-gate.
function passAcceptance(dir) {
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [x] AC1 fixture criterion\n',
  );
}

// U3 (block half): high-risk staged diff + no review evidence -> review-gate must block
// in hook mode. Risk MUST be assessed from `git diff --cached`, not a command string.
test('U3: hook-mode review-gate blocks high-risk staged diff without evidence', () => {
  const dir = makeRepo();
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', '-A']);
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 2, `expected review block, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /HARNESS BLOCK/);
  assert.match(r.stderr, /review/i);
});

// U3 (pass half): same fixture + a valid PASS evidence tuple covering the staged hash -> allow.
test('U3: hook-mode review-gate passes with covering PASS evidence', () => {
  const dir = makeRepo();
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', '-A']);
  const hash = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  mkdirSync(join(dir, 'docs', 'reviews'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'reviews', `review-${localToday()}-000001.json`),
    JSON.stringify(['omp-review-evidence/v1', hash, 'PASS', ['anthropic/claude-4.5', 'openai-codex/gpt-5.6-sol'], null, 'reviewer']),
  );
  writeFileSync(join(dir, 'docs', 'harness', 'backpressure-skip'), '1\n'); // one-shot: satisfies backpressure for this verdict
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 0, `expected pass, got status=${r.status} stderr=${r.stderr}`);
});

// U3n (C-2 regression guard): a high-risk UNSTAGED worktree change must not drive risk when
// the staged diff is docs-only — hook-mode form pins diffRanges to ['--cached'].
test('U3n: hook-mode risk ignores unstaged worktree noise (docs-only staged passes)', () => {
  const dir = makeRepo();
  passAcceptance(dir);
  // The noise file must be TRACKED and modified-unstaged: an UNTRACKED file never appears in
  // `git diff` at all, so it could not distinguish the staged scope from the staged∪unstaged
  // union — that made the earlier version of this test pass even with the fix reverted
  // (review round 2 proved it by mutation).
  writeFileSync(join(dir, 'big.mjs'), 'export const seed = 0;\n');
  sh(dir, 'git', ['add', 'big.mjs']);
  sh(dir, 'git', ['commit', '-q', '-m', 'chore: track big.mjs']);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());          // tracked, modified, NOT staged
  writeFileSync(join(dir, 'notes.md'), '# docs only\n');
  sh(dir, 'git', ['add', 'notes.md']);
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 0, `expected pass, got status=${r.status} stderr=${r.stderr}`);
});

// ---- cycle 2.5: evidence validator must accept current-generation codenames ------------
// Latent bug (scope-add 2026-07-30, L1 self-detect): the model validator rejects pre-version
// codenames ("claude-fable-5" — 'fable' sits before the version digit), so REAL measured
// reviewer ids in this environment invalidate the whole evidence tuple and every
// high/critical commit blocks despite a valid review.
test('U3f: evidence naming measured current-gen ids (claude-fable-5) is accepted', () => {
  const dir = makeRepo();
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', '-A']);
  const hash = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  mkdirSync(join(dir, 'docs', 'reviews'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'reviews', `review-${localToday()}-000001.json`),
    JSON.stringify(['omp-review-evidence/v1', hash, 'PASS', ['anthropic/claude-fable-5', 'openai-codex/gpt-5.6-sol'], null, 'reviewer']),
  );
  writeFileSync(join(dir, 'docs', 'harness', 'backpressure-skip'), '1\n');
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 0, `expected pass, got status=${r.status} stderr=${r.stderr}`);
});

// ---- cycle 3: backpressure + archive-guard hook mode (U5 / U6) -------------------------

function passReview(dir) {
  const hash = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  mkdirSync(join(dir, 'docs', 'reviews'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'reviews', `review-${localToday()}-000001.json`),
    JSON.stringify(['omp-review-evidence/v1', hash, 'PASS', ['anthropic/claude-4.5', 'openai-codex/gpt-5.6-sol'], null, 'reviewer']),
  );
}

// U5: high-risk staged diff, acceptance+review pass, NO backpressure status file ->
// backpressure-gate alone must block in hook mode.
test('U5: hook-mode backpressure blocks unverified high-risk changes', () => {
  const dir = makeRepo();
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', '-A']);
  passReview(dir);
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 2, `expected backpressure block, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /HARNESS BLOCK/);
  assert.match(r.stderr, /build\/test|verification/i);
});

// U6: a staged local-archive file must block in hook mode (docs-only risk stays low,
// so every other gate passes — archive-guard alone renders the verdict).
test('U6: hook-mode archive-guard blocks staged local-archive files', () => {
  const dir = makeRepo();
  passAcceptance(dir);
  mkdirSync(join(dir, 'docs', 'sum'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'sum', 'session_note.md'), '# session narrative\n');
  sh(dir, 'git', ['add', '-A']);
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 2, `expected archive block, got status=${r.status} stderr=${r.stderr}`);
  assert.match(r.stderr, /HARNESS BLOCK/);
  assert.match(r.stderr, /archive|docs\/sum/i);
});

// ---- cycle 4: the pre-commit hook artifact itself (AC1: I1/I2/I3/I7) --------------------

import { copyFileSync, chmodSync, existsSync } from 'node:fs';

const HOOK_SRC = join(here, '..', '..', '..', '..', '.githooks', 'pre-commit');

// Every module the hook-mode dispatcher and its children import. ONE list for all fixtures: a
// cloned gates dir missing a sibling module makes review-gate die on ERR_MODULE_NOT_FOUND, which
// fails closed and lets a budget/signal test pass for the wrong reason (review 2026-09-22, medium).
const GATE_FILES = ['commit-gates.mjs', 'acceptance-gate.mjs', 'backpressure-gate.mjs', 'review-gate.mjs', 'archive-guard.mjs', 'git-commit-detect.mjs', 'risk-assess.mjs', 'estimate.mjs'];

// Install the REAL hook artifact into a fixture repo (harness-sync ships this same file).
function installHook(dir) {
  assert.ok(existsSync(HOOK_SRC), '.githooks/pre-commit artifact missing');
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  copyFileSync(HOOK_SRC, join(dir, '.githooks', 'pre-commit'));
  chmodSync(join(dir, '.githooks', 'pre-commit'), 0o755);
  sh(dir, 'git', ['config', 'core.hooksPath', '.githooks']);
  // Jurisdiction: the hook runs the dispatcher of ITS repo — fixture gets the real gates.
  mkdirSync(join(dir, '.omp', 'extensions', 'harness', 'gates'), { recursive: true });
  const gatesSrc = join(here, '..', 'gates');
  for (const f of GATE_FILES) {
    copyFileSync(join(gatesSrc, f), join(dir, '.omp', 'extensions', 'harness', 'gates', f));
  }
  writeFileSync(join(dir, '.omp', 'extensions', 'harness', 'harness-meta.json'), '{"version":"fixture"}\n');
  // Mirror the real repos' contract: harness state is gitignored (this repo's .gitignore:2).
  writeFileSync(join(dir, '.gitignore'), '.omp/harness-state/\n');
}

function head(dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() }).stdout.trim();
}

// I1: gates-pass state -> plain commit succeeds through the hook.
test('I1: hook allows a passing plain commit', () => {
  const dir = makeRepo();
  installHook(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']); // harness/hook files stay untracked: risk judges the DIFF, not the repo contents
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: fixture'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `commit should pass: ${r.stderr}`);
});

// I2: gates-fail state -> the commit is NOT created (HEAD unchanged) and stderr carries
// the HARNESS BLOCK contract.
test('I2: hook blocks a failing commit — no commit object is created', () => {
  const dir = makeRepo();
  installHook(dir);
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', '-A']);
  const before = head(dir);
  const r = spawnSync('git', ['commit', '-m', 'feat: should be blocked'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(r.status, 0, 'commit must fail');
  assert.match(r.stderr, /HARNESS BLOCK/);
  assert.equal(head(dir), before, 'HEAD must be unchanged');
});

// I3: --amend runs the hook too.
test('I3: hook fires on --amend', () => {
  const dir = makeRepo();
  installHook(dir);
  passAcceptance(dir);
  sh(dir, 'git', ['add', 'docs']); // harness files stay untracked (docs-only diff keeps risk low)
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  // Now flip the repo into a blocking state and amend with a staged code change.
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', '-A']);
  const r = spawnSync('git', ['commit', '--amend', '--no-edit'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(r.status, 0, 'amend must be blocked');
  assert.match(r.stderr, /HARNESS BLOCK/);
});

// I7: spelling smoke — a git alias reaches the hook exactly like the canonical spelling.
test('I7: hook fires through a git alias (spelling-independence smoke)', () => {
  const dir = makeRepo();
  installHook(dir);
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', '-A']);
  const r = spawnSync('git', ['-c', 'alias.c=commit', 'c', '-m', 'x'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(r.status, 0, 'aliased commit must be blocked');
  assert.match(r.stderr, /HARNESS BLOCK/);
});

// ---- cycle 5: temporary-index visibility (A-2) + hermetic human/no-node (B-1) -----------

import { symlinkSync, realpathSync, lstatSync } from 'node:fs';

// U8: `git commit -a` runs the hook under a TEMPORARY GIT_INDEX_FILE holding the swept
// tracked modifications. If the environment inheritance contract is honored, the gates see
// the high-risk code diff and block; a sanitizing adapter would see an empty/docs-only
// --cached and fail open (test-attack A-2 measured both branches).
test('U8: commit -a exposes swept tracked changes to the gates (temp index inherited)', () => {
  const dir = makeRepo();
  installHook(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'code.mjs'), 'export const v = 0;\n');
  sh(dir, 'git', ['add', 'code.mjs', 'docs']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: seed tracked code file']);
  writeFileSync(join(dir, 'code.mjs'), bigCodeFile()); // tracked, NOT staged
  const r = spawnSync('git', ['commit', '-a', '-m', 'feat: sweep'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(r.status, 0, `commit -a must be gated on its real content: ${r.stderr}`);
  assert.match(r.stderr, /HARNESS BLOCK/);
  assert.match(r.stderr, /lines of code|review evidence|verification/i);
});

// U9: pathspec partial commit — same temporary-index mechanism, partial content.
test('U9: pathspec commit exposes exactly the partial content to the gates', () => {
  const dir = makeRepo();
  installHook(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'code.mjs'), 'export const v = 0;\n');
  sh(dir, 'git', ['add', 'code.mjs', 'docs']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: seed tracked code file']);
  writeFileSync(join(dir, 'code.mjs'), bigCodeFile()); // tracked mod, not staged
  const r = spawnSync('git', ['commit', '-m', 'feat: partial', '--', 'code.mjs'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(r.status, 0, `pathspec commit must be gated on its real content: ${r.stderr}`);
  assert.match(r.stderr, /HARNESS BLOCK/);
});

// Hermetic shim environment (test-attack B-1 recipe): a bin dir with ONLY the named tools,
// run through env -i — models a human/GUI commit with no session and a bare PATH.
function shimBin(dir, tools) {
  const bin = join(dir, 'shimbin');
  mkdirSync(bin, { recursive: true });
  for (const t of tools) {
    const real = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf-8' }).stdout.trim();
    assert.ok(real, `tool ${t} not found on host`);
    symlinkSync(realpathSync(real), join(bin, t));
  }
  return bin;
}

function hermeticCommit(dir, bin, msg, extra = {}) {
  const env = {
    PATH: bin,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    ...extra,
  };
  return spawnSync('git', ['commit', '-m', msg], { cwd: dir, encoding: 'utf-8', env });
}

// I5: human commit (no session, bare PATH with node present) — the hook fires and enforces.
test('I5: hermetic human commit is enforced by the hook', () => {
  const dir = makeRepo();
  installHook(dir);
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', '-A']);
  const bin = shimBin(dir, ['git', 'bash', 'node', 'sh']);
  const r = hermeticCommit(dir, bin, 'feat: human path');
  assert.notEqual(r.status, 0, 'hermetic human commit must be blocked');
  assert.match(r.stderr, /HARNESS BLOCK/);
});

// I6: node absent -> fail closed with guidance; OMP_NODE_BIN restores operation.
test('I6: node-less PATH fails closed; OMP_NODE_BIN is the escape hatch', () => {
  const dir = makeRepo();
  installHook(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  const bin = shimBin(dir, ['git', 'bash', 'sh']); // no node
  const blocked = hermeticCommit(dir, bin, 'docs: no node');
  assert.notEqual(blocked.status, 0, 'commit without node must fail closed');
  assert.match(blocked.stderr, /HARNESS BLOCK/);
  assert.match(blocked.stderr, /node not found|OMP_NODE_BIN/);
  const nodeReal = realpathSync(spawnSync('sh', ['-c', 'command -v node'], { encoding: 'utf-8' }).stdout.trim());
  const ok = hermeticCommit(dir, bin, 'docs: with escape hatch', { OMP_NODE_BIN: nodeReal });
  assert.equal(ok.status, 0, `OMP_NODE_BIN commit should pass: ${ok.stderr}`);
});

// ---- cycle 6: backstop hooks + deferred one-shot consumption (I8/I9/I10, U2w, I13, U4) --

import { unlinkSync } from 'node:fs';

const POSTCOMMIT_SRC = join(here, '..', '..', '..', '..', '.githooks', 'post-commit');
const POSTMERGE_SRC = join(here, '..', '..', '..', '..', '.githooks', 'post-merge');

function installBackstop(dir) {
  copyFileSync(POSTCOMMIT_SRC, join(dir, '.githooks', 'post-commit'));
  chmodSync(join(dir, '.githooks', 'post-commit'), 0o755);
  assert.ok(existsSync(POSTMERGE_SRC), '.githooks/post-merge artifact missing');
  copyFileSync(POSTMERGE_SRC, join(dir, '.githooks', 'post-merge'));
  chmodSync(join(dir, '.githooks', 'post-merge'), 0o755);
}

function passingFixture() {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  return dir;
}

// I8: --no-verify skips pre-commit but post-commit still fires -> ungated advisory (non-blocking).
test('I8: --no-verify commit is observed by the post-commit backstop', () => {
  const dir = passingFixture();
  const r = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'docs: bypass'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, 'commit itself must succeed (advisory only)');
  assert.match(r.stderr, /HARNESS ADVISORY/);
  assert.match(r.stderr, /ungated|gate/i);
});

// I9 (A-1 measured): merge auto-commits fire NEITHER pre-commit NOR post-commit; the
// post-merge backstop observes them.
test('I9: merge auto-commit is observed by the post-merge backstop', () => {
  const dir = passingFixture();
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(dir, 'feat.md'), 'feature docs\n');
  sh(dir, 'git', ['add', 'feat.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: feat']);
  sh(dir, 'git', ['checkout', '-q', '-']);
  writeFileSync(join(dir, 'main.md'), 'main docs\n');
  sh(dir, 'git', ['add', 'main.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: main']);
  const r = spawnSync('git', ['merge', '--no-edit', '--no-ff', 'feat'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `merge must succeed: ${r.stderr}`);
  assert.match(r.stderr, /HARNESS ADVISORY/);
  assert.match(r.stderr, /merge/i);
});

// I10: cherry-pick and revert create commits without pre-commit; post-commit observes them.
test('I10: cherry-pick and revert are observed as ungated by the post-commit backstop', () => {
  const dir = passingFixture();
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(dir, 'feat.md'), 'feature docs\n');
  sh(dir, 'git', ['add', 'feat.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: feat']);
  const featSha = head(dir);
  sh(dir, 'git', ['checkout', '-q', '-']);
  const cp = spawnSync('git', ['cherry-pick', featSha], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(cp.status, 0, `cherry-pick must succeed: ${cp.stderr}`);
  assert.match(cp.stderr, /HARNESS ADVISORY/);
  const rv = spawnSync('git', ['revert', '--no-edit', 'HEAD'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(rv.status, 0, `revert must succeed: ${rv.stderr}`);
  assert.match(rv.stderr, /HARNESS ADVISORY/);
});

// U2w: the wip one-shot flag lets a blocked state pass at pre-commit time WITHOUT being
// consumed there; the post-commit consumes it after the commit lands (A-4/B-4).
test('U2w: wip flag passes acceptance in hook mode and is consumed post-commit only', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', 'src.mjs', 'docs', '.gitignore']); // low-risk diff isolates the wip/acceptance axis
  const wipFlag = join(dir, '.omp', 'harness-state', 'commit-wip');
  mkdirSync(join(dir, '.omp', 'harness-state'), { recursive: true });
  writeFileSync(wipFlag, '1\n');
  // Gate-only run: flag must NOT be consumed by the pre-commit verdict itself.
  const gate = runHookDispatcher(dir);
  assert.equal(gate.status, 0, `wip flag should pass the gates: ${gate.stderr}`);
  assert.ok(existsSync(wipFlag), 'wip flag must survive the pre-commit verdict');
  // Full commit: flag consumed after the commit lands.
  const r = spawnSync('git', ['commit', '-q', '-m', 'wip: checkpoint'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `wip commit should land: ${r.stderr}`);
  assert.ok(!existsSync(wipFlag), 'wip flag must be consumed post-commit');
});

// I13: a failure AFTER the pre-commit verdict (empty message abort) must leave one-shot
// state untouched — consumption happens only once a commit actually lands (B-4).
test('I13: post-hook commit failure leaves one-shot state intact', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', 'src.mjs', 'docs', '.gitignore']); // low risk: gates PASS, failure happens after the verdict
  const wipFlag = join(dir, '.omp', 'harness-state', 'commit-wip');
  mkdirSync(join(dir, '.omp', 'harness-state'), { recursive: true });
  writeFileSync(wipFlag, '1\n');
  // Empty commit message -> git aborts AFTER pre-commit ran.
  const r = spawnSync('git', ['commit'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv({ GIT_EDITOR: 'true' }) });
  assert.notEqual(r.status, 0, 'empty-message commit must abort');
  assert.doesNotMatch(r.stderr, /HARNESS BLOCK/, 'failure must come from git (post-verdict), not the gates');
  assert.ok(existsSync(wipFlag), 'wip flag must survive an aborted commit');
});

// U4: the pre-commit verdict must not mutate tracked files or consume one-shot overrides —
// a valid review override is honored at verdict time but consumed only post-commit.
test('U4: hook-mode verdict leaves the worktree and one-shot overrides untouched', () => {
  const dir = makeRepo();
  installHook(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'big.mjs', 'docs', '.gitignore']); // high-risk code diff without sweeping the fixture harness
  writeFileSync(join(dir, 'docs', 'harness', 'backpressure-skip'), '1\n');
  const hash = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  const skip = join(dir, 'docs', 'harness', 'review-skip');
  writeFileSync(skip, JSON.stringify(['omp-review-override/v1', 'fixture reason', 'tester', hash]));
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() }).stdout;
  const gate = runHookDispatcher(dir);
  assert.equal(gate.status, 0, `override should pass the gates: ${gate.stderr}`);
  assert.ok(existsSync(skip), 'review-skip must survive the pre-commit verdict');
  const after = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() }).stdout;
  assert.equal(after, before, 'verdict must not change git status');
});

// ---- cycle 7: output contract, ambient env, hung child, lock, sparse (U7/U10/U11, I11/I12)

// U7: a hook-mode block names the responsible gate so an agent can fix instead of retrying.
test('U7: hook-mode block output names the blocking gate', () => {
  const dir = makeRepo();
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', '-A']);
  const r = runHookDispatcher(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /HARNESS BLOCK \[acceptance-gate/);
  assert.match(r.stderr, /fix|고치|해결/i);
});

// U10 (A-2ii): git exports GIT_DIR/GIT_INDEX_FILE to hooks — hook mode must treat them as
// normal operating conditions, not as ambient retargeting.
test('U10: hook-mode tolerates git-exported ambient GIT_* variables', () => {
  const dir = passingFixture();
  const r = runHookDispatcher(dir, {}, {
    GIT_DIR: join(dir, '.git'),
    GIT_INDEX_FILE: join(dir, '.git', 'index'),
    GIT_PREFIX: '',
  });
  assert.equal(r.status, 0, `ambient hook env must not block: ${r.stderr}`);
});

// U11 (B-3): a hung child gate must be SIGKILLed within its budget and FAIL CLOSED —
// never pin `git commit` forever. Runs a cloned gates dir with a sleeping child.
test('U11: hung child gate is killed and the verdict fails closed', () => {
  const dir = passingFixture();
  // Clone the real gates, then replace acceptance-gate with a sleeper.
  const fakeGates = join(dir, 'fake-gates');
  mkdirSync(fakeGates, { recursive: true });
  const gatesSrc = join(here, '..', 'gates');
  for (const f of GATE_FILES) {
    copyFileSync(join(gatesSrc, f), join(fakeGates, f));
  }
  writeFileSync(join(fakeGates, 'acceptance-gate.mjs'), 'setTimeout(() => {}, 30000);\n');
  // Monotonic clock: Date.now() stepped backwards by ~1.8s mid-test on WSL2 (measured 2026-09-23:
  // wall 1224ms vs hrtime 3004ms for the same 3s timeout), which made a wall-clock lower bound flake.
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [join(fakeGates, 'commit-gates.mjs')], {
    cwd: dir,
    input: JSON.stringify({ mode: 'hook', hook: 'pre-commit', session_state: { cwd: dir } }),
    encoding: 'utf-8',
    env: hermeticEnv(),
    timeout: 25_000,
    killSignal: 'SIGKILL',
  });
  const elapsed = Number((process.hrtime.bigint() - start) / 1_000_000n);
  assert.equal(r.status, 2, `hung gate must fail closed: status=${r.status} stderr=${r.stderr}`);
  // The verdict must come from the sleeper hitting ITS budget, not from a sibling crashing first
  // (review 2026-09-23: a cloned dir missing a module let this pass on ERR_MODULE_NOT_FOUND):
  // ETIMEDOUT on the named gate, and an elapsed time that IS the 3s per-child budget — not a
  // crash (<1s) and not the 25s outer timeout.
  assert.match(r.stderr, /HARNESS BLOCK \[acceptance-gate\.mjs\]: the gate did not run cleanly \(ETIMEDOUT\)/);
  assert.ok(elapsed >= 2_500 && elapsed < 10_000, `the 3s per-child budget must be what fires (elapsed ${elapsed}ms)`);
});

// I11 (A-6): an index.lock loser is a GIT failure, not a harness block — the two surfaces
// must stay distinguishable so agents do not "fix" lock contention by deleting state.
test('I11: index.lock contention is distinguishable from a harness block', () => {
  const dir = passingFixture();
  writeFileSync(join(dir, '.git', 'index.lock'), '');
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: contended'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /index\.lock/);
  assert.doesNotMatch(r.stderr, /HARNESS BLOCK/);
});

// I12 (A-5, documented residual): sparse-checkout cone mode drops .githooks/ from the
// worktree and a relative core.hooksPath silently disables every hook. This test OBSERVES
// the neutralization (AC5 documents it; bootstrap owns the mitigation).
test('I12: sparse-checkout silently neutralizes the hooks (observed residual)', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'code.mjs'), 'export const x = 1;\n');
  // The hooks must be TRACKED for sparse-checkout to be able to drop them from the worktree.
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '--no-verify', '-m', 'chore: track harness + src']);
  // Blocking state: unchecked AC + a staged code change.
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(dir, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: fixture\n\n## Acceptance Criteria\n\n- [ ] AC1 unmet criterion\n',
  );
  writeFileSync(join(dir, 'src', 'code.mjs'), 'export const x = 2;\n');
  sh(dir, 'git', ['add', '-A']);
  const blocked = spawnSync('git', ['commit', '-m', 'feat: gated'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(blocked.status, 0, 'hooks present -> blocked');
  assert.match(blocked.stderr, /HARNESS BLOCK/);
  // Cone mode drops every tracked path outside `src` — including .githooks — and a RELATIVE
  // core.hooksPath then resolves to nothing: hooks are silently neutralized (no warning).
  sh(dir, 'git', ['sparse-checkout', 'init', '--cone']);
  sh(dir, 'git', ['sparse-checkout', 'set', 'src']);
  assert.ok(!existsSync(join(dir, '.githooks', 'pre-commit')), 'sparse-checkout should drop .githooks');
  const r = spawnSync('git', ['commit', '-q', '-m', 'feat: ungated by sparse'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `sparse-neutralized commit currently passes (documented residual): ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /HARNESS BLOCK/);
});

// ---- cycle 8: AC2 cross-repo jurisdiction via hook-in-target-repo ----------------------
// The ORIGINAL bug (2026-07-15): gates judged whichever tree the SESSION started in, so a
// commit into another repo was checked against this repo's acceptance state (false blocks),
// and commits into a harness repo issued from elsewhere were not gated at all. The command
// layer tried to fix it by statically attributing `-C`/env retargeting — six review rounds
// of spelling games. With enforcement in .githooks/pre-commit the question dissolves:
// jurisdiction IS "which repo's hooks did git run", and git answers that itself.

// X1: a harness-enabled target is judged by ITS OWN state, from a foreign working directory.
test('X1: cross-repo commit is judged by the TARGET repo state (not the caller cwd)', () => {
  const target = makeRepo();
  installHook(target);
  installBackstop(target);
  mkdirSync(join(target, 'docs', 'harness'), { recursive: true });
  writeFileSync(
    join(target, 'docs', 'harness', 'current-scope.md'),
    '# Current Scope: TARGET fixture\n\n## Acceptance Criteria\n\n- [ ] AC-TARGET unmet criterion\n',
  );
  writeFileSync(join(target, 'src.mjs'), 'export const x = 1;\n');
  sh(target, 'git', ['add', 'src.mjs', 'docs', '.gitignore']);
  const caller = mkdtempSync(join(tmpdir(), 'caller-'));   // unrelated cwd, not a repo
  const before = head(target);
  const r = spawnSync('git', ['-C', target, 'commit', '-m', 'feat: cross-repo'], {
    cwd: caller, encoding: 'utf-8', env: hermeticEnv(),
  });
  assert.notEqual(r.status, 0, 'target gates must block');
  assert.match(r.stderr, /HARNESS BLOCK/);
  assert.match(r.stderr, /AC-TARGET/, 'the TARGET repo scope must be the one evaluated');
  assert.equal(head(target), before, 'no commit object in the target');
});

// X2 (CHARACTERIZATION, not a regression pin): a repo with no harness hooks is out of
// jurisdiction — no gating, no false block. This is the exact shape of the original false
// positive (the sum-vault backup commit). It cannot fail while jurisdiction IS hook presence,
// so it documents the semantics rather than guarding a fix (review round 3, L6).
test('X2: a repo without harness hooks is out of jurisdiction (no false block)', () => {
  const vault = makeRepo();                                // no installHook: no hooks at all
  writeFileSync(join(vault, 'note.md'), 'backup\n');
  sh(vault, 'git', ['add', '-A']);
  const caller = mkdtempSync(join(tmpdir(), 'caller-'));
  const r = spawnSync('git', ['-C', vault, 'commit', '-q', '-m', 'sum: backup'], {
    cwd: caller, encoding: 'utf-8', env: hermeticEnv(),
  });
  assert.equal(r.status, 0, `out-of-jurisdiction commit must pass: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /HARNESS BLOCK/);
});

// X3: the reverse direction that used to be ungated — a foreign caller committing INTO the
// harness repo. The hook lives in the target, so it fires regardless of who calls.
test('X3: reverse direction is gated — foreign caller into a harness repo', () => {
  const target = makeRepo();
  installHook(target);
  installBackstop(target);
  passAcceptance(target);
  writeFileSync(join(target, 'big.mjs'), bigCodeFile());   // high risk, no review evidence
  sh(target, 'git', ['add', 'big.mjs', 'docs', '.gitignore']);
  const caller = makeRepo();                               // a DIFFERENT repo as the cwd
  const r = spawnSync('git', ['-C', target, 'commit', '-m', 'feat: from elsewhere'], {
    cwd: caller, encoding: 'utf-8', env: hermeticEnv(),
  });
  assert.notEqual(r.status, 0, 'reverse-direction commit must be gated');
  assert.match(r.stderr, /HARNESS BLOCK/);
});

// ---- cycle 9: deferred-consumption protocol hardening (3-pass review, high #2) ---------
// Both cases were MEASURED as live defects before the token was bound to the approved tree
// and the dispatcher started clearing intents: an intent written by a BLOCKED attempt was
// replayed by a later unrelated commit, and a leftover token let a `--no-verify` commit
// pose as gated.

function overrideFixture(dir, extra = {}) {
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  if (extra.archive) {
    mkdirSync(join(dir, 'docs', 'sum'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'sum', 'note.md'), '# narrative\n');
  }
  sh(dir, 'git', ['add', 'big.mjs', 'docs', '.gitignore']);
  writeFileSync(join(dir, 'docs', 'harness', 'backpressure-skip'), '1\n');
  const hash = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  const skip = join(dir, 'docs', 'harness', 'review-skip');
  writeFileSync(skip, JSON.stringify(['omp-review-override/v1', 'fixture reason', 'tester', hash]));
  return skip;
}

const auditLines = (dir) => {
  const p = join(dir, 'docs', 'harness', 'audit.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean) : [];
};

// P1: an override accepted by one gate while ANOTHER gate blocks must leave no consumable
// intent behind — the next commit must not inherit that approval.
test('P1: a blocked attempt leaves no replayable consumption intent', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  const skip = overrideFixture(dir, { archive: true });   // archive-guard will block
  const blockedRun = runHookDispatcher(dir);
  assert.equal(blockedRun.status, 2, 'archive-guard must block this attempt');
  assert.ok(existsSync(skip), 'review-skip must survive a blocked attempt');
  assert.ok(!existsSync(join(dir, '.omp', 'harness-state', 'pending-consume')), 'intents from a blocked attempt must be cleared');
  // Now an unrelated, clean docs commit: it must not consume the override or audit it.
  sh(dir, 'git', ['rm', '-q', '--cached', 'docs/sum/note.md']);
  sh(dir, 'git', ['rm', '-q', '--cached', 'big.mjs']);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: unrelated'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `unrelated docs commit should land: ${r.stderr}`);
  assert.ok(existsSync(skip), 'the override must NOT be consumed by an unrelated commit');
  assert.equal(auditLines(dir).filter((l) => l.includes('review_override')).length, 0, 'no false review_override audit line');
});

// P2: a token left by an attempt whose commit never landed must not launder a later
// ungated commit — the tree binding makes the mismatch visible.
test('P2: a stale verdict token cannot launder a later --no-verify commit', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  const skip = overrideFixture(dir);
  const allow = runHookDispatcher(dir);
  assert.equal(allow.status, 0, `override should pass the gates: ${allow.stderr}`);
  assert.ok(existsSync(join(dir, '.omp', 'harness-state', 'gated-commit-token')), 'an allow writes the token');
  // The commit never lands (empty message), then a DIFFERENT content is committed with
  // --no-verify: the stale token must not mark it gated.
  const aborted = spawnSync('git', ['commit'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv({ GIT_EDITOR: 'true' }) });
  assert.notEqual(aborted.status, 0, 'empty-message commit must abort');
  writeFileSync(join(dir, 'sneak.mjs'), 'export const sneaky = 1;\n');
  sh(dir, 'git', ['add', 'sneak.mjs']);
  const r = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'feat: sneak'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, 'the commit itself is not blocked (advisory layer)');
  assert.match(r.stderr, /HARNESS ADVISORY/, 'the ungated advisory must still fire');
  assert.ok(existsSync(skip), 'the override must NOT be consumed by an unapproved commit');
  assert.equal(auditLines(dir).filter((l) => l.includes('review_override')).length, 0, 'no false review_override audit line');
});

// P3: the happy path still works — an approved commit consumes its own intents exactly once.
test('P3: an approved commit consumes its deferred intents once', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  const skip = overrideFixture(dir);
  const r = spawnSync('git', ['commit', '-q', '-m', 'feat: approved via override'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `approved commit should land: ${r.stderr}`);
  assert.ok(!existsSync(skip), 'the override is consumed once the commit lands');
  assert.equal(auditLines(dir).filter((l) => l.includes('review_override')).length, 1, 'exactly one audit line');
  assert.ok(!existsSync(join(dir, '.omp', 'harness-state', 'gated-commit-token')), 'token consumed');
  assert.doesNotMatch(r.stderr, /HARNESS ADVISORY/, 'an approved commit is not advised as ungated');
});

// ---- cycle 10: commit-scope contract (uniform --cached) + backstop scope ---------------
// Round 2 measured that inferring `--amend` from "nothing staged + a parent exists" is wrong
// in BOTH directions: it false-blocked `--allow-empty`, a plain commit with an empty index,
// and a merge resolved to HEAD's tree (all judged against the PREVIOUS commit), while still
// missing an amend that stages a delta and an amend of a root commit. The heuristic is gone.
// The contract these tests pin is the uniform one: gates judge what the commit ADDS relative
// to HEAD; content already in HEAD is out of scope (documented residual).

// A1: the ordinary shapes the earlier heuristic broke must all pass cleanly.
test('A1: empty-index commit shapes are not judged against the previous commit', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  sh(dir, 'git', ['add', 'docs', '.gitignore']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  // High-risk content lands via the human bypass; it is now in HEAD.
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'big.mjs']);
  const bypass = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'feat: ungated'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(bypass.status, 0, 'the bypass itself is not blocked');
  assert.match(bypass.stderr, /HARNESS ADVISORY/, 'the ungated landing is observed');
  // --allow-empty must NOT be blocked by the content already in HEAD.
  const empty = spawnSync('git', ['commit', '--allow-empty', '-m', 'chore: trigger ci'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(empty.status, 0, `--allow-empty must not be judged against HEAD's content: ${empty.stderr}`);
  // A plain commit with nothing staged must reach git's own "nothing to commit", not a BLOCK.
  const nothing = spawnSync('git', ['commit', '-m', 'noop'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(nothing.status, 0, 'git refuses an empty commit');
  assert.doesNotMatch(nothing.stderr, /HARNESS BLOCK/, 'the harness must not pre-empt git here');
  assert.match(`${nothing.stdout}${nothing.stderr}`, /nothing (added )?to commit/);
});

// A2: an --amend is judged on what it ADDS (documented residual: content already in HEAD is
// not re-judged). Staging a high-risk delta into an amend must therefore still be gated.
test('A2: an amend is gated on the delta it stages', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs', '.gitignore']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  // No staged delta -> nothing added -> allowed (residual: HEAD's content is not re-judged).
  const messageOnly = spawnSync('git', ['commit', '--amend', '--no-edit'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(messageOnly.status, 0, `amending without new content should pass: ${messageOnly.stderr}`);
  // A high-risk delta staged into the amend IS new content -> gated.
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'big.mjs']);
  const withDelta = spawnSync('git', ['commit', '--amend', '--no-edit'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.notEqual(withDelta.status, 0, 'an amend that stages high-risk content must be gated');
  assert.match(withDelta.stderr, /HARNESS BLOCK/);
});

// A3 (3-pass review, medium): the acceptance BACKSTOP (no active AC) must scope risk to the
// staged diff too. Measured before the fix: a closed seed + docs-only staged + unrelated
// unstaged code blocked the docs commit through the staged∪unstaged union.
test('A3: acceptance backstop ignores unstaged noise (docs commit passes)', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  // A CLOSED seed carries no active AC -> the backstop path, no current-scope.md.
  writeFileSync(
    join(dir, 'docs', 'harness', 'seed.yaml'),
    'name: closed-fixture\nstatus: done\nversion: 1\ntask_id: "20260730-000000-aaaa"\n',
  );
  // Tracked + modified-unstaged (an untracked file is invisible to `git diff`, which is why the
  // first version of this test passed even with the union bug restored — review round 2).
  writeFileSync(join(dir, 'unrelated.mjs'), 'export const seed = 0;\n');
  sh(dir, 'git', ['add', 'unrelated.mjs']);
  sh(dir, 'git', ['commit', '-q', '--no-verify', '-m', 'chore: track unrelated.mjs']);
  writeFileSync(join(dir, 'unrelated.mjs'), bigCodeFile());    // high risk, unstaged
  writeFileSync(join(dir, 'notes.md'), '# docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']); // docs-only staged: .gitignore would read as "mixed changes"
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: notes'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `docs-only commit must not be blocked by unstaged code: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /HARNESS BACKSTOP/);
});

// ---- cycle 11: fail-closed matrix + all-gates-run (absorbed from the retired suite) -----
// The deleted commit-gates.test.mjs owned this matrix for the command-layer dispatcher.
// The hook-mode dispatcher must keep the same contract: only a clean exit 0 allows, and
// every gate runs in order so each consumes its own one-shot flag (3-pass review, medium).

function fakeGatesDir(dir, overrides = {}) {
  const fake = join(dir, 'fake-gates');
  mkdirSync(fake, { recursive: true });
  const gatesSrc = join(here, '..', 'gates');
  for (const f of GATE_FILES) {
    copyFileSync(join(gatesSrc, f), join(fake, f));
  }
  for (const [name, body] of Object.entries(overrides)) writeFileSync(join(fake, name), body);
  return fake;
}

function runFake(dir, fake) {
  return spawnSync(process.execPath, [join(fake, 'commit-gates.mjs')], {
    cwd: dir,
    input: JSON.stringify({ mode: 'hook', hook: 'pre-commit', session_state: { cwd: dir } }),
    encoding: 'utf-8',
    env: hermeticEnv(),
    timeout: 25_000,
    killSignal: 'SIGKILL',
  });
}

test('F1: a crashing gate fails closed', () => {
  const dir = passingFixture();
  const fake = fakeGatesDir(dir, { 'review-gate.mjs': 'process.exit(1);\n' });
  const r = runFake(dir, fake);
  assert.equal(r.status, 2, `crash must block: ${r.stderr}`);
  assert.match(r.stderr, /did not run cleanly|failing closed/);
  assert.match(r.stderr, /review-gate/);
});

test('F2: a gate killed by a signal fails closed', () => {
  const dir = passingFixture();
  const fake = fakeGatesDir(dir, { 'backpressure-gate.mjs': "process.kill(process.pid, 'SIGKILL');\n" });
  const r = runFake(dir, fake);
  assert.equal(r.status, 2, `signal death must block: ${r.stderr}`);
  assert.match(r.stderr, /backpressure-gate/);
});

test('F3: a gate that cannot even be spawned fails closed', () => {
  const dir = passingFixture();
  const fake = fakeGatesDir(dir);
  // Remove one gate entirely: node exits non-zero on a missing entry point.
  unlinkSync(join(fake, 'archive-guard.mjs'));
  const r = runFake(dir, fake);
  assert.equal(r.status, 2, `missing gate must block: ${r.stderr}`);
  assert.match(r.stderr, /archive-guard/);
});

test('F4: every gate runs, in registration order, even after one blocks', () => {
  const dir = passingFixture();
  const marker = join(dir, 'gate-order.log');
  const stub = (name, code) => `import { appendFileSync } from 'fs';\nappendFileSync(${JSON.stringify(marker)}, '${name}\\n');\nprocess.exit(${code});\n`;
  const fake = fakeGatesDir(dir, {
    'acceptance-gate.mjs': stub('acceptance', 2),   // blocks FIRST
    'backpressure-gate.mjs': stub('backpressure', 0),
    'review-gate.mjs': stub('review', 0),
    'archive-guard.mjs': stub('archive', 0),
  });
  const r = runFake(dir, fake);
  assert.equal(r.status, 2, 'the blocking verdict propagates');
  assert.equal(
    readFileSync(marker, 'utf-8').trim().split('\n').join(','),
    'acceptance,backpressure,review,archive',
    'all four gates run in registration order',
  );
});

// ---- cycle 12: pins the round-2 mutation audit found missing ---------------------------

// P4: a stale intent left by an attempt that never landed must be discarded by the NEXT hook
// run, not executed by it. Pins the dispatcher's start-of-run cleanup (round 2 showed P1–P3
// stayed green with that cleanup removed, because they only exercised the on-BLOCK path).
test('P4: a stale intent from an earlier attempt is never executed by a later commit', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  // Forge the state an aborted attempt would leave behind.
  const pend = join(dir, '.omp', 'harness-state', 'pending-consume');
  mkdirSync(pend, { recursive: true });
  writeFileSync(join(pend, 'append-audit-review-override.json'), JSON.stringify({ event: 'review_override', meta: { reason: 'stale attempt' } }) + '\n');
  writeFileSync(join(pend, 'unlink-review-skip'), 'docs/harness/review-skip\n');
  const skip = join(dir, 'docs', 'harness', 'review-skip');
  writeFileSync(skip, 'stale override\n');
  // A fresh, clean commit runs the gates and must not inherit that attempt's intents.
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: fresh'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `clean commit should land: ${r.stderr}`);
  assert.equal(auditLines(dir).filter((l) => l.includes('stale attempt')).length, 0, 'the stale audit intent must not be executed');
  assert.ok(existsSync(skip), 'the stale unlink intent must not be executed');
});

// P5: the consumption whitelist must refuse a path that escapes the repo. Pins the guard in
// post-commit (round 2: no test covered it, so removing the guard stayed green).
test('P5: a consumption intent that escapes the repo is refused', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  const victim = join(dir, 'victim.txt');
  writeFileSync(victim, 'must survive\n');
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  // Run the gates first so the token matches this exact attempt, THEN plant the escape intent
  // (the dispatcher clears the directory at the start of its run).
  const gate = runHookDispatcher(dir);
  assert.equal(gate.status, 0, `gates should pass: ${gate.stderr}`);
  const pend = join(dir, '.omp', 'harness-state', 'pending-consume');
  mkdirSync(pend, { recursive: true });
  writeFileSync(join(pend, 'unlink-escape'), '.omp/harness-state/../../victim.txt\n');
  const r = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'docs: fresh'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `commit should land: ${r.stderr}`);
  assert.ok(existsSync(victim), 'a path-escaping consumption target must be refused');
});

// P6 (review round 2, high #2 headline): the same TREE reached from a DIFFERENT base must not
// consume an approval. Measured on the tree-only binding: approve at base A, abort, reset to
// base B, land the identical tree with --no-verify → the advisory went silent, both one-shot
// flags were consumed, and audit.jsonl gained a review_override line whose diff_hash never
// existed in history.
test('P6: a same-tree commit on a different base does not consume the approval', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'git', ['add', 'a.txt', 'docs', '.gitignore']);
  sh(dir, 'git', ['commit', '-q', '-m', 'base A']);
  const baseA = head(dir);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  sh(dir, 'git', ['add', 'a.txt']);
  sh(dir, 'git', ['commit', '-q', '-m', 'base B']);
  const baseB = head(dir);
  // Approve a high-risk tree at base A via an audited override.
  sh(dir, 'git', ['reset', '-q', '--hard', baseA]);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  writeFileSync(join(dir, 'payload.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'a.txt', 'payload.mjs']);
  writeFileSync(join(dir, 'docs', 'harness', 'backpressure-skip'), '1\n');
  const hashA = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  const skip = join(dir, 'docs', 'harness', 'review-skip');
  writeFileSync(skip, JSON.stringify(['omp-review-override/v1', 'approved at base A', 'tester', hashA]));
  const approve = runHookDispatcher(dir);
  assert.equal(approve.status, 0, `the override should pass the gates: ${approve.stderr}`);
  // The commit never lands; move to base B and rebuild the IDENTICAL tree from a different diff.
  sh(dir, 'git', ['reset', '-q', '--hard', baseB]);
  writeFileSync(join(dir, 'payload.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'payload.mjs']);
  const landed = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'feat: same tree, other base'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(landed.status, 0, `the bypass commit itself is not blocked: ${landed.stderr}`);
  assert.match(landed.stderr, /HARNESS ADVISORY/, 'an unapproved base must still be reported as ungated');
  assert.ok(existsSync(skip), 'the override must NOT be consumed by a different-base commit');
  assert.equal(auditLines(dir).filter((l) => l.includes('review_override')).length, 0, 'no audit line for a diff that never landed');
});

// ---- cycle 13: round-3 findings ---------------------------------------------------------

// P7 (round 3, high): a plain `--amend --no-edit` must NOT consume an approval. The amend's
// content is not what the gates judged (they judge only what a commit ADDS to HEAD), and
// accepting it wrote an audit line whose diff_hash never landed. Same for any sibling commit
// built on the approved commit's parent.
test('P7: an amend does not consume the approval of the commit it replaces', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  const skip = overrideFixture(dir);
  const r = spawnSync('git', ['commit', '-q', '-m', 'feat: approved'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `approved commit should land: ${r.stderr}`);
  assert.ok(!existsSync(skip), 'its own approval is consumed');
  const before = auditLines(dir).length;
  // Approve a second attempt, abort it, then amend the previous commit instead.
  writeFileSync(join(dir, 'extra.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'extra.mjs']);
  writeFileSync(join(dir, 'docs', 'harness', 'backpressure-skip'), '1\n');
  const hash2 = execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8', env: hermeticEnv() })
    .trim().split(/\s+/)[0];
  writeFileSync(skip, JSON.stringify(['omp-review-override/v1', 'second attempt', 'tester', hash2]));
  const approve = runHookDispatcher(dir);
  assert.equal(approve.status, 0, `second override should pass: ${approve.stderr}`);
  sh(dir, 'git', ['reset', '-q', 'extra.mjs']);            // attempt abandoned, nothing staged
  const amend = spawnSync('git', ['commit', '--amend', '--no-edit'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(amend.status, 0, `the amend itself is allowed (no new content): ${amend.stderr}`);
  assert.match(amend.stderr, /HARNESS ADVISORY/, 'an amend is not the approved attempt');
  assert.ok(existsSync(skip), 'the second approval must NOT be consumed by the amend');
  assert.equal(auditLines(dir).length, before, 'no audit line for an attempt that never landed');
});

// I9b (round 3, L1): a fast-forward onto an EXISTING merge commit creates nothing, so the
// backstop must stay silent — the earlier parent-comparison check misfired exactly here.
test('I9b: fast-forwarding onto an existing merge commit emits no advisory', () => {
  const dir = passingFixture();
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(dir, 'feat.md'), 'feature docs\n');
  sh(dir, 'git', ['add', 'feat.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: feat']);
  sh(dir, 'git', ['checkout', '-q', '-']);
  writeFileSync(join(dir, 'main.md'), 'main docs\n');
  sh(dir, 'git', ['add', 'main.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: main']);
  sh(dir, 'git', ['merge', '--no-edit', '--no-ff', 'feat']);   // creates merge commit M
  const mergeSha = head(dir);
  // Move a branch to M's first parent, then fast-forward it back onto M.
  sh(dir, 'git', ['checkout', '-q', '-b', 'ffbranch', `${mergeSha}^1`]);
  const r = spawnSync('git', ['merge', '--ff-only', mergeSha], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `fast-forward should succeed: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /HARNESS ADVISORY/, 'a fast-forward creates no commit — no advisory');
});

// ---- cycle 14: round-4 findings -------------------------------------------------------

// R1: when the dispatcher cannot clear the previous attempt's state, the intents present are
// not provably THIS commit's. Executing them replayed a foreign approval into audit.jsonl on
// every later commit (round 4, measured with a read-only pending-consume directory).
test('R1: intents are not executed when the dispatcher could not clear stale state', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  // A read-only pending-consume survives `rm -rf` (removing its ENTRIES needs write on it), while
  // the state dir above stays writable - the exact shape round 4 measured.
  const pend = join(dir, '.omp', 'harness-state', 'pending-consume');
  mkdirSync(pend, { recursive: true });
  writeFileSync(join(pend, 'append-audit-review-override.json'), JSON.stringify({ event: 'review_override', meta: { reason: 'untrusted state' } }) + '\n');
  chmodSync(pend, 0o555);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: dirty state'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  chmodSync(pend, 0o755);
  assert.equal(r.status, 0, `the commit itself must still land: ${r.stderr}`);
  assert.equal(auditLines(dir).filter((l) => l.includes('untrusted state')).length, 0, 'an intent from unclearable state must not be recorded');
  assert.match(r.stderr, /HARNESS WARNING/, 'unclearable state must be announced, not silent');
});

// R2: a recorded consumption whose unlink FAILED left the one-shot armed while the audit said
// it was spent - a later commit then sailed past a FAILED verification state (round 4, measured).
test('R2: a consumption that cannot remove its flag warns that it is still armed', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  const harnessDir = join(dir, 'docs', 'harness');
  const skip = join(harnessDir, 'backpressure-skip');
  writeFileSync(skip, '1\n');
  // Medium risk: a code change (so the backpressure gate engages and defers its consumption)
  // that does not demand review evidence.
  writeFileSync(join(dir, 'small.mjs'), 'export const x = 1;\n');
  sh(dir, 'git', ['add', 'small.mjs', 'docs']);
  // The flag's DIRECTORY is read-only, so `rm -f` cannot unlink it while the gate still reads it -
  // the observable shape of any unlink failure (permissions, immutable bit) without needing root.
  chmodSync(harnessDir, 0o555);
  const r = spawnSync('git', ['commit', '-q', '-m', 'feat: unlink fails'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  chmodSync(harnessDir, 0o755);
  assert.equal(r.status, 0, `the commit must still land: ${r.stderr}`);
  assert.ok(existsSync(skip), 'precondition: the flag survived the removal attempt');
  assert.match(r.stderr, /STILL ARMED/, 'a flag that survived its consumption must be reported as armed');
});

// R3: git runs post-merge with $1=1 for a squash merge, which stages without committing - the
// advisory would name a commit that does not exist (round 4).
test('R3: a squash merge produces no ungated-commit advisory', () => {
  // HEAD must BE a merge commit for this to isolate the squash axis: a `--squash` merge writes no
  // commit and no reflog entry, so the parent/reflog checks alone still see a merge at HEAD and
  // reported a commit that does not exist.
  const dir = passingFixture();
  installBackstop(dir);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(dir, 'feat.md'), 'feature docs\n');
  sh(dir, 'git', ['add', 'feat.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: feat']);
  sh(dir, 'git', ['checkout', '-q', '-']);
  writeFileSync(join(dir, 'main.md'), 'main docs\n');
  sh(dir, 'git', ['add', 'main.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: main']);
  sh(dir, 'git', ['merge', '--no-edit', '--no-ff', 'feat']);   // HEAD is now a merge commit
  const before = head(dir);
  const r = spawnSync('bash', [join(dir, '.githooks', 'post-merge'), '1'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, 'the hook must not fail');
  assert.equal(head(dir), before, 'precondition: a squash merge creates no commit');
  assert.doesNotMatch(r.stderr, /HARNESS ADVISORY/, 'a squash merge creates no commit to report');
});

// R4 (CHARACTERIZATION): a legacy one-line token must never read as a valid approval. Measured
// honesty: the `v2` marker is NOT independently load-bearing here — the empty-field guard
// (`-z "$approved_tree"`) already refuses this token, so removing the version check keeps this
// green. The marker is defense in depth for FUTURE format changes, and this test pins the
// observable contract (a v1-shaped token does not silence the advisory) rather than one guard.
test('R4: a legacy one-line token is not accepted as an approval', () => {
  const dir = makeRepo();
  installHook(dir);      // present but skipped by --no-verify; the backstop still observes
  installBackstop(dir);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md']);
  const tree = spawnSync('git', ['write-tree'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() }).stdout.trim();
  const state = join(dir, '.omp', 'harness-state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'gated-commit-token'), `${tree}\n`);   // v1 shape: tree only
  const r = spawnSync('git', ['commit', '-q', '--no-verify', '-m', 'docs: legacy token'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `the commit lands: ${r.stderr}`);
  assert.match(r.stderr, /HARNESS ADVISORY/, 'a v1-shaped token must not silence the advisory');
});

// R5: the fast-forward test reads git's reflog SUBJECT, which must be anchored at its suffix. A
// branch whose NAME contains "Fast-forward" produces the subject "merge Fast-forward: Merge made
// by ..." — a substring match would read that real merge as a fast-forward and stay silent.
test('R5: a merge of a branch named like the reflog verb still reports', () => {
  const dir = passingFixture();
  installBackstop(dir);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'Fast-forward']);
  writeFileSync(join(dir, 'feat.md'), 'feature docs\n');
  sh(dir, 'git', ['add', 'feat.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: feat']);
  sh(dir, 'git', ['checkout', '-q', '-']);
  writeFileSync(join(dir, 'main.md'), 'main docs\n');
  sh(dir, 'git', ['add', 'main.md']);
  sh(dir, 'git', ['commit', '-q', '-m', 'docs: main']);
  const r = spawnSync('git', ['merge', '--no-edit', '--no-ff', 'Fast-forward'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `the merge should succeed: ${r.stderr}`);
  assert.match(r.stderr, /HARNESS ADVISORY/, 'a real merge commit must be reported whatever the branch is named');
});

// ---- cycle 15: round-5 findings -------------------------------------------------------

// R6: the round-4 dirty-state guard leaned on a MARKER, but the condition that makes cleanup fail
// (an unwritable state dir) also makes the marker unwritable — while the token file itself stays
// writable, so a valid approval was still issued and the foreign intent executed (round 5, M1).
// The protection has to be the absence of a token, not the presence of a marker.
test('R6: no verdict token is issued when stale state cannot be cleared', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  const state = join(dir, '.omp', 'harness-state');
  const pend = join(state, 'pending-consume');
  mkdirSync(pend, { recursive: true });
  writeFileSync(join(pend, 'append-audit-review-override.json'), JSON.stringify({ event: 'review_override', meta: { reason: 'foreign intent' } }) + '\n');
  // The token file pre-exists and is writable; the DIRECTORIES are not, so neither the cleanup nor
  // the marker can be written - the exact asymmetry round 5 measured.
  writeFileSync(join(state, 'gated-commit-token'), 'v2\nstale\nstale\n');
  chmodSync(pend, 0o555);
  chmodSync(state, 0o555);
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: unclearable state'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  chmodSync(state, 0o755);
  chmodSync(pend, 0o755);
  assert.equal(r.status, 0, `the commit itself must still land: ${r.stderr}`);
  assert.equal(auditLines(dir).filter((l) => l.includes('foreign intent')).length, 0, 'a foreign intent must not be executed');
  assert.match(r.stderr, /HARNESS ADVISORY/, 'with no token the commit must be reported as ungated');
});

// R7: `commit-wip` is consumed by `rm -f`, whose failure was unchecked. A directory at that path
// (a `mkdir -p` slip on the gate's own guidance) satisfies the gate's existsSync WIP check and
// survives removal, granting every later commit an open-ended AC exemption in silence (round 5, M2).
test('R7: a commit-wip that cannot be consumed is reported as still armed', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  // No passAcceptance: the WIP flag is what lets this commit through, so its consumption matters.
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'harness', 'seed.yaml'), 'name: open\nstatus: active\nversion: 1\ntask_id: "20260730-000000-aaaa"\n');
  writeFileSync(join(dir, 'docs', 'harness', 'current-scope.md'), '# Current Scope\n\n## Acceptance Criteria\n\n- [ ] AC1 open\n');
  mkdirSync(join(dir, '.omp', 'harness-state', 'commit-wip'), { recursive: true });
  writeFileSync(join(dir, 'notes.md'), 'docs only\n');
  sh(dir, 'git', ['add', 'notes.md', 'docs']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: wip checkpoint'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `the wip commit lands: ${r.stderr}`);
  assert.match(r.stderr, /STILL ARMED/, 'an unconsumable wip exemption must be reported, not silent');
});

// ---- estimate-vs-actual (seed 20260918-023000-e5a1, AC1–AC4) -----------------------------------
// The intake record .omp/harness-state/cycle-estimate is OBSERVED by review-gate in hook mode and
// consumed post-commit through the same deferred protocol as review-skip. It must never touch a
// verdict: E1 pins that a valid AND a malformed record leave exit code + BLOCK output identical
// to the no-record run; E2 the landed/blocked/absent consumption matrix; E3 the malformed lane.

const ESTIMATE_PATH = (dir) => join(dir, '.omp', 'harness-state', 'cycle-estimate');
const estimateTuple = (ts = '2026-09-18T02:00:00Z') =>
  JSON.stringify(['omp-estimate/v1', 'medium', 3, 'high', 'claude-fable-5-1', 'high', ts]) + '\n';
function writeEstimate(dir, text = estimateTuple()) {
  mkdirSync(join(dir, '.omp', 'harness-state'), { recursive: true });
  writeFileSync(ESTIMATE_PATH(dir), text);
}
// The verdict-relevant part of stderr: everything but the ONE permitted estimate warning line.
// The filter is exact — a BLOCK line that merely mentioned the record would survive and fail E1.
const ESTIMATE_WARNING = /^HARNESS WARNING: \.omp\/harness-state\/cycle-estimate is not a valid estimate record/;
const verdictStderr = (s) => s.split('\n').filter((l) => !ESTIMATE_WARNING.test(l)).join('\n');

// E1 / AC2: a high-risk attempt with no evidence blocks identically with no record, a valid
// record, and a malformed record — and the record survives every blocked attempt.
test('E1: the estimate record never changes a verdict (block output byte-identical)', () => {
  const runs = {};
  for (const [name, text] of [['none', null], ['valid', estimateTuple()], ['malformed', '["omp-estimate/v1","severe"]\n']]) {
    const dir = makeRepo();
    passAcceptance(dir);
    writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
    sh(dir, 'git', ['add', '-A']);
    if (text !== null) writeEstimate(dir, text);
    const r = runHookDispatcher(dir);
    assert.equal(r.status, 2, `${name}: high risk without evidence must block`);
    if (text !== null) assert.ok(existsSync(ESTIMATE_PATH(dir)), `${name}: a blocked attempt leaves the record on disk`);
    assert.ok(!existsSync(join(dir, '.omp', 'harness-state', 'pending-consume')), `${name}: no intent survives a block`);
    runs[name] = verdictStderr(r.stderr);
  }
  assert.equal(runs.valid, runs.none, 'a valid record must not alter the block output');
  assert.equal(runs.malformed, runs.none, 'a malformed record must not alter the block output');
});

// E2 / AC3: landed commit -> exactly one estimate_vs_actual line + record consumed; a commit with
// no record leaves audit.jsonl untouched.
test('E2: a landed commit records estimate_vs_actual once and consumes the record', () => {
  const dir = passingFixture();                       // docs-only: low risk, gates allow
  writeEstimate(dir);
  mkdirSync(join(dir, '.omp', 'harness-state'), { recursive: true });
  writeFileSync(join(dir, '.omp', 'harness-state', 'session-log.jsonl'),
    JSON.stringify({ ts: '2026-09-18T02:30:00.000Z', kind: 'test', type: 'test', result: 'FAIL' }) + '\n' +
    JSON.stringify({ ts: '2026-09-18T01:30:00.000Z', kind: 'test', type: 'test', result: 'FAIL' }) + '\n');
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: estimated'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `commit should land: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /HARNESS WARNING.*cycle-estimate/, 'a valid record produces no warning');
  const lines = auditLines(dir).filter((l) => l.includes('estimate_vs_actual'));
  assert.equal(lines.length, 1, 'exactly one estimate_vs_actual audit line');
  const ev = JSON.parse(lines[0]);
  assert.deepEqual(ev.meta.predicted, { risk: 'medium', files: 3, depth: 'high', model: 'claude-fable-5-1', effort: 'high', ts: '2026-09-18T02:00:00Z' });
  assert.equal(ev.meta.actual.risk, 'low');
  assert.equal(ev.meta.actual.files, 2, 'notes.md + docs/harness/current-scope.md');
  assert.equal(ev.meta.fails_since_estimate, 1, 'only the FAIL after the record ts counts');
  assert.ok(!existsSync(ESTIMATE_PATH(dir)), 'the record is consumed once the commit lands');
  assert.ok(!existsSync(join(dir, '.omp', 'harness-state', 'pending-consume')), 'intents fully consumed');
  // A second commit with no record: audit.jsonl gains nothing.
  const before = auditLines(dir).length;
  writeFileSync(join(dir, 'more.md'), 'more docs\n');
  sh(dir, 'git', ['add', 'more.md']);
  const r2 = spawnSync('git', ['commit', '-q', '-m', 'docs: unestimated'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r2.status, 0, `second commit should land: ${r2.stderr}`);
  assert.equal(auditLines(dir).length, before, 'no record, no audit line');
});

// E2b / AC3: a BLOCKED attempt with a record appends nothing and consumes nothing; the record is
// then picked up by the next attempt that lands.
test('E2b: a blocked attempt neither records nor consumes; the next landed commit does', () => {
  const dir = makeRepo();
  installHook(dir);
  installBackstop(dir);
  passAcceptance(dir);
  writeFileSync(join(dir, 'big.mjs'), bigCodeFile());
  sh(dir, 'git', ['add', 'big.mjs', 'docs']); // harness/hook files stay untracked (see I1)
  writeEstimate(dir);
  const blocked = spawnSync('git', ['commit', '-q', '-m', 'feat: unreviewed'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(blocked.status, 1, 'review-gate blocks the unreviewed high-risk commit');
  assert.equal(auditLines(dir).filter((l) => l.includes('estimate_vs_actual')).length, 0, 'nothing recorded for a diff that never landed');
  assert.ok(existsSync(ESTIMATE_PATH(dir)), 'the record survives the block');
  // Drop the risky file entirely (index AND worktree); land a docs-only commit instead.
  sh(dir, 'git', ['rm', '-q', '-f', 'big.mjs']);
  const landed = spawnSync('git', ['commit', '-q', '-m', 'docs: scope only'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(landed.status, 0, `docs commit should land: ${landed.stderr}`);
  assert.equal(auditLines(dir).filter((l) => l.includes('estimate_vs_actual')).length, 1, 'the next landed commit records it once');
  assert.ok(!existsSync(ESTIMATE_PATH(dir)), 'and consumes it');
});

// E3 / AC4: a malformed record is ignored with ONE warning, blocks nothing, and is NOT consumed.
test('E3: a malformed estimate record warns once, allows, and stays on disk', () => {
  const dir = passingFixture();
  writeEstimate(dir, JSON.stringify(['omp-estimate/v1', 'medium', 3, 'medium', 'm', null, 'nope']) + '\n');
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: malformed estimate'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv() });
  assert.equal(r.status, 0, `the commit must still land: ${r.stderr}`);
  const warnings = r.stderr.split('\n').filter((l) => /HARNESS WARNING.*cycle-estimate/.test(l));
  assert.equal(warnings.length, 1, `exactly one warning line, got: ${r.stderr}`);
  assert.match(warnings[0], /element 3 \(depth\)/);
  assert.equal(auditLines(dir).filter((l) => l.includes('estimate_vs_actual')).length, 0, 'nothing recorded');
  assert.ok(existsSync(ESTIMATE_PATH(dir)), 'the malformed record is left for the author to fix');
});

// E4 / AC1+AC4 (review 2026-09-22, high — reproduced): a NON-REGULAR file at the record path or at
// the breadcrumb log must not stall the gate. A plain open of a FIFO blocks until a writer appears —
// past the dispatcher's 3s SIGKILL, which re-rendered this observation-only step as a fail-closed
// BLOCK on a docs-only commit. Both reads now go through the O_NOFOLLOW|O_NONBLOCK + isFile()
// discipline the evidence files already use: the record is rejected with one warning and stays; a
// FIFO log just yields fails_since_estimate = 0.
test('E4: a FIFO or device-symlink record and a FIFO session log never block the commit', () => {
  const cases = [
    ['fifo', (p) => sh(dirname(p), 'mkfifo', [p]), /not a regular file/],
    ['devzero', (p) => symlinkSync('/dev/zero', p), /a symlink/],
    ['dangling', (p) => symlinkSync('/nonexistent/target', p), /a symlink/],   // existsSync would say "absent"
  ];
  for (const [name, plant, why] of cases) {
    const dir = passingFixture();
    mkdirSync(join(dir, '.omp', 'harness-state'), { recursive: true });
    plant(ESTIMATE_PATH(dir));
    const start = Date.now();
    const r = spawnSync('git', ['commit', '-q', '-m', `docs: ${name} estimate`], { cwd: dir, encoding: 'utf-8', env: hermeticEnv(), timeout: 15_000 });
    assert.equal(r.status, 0, `${name}: the commit must land: signal=${r.signal} ${r.stderr}`);
    assert.ok(Date.now() - start < 5_000, `${name}: the gate must not stall on the record`);
    const warnings = r.stderr.split('\n').filter((l) => ESTIMATE_WARNING.test(l));
    assert.equal(warnings.length, 1, `${name}: exactly one warning line, got: ${r.stderr}`);
    assert.match(warnings[0], why);
    assert.equal(auditLines(dir).filter((l) => l.includes('estimate_vs_actual')).length, 0, `${name}: nothing recorded`);
    assert.doesNotThrow(() => lstatSync(ESTIMATE_PATH(dir)), `${name}: the rejected record stays on disk (not consumed)`);
  }
  // A valid record beside a FIFO session log: compared and consumed, tail read skipped.
  const dir = passingFixture();
  writeEstimate(dir);
  sh(dir, 'mkfifo', [join(dir, '.omp', 'harness-state', 'session-log.jsonl')]);
  const start = Date.now();
  const r = spawnSync('git', ['commit', '-q', '-m', 'docs: fifo session log'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv(), timeout: 15_000 });
  assert.equal(r.status, 0, `the commit must land: signal=${r.signal} ${r.stderr}`);
  assert.ok(Date.now() - start < 5_000, 'the gate must not stall on the log');
  const lines = auditLines(dir).filter((l) => l.includes('estimate_vs_actual'));
  assert.equal(lines.length, 1, 'the valid record is still observed');
  assert.equal(JSON.parse(lines[0]).meta.fails_since_estimate, 0);
  assert.ok(!existsSync(ESTIMATE_PATH(dir)), 'and consumed');
});

// E5 (review 2026-09-23, medium — reproduced): a FIFO planted where the gate writes its pending
// intent (in a pending-consume dir the dispatcher's clear could not remove) blocked the intent
// open past the budget and turned a docs-only ALLOW into a BLOCK. The writes now use 'wx'
// (O_EXCL): the planted entry fails with EEXIST at once, the outer catch prints one warning, the
// verdict stays ALLOW, and the record is left unconsumed for the next attempt.
test('E5: a planted FIFO at the pending-intent path cannot stall the gate', () => {
  const dir = passingFixture();
  writeEstimate(dir);
  const pend = join(dir, '.omp', 'harness-state', 'pending-consume');
  mkdirSync(pend, { recursive: true });
  sh(dir, 'mkfifo', [join(pend, 'append-audit-estimate.json')]);
  chmodSync(pend, 0o555);                      // the dispatcher's clearAttemptState cannot remove it
  try {
    const start = Date.now();
    const r = spawnSync('git', ['commit', '-q', '-m', 'docs: planted intent'], { cwd: dir, encoding: 'utf-8', env: hermeticEnv(), timeout: 15_000 });
    assert.equal(r.status, 0, `the commit must land: signal=${r.signal} ${r.stderr}`);
    assert.ok(Date.now() - start < 5_000, 'the gate must not stall on the planted intent');
    assert.match(r.stderr, /HARNESS WARNING: estimate comparison skipped \(.*EEXIST/, 'one warning names the cause');
    assert.equal(auditLines(dir).filter((l) => l.includes('estimate_vs_actual')).length, 0, 'nothing recorded');
    assert.ok(existsSync(ESTIMATE_PATH(dir)), 'the record is not consumed');
  } finally {
    chmodSync(pend, 0o755);
  }
});
