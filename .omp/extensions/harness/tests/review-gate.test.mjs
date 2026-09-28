// Integration tests for review-gate.mjs (PreToolUse: Bash, git commit).
//
// Run: node --test .omp/extensions/harness/tests/review-gate.test.mjs
//
// Focus: strict JSON-tuple evidence —
//   (1) the gate reads ONLY docs/reviews/review-<today>*.json sidecars; markdown
//       review docs are human reports and are NEVER parsed (the whole CommonMark
//       quoting/hiding attack surface of the former line-based parser is gone).
//   (2) evidence is a fixed-arity positional JSON array (tuple):
//       ["omp-review-evidence/v1", <hex64>, <verdict>, <models|null>, <human|null>, <reviewer>]
//       — validation is JSON.parse + Array.isArray + exact arity + per-position
//       type/enum/pattern checks. A tuple has no keys, so duplicate-key last-wins
//       injection is structurally impossible; object-form JSON is rejected outright.
//   (3) the audited override (docs/harness/review-skip) uses the same grammar:
//       ["omp-review-override/v1", <reason>, <approved_by>, <diff_hash|UNVERIFIABLE>]
//   (4) effective-diff hashing, commit-form fail-closed behavior, and the -a TOCTOU
//       guard are unchanged and re-pinned here.
//
// Spawn-based with an EXPLICIT cwd throwaway git repo (memory:
// feedback_shell_test_cwd_isolation). Risk level is driven by the staged files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'review-gate.mjs');
// Match the gate's LOCAL-date naming (it does not use UTC), so sidecar names line up
// with the gate's `today` even when run near the UTC day boundary.
const _now = new Date();
const TODAY = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;

const HIGH = { 'src/big.ts': 'export const x = 1;\n'.repeat(120) }; // code, >100 lines -> high
const LOW = { 'docs/notes.md': '# notes\nprose\n' };               // prose doc -> low
const MED = { 'src/small.ts': 'export const x = 1;\n'.repeat(20) };  // code, <100 lines -> medium

// Build an evidence tuple. Defaults are the het path (>=2 measured families).
function evidence(hash, { verdict = 'PASS', models = ['claude-opus-4', 'gpt-5'], human = null, reviewer = 'reviewer' } = {}) {
  return JSON.stringify(['omp-review-evidence/v1', hash, verdict, models, human, reviewer]);
}
// Human-path evidence: models null, a person's identity in position 4.
function humanEvidence(hash, { verdict = 'PASS', human = 'donghyun' } = {}) {
  return evidence(hash, { verdict, models: null, human });
}
function overrideTuple(reason, approvedBy, hash) {
  return JSON.stringify(['omp-review-override/v1', reason, approvedBy, hash]);
}

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-gate-'));
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
  git(['add', '-A']); // stage so assessRisk + the gate hash see them
  return dir;
}

// The same hash the gate computes from the staged diff.
function stagedHash(dir) {
  return execSync('git diff --cached | shasum -a 256', { cwd: dir, encoding: 'utf-8' }).trim().split(/\s+/)[0];
}

// Write an (untracked) review sidecar/report so it does not perturb the staged diff.
function writeReview(dir, name, content) {
  const rd = join(dir, 'docs', 'reviews');
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, name), content);
}

function runGate(dir, command = 'git commit -m x') {
  return spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_input: { command }, session_state: { cwd: dir } }),
    cwd: dir,
    timeout: 15000, // a hung gate must fail the test, not the runner (FIFO regression guard)
    encoding: 'utf-8',
  });
}

function withRepo(files, fn) {
  const dir = makeRepo(files);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// --- baseline behaviour ---

test('high risk + no evidence at all -> BLOCK (exit 2)', () => {
  withRepo(HIGH, (dir) => {
    assert.equal(runGate(dir).status, 2);
  });
});

test('low risk -> allow without any review (exit 0)', () => {
  withRepo(LOW, (dir) => {
    assert.equal(runGate(dir).status, 0);
  });
});

test('high risk + covering het evidence tuple -> allow', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(stagedHash(dir)));
    assert.equal(runGate(dir).status, 0);
  });
});

test('high risk + matching sidecar is NOT the lexicographically-last of several today -> allow', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-010000.json`, evidence(stagedHash(dir)));
    writeReview(dir, `review-${TODAY}-235959.json`, evidence('f'.repeat(64))); // other PR, sorts last
    assert.equal(runGate(dir).status, 0);
  });
});

// --- markdown is DEAD as machine evidence ---

test('markdown-only evidence (old field syntax, however well-formed) -> BLOCK: the gate no longer parses .md', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-120000.md`,
      `# Review\n\ndiff-hash: ${hash}\nmodels: claude, gpt\nhuman-reviewed-by: donghyun\n\n## Verdict\nVerdict: PASS\n`);
    const r = runGate(dir);
    assert.equal(r.status, 2, 'a .md file must grant nothing');
  });
});

test('markdown FAIL report does NOT veto when the .json sidecar covers with PASS (md is not read at all)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-120000.md`, `diff-hash: ${hash}\nVerdict: FAIL\n`);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash));
    assert.equal(runGate(dir).status, 0, 'only the sidecar speaks for the machine');
  });
});

// --- FAIL scoping ---

test('high risk + covering FAIL tuple -> BLOCK', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(stagedHash(dir), { verdict: 'FAIL' }));
    assert.equal(runGate(dir).status, 2);
  });
});

test('high risk + FAIL in a NON-covering sidecar, PASS in the covering one -> allow', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-010000.json`, evidence('e'.repeat(64), { verdict: 'FAIL' }));
    writeReview(dir, `review-${TODAY}-020000.json`, evidence(stagedHash(dir)));
    assert.equal(runGate(dir).status, 0);
  });
});

test('covering FAIL blocks even when another covering tuple says PASS (block signal wins)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-010000.json`, evidence(hash, { verdict: 'FAIL' }));
    writeReview(dir, `review-${TODAY}-020000.json`, evidence(hash));
    assert.equal(runGate(dir).status, 2);
  });
});

test('medium risk + covering FAIL tuple -> BLOCK (FAIL blocks regardless of risk level)', () => {
  withRepo(MED, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(stagedHash(dir), { verdict: 'FAIL' }));
    assert.equal(runGate(dir).status, 2);
  });
});

