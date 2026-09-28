// harness-version-check.test.mjs — drift probe gate behavior contract.
//
// The gate is a stdin-JSON CLI (exit 0 always; drift => stdout directive). Every
// "remote" in this suite is a local file:// bare git repo, so nothing here ever
// touches the network. Contract under test:
//   - drift (highest remote harness/YYYY.N tag ranks above local version) =>
//     stdout leads with HARNESS STALE and routes resolution via /skill:harness-check
//   - local at (or past) the latest remote tag => silent
//   - annotated tags: on equal version rank the PEELED `^{}` commit sha wins —
//     harness-sync stores `rev-parse HEAD` (a commit sha) in meta, so comparing
//     against the tag-object sha would report DRIFT forever
//   - cache (.omp/state/harness-version-check.json) honors the caller's
//     max_age_ms window; 0 forces a refetch; junk values fall back to the default
//   - a failed probe writes a `failed` marker and subsequent runs back off
//     silently WITHOUT re-probing
//   - no `source_remote` in harness-meta.json (this IS the source repo) => no-op
//
// Fixture tags are ANNOTATED (`git tag -a`) on purpose: only annotated tags make
// the tag-object sha differ from the commit sha, which is what the peeled-sha
// contract is about. Lightweight tags would vacuously pass the old, broken compare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'harness-version-check.mjs');

