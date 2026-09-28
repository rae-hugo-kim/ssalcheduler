// Unit tests for isGitCommit() — the shared commit-gate detector used by
// acceptance-gate / backpressure-gate / review-gate.
//
// Run: node --test .omp/extensions/harness/tests/git-commit-detect.test.mjs
//
// Covers the two defects of the old regex
//   /(?:^|&&|\|\||;)\s*git\b[^|;]*\bcommit\b/  plus the bypass / false-positive
// classes surfaced by adversarial review (Codex + code-reviewer):
//   (1) false-NEGATIVE: real `git commit` missed when separated by newline / single &,
//       behind env-with-quoted-value / wrapper-with-options prefixes, behind bash -c
//       variants (-lc, /bin/bash -c, sh -ec), or behind shell reserved words.
//   (2) false-POSITIVE: fired on non-commit git commands that merely contain "commit"
//       as an argument, on commented-out / heredoc-body text, and on terminal git
//       global options (--help/--version) preceding the word commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitCommit, parseCommitForm, isWipCommit, commitTargetDir } from '../gates/git-commit-detect.mjs';

// --- Should DETECT (true): a real `git commit` invocation in some segment ---
const DETECT = [
  'git commit',
  'git commit -m x',
  'git commit -m "msg; with | ops"',            // operators inside quotes are data
  'git add -A && git commit -m x',
  'git add . ; git commit',
  'cd foo\ngit commit -m x',                     // newline-separated (original bug1)
  'echo hi\ngit commit',
  'foo & git commit',                            // single & separator (original bug1)
  'true && git commit || echo fail',             // commit in a middle segment
  '   git commit   ',                            // surrounding whitespace
  'git\tcommit',                                 // tab between git and subcommand
  'git commit --amend --no-edit',
  // global options before the subcommand
  'git -C /other commit',                        // cross-repo not special-cased -> still a commit
  'git -c user.name="A B" commit',               // -c flag with quoted value
  'git --git-dir=/x commit',
  'git --git-dir /x commit',                     // --git-dir space form (consumes arg)
  '/usr/bin/git commit',                         // full path to git
  // env-assignment prefixes (incl. quoted values containing spaces)
  "GIT_AUTHOR_DATE='2020-01-01' git commit -m x",
  'GIT_AUTHOR_DATE="2020-01-01 12:00:00" git commit',
  'env GIT_AUTHOR_DATE="x y" git commit',
  'env -i git commit',
  // wrapper commands with their own options (arity not modelled — program is scanned for)
  'nice -n 10 git commit',
  'sudo -E git commit',
  'time -p git commit',
  'timeout 5 git commit',
  'command git commit',
  'nohup git commit',
  'env --chdir /tmp git commit',                 // long option with separate arg
  'timeout --signal KILL 5 git commit',
  'ionice -c 2 -n 7 git commit',
  'nice --adjustment 10 git commit',
  'sudo --user root git commit',
  // path-qualified wrappers (matched by basename)
  '/usr/bin/env git commit',
  '/usr/bin/time -p git commit',
  '/usr/bin/nice -n 10 git commit',
  'exec git commit',                             // exec replaces the shell with git commit
  'exec -a name git commit',
  // subshell / group / reserved words
  '(git commit)',
  '{ git commit; }',
  'echo a && (cd d && git commit)',
  'if git commit -m x; then echo ok; fi',
  'if true; then git commit; fi',
  '! git commit',
  // bash -c / sh -c variants (recursion)
  "bash -c 'git commit -m x'",
  'sh -c "git add -A && git commit"',
  'bash -lc "git commit"',
  'bash --noprofile -c "git commit"',
  "sh -ec 'git commit'",
  '/bin/bash -c "git commit"',
  "bash -o pipefail -c 'git commit'",            // shell option with separate arg before -c
  "bash -O extglob -c 'git commit'",
  // git global option with a separate argument
  'git --config-env user.name=GIT_AUTHOR_NAME commit',
  // real commit AFTER a (hyphenated-delimiter) heredoc body is closed
  'cat <<END-MSG\nbody\nEND-MSG\ngit commit',
  'bash -c "git commit" # trailing comment',     // comment after the wrapped command
  'bash -c \'bash -c "git commit"\'',            // 2-level nesting
];

