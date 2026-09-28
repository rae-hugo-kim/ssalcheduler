// Tests for risk-assess.mjs — the shared risk classifier used by backpressure-gate and
// review-gate to decide whether a commit needs test-verification / adversarial review.
//
// Run: node --test .omp/extensions/harness/tests/risk-assess.test.mjs
//
// Focus: the audit "substring footgun" (item #6). HIGH_RISK_PATTERNS are unanchored substrings
// matched against file paths, so documentation files whose NAME contains a risk word
// (`*_policy.md`, `author-guide.md`, ...) were misclassified as CRITICAL — forcing test gates and
// adversarial review on prose. The fix exempts documentation extensions from high-risk while
// keeping real security CODE/CONFIG matching. These tests lock both directions.
//
// Integration tests use a throwaway git repo with an EXPLICIT cwd passed to git and assessRisk,
// so the real repo is never touched (see memory: feedback_shell_test_cwd_isolation).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assessRisk, isHighRiskFile } from '../gates/risk-assess.mjs';
import { parseCommitForm } from '../gates/git-commit-detect.mjs';

// --- Unit: isHighRiskFile (pure, no git) ---

test('isHighRiskFile: real security code/config stays high-risk', () => {
  for (const f of [
    'src/auth/login.ts',
    'src/oauth.ts',
    'lib/authentication.ts',          // substring match must survive (NOT broken by anchoring)
    'migrations/001_init.sql',
    'db/schema.prisma',
    'config/rls_policies.sql',
    'app/policy.ts',
    'src/credentials.ts',
    'lib/tokenStore.ts',
    '.env',
    'secrets/private.pem',
    'keys/server.key',
    'config/app.secret',
  ]) {
    assert.equal(isHighRiskFile(f), true, `should be high-risk: ${f}`);
  }
});

test('isHighRiskFile: prose docs are exempt from TOPIC substrings (the footgun fix)', () => {
  for (const f of [
    // the 9 real files in THIS repo that previously misclassified as CRITICAL
    'docs/rules/glossary_policy.md',
    'docs/rules/seed_evolution_policy.md',
    '.omp/rules/harness-code_review_policy.md',
    'rules/context7_policy.md',
    '.omp/rules/harness-documentation_policy.md',
    '.omp/rules/harness-learning_policy.md',
    '.omp/rules/harness-mcp_policy.md',
    '.omp/rules/harness-tdd_policy.md',
    'templates/policy_sync_checklist.md',
    // other prose docs named for a topic
    'docs/author-guide.md',
    'notes/migration-plan.md',
    'CHANGELOG.txt',
    // case-insensitive: an uppercase prose extension is still exempt
    'rules/tdd_policy.MD',
    'docs/AUTHOR-GUIDE.MD',
  ]) {
    assert.equal(isHighRiskFile(f), false, `prose doc must NOT be high-risk: ${f}`);
  }
});

test('isHighRiskFile: secret/material in a prose doc STAYS high-risk (no false-negative)', () => {
  // A credential/token/password can be leaked into prose — the doc exemption must NOT swallow it.
  // Regression guard: a blanket doc exemption (the first attempt) wrongly dropped these to low.
  for (const f of [
    'config/credentials.txt',
    'runbooks/password-rotation.md',
    'secrets/prod-token.txt',
    'docs/auth-token.md',
  ]) {
    assert.equal(isHighRiskFile(f), true, `secret-bearing doc must stay high-risk: ${f}`);
  }
});

test('isHighRiskFile: .mdx is NOT passive-exempt (can import/execute JSX)', () => {
  for (const f of [
    'docs/schema-overview.mdx',
    'pages/auth.mdx',
    'src/policy.mdx',
  ]) {
    assert.equal(isHighRiskFile(f), true, `.mdx topic file must stay high-risk: ${f}`);
  }
});

// --- Integration: assessRisk over a real staged diff ---

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'risk-test-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  for (const [rel, content] of Object.entries(files)) {
    const fp = join(dir, rel);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
  }
  git(['add', '-A']);
  return dir;
}

