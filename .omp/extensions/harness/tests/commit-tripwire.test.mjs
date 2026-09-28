// tests/commit-tripwire.test.mjs — AC3: the command layer keeps only a MINIMAL tripwire.
//
// After enforcement moved into .githooks/pre-commit, the command layer no longer tries to
// decide "is this a commit?" by enumerating shell spellings (the game the 6th review proved
// unwinnable). It watches exactly one finite, git-DEFINED surface: the documented handles
// that make git skip or relocate its own hooks. Everything else is the hook's business.
//
// Positive cases = declared bypass intent. Negative cases = ordinary work that must never
// be blocked at this layer (including the 2026-07-29 false positive that blocked a
// read-only `git show` loop, and the Orca launcher's ambient GIT_CONFIG_COUNT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitBypassTripwire } from '../gates/git-commit-detect.mjs';

const trip = (cmd, env) => commitBypassTripwire(cmd, env);

// T1: --no-verify, its unambiguous abbreviations, and the independent -n alias.
test('T1: hook-skipping flags on a commit are blocked', () => {
  for (const cmd of [
    'git commit --no-verify -m x',
    'git commit --no-verif -m x',
    'git commit --no-v -m x',
    'git commit -n -m x',
    'git commit -nm x',
  ]) {
    assert.ok(trip(cmd), `expected tripwire for: ${cmd}`);
    assert.match(trip(cmd), /verify|hook/i);
  }
});