// --- Should NOT detect (false) ---
const SKIP = [
  // non-commit git subcommands that merely contain the word "commit" (original bug2)
  'git log --grep commit',
  'git log --grep=commit',
  'git checkout feature/commit-x',
  'git diff main..my-commit',
  'git show HEAD --stat',
  'git branch commit-x',
  'git rev-parse HEAD^{commit}',
  // sibling subcommands whose name merely starts with "commit"
  'git commit-graph write',
  'git commit-tree abc123',
  'git config commit.gpgsign true',
  'git config --get commit.template',
  // terminal/informational git global options short-circuit before any subcommand
  'git --help commit',
  'git --version commit',
  // wrapper terminal options print help/version and never exec git
  'env --help git commit',
  'nice --help git commit',
  'timeout --version git commit',
  // quoted data, not an invocation
  "grep -r 'git commit' .",
  'echo "git commit"',
  'cat commit.txt',
  // commented-out / heredoc-body text must not fire (false-positive regression guard)
  'git status # ; git commit',
  'cat <<EOF\ngit commit\nEOF',
  'ssh host <<EOF\ngit commit\nEOF',
  "cat <<'END-MSG'\ngit commit\nEND-MSG",          // hyphenated quoted heredoc delimiter
  'cat <<"X-Y"\ngit commit\nX-Y',
  // other non-commit commands
  'git status',
  'git push',
  'npm run commit',
  'echo committing && git status',
  'git log --oneline | grep commit',
  'bash -c "git log"',
  'gitfoo commit',
  '',
  '   ',
  // known/accepted gaps: NOT detected — exotic, outside the (non-adversarial) agent
  // threat model; documented in the module header and pinned here so the behavior is
  // intentional rather than a silent oversight.
  '$(echo git) commit',                            // commit inside command substitution
  'echo "$(git commit)"',
  "env -S 'git commit -m x'",                      // env split-string exec
  'case x in x) git commit;; esac',                // case-pattern body
  // sequencer continuations CREATE commits but are deliberately out of scope for a
  // main-centered workflow (squash-merge PRs; sequencers ~unused) — see module header.
  'git merge --continue',
  'git cherry-pick --continue',
  'git revert --continue',
  'git rebase --continue',
];

test('detects real git commit invocations', () => {
  for (const cmd of DETECT) {
    assert.equal(isGitCommit(cmd), true, `expected DETECT: ${JSON.stringify(cmd)}`);
  }
});

test('does not fire on non-commit / commented / heredoc / quoted commands', () => {
  for (const cmd of SKIP) {
    assert.equal(isGitCommit(cmd), false, `expected SKIP: ${JSON.stringify(cmd)}`);
  }
});

test('CRLF input: heredoc drain matches the terminator (fail-open regression)', () => {
  // CRLF slices each heredoc body line as "...\r"; the drain must strip it or the
  // terminator never matches and everything after the heredoc — a real trailing
  // `git commit` included — is swallowed.
  assert.equal(isGitCommit("cat <<'EOF'\r\ntext\r\nEOF\r\ngit commit -m x\r\n"), true);
  assert.equal(isGitCommit('cat <<EOF\r\ntext\r\nEOF\r\ngit commit -m x\r\n'), true);   // bareword delim
  assert.equal(isGitCommit('cat <<-EOF\r\n\ttext\r\n\tEOF\r\ngit commit -m x'), true); // <<- strip mode
  // ...while heredoc-BODY text still must not fire under CRLF (false-positive guard).
  assert.equal(isGitCommit("cat <<'EOF'\r\ngit commit\r\nEOF\r\n"), false);
});

test('LF input: CR-bearing body lines stay DATA (no early termination)', () => {
  // Under LF input bash strips nothing: a stray "EOF\r" body line is data, NOT the
  // terminator. Stripping CRs there would terminate the drain early and mis-expose
  // body text as live commands — here a quote character that swallows the real
  // terminator and the trailing commit (adversarial-review regression, round 2).
  assert.equal(isGitCommit("cat <<EOF\nEOF\r\n'\nEOF\ngit commit -m real\n"), true);
  // A quoted delimiter may contain a literal CR; only the raw comparison matches it.
  assert.equal(isGitCommit('cat <<"EOF\r"\nbody\nEOF\r\ngit commit -m after\n'), true);
});