function withRepo(files, fn) {
  const dir = makeRepo(files);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('assessRisk: editing only a policy DOC is low risk (was falsely CRITICAL)', () => {
  withRepo({ '.omp/rules/harness-tdd_policy.md': '# TDD policy\nsome prose change\n' }, (dir) => {
    assert.equal(assessRisk(dir).level, 'low');
  });
});

test('assessRisk: editing real auth CODE is still critical', () => {
  withRepo({ 'src/auth/login.ts': 'export const login = () => {};\n' }, (dir) => {
    assert.equal(assessRisk(dir).level, 'critical');
  });
});

test('assessRisk: benign code + a policy doc is medium, not critical', () => {
  withRepo({
    'src/util.ts': 'export const add = (a, b) => a + b;\n',
    '.omp/rules/harness-mcp_policy.md': '# MCP policy\nprose\n',
  }, (dir) => {
    assert.equal(assessRisk(dir).level, 'medium');
  });
});

test('assessRisk: a migration .sql is still critical', () => {
  withRepo({ 'migrations/002_add_table.sql': 'CREATE TABLE t (id int);\n' }, (dir) => {
    assert.equal(assessRisk(dir).level, 'critical');
  });
});

test('assessRisk: a doc holding credential material is still critical', () => {
  withRepo({ 'docs/credentials-runbook.md': '# rotate the token\n' }, (dir) => {
    assert.equal(assessRisk(dir).level, 'critical');
  });
});

test('assessRisk: a .mdx file named for a topic is still critical', () => {
  withRepo({ 'pages/auth.mdx': 'import X from "x"\n' }, (dir) => {
    assert.equal(assessRisk(dir).level, 'critical');
  });
});

test('assessRisk: an uppercase prose doc (.MD) is low, not medium (case-insensitive)', () => {
  // Guards the full footgun fix: extension matching across assessRisk (docs-only classification,
  // not just the high-risk check) must be case-insensitive, else `tdd_policy.MD` falls to medium.
  withRepo({ 'rules/tdd_policy.MD': '# TDD policy\nprose change\n' }, (dir) => {
    assert.equal(assessRisk(dir).level, 'low');
  });
});

// --- Commit-form scoping: risk is assessed on what the commit actually CAPTURES ---
// A repo with an initial commit, then a STAGED low-risk doc edit and an UNSTAGED
// (tracked) critical-risk code edit. A plain commit captures only the staged doc;
// -a captures the unstaged code too; an unverifiable form falls back to the union.

function makeMixedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'risk-form-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'src/auth/login.ts'), 'init\n');
  writeFileSync(join(dir, 'docs/notes.md'), '# init\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  writeFileSync(join(dir, 'docs/notes.md'), '# init\nstaged prose edit\n');  // staged: low
  git(['add', 'docs/notes.md']);
  writeFileSync(join(dir, 'src/auth/login.ts'), 'init\nunstaged auth edit\n'); // unstaged: critical
  return dir;
}

function withMixed(fn) {
  const dir = makeMixedRepo();
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('assessRisk(form=plain): only the staged doc counts -> low (ignores unstaged auth)', () => {
  withMixed((dir) => {
    assert.equal(assessRisk(dir, parseCommitForm('git commit -m x')).level, 'low');
  });
});

test('assessRisk(form=-a): captures unstaged tracked code -> critical', () => {
  withMixed((dir) => {
    assert.equal(assessRisk(dir, parseCommitForm('git commit -am x')).level, 'critical');
  });
});

test('assessRisk(unverifiable form): conservative union -> critical', () => {
  withMixed((dir) => {
    assert.equal(assessRisk(dir, parseCommitForm('git commit -m x src/auth/login.ts')).level, 'critical');
  });
});

test('assessRisk(no form): legacy union default is unchanged -> critical', () => {
  // Back-compat: callers that pass no form still get the staged∪unstaged union, so the
  // unstaged auth edit is seen. This is what guarantees the plain-form result above is a
  // real narrowing, not an across-the-board drop.
  withMixed((dir) => {
    assert.equal(assessRisk(dir).level, 'critical');
  });
});

// --- Template bootstrap window (#35-2) ---
// `init` commits the Phase 2 cleanup as the SECOND commit of a fresh template clone: many
// deletions (including a source-only `*credentials*` prose doc that scores critical) plus the
// README/meta/glossary/audit edits. Inside the window — one commit, no refs/harness/*, committed
// harness-meta.json carrying bootstrapped_at + source_remote — deletions and the init-edited
// files are excluded; anything else in the commit is scored as usual, and outside the window
// nothing changes.

const META = '.omp/extensions/harness/harness-meta.json';
const TEMPLATE = {
  'README.md': '# omp template\nlong\n',
  'AGENTS.md': '# policy\n',
  [META]: '{"version":"2026.77"}\n',
  '.omp/extensions/harness/index.ts': 'export default function harness() {}\n',
  '.githooks/pre-commit': '#!/usr/bin/env bash\nexit 0\n',
  '.omp/rules/harness-tdd_policy.md': '# tdd\n',
  'claudedocs/CLAUDEKR.md': '# mirror\n',
  'docs/plans/agent-browser-credentials-plan.md': '# plan\n',
  'scripts/docs-drift': '#!/usr/bin/env node\n',
  'docs/harness/audit.jsonl': '{"event":"x"}\n',
};
const BOOTSTRAP_META = '{"version":"2026.77","source_remote":"git@github.com:o/omp.git","commit_sha":"abc","bootstrapped_at":"2026-09-23T00:00:00Z"}\n';

function makeTemplateClone(extraCommits = 0) {
  const dir = makeRepo(TEMPLATE);
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['commit', '-q', '-m', 'Initial commit']);
  for (let i = 0; i < extraCommits; i++) git(['commit', '-q', '--allow-empty', '-m', `more ${i}`]);
  const cleanup = () => {
    for (const rel of ['claudedocs/CLAUDEKR.md', 'docs/plans/agent-browser-credentials-plan.md', 'scripts/docs-drift']) rmSync(join(dir, rel));
    writeFileSync(join(dir, 'README.md'), '# proj\n<!-- claude-template-placeholder -->\n');
    writeFileSync(join(dir, 'docs/harness/audit.jsonl'), '');
    writeFileSync(join(dir, META), BOOTSTRAP_META);
    git(['add', '-A']);
  };
  return { dir, git, cleanup };
}

function withTemplateClone(extraCommits, fn) {
  const t = makeTemplateClone(extraCommits);
  try { return fn(t); } finally { rmSync(t.dir, { recursive: true, force: true }); }
}

test('bootstrap: the init cleanup commit of a fresh clone is low (deletions + README/meta edits excluded)', () => {
  withTemplateClone(0, ({ dir, cleanup }) => {
    cleanup();
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'low', r.reason);
    assert.match(r.reason, /template bootstrap/);
    assert.equal(r.files.length, 0, 'nothing is left to score');
    assert.ok(r.bootstrap.includes('docs/plans/agent-browser-credentials-plan.md'), 'the credential-named deletion is inside the window');
  });
});