// Hermetic env: strip ambient GIT_* so a hook-provided GIT_DIR/GIT_INDEX_FILE cannot redirect fixtures.
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return env;
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: cleanEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// Fixture: a bare "source" repo carrying annotated harness/* tags + a consumer
// dir whose harness-meta.json points at it via file://.
//   sourceRemote: null  => omit source_remote entirely (source-repo skip case)
//   missingRemote: true => source_remote points at a path that does not exist
function makeFixture({ localVersion, tags = ['2026.60', '2026.61'], sourceRemote, missingRemote = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hvc-'));
  const bare = join(root, 'source.git');
  const work = join(root, 'work');
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  git(root, ['init', '-q', '--bare', bare]);
  git(root, ['init', '-q', work]);
  git(work, [...ident, 'commit', '-q', '--allow-empty', '-m', 'seed']);
  const addTag = (v) => {
    git(work, [...ident, 'tag', '-a', '-m', `harness ${v}`, `harness/${v}`]);
    git(work, ['push', '-q', `file://${bare}`, `refs/tags/harness/${v}`]);
  };
  for (const v of tags) addTag(v);

  const consumer = join(root, 'consumer');
  mkdirSync(join(consumer, '.omp', 'extensions', 'harness'), { recursive: true });
  const metaPath = join(consumer, '.omp', 'extensions', 'harness', 'harness-meta.json');
  const writeMeta = (m) => writeFileSync(metaPath, JSON.stringify(m, null, 2));
  let remote = `file://${bare}`;
  if (missingRemote) remote = `file://${join(root, 'no-such-remote.git')}`;
  if (sourceRemote === null) remote = null;
  const meta = { version: localVersion };
  if (remote !== null) meta.source_remote = remote;
  writeMeta(meta);

  return {
    root, consumer, addTag, writeMeta,
    sourceRemote: remote,
    cachePath: join(consumer, '.omp', 'state', 'harness-version-check.json'),
    commitShaOf: (v) => git(work, ['rev-parse', `harness/${v}^{commit}`]).trim(),
    tagObjectShaOf: (v) => git(work, ['rev-parse', `refs/tags/harness/${v}`]).trim(),
  };
}

function withFixture(opts, fn) {
  const fx = makeFixture(opts);
  try { return fn(fx); } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

function runGate(cwd, payload = {}, envExtra = {}) {
  const started = Date.now();
  const r = spawnSync('node', [GATE], {
    input: JSON.stringify({ session_state: { cwd }, ...payload }),
    cwd,
    encoding: 'utf-8',
    env: { ...cleanEnv(), ...envExtra },
  });
  r.durationMs = Date.now() - started;
  return r;
}

test('drift: remote ahead of local emits a HARNESS STALE directive naming the latest remote version', () => {
  withFixture({ localVersion: '2026.50' }, (fx) => {
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0, 'drift is advisory — exit must stay 0');
    const out = r.stdout.trim();
    assert.ok(out.startsWith('HARNESS STALE'), `directive must lead with HARNESS STALE, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('/skill:harness-check'), 'directive must route resolution through /skill:harness-check');
    assert.ok(out.includes('2026.61'), 'directive must name the latest remote version');
    assert.ok(!out.includes('2026.60'), 'directive must pick the HIGHEST remote tag, not an arbitrary one');
  });
});

test('up to date: local matching the latest remote tag is silent', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'no drift => no output');
  });
});

test('local ahead of remote is silent (comparison is strictly remote > local)', () => {
  withFixture({ localVersion: '2026.99' }, (fx) => {
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'a locally-newer harness must not be reported as stale');
  });
});

test('annotated tags: version match + commit_sha == peeled commit is silent (no false DRIFT)', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    const commit = fx.commitShaOf('2026.61');
    assert.notEqual(commit, fx.tagObjectShaOf('2026.61'),
      'fixture must use ANNOTATED tags (tag object != commit) or this test proves nothing');
    fx.writeMeta({ version: '2026.61', commit_sha: commit, source_remote: fx.sourceRemote });
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '',
      'the gate must compare the PEELED ^{} commit sha, not the annotated tag-object sha');
  });
});

test('version match but genuinely different commit_sha still reports HARNESS DRIFT', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    fx.writeMeta({ version: '2026.61', commit_sha: '0'.repeat(40), source_remote: fx.sourceRemote });
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    const out = r.stdout.trim();
    assert.ok(out.startsWith('HARNESS DRIFT'),
      `the sha fallback must still fire on a real mismatch, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('/skill:harness-check'), 'directive must route resolution through /skill:harness-check');
  });
});

test('cache window: a fresh cache pins the remote version; max_age_ms 0 forces a refetch', () => {
  withFixture({ localVersion: '2026.50' }, (fx) => {
    const seed = runGate(fx.consumer);
    assert.match(seed.stdout, /2026\.61/, 'seed run must probe and report the current latest');
    assert.ok(existsSync(fx.cachePath), 'a successful probe must persist its result');

    fx.addTag('2026.62'); // published mid-window

    const hit = runGate(fx.consumer, { max_age_ms: 3600000 });
    assert.equal(hit.status, 0);
    assert.match(hit.stdout, /2026\.61/, 'inside the window the CACHED remote version must win');
    assert.ok(!hit.stdout.includes('2026.62'), 'a cache hit must not re-probe the remote');

    const fresh = runGate(fx.consumer, { max_age_ms: 0 });
    assert.match(fresh.stdout, /2026\.62/, 'max_age_ms 0 must bypass the cache and see the new tag');
  });
});

// Clock step backwards (measured on WSL2, 2026-09-23: Date.now() jumped -1.8s between two reads,
// which made the test above flake): a cache whose checkedAt is in the FUTURE made `now - checkedAt`
// negative, which satisfied every window including max_age_ms 0 — the caller asked for a refetch
// and silently got the stale cache. A future checkedAt must be treated as stale.
test('cache window: a checkedAt in the future (clock stepped backwards) never satisfies the window', () => {
  withFixture({ localVersion: '2026.50' }, (fx) => {
    const seed = runGate(fx.consumer);
    assert.match(seed.stdout, /2026\.61/);
    fx.addTag('2026.62');
    const cached = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    const futureCheckedAt = Date.now() + 60_000;
    writeFileSync(fx.cachePath, JSON.stringify({ ...cached, checkedAt: futureCheckedAt }));
    const fresh = runGate(fx.consumer, { max_age_ms: 0 });
    assert.match(fresh.stdout, /2026\.62/, 'a future checkedAt must not be treated as a cache hit');
    const after = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    // No wall-clock comparison here (that is the very flake under test): the injected value being
    // gone, plus the new tag above, proves the re-probe rewrote the cache.
    assert.notEqual(after.checkedAt, futureCheckedAt, 'the re-probe must rewrite the injected checkedAt');
    assert.equal(after.remoteLatestVersion, '2026.62', 'the rewritten cache carries the re-probed version');
    // And the normal window still works after the rewrite.
    const hit = runGate(fx.consumer, { max_age_ms: 3600000 });
    assert.match(hit.stdout, /2026\.62/);
  });
});

test('failure backoff: dead remote is silent, exits 0, records failed marker, then skips the re-probe', () => {
  withFixture({ localVersion: '2026.50', missingRemote: true }, (fx) => {
    rmSync(fx.cachePath, { force: true });

    const first = runGate(fx.consumer);
    assert.equal(first.status, 0, 'probe failure must never break the caller');
    assert.equal(first.stdout.trim(), '', 'probe failure must be silent');
    const marker = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    assert.equal(marker.failed, true, 'failure must be recorded so frequent callers back off');
    assert.ok(Number.isFinite(marker.checkedAt), 'failure marker must carry a timestamp');

    const second = runGate(fx.consumer);
    assert.equal(second.status, 0);
    assert.equal(second.stdout.trim(), '', 'backoff hit must stay silent');
    assert.ok(second.durationMs < 2000, `backoff hit must be fast (no probe), took ${second.durationMs}ms`);
    const after = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    assert.equal(after.checkedAt, marker.checkedAt, 'backoff hit must NOT re-probe — marker stays untouched');
  });
});

test('source repo (no source_remote in meta) is a silent no-op', () => {
  withFixture({ localVersion: '2026.50', sourceRemote: null }, (fx) => {
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.ok(!existsSync(fx.cachePath), 'the source repo must neither probe nor write a cache');
  });
});

test('invalid max_age_ms (negative, string) behaves like the default window, not always-refetch', () => {
  withFixture({ localVersion: '2026.50' }, (fx) => {
    const seed = runGate(fx.consumer); // populate cache at 2026.61
    assert.match(seed.stdout, /2026\.61/);
    fx.addTag('2026.62');

    for (const bad of [-1, 'soon']) {
      const r = runGate(fx.consumer, { max_age_ms: bad });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /2026\.61/,
        `max_age_ms=${JSON.stringify(bad)} must fall back to the default window (cache hit)`);
      assert.ok(!r.stdout.includes('2026.62'),
        `max_age_ms=${JSON.stringify(bad)} must NOT be coerced into an always-refetch`);
    }
  });
});

