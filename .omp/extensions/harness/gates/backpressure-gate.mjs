#!/usr/bin/env node
// backpressure-gate.mjs - PreToolUse hook for Bash (git commit)
// Purpose: Block commits if build/test/lint not verified
// Risk-aware: docs-only changes skip test requirement
// Exit 0 = allow, Exit 2 = block

import { readFileSync, existsSync, appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { assessRisk } from './risk-assess.mjs';
import { isGitCommit, parseCommitForm } from './git-commit-detect.mjs';

const input = readFileSync(0, 'utf-8');

let data;
try {
  data = JSON.parse(input);
} catch (e) {
  console.error('HARNESS WARNING: Hook received invalid input, skipping check.');
  process.exit(0);
}

const cwd = data?.session_state?.cwd || process.cwd();
const stateDir = join(cwd, '.omp', 'harness-state');
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

const logFile = join(stateDir, 'hook-debug.log');

function log(msg) {
  if (!process.env.HARNESS_DEBUG) return;
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `[${timestamp}] backpressure-gate: ${msg}\n`);
}

log('Hook started');

const command = data?.tool_input?.command || '';
log(`Command: ${command}`);

// Hook mode (AC6): spawned by the pre-commit dispatcher — no command string; the hook
// firing is the commit, and the synthetic form pins risk to the staged index (--cached).
const isHookMode = data?.mode === 'hook';
if (!isHookMode && !isGitCommit(command)) {
  log('Not a git commit, allowing');
  process.exit(0);
}

log('Git commit detected, checking backpressure status');

// Scope risk to what the commit actually captures (staged-only for a plain commit,
// all tracked for -a), so unrelated unstaged edits don't force test-verification on a
// commit that won't include them. Unverifiable forms fall back to the conservative union.
const form = isHookMode
  ? { all: false, verifiable: true }
  : parseCommitForm(command);
const risk = assessRisk(cwd, form);
log(`Risk: ${risk.level} (${risk.reason})`);

if (risk.level === 'low' || risk.level === 'none') {
  log('Low/no risk (docs/config only), skipping test requirement');
  process.exit(0);
}

const skipFile = join(cwd, 'docs', 'harness', 'backpressure-skip');
if (existsSync(skipFile)) {
  if (isHookMode) {
    // Deferred consumption (test-attack B-4): the verdict may precede a commit that never
    // lands. Leave the flag; the post-commit backstop executes the intent.
    const pendDir = join(cwd, '.omp', 'harness-state', 'pending-consume');
    mkdirSync(pendDir, { recursive: true });
    writeFileSync(join(pendDir, 'unlink-backpressure-skip'), 'docs/harness/backpressure-skip\n');
    log('backpressure-skip flag found, allowing (consumption deferred to post-commit)');
  } else {
    log('backpressure-skip flag found, allowing');
    unlinkSync(skipFile);
  }
  process.exit(0);
}

// If risk could not be assessed (assessRisk returns 'unknown' when `git diff` throws), fail CLOSED:
// a safety gate must not let an unverified commit through when it cannot even gauge the risk. The
// skip flag above still overrides. (This also closes a pre-existing fail-open in both status paths.)
if (risk.level === 'unknown') {
  log('Risk assessment failed (git error), blocking conservatively');
  console.error('HARNESS BLOCK: Could not assess change risk (git error).');
  console.error('Run build/test/lint and ensure they pass (a project-specific runner can be registered in docs/harness/verify-commands.json), or create docs/harness/backpressure-skip to override.');
  process.exit(2);
}

const statusFile = join(stateDir, 'backpressure-status');

if (!existsSync(statusFile)) {
  if (risk.level === 'critical' || risk.level === 'high') {
    log('No status file + high risk, blocking');
    console.error('HARNESS BLOCK: No build/test verification for high-risk changes.');
    console.error('Run tests first (a project-specific runner can be registered in docs/harness/verify-commands.json — see .omp/rules/harness-harness_integration_contract.md §3), or create docs/harness/backpressure-skip to override.');
    process.exit(2);
  }
  log('No status file + medium risk, warning');
  console.error('HARNESS WARNING: No build/test verification recorded. Consider running tests.');
  process.exit(0);
}

const status = readFileSync(statusFile, 'utf-8').trim();
log(`Status: ${status}`);

if (status === 'PASS') {
  log('Status is PASS, allowing');
  process.exit(0);
}

if (status === 'UNKNOWN') {
  // UNKNOWN means a code edit reset the verification state — no positive verification, the same
  // situation as a missing status file above, so treat it symmetrically: block only high/critical
  // (where committing unverified code is dangerous), warn on medium (the only level that reaches
  // here — low/none and risk='unknown' already returned above).
  // (FAIL — handled below — is different: it is positive evidence of breakage and always blocks.)
  if (risk.level === 'critical' || risk.level === 'high') {
    log('Status UNKNOWN + high risk, blocking');
    console.error('HARNESS BLOCK: No build/test verification in this session for high-risk changes.');
    console.error('Run build/test/lint and ensure they pass (a project-specific runner can be registered in docs/harness/verify-commands.json), or create docs/harness/backpressure-skip to override.');
    process.exit(2);
  }
  log(`Status UNKNOWN + ${risk.level} risk, warning`);
  console.error('HARNESS WARNING: Verification is stale (code changed since the last run). Consider running tests.');
  process.exit(0);
}

const failFile = join(stateDir, 'backpressure-last-fail');
const lastFail = existsSync(failFile) ? readFileSync(failFile, 'utf-8').trim() : 'unknown';
log(`Status is not PASS, blocking. Last fail: ${lastFail}`);
console.error(`HARNESS BLOCK: Last verification failed: ${lastFail}`);
console.error('Run build/test/lint and ensure they pass before committing.');
process.exit(2);