test('bootstrap: user code or an AGENTS.md edit mixed into the cleanup commit is still scored', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/app.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'AGENTS.md'), '# policy\nconsumer edit\n');
    git(['add', '-A']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'medium', r.reason);
    assert.deepEqual(r.files.sort(), ['AGENTS.md', 'src/app.ts'], 'only the non-cleanup remainder is scored');
  });
});

test('bootstrap: outside the window (a second commit exists) the same diff is critical', () => {
  withTemplateClone(1, ({ dir, cleanup }) => {
    cleanup();
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  });
});

test('bootstrap: without bootstrapped_at/source_remote in the COMMITTED meta the window does not open', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    // The worktree copy carries the fields but the staged copy does not: a plain commit
    // ships the index, so the index decides.
    git(['add', '-A']);
    spawnSync('git', ['update-index', '--cacheinfo', `100644,${spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: '{"version":"2026.77"}\n', encoding: 'utf-8' }).stdout.trim()},${META}`], { cwd: dir });
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
  });
});

// Review 2026-09-23 (high): `rev-list --count HEAD == 1` alone also describes a `--depth 1` clone.
// This fixture is a shallow clone of a TEMPLATE (HEAD meta carries no marker, the source has more
// history) and then performs a textbook cleanup commit — so ONLY the shallow guard closes the
// window here (round 3: the earlier consumer-clone variant was also closed by the HEAD-marker rule
// and survived removal of the shallow guard).
test('bootstrap: a shallow clone is never a bootstrap window, even for a textbook cleanup commit', () => {
  const src = makeRepo(TEMPLATE);
  const g = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  g(src, ['commit', '-q', '-m', 'template history 1']);
  g(src, ['commit', '-q', '--allow-empty', '-m', 'template history 2']);
  const clone = join(mkdtempSync(join(tmpdir(), 'risk-shallow-')), 'c');
  g(src, ['clone', '-q', '--depth', '1', `file://${src}`, clone]);
  g(clone, ['config', 'user.email', 't@example.com']);
  g(clone, ['config', 'user.name', 'Test']);
  try {
    assert.equal(g(clone, ['rev-list', '--count', 'HEAD']).trim(), '1', 'precondition: the clone has exactly one commit');
    assert.equal(g(clone, ['rev-parse', '--is-shallow-repository']).trim(), 'true');
    for (const rel of ['claudedocs/CLAUDEKR.md', 'docs/plans/agent-browser-credentials-plan.md', 'scripts/docs-drift']) rmSync(join(clone, rel));
    writeFileSync(join(clone, META), BOOTSTRAP_META);
    g(clone, ['add', '-A']);
    const r = assessRisk(clone, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0, 'nothing may be exempted in a shallow clone');
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dirname(clone), { recursive: true, force: true });
  }
});