test('failure preserves last-known drift: marker keeps remote fields and STALE keeps being reported', () => {
  withFixture({ localVersion: '2026.50' }, (fx) => {
    // (1) healthy probe seeds a drift cache
    const seed = runGate(fx.consumer);
    assert.ok(seed.stdout.trim().startsWith('HARNESS STALE'), 'seed probe must report the known drift');
    const good = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    assert.equal(good.remoteLatestVersion, '2026.61');

    // (2) the remote dies; max_age_ms 0 forces a re-probe, which fails
    fx.writeMeta({ version: '2026.50', source_remote: `file://${join(fx.root, 'gone.git')}` });
    const failing = runGate(fx.consumer, { max_age_ms: 0 });
    assert.equal(failing.status, 0, 'a failed re-probe must never break the caller');
    assert.ok(failing.stdout.trim().startsWith('HARNESS STALE'),
      'a KNOWN drift must survive a failed re-probe (last-known-good), not go silent');
    const marker = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    assert.equal(marker.failed, true, 'the failed probe must still be recorded for backoff');
    assert.equal(marker.remoteLatestVersion, '2026.61',
      'the failure marker must PRESERVE the previous remote fields, not clobber them');

    // (3) within FAILURE_TTL the backoff window keeps reporting the drift without re-probing
    const backoff = runGate(fx.consumer);
    assert.equal(backoff.status, 0);
    assert.ok(backoff.stdout.trim().startsWith('HARNESS STALE'),
      'the backoff window must keep reporting the known drift, not go silent for FAILURE_TTL');
    const after = JSON.parse(readFileSync(fx.cachePath, 'utf-8'));
    assert.equal(after.checkedAt, marker.checkedAt, 'the backoff hit must NOT re-probe — marker stays untouched');
  });
});

// --- Hook activation probe (#26) ---
// `core.hooksPath` is local git config, so no file sync can propagate it: a consumer
// that ships `.githooks/` but never pointed git at it has every commit/push gate
// silently dead. Contract: `.githooks/` present + hooksPath not resolving to it =>
// one HARNESS HOOKS INACTIVE notice per 24h; already active, no hooks dir, or no
// git work tree => silent. The probe runs BEFORE the source-repo skip.

