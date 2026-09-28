// commit-landed-handlers.test.mjs — #48-5/6 + #22, exercised through the CAPTURED index.ts
// handlers (tests/helpers/harness-handlers.mjs) against real temp repos, with the real gates
// spawned: a `git commit` tool_call snapshots the target repo's HEAD, and the tool_result is
// judged by whether that repo GAINED a commit — not by the shell exit code.
//
// The bash tool itself is not run: each test performs (or withholds) the git action between
// the two handler calls, exactly as the tool would, then feeds the result event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHarness, ctxFor } from './helpers/harness-handlers.mjs';

const { handlers } = await loadHarness();
const toolCall = handlers.tool_call[0];
const toolResult = handlers.tool_result[0];
assert.ok(toolCall && toolResult, 'index.ts must register tool_call and tool_result');

// Hermetic git for BOTH the fixtures and index.ts's own spawns (they inherit process.env): no
// user/system config (commit.gpgSign, core.hooksPath, core.abbrev, log.showSignature, …) can leak in.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
Object.assign(process.env, { HOME: tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' });
const ENV = process.env;
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo(root, name) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'landed-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function breadcrumbs(cwd) {
  const f = join(cwd, '.omp', 'harness-state', 'session-log.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}
let seq = 0;
async function drive({ cwd, command, act, exitCode }) {
  const toolCallId = `call-${++seq}`;
  const ctx = ctxFor(cwd);
  const block = await toolCall({ toolName: 'bash', toolCallId, input: { command } }, ctx);
  assert.equal(block, undefined, 'the commit call itself must not be blocked');
  if (act) act();
  const details = exitCode === undefined ? {} : { exitCode };
  const patch = await toolResult({ toolName: 'bash', toolCallId, input: { command }, content: [{ type: 'text', text: 'out' }], details, isError: false }, ctx);
  const noteText = patch?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  const last = breadcrumbs(cwd).filter((e) => e.kind === 'commit').at(-1);
  return { note: /cycle boundary/.test(noteText), last };
}

test('(a) blocked commit with a masked exit (`| tail`, exit 0, HEAD unchanged) -> no note, breadcrumb BLOCKED without hash', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const { note, last } = await drive({ cwd: a, command: 'git commit -m x 2>&1 | tail -1' });
    assert.equal(note, false);
    assert.deepEqual({ kind: last.kind, result: last.result, hash: last.hash }, { kind: 'commit', result: 'BLOCKED', hash: undefined });
  });
});

test('(b) `git -C other commit` that lands -> note + the OTHER repo\'s new hash, session HEAD untouched (#22)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const b = repo(root, 'B');
    const sessionHead = git(a, 'rev-parse', '--short', 'HEAD');
    const cmd = `git -C ${b} commit --allow-empty -m second`;
    const { note, last } = await drive({ cwd: a, command: cmd, act: () => git(b, 'commit', '-q', '--allow-empty', '-m', 'second') });
    assert.equal(note, true);
    assert.equal(last.hash, git(b, 'rev-parse', '--short', 'HEAD'));
    assert.notEqual(last.hash, sessionHead);
    assert.equal(git(a, 'rev-parse', '--short', 'HEAD'), sessionHead);
  });
});

test('(c) plain commit in the session repo that lands -> note + new hash (unchanged happy path)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m x', act: () => git(a, 'commit', '-q', '--allow-empty', '-m', 'x') });
    assert.equal(note, true);
    assert.equal(last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
    assert.equal(last.result, undefined);
  });
});

test('(d) HEAD moved but no commit gained (`reset --hard HEAD~1` beside a blocked commit) -> BLOCKED, no note', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'two');
    const { note, last } = await drive({ cwd: a, command: 'git reset --hard HEAD~1 && git commit -m x', act: () => git(a, 'reset', '-q', '--hard', 'HEAD~1'), exitCode: 1 });
    assert.equal(note, false);
    assert.equal(last.result, 'BLOCKED');
    assert.equal(last.hash, undefined);
  });
});

test('(e) --amend replaces HEAD (parent unchanged) -> still counts as a landed commit', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    writeFileSync(join(a, 'f'), '1');
    git(a, 'add', 'f');
    git(a, 'commit', '-q', '-m', 'one');
    const { note, last } = await drive({ cwd: a, command: 'git commit --amend --no-edit', act: () => git(a, 'commit', '-q', '--amend', '--no-edit', '--allow-empty', '-m', 'one-amended') });
    assert.equal(note, true);
    assert.equal(last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
  });
});