// Round 3 (C-1 residual): the HEAD marker test is KEY presence — any value type closes the window —
// and a non-object meta root at HEAD is not a template copy either.
test('bootstrap: non-string marker values or a non-object meta root at HEAD close the window', () => {
  const cases = [
    '{"version":"2026.77","bootstrapped_at":null}\n',
    '{"version":"2026.77","source_remote":false}\n',
    '{"version":"2026.77","bootstrapped_at":0}\n',
    '{"version":"2026.77","bootstrapped_at":["x"]}\n',
    '["version","2026.77"]\n',
    '"2026.77"\n',
  ];
  for (const headMetaText of cases) {
    const dir = makeRepo({ ...TEMPLATE, [META]: headMetaText });
    const g = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); };
    g(['commit', '-q', '-m', 'Initial commit']);
    try {
      rmSync(join(dir, 'docs/plans/agent-browser-credentials-plan.md'));
      writeFileSync(join(dir, META), BOOTSTRAP_META);
      g(['add', '-A']);
      const r = assessRisk(dir, parseCommitForm('git commit -m x'));
      assert.equal(r.level, 'critical', `${headMetaText.trim()} -> ${r.reason}`);
      assert.equal(r.bootstrap.length, 0, `${headMetaText.trim()} must not open the window`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Round 3 (low): in the unverifiable union, a path whose index status (M) and worktree status (D)
// disagree is neither a clean edit nor a clean deletion — it is scored.
test('bootstrap (unverifiable form): index-modified + worktree-deleted README.md is scored, not exempted', () => {
  withTemplateClone(0, ({ dir, cleanup }) => {
    cleanup();                                   // README.md: M in the index
    rmSync(join(dir, 'README.md'));              // README.md: D in the worktree
    const r = assessRisk(dir, parseCommitForm('git commit -m x README.md'));
    assert.ok(!r.bootstrap.includes('README.md'), 'a disagreeing status must not be exempted');
    assert.ok(r.files.includes('README.md'), 'README.md is scored');
  });
});

test('bootstrap: a single-commit repo whose HEAD already carries bootstrap meta is a consumer, not a template copy', () => {
  // Same shape as an init clone (one commit, not shallow, no refs/harness) but the meta transition
  // already happened in HEAD: the deletion of a credential-named file must be scored.
  const dir = makeRepo({ ...TEMPLATE, [META]: BOOTSTRAP_META });
  const g = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); };
  g(['commit', '-q', '-m', 'Initial commit']);
  try {
    rmSync(join(dir, 'docs/plans/agent-browser-credentials-plan.md'));
    g(['add', '-A']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap: any ref under refs/harness/ closes the window, version-shaped or not', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    git(['update-ref', 'refs/harness/manual', 'HEAD']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  });
});

// Advisory 2026-09-23 (blocker): the window must not exempt EVERY deletion. Inside a legitimate
// template->consumer transition, deleting harness assets (the extension entry point, a git hook,
// a rule) would have passed as low and silently unwired the gates. Deletions are exempt only for
// the Phase 2 source-only cleanup set (docs/, claudedocs/, scripts/docs-drift, CHANGELOG.md, never
// a harness asset path); everything else is scored.
test('bootstrap: deleting harness assets inside the window is scored, cleanup deletions stay exempt', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    for (const f of ['.omp/extensions/harness/index.ts', '.githooks/pre-commit', '.omp/rules/harness-tdd_policy.md']) rmSync(join(dir, f));
    git(['add', '-A']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.notEqual(r.level, 'low', `harness-asset deletions must be scored: ${r.reason}`);
    assert.deepEqual(r.files.sort(), ['.githooks/pre-commit', '.omp/extensions/harness/index.ts', '.omp/rules/harness-tdd_policy.md'], 'exactly the harness-asset deletions are scored');
    assert.ok(r.bootstrap.includes('claudedocs/CLAUDEKR.md') && r.bootstrap.includes('scripts/docs-drift') && r.bootstrap.includes('docs/plans/agent-browser-credentials-plan.md'), 'source-only cleanup deletions remain exempt');
    assert.ok(!r.bootstrap.some((f) => f.startsWith('.omp/extensions/harness/index') || f.startsWith('.githooks/') || f.startsWith('.omp/rules/harness-')), 'no harness asset may appear in the exempt set');
  });
});

test('bootstrap: a deletion under a harness-owned docs/ prefix (docs/rules) is not cleanup', () => {
  const dir = makeRepo({ ...TEMPLATE, 'docs/rules/seed_contract.md': '# contract\n' });
  const g = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); };
  g(['commit', '-q', '-m', 'Initial commit']);
  try {
    rmSync(join(dir, 'docs/rules/seed_contract.md'));
    writeFileSync(join(dir, META), BOOTSTRAP_META);
    g(['add', '-A']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.deepEqual(r.files, ['docs/rules/seed_contract.md'], 'docs/rules/ is a harness asset path, so its deletion is scored');
    assert.ok(!r.bootstrap.includes('docs/rules/seed_contract.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review 2026-09-23 round 2 (C-1): a HEAD meta with a PARTIAL or empty bootstrap marker is still a
// consumer — the window opens only when HEAD carries no marker at all — and a committed meta with
// empty-string markers does not count as bootstrapped.
test('bootstrap: a partial marker at HEAD (bootstrapped_at without source_remote) closes the window', () => {
  const dir = makeRepo({ ...TEMPLATE, [META]: '{"version":"2026.77","bootstrapped_at":"2026-09-01T00:00:00Z"}\n' });
  const g = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); };
  g(['commit', '-q', '-m', 'Initial commit']);
  try {
    rmSync(join(dir, 'docs/plans/agent-browser-credentials-plan.md'));
    writeFileSync(join(dir, META), BOOTSTRAP_META);
    g(['add', '-A']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap: empty-string markers in the committed meta do not open the window', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    writeFileSync(join(dir, META), '{"version":"2026.77","source_remote":"","bootstrapped_at":" "}\n');
    git(['add', '-A']);
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  });
});

// Review 2026-09-23 round 2 (C-4): under `-a` the committed meta is read from the worktree, so
// removing harness-meta.json from the INDEX while keeping the worktree copy must not let the
// meta DELETION ride the edited-path exemption.
test('bootstrap (-a form): a staged deletion of harness-meta.json is scored, not exempted as an edit', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    git(['rm', '-q', '--cached', META]);          // index: deleted; worktree: bootstrapped copy
    const r = assessRisk(dir, parseCommitForm('git commit -am x'));
    assert.ok(!r.bootstrap.includes(META), 'the meta deletion must not be in the exempt set');
    assert.ok(r.files.includes(META), 'the meta deletion is scored');
  });
});