test('high risk + today sidecar exists but none covers the current diff -> BLOCK', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, evidence('a'.repeat(64)));
    assert.equal(runGate(dir).status, 2);
  });
});

// #48-2: the scan window is today + yesterday (local). A review written at 23:5x binds the
// same diff hash as the commit that lands after midnight; the date only bounds the scan.
const _y = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate() - 1);
const YESTERDAY = `${_y.getFullYear()}-${String(_y.getMonth() + 1).padStart(2, '0')}-${String(_y.getDate()).padStart(2, '0')}`;

test('yesterday-named sidecar with the right hash -> allow (two-day window, hash-bound)', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${YESTERDAY}-235900.json`, evidence(stagedHash(dir)));
    assert.equal(runGate(dir).status, 0);
  });
});

test('yesterday-named covering FAIL still vetoes (the window widens both axes)', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${YESTERDAY}-235900.json`, evidence(stagedHash(dir), { verdict: 'FAIL' }));
    writeReview(dir, `review-${TODAY}-000100.json`, evidence(stagedHash(dir)));
    assert.equal(runGate(dir).status, 2);
  });
});

test('older-than-yesterday sidecar with the right hash -> BLOCK (outside the window)', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, 'review-2001-01-01-120000.json', evidence(stagedHash(dir)));
    assert.equal(runGate(dir).status, 2);
  });
});

// --- schema fail-closed: every malformation invalidates the FILE (ignored + warned) ---

function expectInvalid(dir, name, content, msgRe) {
  writeReview(dir, name, content);
  const r = runGate(dir);
  assert.equal(r.status, 2, `invalid sidecar must grant nothing: ${content.slice(0, 80)}`);
  assert.match(r.stderr, new RegExp(`docs/reviews/${name}.*not a valid evidence tuple`), 'gate warns naming the file');
  if (msgRe) assert.match(r.stderr, msgRe);
}

