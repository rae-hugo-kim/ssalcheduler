#!/usr/bin/env node
// commit-gates.mjs — HOOK-MODE dispatcher for the commit gates.
//
// Invoked by .githooks/pre-commit from inside the repo being committed to, with
//   {"mode":"hook","hook":"pre-commit"}
// on stdin. It runs every registered gate against that repo's STAGED INDEX and
// renders one verdict: exit 2 if any gate blocks, else exit 0.
//
// Why there is no command parsing here any more (seed 20260729-132948-e510, AC3):
// this used to be a PreToolUse:Bash dispatcher that had to decide, from a shell
// command string, whether a commit was about to happen and which repo it would
// land in. Six adversarial review rounds showed that decision cannot be made
// safely at the string layer — every closed spelling reopened as an equivalent one
// (`env --split-strin`, `setsid --fo`, `"$TOOL" commit`, `git -c alias.c=commit c`).
// The hook removes the question: git runs it only for real commits, only in the
// real target repo, for every spelling and every author. The command layer keeps
// just a bypass tripwire (commitBypassTripwire in git-commit-detect.mjs).
//
// Environment: git exports GIT_INDEX_FILE / GIT_PREFIX to hooks (measured: GIT_DIR is NOT set
// for pre-commit), and for `commit -a` and pathspec commits GIT_INDEX_FILE names the TEMPORARY
// index holding exactly what the commit will capture. Children inherit this environment untouched
// so `git diff --cached` sees the real commit content — sanitizing it would make
// -a/partial commits look empty (measured: test-attack A-2).
//
// Fail-closed: a gate that crashes, times out, or dies to a signal BLOCKS. A gate
// that cannot render a verdict must never be treated as passing (owner decision,
// 3rd adversarial review 2026-07-22).
//
// All gates run (rather than stopping at the first block) so every gate consumes its
// own one-shot flag deterministically and all diagnostics surface in one pass.

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const raw = readFileSync(0, 'utf-8');

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error('HARNESS WARNING: commit-gates received invalid JSON on stdin; nothing to gate.');
  process.exit(0);
}

if (data?.mode !== 'hook') {
  // The PreToolUse command path was retired with AC3: enforcement is .githooks/pre-commit.
  // A stale caller gets a no-op here (the hook still gates the actual commit).
  console.error('HARNESS WARNING: commit-gates now runs in hook mode only (payload {"mode":"hook"}); the command-layer path was retired — enforcement is .githooks/pre-commit.');
  process.exit(0);
}

const cwd = data?.session_state?.cwd || process.cwd();
const here = dirname(fileURLToPath(import.meta.url));
const GATES = ['acceptance-gate.mjs', 'backpressure-gate.mjs', 'review-gate.mjs', 'archive-guard.mjs'];

// NO amend special-casing. git gives hooks no amend flag, and the only observable shape
// ("nothing staged while a parent exists") is shared by `--allow-empty`, a plain commit with
// an empty index, and a merge conflict resolved to HEAD's tree — a first attempt at inferring
// amend from it re-judged the PREVIOUS commit's content and blocked all three (measured,
// 3-pass review round 2), while still missing an amend that stages a delta and an amend of a
// root commit. The contract is therefore simple and uniform: the gates judge what THIS commit
// adds relative to HEAD (the staged index). Content already in HEAD is out of scope, including
// under --amend — an enumerated residual in .omp/rules/harness-harness_integration_contract.md.
const childPayload = raw;

// Per-child budget. The hook adds an outer `timeout` belt where available, but the
// hard ceiling lives here: SIGKILL is deliberate — with SIGTERM a child can catch
// termination and report exit 0 after the timeout (status 0 + error ETIMEDOUT).
const CHILD_TIMEOUT_MS = 3000;