test('mixed line endings: the delimiter carries the CR, like bash (round-3 pins)', () => {
  // CRLF opener -> bash's delimiter word is "EOF\r" (CR is a word char, not
  // whitespace). An LF-only "EOF" body line is therefore DATA — terminating early
  // on it would mis-expose a quote that swallows the real trailing commit.
  assert.equal(isGitCommit(": <<EOF\r\nEOF\n'\nEOF\r\ngit commit -m real\r\n"), true);
  assert.equal(isGitCommit(": <<'EOF'\r\nEOF\n'\nEOF\r\ngit commit -m real\r\n"), true);
  // Multiple CRs are all part of the delimiter word ("EOF\r\r").
  assert.equal(isGitCommit(': <<EOF\r\r\nbody\r\nEOF\r\r\ngit commit -m x\r\n'), true);
  // Multiple heredocs on one line: each delimiter keeps its own trailing CRs
  // (A is space-terminated -> "A"; B is line-terminated -> "B\r").
  assert.equal(isGitCommit(": <<A <<B\r\nA\nB\n'\nB\r\ngit commit -m real\r\n"), true);
});

// Build N levels of valid nested `bash -c "<inner>"` (escape \ and " each level).
function nest(inner, levels) {
  let cmd = inner;
  for (let i = 0; i < levels; i++) {
    cmd = `bash -c "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return cmd;
}

test('fails closed on pathologically deep bash -c nesting', () => {
  // A shallow nest is parsed exactly: a non-commit core stays non-commit.
  assert.equal(isGitCommit(nest('git log', 2)), false, 'shallow nest descends correctly');
  // Past MAX_DEPTH the recursion can no longer prove the inner is harmless, so the
  // gate must fail CLOSED (treat as a commit), never silently allow.
  assert.equal(isGitCommit(nest('git commit', 8)), true, 'deep commit nest detected');
  assert.equal(isGitCommit(nest('git log', 8)), true, 'deep nest fails closed even for a non-commit core');
});

test('handles non-string input safely', () => {
  assert.equal(isGitCommit(undefined), false);
  assert.equal(isGitCommit(null), false);
  assert.equal(isGitCommit(123), false);
});

// --- parseCommitForm: classify a commit's effective-content form ------------
// Drives the review-gate's effective-content hashing. The contract is fail-closed:
// ONLY a plain commit ({verifiable:true,all:false} -> hash `git diff --cached`) or a
// -a/--all commit ({verifiable:true,all:true} -> hash `git diff HEAD`) is verifiable;
// every other form must be {verifiable:false} so the gate cannot fail OPEN on a
// wrong-but-confident guess. The exotic-form cases below were all surfaced by
// adversarial review (codex + code-reviewer) as fail-open or self-commit regressions.

const PLAIN = { verifiable: true, all: false };
const ALL = { verifiable: true, all: true };

test('plain commit -> { all:false } (hash --cached)', () => {
  for (const cmd of ['git commit', 'git commit -m x', 'git commit -m "a; b | c"',
                     'git commit -F - ', 'git commit --message=hi', 'git commit -q -s',
                     'git commit --gpg-sign -m x', 'git commit --allow-empty -m x']) {
    assert.deepEqual(parseCommitForm(cmd), PLAIN, cmd);
  }
});

test('-a / --all -> { all:true } (incl. bundled -am and add&&commit)', () => {
  for (const cmd of ['git commit -a', 'git commit -am x', 'git commit -a -m x',
                     'git commit --all -m x', 'git add -A && git commit -am "msg"']) {
    assert.deepEqual(parseCommitForm(cmd), ALL, cmd);
  }
});

test('option VALUES are never mistaken for pathspecs', () => {
  // The message/value after -m / -am / -F must not become a (blocking) pathspec.
  assert.deepEqual(parseCommitForm('git commit -am "feat: x"'), ALL);
  assert.deepEqual(parseCommitForm('git commit -m"glued"'), PLAIN);
  assert.deepEqual(parseCommitForm('git commit -F msg.txt'), PLAIN);
});

test('pathspec commits -> verifiable:false (cwd-relative + shell-fragile -> fail-closed)', () => {
  for (const cmd of ['git commit -m x file.ts', 'git commit -- a.ts b.ts',
                     'git commit --only -m x src/', 'git commit -m x "src/has space.ts"',
                     'git commit -m x src/esc\\ aped.ts']) {  // escaped space splits -> still a pathspec
    assert.equal(parseCommitForm(cmd).verifiable, false, cmd);
  }
});

test('git option ABBREVIATIONS of unverifiable forms still fail closed (prefix rule)', () => {
  // git resolves any unambiguous prefix to the full option; exact-match would fail OPEN.
  for (const cmd of ['git commit --amen -m x', 'git commit --ame -m x', 'git commit --am -m x',
                     'git commit --inc foo.ts', 'git commit --incl foo.ts',
                     'git commit --interac', 'git commit --pathspec-from-fi=l.txt']) {
    assert.equal(parseCommitForm(cmd).verifiable, false, cmd);
  }
});

test('hashing-defeating forms (canonical) -> verifiable:false', () => {
  for (const cmd of ['git commit --amend', 'git commit --amend --no-edit', 'git commit -a --amend',
                     'git commit --include foo.ts', 'git commit -i foo.ts', 'git commit -p',
                     'git commit --interactive', 'git commit --patch -m x',
                     'git commit --pathspec-from-file=list.txt']) {
    assert.equal(parseCommitForm(cmd).verifiable, false, cmd);
  }
});

test('bash -c siblings / >1 commit per line -> verifiable:false (no fail-open)', () => {
  assert.equal(parseCommitForm('bash -c "git commit -am x"').verifiable, false);
  assert.equal(parseCommitForm('git commit -m a && git commit -m b').verifiable, false);
  // A direct commit beside a wrapped one must NOT be confidently classified.
  assert.equal(parseCommitForm("git commit -m reviewed && bash -c 'git commit -am leak'").verifiable, false);
});

test('repo/worktree-redirecting globals -> verifiable:false (wrong-tree hash)', () => {
  assert.equal(parseCommitForm('git -C /repo commit -m x').verifiable, false);
  assert.equal(parseCommitForm('git --git-dir=/x commit -m x').verifiable, false);
  assert.equal(parseCommitForm('git --work-tree /w commit -am x').verifiable, false);
});

test('plain shell redirections / heredocs are dropped, not read as pathspecs', () => {
  // Critical: protects the repo self-commit form and plain commits with redirections.
  assert.deepEqual(parseCommitForm('git commit -m x >out'), PLAIN);
  assert.deepEqual(parseCommitForm('git commit -m x >> log.txt'), PLAIN);
  assert.deepEqual(parseCommitForm('git commit -F - < msg.txt'), PLAIN);
  assert.deepEqual(parseCommitForm("git commit -F - <<'MSG'\nbody line\nMSG"), PLAIN);
  assert.deepEqual(parseCommitForm('git commit -am x > out'), ALL);
  // CRLF variants: same classification as LF (was: the unmatched terminator swallowed
  // a second commit, leaving a single-commit PLAIN verdict for a two-commit line).
  assert.deepEqual(parseCommitForm("git commit -F - <<'MSG'\r\nbody line\r\nMSG\r\n"), PLAIN);
  assert.equal(parseCommitForm("git commit -F - <<'MSG'\r\nbody\r\nMSG\r\ngit commit -a -m real").verifiable, false);
});

test('&-bearing redirections (2>&1, >&2, &>x) -> verifiable:false (segment-split fail-open)', () => {
  // lexSegments splits on the lone `&`, which would hide a trailing -a -> fail closed.
  for (const cmd of ['git commit 2>&1 -a -m x', 'git commit >&2 -a -m x',
                     'git commit 1>&2 -a -m x', 'git commit &>/dev/null -a -m x',
                     'git commit -am x >/dev/null 2>&1', 'git commit -m x 2>&1']) {
    assert.equal(parseCommitForm(cmd).verifiable, false, cmd);
  }
  // ...but a quoted & (inside the message) is data, not a redirection.
  assert.deepEqual(parseCommitForm('git commit -am "fixed 2>&1 bug"'), ALL);
});

test('repo/index/worktree redirection via env or -c config -> verifiable:false', () => {
  for (const cmd of ['GIT_DIR=/other/.git git commit -m x',
                     'GIT_WORK_TREE=/w GIT_DIR=/g git commit -am x',
                     'GIT_INDEX_FILE=/alt.idx git commit -m x',
                     'env GIT_DIR=/g git commit -m x',
                     'git -c core.worktree=/other commit -am x',
                     'git --config-env=core.worktree=WT commit -m x']) {
    assert.equal(parseCommitForm(cmd).verifiable, false, cmd);
  }
  // A benign -c key (not repo-locating) stays verifiable.
  assert.deepEqual(parseCommitForm('git -c user.name=A commit -m x'), PLAIN);
});

test('optional glued-value short flags (-S/-u) are not read as -a; --no-all cancels', () => {
  assert.deepEqual(parseCommitForm('git commit -Sakey -m x'), PLAIN);   // -S<keyid>, not --all
  assert.deepEqual(parseCommitForm('git commit -uall -m x'), PLAIN);    // -u<mode>
  assert.deepEqual(parseCommitForm('git commit -a --no-all -m x'), PLAIN);
});

test('non-commit / non-string -> verifiable:false', () => {
  assert.equal(parseCommitForm('git log --grep commit').verifiable, false);
  assert.equal(parseCommitForm('git status').verifiable, false);
  assert.equal(parseCommitForm(undefined).verifiable, false);
  assert.equal(parseCommitForm(123).verifiable, false);
});

test('wrappers before a direct git commit are seen through', () => {
  assert.deepEqual(parseCommitForm('sudo git commit -am x'), ALL);
  assert.deepEqual(parseCommitForm('env FOO=1 git commit -m x'), PLAIN);
});

// --- isWipCommit: a wip:/[wip] marker in the -m/--message text ---------------
// Drives the acceptance-gate's in-progress bypass. Best-effort over -m forms;
// a message via -F/heredoc is not inspected (-> false).

test('isWipCommit: true for a wip:/[wip] marker across -m forms', () => {
  for (const cmd of ['git commit -m "wip: partway"', 'git commit -m "WIP foo"',
                     'git commit -m "wip(scope): x"', 'git commit -am "[wip] checkpoint"',
                     'git commit -mwip:glued', 'git commit -m "feat" -m "wip: body"',
                     'git add -A && git commit -m "wip: x"', 'git commit --message="[WIP] x"']) {
    assert.equal(isWipCommit(cmd), true, cmd);
  }
});

test('isWipCommit: false for non-wip messages and uninspectable forms', () => {
  for (const cmd of ['git commit -m "feat: done"', 'git commit -m "wiping the cache"',
                     'git commit -m "fix wip handling later"', 'git commit -F msg.txt',
                     "git commit -F - <<'MSG'\nwip: x\nMSG", 'git status', '']) {
    assert.equal(isWipCommit(cmd), false, cmd);
  }
  assert.equal(isWipCommit(undefined), false);
  assert.equal(isWipCommit(123), false);
});

test('isWipCommit: scoped to the commit segment — no whole-line false-positives', () => {
  // a `wip` -m OUTSIDE the actual commit must NOT bypass:
  assert.equal(isWipCommit('git commit -m "feat: real" # -m "wip: x"'), false);    // comment dropped
  assert.equal(isWipCommit('grep -m "wip: x" file && git commit -m "feat: real"'), false); // sibling -m
  assert.equal(isWipCommit('git commit -m "wip: x" && git commit -m "feat: real"'), false); // a non-wip commit present
  assert.equal(isWipCommit("bash -c \"git commit -m 'wip: x'\""), false);          // unreadable (bash -c) -> don't bypass
  // multi-commit where EVERY commit is wip -> bypass:
  assert.equal(isWipCommit('git commit -m "wip: a" && git commit -m "wip: b"'), true);
});


// --- commitTargetDir (index.ts HEAD snapshot; #22 / #48-6) -------------------------
// The repo whose HEAD a commit moves: plain -> base, -C -> resolved (chained like git),
// bash -c recursed; null whenever the target cannot be trusted (cwd shift, substitution,
// --git-dir/--work-tree/GIT_DIR=, two repos in one line) — the caller then falls back to
// the exit code instead of snapshotting the wrong HEAD.

test('commitTargetDir: plain commit -> base dir; -C resolves relative to base and chains', () => {
  assert.equal(commitTargetDir('git commit -m x', '/base'), '/base');
  assert.equal(commitTargetDir('git add . && git commit -m x', '/base'), '/base');
  assert.equal(commitTargetDir('git commit -m "fix: cd into dir"', '/base'), '/base', 'a quoted message is one token — no over-match');
  assert.equal(commitTargetDir('git -C ../other commit -m x', '/base/repo'), '/base/other');
  assert.equal(commitTargetDir('git -C /abs commit', '/base'), '/abs');
  assert.equal(commitTargetDir('git -C a -C b commit', '/base'), '/base/a/b');
  assert.equal(commitTargetDir('git -C "/with space" commit', '/base'), '/with space');
  assert.equal(commitTargetDir("bash -c 'git -C /r commit -m x'", '/base'), '/r');
  assert.equal(commitTargetDir('git -C /a commit -m a && git -C /a commit --amend', '/base'), '/a');
});

test('commitTargetDir: null when the target repo cannot be trusted or there is no commit', () => {
  for (const cmd of ['cd other && git commit -m x', 'pushd x && git commit', 'git -C $(pwd) commit',
                     'git --git-dir=/x commit', 'git --work-tree /x commit', 'GIT_DIR=/x git commit',
                     'git -c core.worktree=/x commit', 'git -C /a commit && git -C /b commit',
                     // review round 1 (#48 cycle ①): values the shell would still expand, and cwd
                     // shifters hidden behind wrappers / builtins / exported retargeting.
                     'git -C ~/repo commit', 'git -C $REPO commit', 'git -C "$REPO" commit', 'git -C "$(pwd)" commit',
                     'git -C /tmp/r* commit', 'for d in a b; do git -C $d commit; done',
                     'command cd x && git commit', 'builtin cd x; git commit', 'eval "cd x" && git commit',
                     'source env.sh && git commit', '. env.sh && git commit', 'env -C /x git commit', 'env --chdir=/x git commit',
                     'export GIT_DIR=/x && git commit',
                     // review round 2: builtin runners around source/., attached/abbreviated env chdir,
                     // wrapper chdir behind an earlier candidate, brace expansion.
                     'command source e.sh && git commit', 'builtin . e.sh && git commit', 'command . e.sh; git commit',
                     'env -C/x git commit', 'env --chd=/x git commit', 'sudo -u git env -C /o git commit', 'git -C /tmp/r{1..1} commit',
                     'sudo -D /x git commit', 'sudo -D/x git commit',
                     'ls -la', 'git status', '']) {
    assert.equal(commitTargetDir(cmd, '/base'), null, cmd);
  }
  assert.equal(commitTargetDir('git commit', ''), null);
  assert.equal(commitTargetDir(undefined, '/base'), null);
});

test('commitTargetDir: -C chaining follows symlinks like git chdir (physical, not lexical)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctd-'));
  try {
    mkdirSync(join(root, 'A'));
    mkdirSync(join(root, 'B'));
    symlinkSync(join(root, 'B'), join(root, 'A', 'link'));
    // git -C A/link -C .. lands in B's parent (root), not A (the lexical parent of A/link).
    assert.equal(commitTargetDir('git -C A/link -C .. commit', root), realpathSync(root));
    assert.equal(commitTargetDir('git -C A/link commit', root), realpathSync(join(root, 'B')));
    // Same within ONE value: `link/..` is the parent of the link TARGET (round 2, C2) — a lexical
    // resolve() would collapse it to A before any symlink is seen.
    assert.equal(commitTargetDir('git -C A/link/.. commit', root), realpathSync(root));
    // And a symlinked BASE: from A/link (=B) `-C ..` is root, not A.
    assert.equal(commitTargetDir('git -C .. commit', join(root, 'A', 'link')), realpathSync(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