test('(f) unresolvable target (`cd B && git commit`) -> no snapshot: exit code decides the note, breadcrumb never guesses a hash', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const b = repo(root, 'B');
    const ok = await drive({ cwd: a, command: `cd ${b} && git commit --allow-empty -m x`, act: () => git(b, 'commit', '-q', '--allow-empty', '-m', 'x') });
    assert.equal(ok.note, true, 'exit 0 fallback keeps the note');
    assert.equal(ok.last.result, 'UNVERIFIED');
    assert.equal(ok.last.hash, undefined, 'the session repo HEAD must not be attributed (#22)');
    const failed = await drive({ cwd: a, command: `cd ${b} && git commit -m x`, exitCode: 1 });
    assert.equal(failed.note, false);
    assert.equal(failed.last.result, 'FAIL');
  });
});

test('(g) a background-start result drops the snapshot and records PENDING', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const ctx = ctxFor(a);
    const toolCallId = 'bg-1';
    await toolCall({ toolName: 'bash', toolCallId, input: { command: 'git commit -m x' } }, ctx);
    const patch = await toolResult({ toolName: 'bash', toolCallId, input: { command: 'git commit -m x' }, content: [], details: { async: { state: 'running', jobId: 'j' } }, isError: false }, ctx);
    assert.equal(patch, undefined);
    assert.equal(breadcrumbs(a).at(-1).result, 'PENDING');
  });
});

test('(h) HEAD moved FORWARD without a commit (checkout to a branch with unique commits) beside a blocked commit -> BLOCKED (reflog action is checkout)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    git(a, 'checkout', '-q', '-b', 'feature');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'on-feature');
    git(a, 'checkout', '-q', 'main');
    const { note, last } = await drive({ cwd: a, command: 'git checkout feature && git commit -m x', act: () => git(a, 'checkout', '-q', 'feature'), exitCode: 1 });
    assert.equal(note, false);
    assert.equal(last.result, 'BLOCKED');
  });
});

test('(i) commit that lands right after a pull/merge in the same call -> landed with the COMMIT hash (newest reflog action is commit)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    git(a, 'checkout', '-q', '-b', 'side');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'side');
    git(a, 'checkout', '-q', 'main');
    const { note, last } = await drive({ cwd: a, command: 'git merge side && git commit --allow-empty -m after', act: () => { git(a, 'merge', '-q', 'side'); git(a, 'commit', '-q', '--allow-empty', '-m', 'after'); } });
    assert.equal(note, true);
    assert.equal(last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
  });
});

test('(j) first commit on an unborn HEAD -> landed', async () => {
  await withRoot(async (root) => {
    const a = join(root, 'fresh');
    mkdirSync(a);
    git(a, 'init', '-q', '-b', 'main');
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m root', act: () => git(a, 'commit', '-q', '--allow-empty', '-m', 'root') });
    assert.equal(note, true);
    assert.equal(last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
  });
});

test('(k) landed commit followed by a non-commit HEAD move in the same call (commit && checkout -b) -> still landed with the commit hash', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    let committed;
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m x && git checkout -b next', act: () => { git(a, 'commit', '-q', '--allow-empty', '-m', 'x'); committed = git(a, 'rev-parse', '--short', 'HEAD'); git(a, 'checkout', '-q', '-b', 'next'); } });
    assert.equal(note, true);
    assert.equal(last.hash, committed);
  });
});

test('(l) repo without any reflog (core.logAllRefUpdates=false from init) -> ancestry fallback lands a real commit; a no-op is UNKNOWN (exit code decides), never a guessed hash', async () => {
  await withRoot(async (root) => {
    const a = join(root, 'nolog');
    mkdirSync(a);
    git(a, 'init', '-q', '-b', 'main');
    git(a, 'config', 'core.logAllRefUpdates', 'false');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'init');
    assert.equal(existsSync(join(a, '.git', 'logs')), false, 'fixture must have no reflog');
    const ok = await drive({ cwd: a, command: 'git commit --allow-empty -m x', act: () => git(a, 'commit', '-q', '--allow-empty', '-m', 'x') });
    assert.equal(ok.note, true);
    assert.equal(ok.last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
    const noop = await drive({ cwd: a, command: 'git commit -m x 2>&1 | tail -1' });
    assert.equal(noop.note, true, 'without a log a no-op and commit+undo look alike: exit-code fallback');
    assert.equal(noop.last.result, 'UNVERIFIED');
    assert.equal(noop.last.hash, undefined);
  });
});