// Review 2026-09-23 rounds 4–5: a harness-meta.json that is a SYMLINK must never satisfy the
// transition, wherever it is observed. Three fixtures, each of which ONLY the named guard can
// reject (mutation-verified: removing that guard fails exactly that test):
//   index guard  — a 120000 index entry whose LINK TEXT is the bootstrapped JSON (`git show :path`
//                  returns the link text, which JSON.parse accepts); plain-commit form.
//   lstat guard  — a worktree symlink to a REAL file holding the bootstrapped JSON (readFileSync
//                  follows it happily); -a form, index also holds the link.
//   HEAD guard   — HEAD's entry is a 120000 symlink whose link text is the template JSON; the
//                  commit replaces it with a regular bootstrapped file (index gets a T/M entry).
test('bootstrap (index guard): a 120000 index entry with JSON link text never opens the window', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    unlinkSync(join(dir, META));
    symlinkSync(BOOTSTRAP_META.trim(), join(dir, META));
    git(['add', '-A']);
    assert.match(spawnSync('git', ['ls-files', '-s', '--', META], { cwd: dir, encoding: 'utf-8' }).stdout, /^120000 /, 'precondition: index entry is a symlink');
    assert.doesNotThrow(() => JSON.parse(spawnSync('git', ['show', `:${META}`], { cwd: dir, encoding: 'utf-8' }).stdout), 'precondition: the link text parses as JSON');
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  });
});