// T2: core.hooksPath retargeting via -c / --config-env / GIT_CONFIG_KEY_* values.
test('T2: hooksPath retargeting is blocked (flag and env forms)', () => {
  assert.ok(trip('git -c core.hooksPath=/dev/null commit -m x'));
  assert.ok(trip('git --config-env=core.hooksPath=EMPTY commit -m x'));
  assert.ok(trip('git commit -m x', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' }));
  assert.ok(trip('git commit -m x', { GIT_CONFIG_KEY_0: 'include.path', GIT_CONFIG_VALUE_0: '/tmp/evil' }));
});

// T3: top-level repo retargeting flags.
test('T3: --git-dir / --work-tree retargeting is blocked', () => {
  assert.ok(trip('git --git-dir=/other/.git commit -m x'));
  assert.ok(trip('git --work-tree=/other commit -m x'));
  assert.ok(trip('git --git-dir /other/.git commit -m x'));
});

// T4: GIT_* retargeting env, both structured (bash tool `env`) and inline assignments.
test('T4: GIT_* retargeting environment is blocked', () => {
  assert.ok(trip('git commit -m x', { GIT_DIR: '/other/.git' }));
  assert.ok(trip('git commit -m x', { GIT_WORK_TREE: '/other' }));
  assert.ok(trip('GIT_DIR=/other/.git git commit -m x'));
  assert.ok(trip('git commit -m x', { GIT_CEILING_DIRECTORIES: '/' }));
});

// T5: negative regressions — ordinary work stays untouched at the command layer.
test('T5: ordinary commands and benign ambient env are not blocked', () => {
  const benign = [
    'git commit -m x',
    'git commit -a -m x',
    'git add -A && git commit -m x',            // gates judge the index at hook time now
    'git merge --no-edit feat',
    'git show HEAD:some/file.mjs | wc -l',       // the 2026-07-29 false positive
    'for f in a b; do git show "HEAD:$f" | wc -l; done',
    'git commit --amend --no-edit',
    'grep -n "git commit" docs/notes.md',
    'git log --oneline -n 5',
    'git commit -m "do not use --no-verify"',    // flag inside a quoted message is not a flag
  ];
  for (const cmd of benign) {
    assert.equal(trip(cmd), null, `must not trip: ${cmd} (got: ${trip(cmd)})`);
  }
  // Orca launcher credential ambient (A-3 regression): keys are not repo-retargeting.
  assert.equal(trip('git commit -m x', {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store',
    GIT_CONFIG_KEY_1: 'credential.useHttpPath', GIT_CONFIG_VALUE_1: 'true',
  }), null);
  // Config neutralization idiom used by deterministic fixtures/CI.
  assert.equal(trip('git commit -m x', { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }), null);
});

// T6 (3-pass review, high #3): spellings INSIDE the declared finite surface that the first
// implementation missed. These are not new denylist entries — each is another syntax for a
// handle the tripwire already claims to watch, measured as landing rc=0 with both channels
// silent.
test('T6: declared handles are covered in all of git\'s accepted syntaxes', () => {
  // (1) an alias-invoked commit still carries --no-verify
  assert.ok(trip('git -c alias.c=commit c --no-verify -m x'), 'alias + --no-verify');
  // (2) --config-env in its SEPARATED form (git accepts `--config-env <key>=<envvar>`)
  assert.ok(trip('git --config-env core.hooksPath=EMPTYHOOKS commit -m x'), 'separated --config-env');
  // (3) a commit behind bash -c
  assert.ok(trip('bash -c "git commit --no-verify -m x"'), 'bash -c payload');
  assert.ok(trip("sh -c 'git commit -n -m x'"), 'sh -c payload');
  // (4) GIT_CONFIG_PARAMETERS is another config-injection channel git honors
  assert.ok(trip('git commit -m x', { GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/dev/null'" }), 'GIT_CONFIG_PARAMETERS');
});

// T7 (3-pass review, medium): ordinary commits must not be mistaken for a bypass. Option
// VALUES that merely look like flags are the trap — the module's own classifyCommitArgs
// already models -S/-u glued values and the `--` terminator, so the tripwire must too.
test('T7: option values that look like bypass flags do not trip', () => {
  const benign = [
    'git commit -unormal -m x',            // -u<mode>, glued value starting with "n"
    'git commit -Sname -m x',              // -S<keyid>, glued value
    'git commit -m x -- --no-verify',      // after `--` everything is a pathspec
    'git commit -m --no-verify',           // the message happens to be a flag-looking word
    'git commit -m "-n"',                  // ditto, quoted
    'git commit --message=--no-verify',    // attached value
    'git commit -F -n',                    // -F takes the next token as a path
  ];
  for (const cmd of benign) {
    assert.equal(trip(cmd), null, `must not trip: ${cmd} (got: ${trip(cmd)})`);
  }
});

// T8 (review round 2, medium): the tripwire watches the WRITE side only. Read-only and
// history-rewriting git calls carry no gate to skip, and blocking their `-c`/`GIT_*` idioms
// was pure friction — every case below was MEASURED as a false block.
test('T8: read-only and non-commit git calls are never tripped', () => {
  const benign = [
    'git -c core.hooksPath=/tmp/x status',
    'git -c core.worktree=/other diff --cached',
    'GIT_INDEX_FILE=/tmp/idx git read-tree HEAD',
    'GIT_DIR=/other/.git git log --oneline',
    'GIT_WORK_TREE=/other git status --short',
    'git --git-dir=/other/.git log --oneline',      // inspecting another repo is not a bypass
    'git --work-tree=/other status --short',
    'git --git-dir /other/.git rev-parse HEAD',
    'git merge --no-verify feat',            // merges are deliberately never gated
    'git stash push -m wip',
    'GIT_DIR=/x ls /tmp/git-repos',           // no git program at all
    'GIT_WORK_TREE=/x make deploy-git',
  ];
  for (const cmd of benign) {
    assert.equal(trip(cmd), null, `must not trip: ${cmd} (got: ${trip(cmd)})`);
  }
  // Structured env must agree with the inline form: neither blocks a read-only call.
  assert.equal(trip('git log --oneline', { GIT_DIR: '/other/.git' }), null);
});

// T9: `push --no-verify` skips .githooks/pre-push (our archive/drift boundary), so it IS
// watched — with a message that names the right hook.
test('T9: push --no-verify is tripped with a push-specific reason', () => {
  const reason = trip('git push --no-verify origin main');
  assert.ok(reason, 'push --no-verify must trip');
  assert.match(reason, /pre-push/);
  // `-n` on push is --dry-run, not --no-verify: it must NOT trip.
  assert.equal(trip('git push -n origin main'), null);
});

// T10 (review round 2, medium): the alias path must be load-bearing on its own. The earlier
// T6 assertion passed even with alias resolution disabled, because the long `--no-verify`
// matched anyway. The SHORT `-n` only reaches the commit rule through alias resolution.
test('T10: an aliased commit is recognized for the short -n alias too', () => {
  const reason = trip('git -c alias.c=commit c -n -m x');
  assert.ok(reason, 'aliased commit with -n must trip');
  assert.match(reason, /no-verify/);
  // Same spelling against a NON-commit alias stays untouched (`-n` is not universal).
  assert.equal(trip('git -c alias.l=log l -n 5'), null);
});

// T11 (review round 4): git config section/key names are case-insensitive, so `ALIAS.c=commit`
// defines the same alias. Matching the section case-sensitively let the spelling through.
test('T11: an alias defined with a differently-cased section is still recognized', () => {
  const reason = trip('git -c ALIAS.c=commit c -n -m x');
  assert.ok(reason, 'ALIAS.c must define the same alias git would');
  assert.match(reason, /no-verify/);
});

// T12 (review round 4): the alias DEFINITION body carries argv too, and it is the only place a
// bypass can hide when the invocation itself looks clean. Pins the body walk (removing it left
// T6/T10 green, because those spell the flag in the invocation).
test('T12: a bypass flag inside the alias definition body is read', () => {
  const reason = trip('git -c "alias.ci=commit --no-verify" ci -m x');
  assert.ok(reason, 'the flag lives in the alias body, not the argv');
  assert.match(reason, /no-verify/);
  // A body with no bypass stays untouched.
  assert.equal(trip('git -c "alias.ci=commit -m default" ci'), null);
});

// T13 (review round 4): `-c` AFTER the verb is `--reedit-message` and takes a commit-ish, not a
// config pair. Reading it as config could block an ordinary commit.
test('T13: post-verb -c is a message option, not a config assignment', () => {
  assert.equal(trip('git commit -c include.path -m x'), null);
  assert.equal(trip('git commit -C HEAD'), null);
  // Pre-verb, the same spelling IS the global config option and must trip.
  assert.ok(trip('git -c include.path=/tmp/e commit -m x'), 'pre-verb -c is config');
});

// T14 (review round 4): GIT_CONFIG_PARAMETERS pairs are inspected by KEY. Splitting the quoted
// form on whitespace also walked into VALUES, so an ordinary credential helper tripped.
test('T14: GIT_CONFIG_PARAMETERS is judged by key, not by words inside a value', () => {
  assert.equal(
    trip('git commit -m x', { GIT_CONFIG_PARAMETERS: "'credential.helper'='!f() { echo core.hooksPath=/tmp/x; }'" }),
    null,
    'a value mentioning a retarget key is not a retarget',
  );
  assert.ok(
    trip('git commit -m x', { GIT_CONFIG_PARAMETERS: "'user.name'='x' 'core.hooksPath'='/tmp/none'" }),
    'a quoted retarget KEY must trip',
  );
  // The legacy unquoted form has no quoted pairs at all, so it falls back to bare splitting.
  assert.ok(
    trip('git commit -m x', { GIT_CONFIG_PARAMETERS: 'user.name=x core.hooksPath=/tmp/none' }),
    'the legacy unquoted form must still trip',
  );
});

// T15 (review round 5, L5): an alias BODY starts after the verb it defines, so `-c` inside it is
// `--reedit-message`, not a config assignment. Walking the body as if it were pre-verb argv made
// an ordinary aliased commit look like a hooks-path retarget.
test('T15: -c inside an alias body is a message option, not a config assignment', () => {
  assert.equal(trip('git -c "alias.c=commit -c include.path" c'), null);
  // A real bypass in the same position still trips.
  assert.ok(trip('git -c "alias.c=commit --no-verify" c'), 'a bypass flag in the body still trips');
});

// T16 (review round 5, L4): `--attr-source` takes a REQUIRED value, so git consumes the next token
// (measured: `git --attr-source HEAD commit` → "bad --attr-source", i.e. HEAD was the value).
// Reading that value as a flag produced a false block. Options with OPTIONAL values must NOT be
// consumed the same way: `git commit --gpg-sign -n` really is a `-n` bypass.
test('T16: a required-value global option consumes its value; an optional-value one does not', () => {
  assert.equal(trip('git --attr-source -n commit -m x'), null, '-n is the value of --attr-source');
  assert.ok(trip('git commit --gpg-sign -n -m x'), '-n after an optional-value option is a real bypass');
  assert.ok(trip('git commit --untracked-files -n -m x'), 'same for --untracked-files');
});