test('(m) log.showSignature=true with a REALLY signed commit (ssh) does not corrupt the reflog parse', async (t) => {
  if (spawnSync('ssh-keygen', ['-h']).error) return t.skip('ssh-keygen not available');
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const key = join(root, 'key');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: ENV });
    writeFileSync(join(root, 'signers'), 't@x ' + readFileSync(key + '.pub', 'utf-8'));
    git(a, 'config', 'gpg.format', 'ssh');
    git(a, 'config', 'user.signingkey', key + '.pub');
    git(a, 'config', 'gpg.ssh.allowedSignersFile', join(root, 'signers'));
    git(a, 'config', 'log.showSignature', 'true');
    git(a, 'config', 'commit.gpgSign', 'true');
    // Sanity: the signature really prints without --no-show-signature.
    git(a, 'commit', '-q', '--allow-empty', '-m', 'signed-base');
    assert.match(git(a, 'log', '-1', '--format=%H'), /Good "git" signature|signature/i, 'fixture must actually be signed (showSignature output present)');
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m x', act: () => git(a, 'commit', '-q', '--allow-empty', '-m', 'x') });
    assert.equal(note, true);
    assert.equal(last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
  });
});

test('(n) reflog expiry DURING the call (auto-gc style: older entries dropped) still lands the commit', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'two');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'three');
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m x', act: () => {
      git(a, 'commit', '-q', '--allow-empty', '-m', 'x');
      // Expire everything but the newest entry (what gc does to entries past reflogExpire).
      git(a, 'reflog', 'expire', '--expire=now', '--expire-unreachable=now', 'HEAD');
      git(a, 'reflog', 'expire', '--expire=now', 'HEAD'); // idempotent; leaves the commit entry when git keeps the tip
    } });
    const tip = git(a, 'rev-parse', '--short', 'HEAD');
    // Depending on git version the expiry may keep 0 or 1 entries: 1 -> anchored-less commit found
    // -> landed; 0 -> unknown (exit-code fallback, note kept). Never BLOCKED.
    assert.notEqual(last.result, 'BLOCKED');
    assert.equal(note, true);
    if (last.hash !== undefined) assert.equal(last.hash, tip);
  });
});

test('(o) commit then checkout --orphan (HEAD unborn at result) -> still landed: logs/HEAD keeps the commit line', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    let committed;
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m x && git checkout --orphan o', act: () => { git(a, 'commit', '-q', '--allow-empty', '-m', 'x'); committed = git(a, 'rev-parse', '--short', 'HEAD'); git(a, 'checkout', '-q', '--orphan', 'o'); } });
    assert.equal(note, true);
    assert.equal(last.hash, committed);
  });
});

test('(q) a prior orphan checkout left logs/HEAD behind: a later blocked commit on a born branch is BLOCKED, not the stale root hash (round-5 M3)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    git(a, 'checkout', '-q', '--orphan', 'gh-pages');
    git(a, 'checkout', '-q', 'main');
    const { note, last } = await drive({ cwd: a, command: 'git commit -m blocked', exitCode: 1 });
    assert.equal(note, false);
    assert.equal(last.result, 'BLOCKED');
  });
});

test('(r) duplicate reflog identities (switch a -> b -> a within a second) beside a landed commit -> landed with the commit hash (round-5 high)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    git(a, 'checkout', '-q', '-b', 'docs');
    git(a, 'checkout', '-q', 'main');
    let committed;
    const { note, last } = await drive({ cwd: a, command: 'git switch docs && git commit --allow-empty -m x && git switch main', act: () => {
      git(a, 'switch', '-q', 'docs'); git(a, 'commit', '-q', '--allow-empty', '-m', 'x'); committed = git(a, 'rev-parse', '--short', 'HEAD'); git(a, 'switch', '-q', 'main');
    } });
    assert.equal(note, true);
    assert.equal(last.hash, committed);
  });
});

test('(s) snapshot lines expired under us while an OLDER reachable commit line survives -> a blocked commit is NOT landed (round-5 M2)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    // Backdated history: an old reachable commit line that expiry keeps, then a newer side commit
    // + checkout back that expire-unreachable drops (git drops the checkout line too).
    const old = { ...ENV, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
    const gitOld = (...args) => execFileSync('git', args, { cwd: a, env: old, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    gitOld('commit', '-q', '--allow-empty', '-m', 'old-main');
    gitOld('checkout', '-q', '-b', 'side');
    gitOld('commit', '-q', '--allow-empty', '-m', 'old-side');
    gitOld('checkout', '-q', 'main');
    const { note, last } = await drive({ cwd: a, command: 'git branch -D side && git gc && git commit -m blocked', exitCode: 1, act: () => {
      git(a, 'branch', '-q', '-D', 'side');
      git(a, 'reflog', 'expire', '--expire-unreachable=now', 'HEAD');
    } });
    assert.equal(note, false);
    assert.equal(last.hash, undefined, 'no historical hash may be attributed');
    assert.ok(last.result === 'BLOCKED' || last.result === 'FAIL', String(last.result));
  });
});