// A verdict token and its deferred-consumption intents belong to ONE attempt. Clearing both
// at the start of every run (and never writing a token on BLOCK) is what stops (a) an intent
// from a BLOCKED attempt being replayed by a later commit and (b) a leftover ALLOW token from
// laundering a later ungated commit — including the case where the SAME tree is re-attempted
// and blocked, which a tree-only binding could not distinguish (3-pass review round 2).
const stateDir = join(cwd, '.omp', 'harness-state');
const pendingDir = join(stateDir, 'pending-consume');
const tokenPath = join(stateDir, 'gated-commit-token');
// Returns true when BOTH surfaces are provably gone. A silent failure here is how a stale ALLOW
// token survives a BLOCK, and how a stale INTENT gets replayed into audit.jsonl by every later
// commit (measured in review round 4 with a read-only pending-consume directory).
function clearAttemptState() {
  try { rmSync(pendingDir, { recursive: true, force: true }); } catch { /* reported below */ }
  try { rmSync(tokenPath, { force: true }); } catch { /* reported below */ }
  const stale = [];
  if (existsSync(tokenPath)) stale.push(tokenPath);
  if (existsSync(pendingDir)) stale.push(pendingDir);
  const dirtyMarker = join(stateDir, 'attempt-state-dirty');
  if (stale.length === 0) {
    try { rmSync(dirtyMarker, { force: true }); } catch { /* advisory only */ }
    return true;
  }
  // The marker is a courtesy for the backstop, and the condition that makes cleanup fail (an
  // unwritable state dir) can make the marker unwritable too — so it is NEVER the protection.
  // The protection is the caller refusing to issue a verdict token at all (review round 5, M1).
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(dirtyMarker, `${stale.join('\n')}\n`);
  } catch { /* advisory only */ }
  console.error(`HARNESS WARNING: could not clear stale harness state (${stale.join(', ')}). No verdict token will be issued for this commit — it will be reported as ungated, and deferred one-shot flags stay unconsumed until you remove those paths.`);
  return false;
}

// This attempt owns its state: anything an earlier (aborted or blocked) attempt left behind is
// cleared before the gates run — pinned by P4. If it cannot be cleared, this attempt must not be
// able to issue an approval at all (review round 5, M1).
const stateWasCleared = clearAttemptState();

let blocked = false;
for (const gate of GATES) {
  const r = spawnSync(process.execPath, [join(here, gate)], {
    input: childPayload,
    cwd,
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 2) {
    blocked = true;
    // The hook has no structured channel back to the agent, so the gate identity and
    // the "do not retry" signal go on stderr (test-attack C-3: an opaque failure invites
    // a retry loop).
    console.error(`HARNESS BLOCK [${gate}]: this gate blocked the commit — fix the cause above; do NOT retry the same commit (the verdict is deterministic).`);
  } else if (r.status === 0 && !r.error && !r.signal) {
    // Clean exit 0 is the ONLY allow result.
  } else {
    blocked = true;
    const why = r.error?.code || r.signal || `exit ${r.status}`;
    console.error(`HARNESS BLOCK [${gate}]: the gate did not run cleanly (${why}); failing closed — a gate that cannot render a verdict must not pass the commit.`);
    console.error(`Debug it standalone from the repo root: printf '{"mode":"hook","hook":"pre-commit"}' | node ${join(here, gate)}`);
  }
}

// Verdict token for the non-blocking backstop, bound to the ATTEMPT. It records the approved
// tree (`git write-tree` on the very index git will commit: the temporary one for -a/pathspec
// commits, inherited via GIT_INDEX_FILE) and the commit this attempt would sit on (HEAD).
// .githooks/post-commit consumes it only when the landed commit has that exact tree AND that
// exact parent. The parent axis is STRICT — an `--amend` (whose parent is HEAD's parent) and a
// sibling commit on the same base both carry content the gates never judged, and accepting
// them wrote audit lines for diffs that never landed (measured in review rounds 2 and 3).
// The `v2` line makes the format explicit so a legacy one-line token cannot read as valid.
// A write failure must never turn an allow into a block: on any failure NO token is written and
// the intents are dropped, so the backstop errs toward an extra advisory.
if (blocked) {
  // A gate may have written an intent before a LATER gate blocked: nothing this attempt
  // approved may survive it (pinned by P1 — mutation-verified in review round 2).
  clearAttemptState();
} else if (!stateWasCleared) {
  // Foreign intents may still be on disk and cannot be removed. Issuing a valid token here would
  // let the backstop execute them as if this attempt had approved them: an unwritable marker meant
  // the backstop's guard never armed, while the token file itself stayed writable (round 5, M1).
  console.error('HARNESS NOTE: the commit is allowed, but no verdict token was issued (harness state could not be cleared) — post-commit will report it as ungated and consume nothing.');
} else {
  try {
    const gitOut = (args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 2000, killSignal: 'SIGKILL' });
      return r.status === 0 && !r.error ? r.stdout.trim() : '';
    };
    const treeSha = gitOut(['write-tree']);
    if (/^[0-9a-f]{40,64}$/.test(treeSha)) {
      mkdirSync(stateDir, { recursive: true });
      const head = gitOut(['rev-parse', '-q', '--verify', 'HEAD']);
      writeFileSync(tokenPath, `v2\n${treeSha}\n${head}\n`);
    } else {
      clearAttemptState();
      console.error('HARNESS WARNING: could not bind the gate verdict to a tree object (git write-tree failed); the post-commit backstop will report this commit as ungated and deferred one-shot flags stay unconsumed.');
    }
  } catch { clearAttemptState(); }
}

process.exit(blocked ? 2 : 0);