test('bootstrap (lstat guard, -a form): a worktree symlink to a real bootstrapped JSON file never opens the window', () => {
  withTemplateClone(0, ({ dir, git, cleanup }) => {
    cleanup();
    unlinkSync(join(dir, META));
    writeFileSync(join(dir, 'meta-target.json'), BOOTSTRAP_META);
    symlinkSync('../../../meta-target.json', join(dir, META));
    git(['add', '-A']);
    assert.equal(readFileSync(join(dir, META), 'utf-8'), BOOTSTRAP_META, 'precondition: readFileSync follows the link to bootstrapped JSON');
    const r = assessRisk(dir, parseCommitForm('git commit -am x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  });
});

test('bootstrap (HEAD guard): a 120000 harness-meta.json AT HEAD is not a template copy', () => {
  const dir = makeRepo({ ...TEMPLATE });
  const g = (args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  try {
    unlinkSync(join(dir, META));
    symlinkSync('{"version":"2026.77"}', join(dir, META));
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'Initial commit']);
    assert.match(g(['ls-tree', 'HEAD', '--', META]), /^120000 /, 'precondition: HEAD entry is a symlink');
    unlinkSync(join(dir, META));                       // unlink, not rm: a dangling link must go
    writeFileSync(join(dir, META), BOOTSTRAP_META);
    rmSync(join(dir, 'docs/plans/agent-browser-credentials-plan.md'));
    g(['add', '-A']);
    assert.match(g(['ls-files', '-s', '--', META]), /^100644 /, 'precondition: the index now holds a regular file');
    assert.match(g(['diff', '--cached', '--name-status', '--', META]), /^T\t/, 'precondition: the commit is a type change of the meta');
    const r = assessRisk(dir, parseCommitForm('git commit -m x'));
    assert.equal(r.level, 'critical', r.reason);
    assert.equal(r.bootstrap.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