test('(p) bash cwd input through a symlink with .. (cwd: A/link/..) targets the physical repo', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const b = repo(root, 'B');
    mkdirSync(join(b, 'inner'));
    symlinkSync(join(b, 'inner'), join(a, 'link'));
    const ctx = ctxFor(a);
    const toolCallId = 'cwd-1';
    // The shell would cd into A/link/.. = B (physical), so the commit lands in B.
    await toolCall({ toolName: 'bash', toolCallId, input: { command: 'git commit --allow-empty -m x', cwd: 'link/..' } }, ctx);
    git(b, 'commit', '-q', '--allow-empty', '-m', 'x');
    await toolResult({ toolName: 'bash', toolCallId, input: { command: 'git commit --allow-empty -m x', cwd: 'link/..' }, content: [], details: {}, isError: false }, ctx);
    const last = breadcrumbs(a).filter((e) => e.kind === 'commit').at(-1);
    assert.equal(last.hash, git(b, 'rev-parse', '--short', 'HEAD'));
  });
});

test('(t) git failing at SNAPSHOT time -> no snapshot: exit code decides, never a guessed verdict (round-4 M2, snapshot side)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const shim = join(root, 'shim');
    mkdirSync(shim);
    writeFileSync(join(shim, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 });
    const ctx = ctxFor(a);
    const toolCallId = 'shim-1';
    const savedPath = process.env.PATH;
    process.env.PATH = `${shim}:${savedPath}`;
    try {
      await toolCall({ toolName: 'bash', toolCallId, input: { command: 'git checkout feature && git commit -m x' } }, ctx);
    } finally { process.env.PATH = savedPath; }
    git(a, 'checkout', '-q', '-b', 'feature');
    git(a, 'commit', '-q', '--allow-empty', '-m', 'on-feature');
    const patch = await toolResult({ toolName: 'bash', toolCallId, input: { command: 'git checkout feature && git commit -m x' }, content: [], details: { exitCode: 1 }, isError: false }, ctx);
    assert.equal(patch, undefined, 'exit 1 fallback: no note');
    const last = breadcrumbs(a).filter((e) => e.kind === 'commit').at(-1);
    assert.equal(last.result, 'FAIL');
    assert.equal(last.hash, undefined);
  });
});

test('(u) first commit in a repo that keeps NO reflog (unborn, no logs/HEAD before or after) -> landed via ancestry, not BLOCKED (round-6 M1)', async () => {
  await withRoot(async (root) => {
    const a = join(root, 'nolog');
    mkdirSync(a);
    git(a, 'init', '-q', '-b', 'main');
    git(a, 'config', 'core.logAllRefUpdates', 'false');
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m root', act: () => git(a, 'commit', '-q', '--allow-empty', '-m', 'root') });
    assert.equal(existsSync(join(a, '.git', 'logs', 'HEAD')), false, 'fixture must still have no reflog');
    assert.equal(note, true);
    assert.equal(last.hash, git(a, 'rev-parse', '--short', 'HEAD'));
  });
});

test('(v) a byte-identical commit line re-created in the same call (reset + re-commit reproducing the same oid) -> landed (multiset, round-6 M2)', async () => {
  await withRoot(async (root) => {
    const a = repo(root, 'A');
    const pinned = { ...ENV, GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' };
    const gitPinned = (...args) => execFileSync('git', args, { cwd: a, env: pinned, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    gitPinned('commit', '-q', '--allow-empty', '-m', 'same');
    const oid = git(a, 'rev-parse', '--short', 'HEAD');
    git(a, 'reset', '-q', '--hard', 'HEAD~1');
    const before = readFileSync(join(a, '.git', 'logs', 'HEAD'), 'utf-8');
    const { note, last } = await drive({ cwd: a, command: 'git commit --allow-empty -m same', act: () => {
      gitPinned('commit', '-q', '--allow-empty', '-m', 'same');
    } });
    const after = readFileSync(join(a, '.git', 'logs', 'HEAD'), 'utf-8');
    assert.equal(git(a, 'rev-parse', '--short', 'HEAD'), oid, 'fixture must reproduce the identical oid');
    assert.ok(after.length > before.length, 'a new (byte-identical) commit line was appended');
    assert.equal(note, true);
    assert.equal(last.hash, oid);
  });
});