test('schema: syntactically broken JSON -> ignored + warned -> BLOCK', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`, '["omp-review-evidence/v1", ', /not valid JSON/);
  });
});

test('schema: OBJECT form (keys!) is rejected outright — tuples only', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      JSON.stringify({ magic: 'omp-review-evidence/v1', diff_hash: hash, verdict: 'PASS', models: ['claude', 'gpt-5'], reviewer: 'r' }),
      /not a JSON array/);
  });
});

test('schema: duplicate-key last-wins injection is structurally impossible (object rejected even with a "clean" shape)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    // Raw text with duplicate keys: JSON.parse would keep the LAST verdict ("PASS").
    // Under the tuple grammar the object never gets that far — not an array, invalid file.
    const raw = `{"verdict":"FAIL","diff_hash":"${hash}","verdict":"PASS","models":["claude","gpt-5"],"reviewer":"r"}`;
    expectInvalid(dir, `review-${TODAY}-120000.json`, raw, /not a JSON array/);
  });
});

test('schema: wrong magic string -> invalid', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      JSON.stringify(['omp-review-evidence/v2', stagedHash(dir), 'PASS', ['claude-opus-4', 'gpt-5'], null, 'r']),
      /element 0/);
  });
});

test('schema: wrong arity — 5 elements (missing reviewer) -> invalid', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      JSON.stringify(['omp-review-evidence/v1', stagedHash(dir), 'PASS', ['claude-opus-4', 'gpt-5'], null]),
      /wrong arity: expected exactly 6 elements, got 5/);
  });
});

test('schema: wrong arity — 7 elements (extra data smuggled) -> invalid', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      JSON.stringify(['omp-review-evidence/v1', stagedHash(dir), 'PASS', ['claude-opus-4', 'gpt-5'], null, 'r', 'extra']),
      /wrong arity: expected exactly 6 elements, got 7/);
  });
});

test('schema: verdict enum is EXACT — "pass", "PASSED", "Pass With Notes" all invalid', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const bad of ['pass', 'PASSED', 'Pass With Notes', 'PASS ', '']) {
      writeReview(dir, `review-${TODAY}-120000.json`,
        JSON.stringify(['omp-review-evidence/v1', hash, bad, ['claude-opus-4', 'gpt-5'], null, 'r']));
      const r = runGate(dir);
      assert.equal(r.status, 2, `verdict ${JSON.stringify(bad)} must not pass`);
      assert.match(r.stderr, /element 2 \(verdict\)/);
    }
  });
});

test('schema: diff_hash must be 64 LOWERCASE hex — uppercase, short, prose all invalid', () => {
  withRepo(HIGH, (dir) => {
    for (const bad of [stagedHash(dir).toUpperCase(), 'deadbeef', `${stagedHash(dir)} trailing`, 42]) {
      writeReview(dir, `review-${TODAY}-120000.json`,
        JSON.stringify(['omp-review-evidence/v1', bad, 'PASS', ['claude-opus-4', 'gpt-5'], null, 'r']));
      const r = runGate(dir);
      assert.equal(r.status, 2, `diff_hash ${JSON.stringify(bad)} must not pass`);
      assert.match(r.stderr, /element 1 \(diff_hash\)/);
    }
  });
});

test('schema: reviewer (element 5) must be a non-empty string', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const bad of ['', '   ', null, 7]) {
      writeReview(dir, `review-${TODAY}-120000.json`,
        JSON.stringify(['omp-review-evidence/v1', hash, 'PASS', ['claude-opus-4', 'gpt-5'], null, bad]));
      const r = runGate(dir);
      assert.equal(r.status, 2, `reviewer ${JSON.stringify(bad)} must not pass`);
      assert.match(r.stderr, /element 5 \(reviewer\)/);
    }
  });
});

test('schema: trailing garbage after the tuple -> invalid (JSON.parse of the whole file)', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      evidence(stagedHash(dir)) + '\n["omp-review-evidence/v1"]', /not valid JSON/);
  });
});

// --- evidence axis: models (het) ---

test('het: >=2 distinct families required — single-family list is invalid', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      evidence(stagedHash(dir), { models: ['claude-opus-4', 'claude-3-5-sonnet'] }),
      /DISTINCT model families/);
  });
});

test('het: codex folds into gpt family — ["codex","gpt-5"] is ONE family -> invalid; ["claude","gpt-5"] -> allow', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models: ['codex', 'gpt-5'] }));
    assert.equal(runGate(dir).status, 2);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models: ['claude', 'gpt-5'] }));
    assert.equal(runGate(dir).status, 0);
  });
});

test('het: a non-model token anywhere invalidates the file (octopus, gptscript, bare noise)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const models of [['claude-opus-4', 'octopus'], ['gptscript', 'claude'], ['claude', 'gpt-5', 'and friends']]) {
      writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models }));
      const r = runGate(dir);
      assert.equal(r.status, 2, `models ${JSON.stringify(models)} must not pass`);
      assert.match(r.stderr, /not a clean model name/);
    }
  });
});

test('het: negated/skipped pseudo-models are rejected (codex-skipped, gpt-not-run-2, claude-unavailable-5)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const tok of ['codex-skipped', 'gpt-not-run-2', 'claude-unavailable-5']) {
      writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models: ['claude-opus-4', tok] }));
      assert.equal(runGate(dir).status, 2, `${tok} must not count as a model`);
    }
  });
});

test('het: real version/variant suffixes still map (o3-mini, deepseek-r1, gpt-5.6-sol, provider/ prefix)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const models of [['claude-opus-4-8', 'o3-mini'], ['deepseek-r1', 'anthropic/claude-3-5-sonnet'], ['claude-opus-4', 'gpt-5.6-sol']]) {
      writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models }));
      assert.equal(runGate(dir).status, 0, `models ${JSON.stringify(models)} should be accepted`);
    }
  });
});

test('het: empty models array / non-string entries are invalid', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const models of [[], ['claude-opus-4', 42], 'claude, gpt']) {
      writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models }));
      assert.equal(runGate(dir).status, 2, `models ${JSON.stringify(models)} must not pass`);
    }
  });
});

// --- evidence axis: human review ---

test('human review: covering tuple with a person in position 4 -> allow', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(stagedHash(dir)));
    assert.equal(runGate(dir).status, 0);
  });
});

test('human review: multi-word identity is accepted', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(stagedHash(dir), { human: 'Dong-hyun Kim (platform)' }));
    assert.equal(runGate(dir).status, 0);
  });
});

test('human review: identity that is a bare MODEL name does not count (spoof guard)', () => {
  withRepo(HIGH, (dir) => {
    for (const spoof of ['claude', 'gpt-5', 'anthropic/claude-opus-4']) {
      writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(stagedHash(dir), { human: spoof }));
      const r = runGate(dir);
      assert.equal(r.status, 2, `${spoof} is not a person`);
      assert.match(r.stderr, /names a model, not a person/);
    }
  });
});

test('human review: PASS WITH NOTES is on the whitelist -> allow', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(stagedHash(dir), { verdict: 'PASS WITH NOTES' }));
    assert.equal(runGate(dir).status, 0);
  });
});

test('human review: Verdict FAIL still blocks (verification axis honors the verdict)', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(stagedHash(dir), { verdict: 'FAIL' }));
    assert.equal(runGate(dir).status, 2);
  });
});

test('evidence axis is REQUIRED: models null + human null -> invalid', () => {
  withRepo(HIGH, (dir) => {
    expectInvalid(dir, `review-${TODAY}-120000.json`,
      evidence(stagedHash(dir), { models: null, human: null }), /one evidence axis is required/);
  });
});

test('hash mismatch: valid tuple for a DIFFERENT diff -> BLOCK, message teaches paths with the REAL hash', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence('b'.repeat(64)));
    const r = runGate(dir);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(stagedHash(dir)), 'block message carries the actual current hash');
    assert.match(r.stderr, /omp-review-evidence\/v1/, 'block message shows the tuple template');
  });
});

// --- fail-closed: hash cannot be computed (e.g. shasum missing) ---

test('high risk + diff hash uncomputable -> BLOCK (fail-closed)', () => {
  withRepo(HIGH, (dir) => {
    // A today sidecar exists, but with shasum stubbed to fail the gate cannot
    // verify coverage -> unverified -> high/critical must fail closed.
    writeReview(dir, `review-${TODAY}-120000.json`, evidence('0'.repeat(64)));
    const binDir = mkdtempSync(join(tmpdir(), 'rv-nobin-'));
    writeFileSync(join(binDir, 'shasum'), '#!/bin/sh\nexit 127\n');
    chmodSync(join(binDir, 'shasum'), 0o755);
    try {
      const r = spawnSync('node', [GATE], {
        input: JSON.stringify({ tool_input: { command: 'git commit -m x' }, session_state: { cwd: dir } }),
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      });
      assert.equal(r.status, 2);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

test('hash unknown + a today FAIL tuple -> BLOCK via the FAIL signal (fail-closed on the block axis)', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, evidence('0'.repeat(64), { verdict: 'FAIL' }));
    // A pathspec form is unverifiable -> currentHash null -> ANY valid today FAIL blocks.
    const r = runGate(dir, 'git commit -m x src/big.ts');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /verdict is FAIL/);
  });
});

// --- effective-content hashing: the hash must cover what the commit CAPTURES ---
// Closes the gap where `git commit -a` / a pathspec commit pulled in tracked
// changes the staged-diff hash never saw, letting a stale PASS review match.
// These repos carry an INITIAL COMMIT so the -a/pathspec forms' `git diff HEAD`
// has a base (cf. feedback_shell_test_cwd_isolation: explicit cwd, throwaway repo).

const BIG = 'export const x = 1;\n'.repeat(130);   // >100 lines of code -> high risk

function committedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-eff-'));
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'Test']);
  for (const rel of ['src/big.ts', 'src/extra.ts']) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, rel), 'init\n');
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return { dir, git };
}

// Hash exactly as the gate/reviewer do, for an arbitrary diff selector.
const diffHash = (dir, sel) =>
  execSync(`git diff ${sel} | shasum -a 256`, { cwd: dir, encoding: 'utf-8' }).trim().split(/\s+/)[0];

function withCommitted(fn) {
  const { dir, git } = committedRepo();
  try { return fn(dir, git); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('git commit -a + unreviewed UNSTAGED change -> BLOCK (the core gap)', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);           // staged change A (reviewed)
    git(['add', 'src/big.ts']);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    writeFileSync(join(dir, 'src/extra.ts'), 'leak\n');    // change B: tracked, UNSTAGED, unreviewed
    // -a stages B at commit time -> effective diff (git diff HEAD) != reviewed --cached hash.
    assert.equal(runGate(dir, 'git commit -am x').status, 2);
  });
});

test('plain git commit in the SAME state -> allow (commits only the reviewed staged diff)', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    writeFileSync(join(dir, 'src/extra.ts'), 'leak\n');    // unstaged: a plain commit ignores it
    assert.equal(runGate(dir, 'git commit -m x').status, 0);
  });
});

test('git commit -a with everything staged (nothing extra unstaged) -> allow', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    // No unstaged tracked change, so git diff HEAD == git diff --cached == reviewed hash.
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    assert.equal(runGate(dir, 'git commit -am x').status, 0);
  });
});

test('pathspec commit -> fail-closed BLOCK (unverifiable form)', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);           // staged + reviewed
    git(['add', 'src/big.ts']);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    writeFileSync(join(dir, 'src/extra.ts'), 'leak\n');    // unstaged, unreviewed
    // A pathspec commit's content is cwd-relative + shell-fragile, so the form is
    // unverifiable -> the staged-hash evidence cannot vouch for it -> fail closed.
    assert.equal(runGate(dir, 'git commit -m x src/extra.ts').status, 2);
  });
});

test('--amend -> fail-closed BLOCK even when evidence matches the staged hash', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    // amend rewrites the prior commit; its effective content can't be statically
    // hashed, so the form is unverifiable -> high risk fails closed.
    assert.equal(runGate(dir, 'git commit --amend -m x').status, 2);
  });
});

test('output-capture redirection `git commit … 2>&1` -> BLOCK with a standalone hint (agent footgun)', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    // staged diff IS reviewed (matching hash) ...
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    // ... but appending `2>&1` to capture output makes the form unverifiable: an
    // &-bearing redirection segment-splits the line, so the staged-hash evidence cannot
    // vouch for it -> fail closed. The message must point at the standalone-commit fix.
    const r = runGate(dir, 'git commit -m x 2>&1');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unverifiable|standalone/i);
  });
});

test('option-abbreviation --inc (=--include) smuggling the index -> BLOCK', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);           // staged + reviewed
    git(['add', 'src/big.ts']);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    writeFileSync(join(dir, 'src/extra.ts'), 'leak\n');    // unstaged, unreviewed
    // `--inc` is git's abbreviation of `--include`, which commits the whole index
    // (big.ts + extra.ts). Exact-string matching would have classified it plain and
    // hashed only --cached -> fail OPEN. Prefix matching keeps it unverifiable -> BLOCK.
    assert.equal(runGate(dir, 'git commit --inc src/extra.ts -m x').status, 2);
  });
});

test('self-commit heredoc form (git commit -F - <<MSG) is NOT mis-read as a pathspec -> allow', () => {
  withCommitted((dir, git) => {
    // Regression guard: the repo commits via `git commit -F - <<'MSG' … MSG`. The
    // `<<MSG` heredoc operator must be dropped, not hashed as `git diff HEAD -- '<<MSG'`
    // (which would empty the diff and wrongly BLOCK every reviewed self-commit).
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(diffHash(dir, '--cached')));
    assert.equal(runGate(dir, "git commit -F - <<'MSG'\ncommit body\nMSG").status, 0);
  });
});

// --- path (3): audited override (approval axis), strict tuple grammar ---------------
// docs/harness/review-skip is no longer a bare bypass: it must be the tuple
// ["omp-review-override/v1", <reason>, <approved_by>, <diff_hash|UNVERIFIABLE>],
// is bound to THIS commit's hash, is recorded to docs/harness/audit.jsonl as a
// `review_override` event, and is consumed on success.

function writeSkip(dir, content) {
  const hd = join(dir, 'docs', 'harness');
  mkdirSync(hd, { recursive: true });
  writeFileSync(join(hd, 'review-skip'), content);
}

const skipPath = (dir) => join(dir, 'docs', 'harness', 'review-skip');
const auditPath = (dir) => join(dir, 'docs', 'harness', 'audit.jsonl');

test('override: valid tuple -> allow, audited, consumed', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeSkip(dir, overrideTuple('adversary model unavailable, hotfix needed', 'donghyun', hash));
    const r = runGate(dir);
    assert.equal(r.status, 0);
    assert.equal(existsSync(skipPath(dir)), false, 'a valid override is consumed');
    const events = readFileSync(auditPath(dir), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const ev = events.find((e) => e.event === 'review_override');
    assert.ok(ev, 'audit.jsonl must record a review_override event');
    assert.equal(ev.actor, 'donghyun');
    assert.equal(ev.meta.diff_hash, hash);
    assert.match(ev.meta.reason, /adversary model unavailable/);
    assert.ok(ev.ts, 'event carries a timestamp');
  });
});

test('override: OLD field syntax (reason:/approved-by: lines) is no longer parsed -> BLOCK, flag kept', () => {
  withRepo(HIGH, (dir) => {
    writeSkip(dir, `reason: r\napproved-by: donghyun\ndiff-hash: ${stagedHash(dir)}\n`);
    const r = runGate(dir);
    assert.equal(r.status, 2, 'field-syntax flags must fail closed under the tuple grammar');
    assert.match(r.stderr, /positional tuple/);
    assert.match(r.stderr, /omp-review-override\/v1/, 'message shows the tuple template');
    assert.equal(existsSync(skipPath(dir)), true, 'flag kept in place for fixing');
    assert.equal(existsSync(auditPath(dir)), false, 'no audit event for a rejected override');
  });
});

test('override: BARE review-skip file no longer bypasses -> BLOCK with tuple guidance', () => {
  withRepo(HIGH, (dir) => {
    writeSkip(dir, '');
    const r = runGate(dir);
    assert.equal(r.status, 2, 'an empty flag must fail closed');
    assert.match(r.stderr, /omp-review-override\/v1/, 'message teaches the exact tuple');
    assert.ok(r.stderr.includes(stagedHash(dir)), 'message carries the exact hash to write');
    assert.equal(existsSync(skipPath(dir)), true, 'an invalid flag is kept in place for fixing');
    assert.equal(existsSync(auditPath(dir)), false, 'no audit event for a rejected override');
  });
});

test('override: empty reason / empty approved_by -> BLOCK naming the position', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeSkip(dir, overrideTuple('', 'donghyun', hash));
    let r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /element 1 \(reason\)/);
    writeSkip(dir, overrideTuple('r', '', hash));
    r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /element 2 \(approved_by\)/);
  });
});

test('override: wrong arity (3 or 5 elements) -> BLOCK', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeSkip(dir, JSON.stringify(['omp-review-override/v1', 'r', hash]));
    assert.equal(runGate(dir).status, 2);
    writeSkip(dir, JSON.stringify(['omp-review-override/v1', 'r', 'a', hash, 'extra']));
    assert.equal(runGate(dir).status, 2);
  });
});

test('override: diff_hash mismatch (stale flag) -> BLOCK naming both hashes', () => {
  withRepo(HIGH, (dir) => {
    writeSkip(dir, overrideTuple('r', 'a', '0'.repeat(64)));
    const r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /diff_hash mismatch/);
    assert.ok(r.stderr.includes(stagedHash(dir)), 'message shows the current effective hash');
  });
});

test('override: literal UNVERIFIABLE on a VERIFIABLE commit -> BLOCK (hash must bind)', () => {
  withRepo(HIGH, (dir) => {
    writeSkip(dir, overrideTuple('r', 'a', 'UNVERIFIABLE'));
    assert.equal(runGate(dir).status, 2);
  });
});

test('override: unverifiable commit form + "UNVERIFIABLE" -> allow + audited', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    writeSkip(dir, overrideTuple('pathspec commit needed', 'donghyun', 'UNVERIFIABLE'));
    assert.equal(runGate(dir, 'git commit -m x src/big.ts').status, 0);
    const ev = readFileSync(auditPath(dir), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
      .find((e) => e.event === 'review_override');
    assert.equal(ev.meta.diff_hash, 'UNVERIFIABLE');
  });
});

test('override: unverifiable form BLOCK message tells the user to write UNVERIFIABLE', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    const r = runGate(dir, 'git commit -m x src/big.ts'); // no skip file at all
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"UNVERIFIABLE"/, 'help must show the exact token for this form');
  });
});

test('override: valid override bypasses a covering FAIL (approval axis, on the record)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { verdict: 'FAIL' }));
    writeSkip(dir, overrideTuple('risk accepted despite FAIL', 'donghyun', hash));
    assert.equal(runGate(dir).status, 0);
    assert.match(readFileSync(auditPath(dir), 'utf-8'), /review_override/);
  });
});

// --- override + `git commit -a` TOCTOU -------------------------------------------
// Consuming an override appends to docs/harness/audit.jsonl and unlinks review-skip
// BEFORE the commit runs. If either file is git-TRACKED (audit.jsonl is, in this
// repo), `-a` sweeps those writes into the commit, so the committed diff would no
// longer be the diff the approver hashed. The gate fails closed on -a when a sweep
// is possible; a plain commit of the staged diff is unaffected. These tests run the
// REAL `git commit` the gate allowed and verify the committed diff.

// Track docs/harness/audit.jsonl in the temp repo, like the real repo does.
function trackAuditLog(dir, git) {
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  writeFileSync(auditPath(dir), '');
  git(['add', 'docs/harness/audit.jsonl']);
  git(['commit', '-q', '-m', 'track audit log']);
}

test('override + git commit -a with TRACKED audit.jsonl -> BLOCK, flag kept, nothing audited', () => {
  withCommitted((dir, git) => {
    trackAuditLog(dir, git);
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    // Everything staged: -a's effective diff (git diff HEAD) == staged diff, so the flag is
    // otherwise VALID — only the audit-append sweep makes it unconsumable on this form.
    writeSkip(dir, overrideTuple('r', 'donghyun', diffHash(dir, 'HEAD')));
    const r = runGate(dir, 'git commit -am x');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /commit -a/, 'message names the -a form as the problem');
    assert.match(r.stderr, /plain `git commit`/, 'message routes to the staged plain-commit form');
    assert.equal(existsSync(skipPath(dir)), true, 'flag NOT consumed');
    assert.equal(readFileSync(auditPath(dir), 'utf-8'), '', 'no audit event for a rejected consumption');
  });
});

test('INTEGRATION: override + plain commit -> gate allows and the REAL committed diff equals the approved hash', () => {
  withCommitted((dir, git) => {
    trackAuditLog(dir, git);
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    const approved = diffHash(dir, '--cached');
    writeSkip(dir, overrideTuple('r', 'donghyun', approved));
    assert.equal(runGate(dir).status, 0, 'plain form consumes the override');
    assert.equal(existsSync(skipPath(dir)), false, 'flag consumed');
    // Run the REAL commit the gate just allowed.
    git(['commit', '-q', '-m', 'x']);
    const committed = execSync('git diff HEAD~1 HEAD | shasum -a 256', { cwd: dir, encoding: 'utf-8' }).trim().split(/\s+/)[0];
    assert.equal(committed, approved, 'committed diff is exactly the approved staged diff');
    // The gate's audit append stayed OUT of the commit (it is an unstaged change to the tracked file).
    assert.match(execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' }), /^ M docs\/harness\/audit\.jsonl$/m);
    assert.match(readFileSync(auditPath(dir), 'utf-8'), /review_override/);
  });
});

test('INTEGRATION: override + git commit -a with UNTRACKED audit/flag -> allowed, real -a commit matches approved hash', () => {
  withCommitted((dir, git) => {
    // No trackAuditLog: audit.jsonl and review-skip are untracked, so -a cannot sweep them.
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    const approved = diffHash(dir, 'HEAD');
    writeSkip(dir, overrideTuple('r', 'donghyun', approved));
    assert.equal(runGate(dir, 'git commit -am x').status, 0, 'no tracked sweep target -> -a override stays consumable');
    assert.equal(existsSync(skipPath(dir)), false, 'flag consumed');
    git(['commit', '-q', '-am', 'x']);
    const committed = execSync('git diff HEAD~1 HEAD | shasum -a 256', { cwd: dir, encoding: 'utf-8' }).trim().split(/\s+/)[0];
    assert.equal(committed, approved, '-a commit captures exactly the approved diff (untracked files not swept)');
    assert.match(readFileSync(auditPath(dir), 'utf-8'), /review_override/);
  });
});

test('medium risk + valid override + git commit -a (tracked audit) -> warn, NOT consumed, commit proceeds', () => {
  withCommitted((dir, git) => {
    trackAuditLog(dir, git);
    writeFileSync(join(dir, 'src/big.ts'), 'export const x = 1;\n'.repeat(20)); // <100 lines -> medium
    git(['add', 'src/big.ts']);
    writeSkip(dir, overrideTuple('r', 'donghyun', diffHash(dir, 'HEAD')));
    const r = runGate(dir, 'git commit -am x');
    assert.equal(r.status, 0, 'medium never required review');
    assert.match(r.stderr, /cannot be consumed under `git commit -a`/i);
    assert.equal(existsSync(skipPath(dir)), true, 'flag NOT consumed under -a');
    assert.equal(readFileSync(auditPath(dir), 'utf-8'), '', 'no audit event without consumption');
  });
});

// --- risk-level scoping of the paths ------------------------------------------

test('low risk: unaffected — even a bare review-skip lying around does not block', () => {
  withRepo(LOW, (dir) => {
    writeSkip(dir, '');
    assert.equal(runGate(dir).status, 0);
    assert.equal(existsSync(skipPath(dir)), true, 'low risk exits before the override check; flag untouched');
  });
});

test('medium risk: invalid review-skip is ignored with a warning, not a block', () => {
  withRepo(MED, (dir) => {
    writeSkip(dir, '');
    const r = runGate(dir);
    assert.equal(r.status, 0, 'medium never required review, so a broken flag must not brick it');
    assert.match(r.stderr, /not a valid audited override/i);
    assert.equal(existsSync(skipPath(dir)), true, 'invalid flag is not consumed');
  });
});

test('medium risk: VALID override is consumed + audited (can clear a covering FAIL)', () => {
  withRepo(MED, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { verdict: 'FAIL' }));
    writeSkip(dir, overrideTuple('r', 'a', hash));
    assert.equal(runGate(dir).status, 0);
    assert.equal(existsSync(skipPath(dir)), false);
    assert.match(readFileSync(auditPath(dir), 'utf-8'), /review_override/);
  });
});

test('medium risk: invalid sidecar is warned + ignored, commit proceeds', () => {
  withRepo(MED, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, '{not json');
    const r = runGate(dir);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not a valid evidence tuple/);
  });
});

// --- first-block message quality (single-model deployment UX) ---------------------
// The BLOCK message must be COPYABLE: the printed templates parse as JSON and carry
// the real hash + today's local-date filename, so a first-time-blocked user can
// write path (2) or (3) from the message alone.

test('high risk + NO evidence: block message alone suffices to write path 2 or 3', () => {
  withRepo(HIGH, (dir) => {
    const r = runGate(dir);
    assert.equal(r.status, 2);
    const hash = stagedHash(dir);
    assert.ok(r.stderr.includes(hash), 'carries the exact diff_hash value');
    assert.ok(r.stderr.includes(`docs/reviews/review-${TODAY}-`), 'carries the exact sidecar filename (today, local date)');
    assert.match(r.stderr, /does NOT read markdown/i, 'states that markdown is not machine evidence');
    // The human-path template must be extractable and must PARSE as a valid tuple.
    const tupleLine = r.stderr.split('\n').find((l) => l.includes('"omp-review-evidence/v1"') && l.includes('null,'));
    assert.ok(tupleLine, 'prints an evidence tuple template');
    const parsed = JSON.parse(tupleLine.trim().replace('<your name>', 'me').replace('<your name>', 'me'));
    assert.equal(parsed.length, 6, 'template is the exact 6-tuple');
    assert.equal(parsed[0], 'omp-review-evidence/v1');
    assert.equal(parsed[1], hash, 'template carries the real hash');
    // The override template parses too.
    const ovLine = r.stderr.split('\n').find((l) => l.includes('"omp-review-override/v1"'));
    assert.ok(ovLine, 'prints an override tuple template');
    const ov = JSON.parse(ovLine.trim());
    assert.equal(ov.length, 4);
    assert.equal(ov[3], hash, 'override template carries the real hash');
    assert.match(r.stderr, /docs\/harness\/review-skip/, 'teaches the override file path');
    assert.match(r.stderr, /audit\.jsonl/, 'discloses that the override is audited');
  });
});

// --- hardening (1st-round tuple review): placeholders, spoof tokens, FAIL exemption, I/O bounds ---

test('placeholder guard: the help templates pasted VERBATIM are rejected, never accepted', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    // Path (2) template with <your name> left unfilled.
    writeReview(dir, `review-${TODAY}-120000.json`,
      `["omp-review-evidence/v1", "${hash}", "PASS", null, "<your name>", "<your name>"]`);
    let r = runGate(dir);
    assert.equal(r.status, 2, 'unfilled human placeholder must not count');
    assert.match(r.stderr, /unfilled template placeholder/);
    // Reviewer placeholder alone is rejected too.
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(hash).replace('"reviewer"', '"<reviewer>"'));
    r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /element 5 \(reviewer\).*placeholder/);
  });
});

test('human spoof guard scans ALL tokens and invisible chars ("OpenAI GPT-5", ZWSP-claude)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const spoof of ['OpenAI GPT-5', '\u200bclaude', 'reviewed by gemini-2.5-pro today', 'claude,']) {
      writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(hash, { human: spoof }));
      const r = runGate(dir);
      assert.equal(r.status, 2, `${JSON.stringify(spoof)} must not count as a person`);
      assert.match(r.stderr, /names a model, not a person/);
    }
    // A real multi-word identity still works.
    writeReview(dir, `review-${TODAY}-120000.json`, humanEvidence(hash, { human: 'Dong-hyun Kim' }));
    assert.equal(runGate(dir).status, 0);
  });
});

test('FAIL exemption: an honest FAIL with BOTH axes null is valid and blocks — even against a covering PASS', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    writeReview(dir, `review-${TODAY}-010000.json`, evidence(hash)); // covering het PASS
    writeReview(dir, `review-${TODAY}-020000.json`, evidence(hash, { verdict: 'FAIL', models: null, human: null }));
    const r = runGate(dir);
    assert.equal(r.status, 2, 'the null-axes FAIL must stay valid; PASS must not outrank it');
    assert.match(r.stderr, /verdict is FAIL/);
    // But a PASS with both axes null is still invalid (grants nothing).
    rmSync(join(dir, 'docs', 'reviews', `review-${TODAY}-020000.json`));
    writeReview(dir, `review-${TODAY}-010000.json`, evidence(hash, { models: null, human: null }));
    assert.equal(runGate(dir).status, 2);
  });
});

test('het: negation-shaped provider/codename spoofs are rejected (skipped/gpt-5, gpt-5-skippedrun)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    for (const tok of ['skipped/gpt-5', 'gpt-5-skippedrun', 'unavailable/gemini-2.5-pro', 'gpt-5-notactuallyrun']) {
      writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models: ['claude-opus-4', tok] }));
      assert.equal(runGate(dir).status, 2, `${tok} must not count as a model`);
    }
    // A legit provider prefix still maps.
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(hash, { models: ['claude-opus-4', 'openai/gpt-5'] }));
    assert.equal(runGate(dir).status, 0);
  });
});

test('het: implausibly many model entries invalidate the file (max 16)', () => {
  withRepo(HIGH, (dir) => {
    const models = Array.from({ length: 17 }, (_, i) => (i % 2 ? 'gpt-5' : 'claude-opus-4'));
    expectInvalid(dir, `review-${TODAY}-120000.json`, evidence(stagedHash(dir), { models }), /implausibly many/);
  });
});

// The dispatcher (commit-gates.mjs) kills a gate over its ~3s/4MiB budget and then FAILS CLOSED
// (a gate that cannot render a verdict blocks the commit — 3rd-round owner decision). Staying
// within budget on attacker-controlled inputs is therefore an availability requirement: an
// over-budget gate no longer bypasses review, but it would block every legitimate commit too.
// Oversized files are rejected by a bounded read, and per-file diagnostics are capped.

test('I/O bounds: an OVERSIZED sidecar is skipped unread with a short warning -> BLOCK, bounded stderr', () => {
  withRepo(HIGH, (dir) => {
    // 8MiB of junk — bigger than the dispatcher's whole 4MiB maxBuffer. Echoing any of it back
    // (or even JSON.parsing it) would blow the child budget: formerly a fail-open bypass via the
    // dispatcher, now a spurious fail-closed block on every commit. Neither is acceptable.
    writeReview(dir, `review-${TODAY}-120000.json`, `["${'x'.repeat(8 * 1024 * 1024)}"]`);
    const r = runGate(dir);
    assert.equal(r.status, 2, 'oversized sidecar grants nothing');
    assert.match(r.stderr, /implausibly large/);
    assert.ok(r.stderr.length < 16 * 1024, `stderr must stay bounded (got ${r.stderr.length} bytes)`);
  });
});

test('I/O bounds: a flood of invalid sidecars produces capped diagnostics, not unbounded stderr', () => {
  withRepo(HIGH, (dir) => {
    for (let i = 0; i < 12; i++) {
      writeReview(dir, `review-${TODAY}-1200${String(i).padStart(2, '0')}.json`, `{"junk": ${i}`);
    }
    const r = runGate(dir);
    assert.equal(r.status, 2);
    const detailed = (r.stderr.match(/not a valid evidence tuple/g) || []).length;
    assert.ok(detailed <= 5, `at most 5 detailed per-file warnings (got ${detailed})`);
    assert.match(r.stderr, /more invalid sidecar\(s\) ignored/);
    assert.ok(r.stderr.length < 16 * 1024, `stderr must stay bounded (got ${r.stderr.length} bytes)`);
  });
});

test('I/O bounds: a sidecar flood beyond the scan cap -> unconditional fail-closed BLOCK (no subset selection)', () => {
  withRepo(HIGH, (dir) => {
    for (let i = 0; i < 40; i++) {
      writeReview(dir, `review-${TODAY}-13${String(i).padStart(4, '0')}.json`, '[]');
    }
    const r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /exceed the scan cap/);
    assert.ok(r.stderr.length < 16 * 1024, `stderr must stay bounded (got ${r.stderr.length} bytes)`);
  });
});

test('I/O bounds: a sidecar of EXACTLY MAX_EVIDENCE_BYTES is accepted; one byte more is rejected', () => {
  withRepo(HIGH, (dir) => {
    const MAX = 64 * 1024; // MAX_EVIDENCE_BYTES
    const tuple = evidence(stagedHash(dir));
    // Trailing newlines are JSON whitespace, so the padded file is still one valid covering tuple.
    writeReview(dir, `review-${TODAY}-120000.json`, tuple + '\n'.repeat(MAX - tuple.length));
    let r = runGate(dir);
    assert.equal(r.status, 0, `an at-cap sidecar must be read whole and accepted (stderr: ${r.stderr})`);
    // One byte past the cap must be rejected by the READ itself (a stat-only check races a
    // concurrently growing file — readFileSync(fd) re-stats and reads to EOF; 3rd-round CRITICAL).
    writeReview(dir, `review-${TODAY}-120000.json`, tuple + '\n'.repeat(MAX - tuple.length + 1));
    r = runGate(dir);
    assert.equal(r.status, 2, 'cap+1 must reject the file, leaving no evidence');
    assert.match(r.stderr, /implausibly large/);
  });
});

test('I/O bounds: a flood of NON-matching directory entries -> fail-closed BLOCK before any evidence is honored', () => {
  withRepo(HIGH, (dir) => {
    writeReview(dir, `review-${TODAY}-120000.json`, evidence(stagedHash(dir))); // would allow on its own
    const rd = join(dir, 'docs', 'reviews');
    // >10,000 entries that never match review-<today>*.json: the sidecar cap cannot fire, so only
    // the total-entry scan bound keeps the enumeration itself inside the dispatcher budget
    // (3rd-round CRITICAL: readdirSync+filter+sort did unbounded work before any cap ran).
    for (let i = 0; i < 10001; i++) writeFileSync(join(rd, `flood-${i}.txt`), '');
    const r = runGate(dir);
    assert.equal(r.status, 2, 'an entry flood must fail closed, not allow via the covering PASS');
    assert.match(r.stderr, /refuses to enumerate/);
    assert.ok(r.stderr.length < 16 * 1024, `stderr must stay bounded (got ${r.stderr.length} bytes)`);
  });
});

test('override: unfilled placeholder tuple pasted from the help -> BLOCK', () => {
  withRepo(HIGH, (dir) => {
    writeSkip(dir, overrideTuple('<why review is being skipped>', '<who accepts the risk>', stagedHash(dir)));
    const r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /element 1 \(reason\).*placeholder/);
    assert.match(r.stderr, /element 2 \(approved_by\).*placeholder/);
    assert.equal(existsSync(skipPath(dir)), true, 'flag kept for fixing');
  });
});

test('override: OVERSIZED review-skip is rejected unread', () => {
  withRepo(HIGH, (dir) => {
    writeSkip(dir, `["${'y'.repeat(256 * 1024)}"]`);
    const r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /implausibly large/);
    assert.ok(r.stderr.length < 16 * 1024, `stderr must stay bounded (got ${r.stderr.length} bytes)`);
  });
});

test('help text names the diff command the COMMIT FORM is hashed with (-a -> git diff HEAD)', () => {
  withCommitted((dir, git) => {
    writeFileSync(join(dir, 'src/big.ts'), BIG);
    git(['add', 'src/big.ts']);
    const r = runGate(dir, 'git commit -am x'); // verifiable -a form, no evidence -> block + help
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git diff HEAD/, '-a help must hash git diff HEAD, not --cached');
    const r2 = runGate(dir, 'git commit -m x');
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /git diff --cached/);
  });
});

// --- hardening (2nd-round tuple review, CRITICAL 1-3): crash-proof parse, special files, cap policy ---

test('CRITICAL-1: a deeply nested sub-64KiB sidecar must be REJECTED, never crash the gate (a crash blocks every commit — dispatcher fails closed)', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    // (a) ~24KB of pure nesting as a models entry — JSON.parse may throw RangeError (caught) or
    // parse; either way the gate must exit 2 cleanly, not die on a diagnostics stack overflow.
    const deep = '['.repeat(12000) + ']'.repeat(12000);
    writeReview(dir, `review-${TODAY}-120000.json`,
      `["omp-review-evidence/v1","${hash}","PASS",[${deep}],null,"r"]`);
    let r = runGate(dir);
    assert.equal(r.status, 2, `gate must reject, got status=${r.status} signal=${r.signal}`);
    assert.ok(r.stderr.length < 16 * 1024, 'stderr bounded');
    // (b) nesting shallow enough for JSON.parse but beyond the tuple grammar -> depth gate.
    writeReview(dir, `review-${TODAY}-120000.json`,
      `["omp-review-evidence/v1","${hash}","PASS",[[["gpt-5"]]],null,"r"]`);
    r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nesting too deep/);
    // (c) same class through the override flag.
    rmSync(join(dir, 'docs', 'reviews', `review-${TODAY}-120000.json`));
    writeSkip(dir, `["omp-review-override/v1",["r"],"a","${hash}"]`);
    r = runGate(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /nesting too deep/);
  });
});

test('CRITICAL-2: FIFO / symlink sidecars are rejected without blocking (open is O_NOFOLLOW|O_NONBLOCK)', () => {
  withRepo(HIGH, (dir) => {
    const rd = join(dir, 'docs', 'reviews');
    mkdirSync(rd, { recursive: true });
    // (a) a FIFO named like a sidecar must not hang the gate to the dispatcher's 3s kill.
    execSync(`mkfifo ${join(rd, `review-${TODAY}-120000.json`)}`);
    let start = Date.now();
    let r = runGate(dir);
    assert.equal(r.status, 2, `FIFO must be rejected, got status=${r.status} signal=${r.signal}`);
    assert.ok(Date.now() - start < 5000, 'gate must not block on the FIFO');
    assert.match(r.stderr, /not a regular file/);
    // (b) symlink -> FIFO (isFile() on a followed stat would chase it; O_NOFOLLOW must not).
    execSync(`mkfifo ${join(dir, 'target.fifo')}`);
    symlinkSync(join(dir, 'target.fifo'), join(rd, `review-${TODAY}-120001.json`));
    start = Date.now();
    r = runGate(dir);
    assert.equal(r.status, 2);
    assert.ok(Date.now() - start < 5000, 'gate must not block on the symlinked FIFO');
    // (c) even a symlink to a VALID evidence file is rejected — evidence is a plain regular file.
    const hash = stagedHash(dir);
    rmSync(join(rd, `review-${TODAY}-120000.json`));
    rmSync(join(rd, `review-${TODAY}-120001.json`));
    writeFileSync(join(dir, 'valid.json'), evidence(hash));
    symlinkSync(join(dir, 'valid.json'), join(rd, `review-${TODAY}-120002.json`));
    r = runGate(dir);
    assert.equal(r.status, 2, 'a symlinked sidecar grants nothing');
    assert.match(r.stderr, /symlink/);
  });
});

test('CRITICAL-2: a FIFO review-skip flag is rejected without blocking', () => {
  withRepo(HIGH, (dir) => {
    const hd = join(dir, 'docs', 'harness');
    mkdirSync(hd, { recursive: true });
    execSync(`mkfifo ${skipPath(dir)}`);
    const start = Date.now();
    const r = runGate(dir);
    assert.equal(r.status, 2, `FIFO flag must fail closed, got status=${r.status} signal=${r.signal}`);
    assert.ok(Date.now() - start < 5000, 'gate must not block on the FIFO flag');
    assert.match(r.stderr, /not a regular file/);
  });
});

test('CRITICAL-3: a flood of covering PASS sidecars cannot push a covering FAIL out of the window -> BLOCK', () => {
  withRepo(HIGH, (dir) => {
    const hash = stagedHash(dir);
    // 33 covering PASS tuples sort BEFORE the covering FAIL; under subset selection the FAIL
    // would fall out of the 32-file window and the PASSes would win. The cap now blocks outright.
    for (let i = 0; i < 33; i++) {
      writeReview(dir, `review-${TODAY}-10${String(i).padStart(4, '0')}.json`, evidence(hash));
    }
    writeReview(dir, `review-${TODAY}-235959.json`, evidence(hash, { verdict: 'FAIL' }));
    const r = runGate(dir);
    assert.equal(r.status, 2, 'cap overflow must fail closed regardless of window contents');
    assert.match(r.stderr, /exceed the scan cap/);
    // At or under the cap, the covering FAIL is seen and blocks on its own signal.
    for (let i = 5; i < 33; i++) rmSync(join(dir, 'docs', 'reviews', `review-${TODAY}-10${String(i).padStart(4, '0')}.json`));
    const r2 = runGate(dir);
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /verdict is FAIL/);
  });
});