function gitInit(dir) {
  git(dir, ['init', '-q']);
}

test('hooks inactive: .githooks/ in a git work tree without core.hooksPath emits HOOKS INACTIVE once per window', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    gitInit(fx.consumer);
    mkdirSync(join(fx.consumer, '.githooks'));
    const first = runGate(fx.consumer);
    assert.equal(first.status, 0, 'advisory — exit stays 0');
    const out = first.stdout.trim();
    assert.ok(out.startsWith('HARNESS HOOKS INACTIVE'), `must lead with HARNESS HOOKS INACTIVE, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('git config core.hooksPath .githooks'), 'notice must carry the exact activation command');
    assert.ok(out.includes('/skill:harness-check'), 'notice must route to the idempotent skill path');
    assert.ok(existsSync(join(fx.consumer, '.omp', 'state', 'harness-hooks-check.json')), 'marker must be written');

    const second = runGate(fx.consumer);
    assert.equal(second.stdout.trim(), '', 'within the 24h window the notice must not repeat (no per-turn nag)');

    const forced = spawnSync('node', [GATE, '--force'], {
      input: JSON.stringify({ session_state: { cwd: fx.consumer } }), cwd: fx.consumer, encoding: 'utf-8', env: cleanEnv(),
    });
    assert.ok(forced.stdout.trim().startsWith('HARNESS HOOKS INACTIVE'), '--force bypasses the notice window');
  });
});

test('hooks active: relative core.hooksPath=.githooks is silent (resolved against the work-tree top)', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    gitInit(fx.consumer);
    mkdirSync(join(fx.consumer, '.githooks'));
    git(fx.consumer, ['config', 'core.hooksPath', '.githooks']);
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'active hooks => no notice');
    assert.ok(!existsSync(join(fx.consumer, '.omp', 'state', 'harness-hooks-check.json')), 'no marker when nothing was emitted');
  });
});

test('hooks re-pointed elsewhere still counts as inactive and names the configured value', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    gitInit(fx.consumer);
    mkdirSync(join(fx.consumer, '.githooks'));
    git(fx.consumer, ['config', 'core.hooksPath', '/tmp/none']);
    const r = runGate(fx.consumer);
    const out = r.stdout.trim();
    assert.ok(out.startsWith('HARNESS HOOKS INACTIVE'));
    assert.ok(out.includes('/tmp/none'), 'notice must show where hooksPath currently points');
  });
});

test('hooks probe is silent without .githooks/ or outside a git work tree', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    // git repo, no .githooks/ => nothing to activate
    gitInit(fx.consumer);
    assert.equal(runGate(fx.consumer).stdout.trim(), '');
  });
  withFixture({ localVersion: '2026.61' }, (fx) => {
    // .githooks/ but not a git work tree (plain directory) => cannot read git config, stay silent
    mkdirSync(join(fx.consumer, '.githooks'));
    const r = runGate(fx.consumer);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

test('hooks probe runs before the source-repo skip (no source_remote still gets the notice)', () => {
  withFixture({ localVersion: '2026.61', sourceRemote: null }, (fx) => {
    gitInit(fx.consumer);
    mkdirSync(join(fx.consumer, '.githooks'));
    const r = runGate(fx.consumer);
    assert.ok(r.stdout.trim().startsWith('HARNESS HOOKS INACTIVE'), 'source repos carry hooks too — the probe must not be gated behind source_remote');
  });
});

test('hooks active through a symlinked session cwd is silent (real-path comparison)', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    gitInit(fx.consumer);
    mkdirSync(join(fx.consumer, '.githooks'));
    git(fx.consumer, ['config', 'core.hooksPath', '.githooks']);
    const link = join(fx.root, 'consumer-link');
    symlinkSync(fx.consumer, link);
    const r = runGate(link);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'symlinked cwd must not produce a false HOOKS INACTIVE');
  });
});

// --- Policy shadow probe (#35) ---
// Measured on omp 18.2.5 (`omp -p --no-extensions` marker probes, 2026-09-23): a `.omp/AGENTS.md`
// with ANY bytes (content, a lone newline, whitespace) replaces the same-depth root AGENTS.md; a
// 0-byte file is ignored. Project and user RULES.md are both loaded, so `.omp/RULES.md` is not a
// shadow and is never probed. Contract: root AGENTS.md + non-empty .omp/AGENTS.md => one
// HARNESS POLICY SHADOWED notice per 24h routing to `.omp/rules/`; otherwise silent, no marker.

test('policy shadowed: .omp/AGENTS.md beside a root AGENTS.md emits POLICY SHADOWED once per window', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    writeFileSync(join(fx.consumer, 'AGENTS.md'), '# policy\n');
    writeFileSync(join(fx.consumer, '.omp', 'AGENTS.md'), '# project\n');
    const first = runGate(fx.consumer);
    assert.equal(first.status, 0, 'advisory — exit must stay 0');
    const out = first.stdout.trim();
    assert.ok(out.startsWith('HARNESS POLICY SHADOWED'), `must lead with HARNESS POLICY SHADOWED, got: ${JSON.stringify(out)}`);
    assert.ok(out.includes('.omp/AGENTS.md') && out.includes('.omp/rules/'), 'notice must name the offending file and the replacement location');
    assert.ok(existsSync(join(fx.consumer, '.omp', 'state', 'harness-policy-check.json')), 'marker must be written');

    const second = runGate(fx.consumer);
    assert.equal(second.stdout.trim(), '', 'within the 24h window the notice must not repeat');
  });
});

test('policy shadowed: a whitespace-only or single-newline .omp/AGENTS.md still shadows (size > 0, not trimmed content)', () => {
  for (const body of ['\n', ' \n\n', '\t']) {
    withFixture({ localVersion: '2026.61' }, (fx) => {
      writeFileSync(join(fx.consumer, 'AGENTS.md'), '# policy\n');
      writeFileSync(join(fx.consumer, '.omp', 'AGENTS.md'), body);
      const r = runGate(fx.consumer);
      assert.ok(r.stdout.trim().startsWith('HARNESS POLICY SHADOWED'), `${JSON.stringify(body)} must be reported`);
    });
  }
});

test('policy not shadowed: no root AGENTS.md, a 0-byte .omp/AGENTS.md, or a project .omp/RULES.md are all silent', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    writeFileSync(join(fx.consumer, '.omp', 'AGENTS.md'), '# project\n');  // no root AGENTS.md to shadow
    writeFileSync(join(fx.consumer, '.omp', 'RULES.md'), 'hard\n');         // both RULES.md load: not a shadow
    assert.equal(runGate(fx.consumer).stdout.trim(), '', 'nothing is shadowed => no notice');
    writeFileSync(join(fx.consumer, 'AGENTS.md'), '# policy\n');
    writeFileSync(join(fx.consumer, '.omp', 'AGENTS.md'), '');              // 0 bytes: ignored by the provider
    assert.equal(runGate(fx.consumer).stdout.trim(), '', 'a 0-byte .omp/AGENTS.md shadows nothing');
    assert.ok(!existsSync(join(fx.consumer, '.omp', 'state', 'harness-policy-check.json')), 'no marker when nothing was emitted');
  });
});

// Review 2026-09-23 round 2 (C-3): a marker dated in the FUTURE (clock stepped back, or a
// hand-written suppressor) must not silence the notice — the drift cache applies the same rule.
test('policy shadowed: a future-dated notice marker does not suppress the notice', () => {
  withFixture({ localVersion: '2026.61' }, (fx) => {
    writeFileSync(join(fx.consumer, 'AGENTS.md'), '# policy\n');
    writeFileSync(join(fx.consumer, '.omp', 'AGENTS.md'), '# project\n');
    mkdirSync(join(fx.consumer, '.omp', 'state'), { recursive: true });
    writeFileSync(join(fx.consumer, '.omp', 'state', 'harness-policy-check.json'), JSON.stringify({ notifiedAt: Date.now() + 60 * 60 * 1000 }));
    const r = runGate(fx.consumer);
    assert.ok(r.stdout.trim().startsWith('HARNESS POLICY SHADOWED'), 'a future marker is stale, not a valid window');
  });
});
