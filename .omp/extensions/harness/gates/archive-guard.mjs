#!/usr/bin/env node
// archive-guard.mjs - commit-time guard for LOCAL ARCHIVE paths (docs/sum, docs/reviews,
// docs/brainstorming). Policy: session narratives never live in project repos — they stay
// untracked locally and are backed up to the private sum-vault (.omp/rules/harness-doc_standards.md).
//
// Dispatched by commit-gates.mjs on a real `git commit` (4th child). Independently runnable.
//   - STAGED archive file -> BLOCK (exit 2): the commit would ingest a narrative.
//   - `-a` commit + a tracked archive file with unstaged modifications -> BLOCK: -a would
//     sweep it into the commit even though nothing was staged by hand.
//   - tracked archive files exist (but not in this commit) -> WARN (exit 0) with cleanup
//     guidance; the push boundary (pre-push hook, compush/compr pre-push checks) is the
//     backstop that keeps legacy-tracked files off the remote.
// Fail-open on git/infra errors: a broken guard must never block commits (exit 0).

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { isGitCommit, parseCommitForm } from './git-commit-detect.mjs';

const ARCHIVE_DIRS = ['docs/sum', 'docs/reviews', 'docs/brainstorming'];

let stdin = '';
try { stdin = readFileSync(0, 'utf-8'); } catch { /* no stdin is fine */ }

let data = {};
try { data = JSON.parse(stdin); } catch { process.exit(0); }

const command = data?.tool_input?.command || '';
// Hook mode (AC6): spawned by the pre-commit dispatcher — no command string; the hook
// firing is the commit. The synthetic form is staged-only: at pre-commit time git has
// already materialized -a/pathspec into the (inherited) temporary index, so staged IS
// the commit content and the tracked-but-unstaged sweep set is empty by construction.
const isHookMode = data?.mode === 'hook';
if (!isHookMode && !isGitCommit(command)) process.exit(0);

const cwd = data?.session_state?.cwd || process.cwd();
// -z (NUL-delimited) output: git does NOT c-quote non-ASCII paths in -z mode, so a
// Korean-named narrative (`docs/sum/세션_요약.md`) matches the prefix check — with the
// default core.quotePath the path arrives as `"docs/sum/\354\204\270..."` and slips past
// startsWith (reviewer finding, live-verified).
const gitz = (args) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
    .split('\0')
    .filter(Boolean);

const inArchive = (p) => ARCHIVE_DIRS.some((d) => p === d || p.startsWith(`${d}/`));

let staged = [];
let tracked = [];
let unstagedModified = [];
try {
  // --diff-filter=d EXCLUDES deletions: removing an archive from tracking is the
  // remediation this guard itself prescribes (`git rm -r --cached …` + commit) — the
  // cleanup commit must never be blocked. Renaming OUT of a guarded dir (content
  // escape) is an accepted residual: a path policy cannot trace content, and `cp` to
  // any unguarded path was always possible.
  staged = gitz(['diff', '--cached', '--name-only', '--diff-filter=d', '-z']).filter(inArchive);
  tracked = gitz(['ls-files', '-z', ...ARCHIVE_DIRS]);
  unstagedModified = gitz(['diff', '--name-only', '--diff-filter=d', '-z', '--', ...ARCHIVE_DIRS]);
} catch {
  process.exit(0); // fail-open: cannot assess -> never block
}

// `git commit -a` also captures tracked-but-unstaged modifications. UNVERIFIABLE forms
// (pathspec `git commit docs/sum/x.md`, --amend, --include, bash -c wrappers, …) may
// capture them too and we cannot prove exclusion — so a MODIFIED tracked archive file
// blocks those forms as well. Unmodified legacy-tracked files stay a WARN (below); the
// push boundary is their backstop, and blocking every --amend in a legacy repo would be
// hostile without adding safety.
const form = isHookMode
  ? { all: false, verifiable: true }
  : parseCommitForm(command);
const modifiedTracked = unstagedModified.filter((p) => tracked.includes(p));
const swept = (form?.all || form?.verifiable === false) ? modifiedTracked : [];

if (staged.length || swept.length) {
  const offenders = [...new Set([...staged, ...swept])].slice(0, 10);
  console.error(
    `HARNESS BLOCK: local archive files would enter this commit:\n` +
      offenders.map((p) => `  - ${p}`).join('\n') +
      `\nSession narratives are untracked by policy (backup lives in the private sum-vault).` +
      `\nUnstage: git restore --staged ${ARCHIVE_DIRS.join(' ')}` +
      `\nThen ensure .gitignore covers: ${ARCHIVE_DIRS.map((d) => `${d}/`).join(' ')}`,
  );
  process.exit(2);
}

if (tracked.length) {
  console.error(
    `HARNESS WARNING: ${tracked.length} archive file(s) are TRACKED in git (legacy). ` +
      `They will be blocked at push. Clean up: git rm -r --cached ${ARCHIVE_DIRS.join(' ')} ` +
      `&& add them to .gitignore; narratives are backed up in sum-vault.`,
  );
}

process.exit(0);
