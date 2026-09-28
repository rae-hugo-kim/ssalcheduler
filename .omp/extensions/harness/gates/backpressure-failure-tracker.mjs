#!/usr/bin/env node
// backpressure-failure-tracker.mjs - PostToolUseFailure hook for Bash
// Purpose: when a build/test/lint command FAILS, record status=FAIL +
// backpressure-last-fail so backpressure-gate blocks commits on red.
//
// Why a separate hook: Claude Code fires PostToolUse only when a Bash command
// SUCCEEDS; a non-zero exit routes to PostToolUseFailure instead. So the
// success-path tracker (backpressure-tracker.mjs) can never observe a failing
// verification run — without this hook a failed test leaves a stale PASS and
// the commit gate would wrongly allow the commit.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { classifyVerification } from './backpressure-patterns.mjs';

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
  appendFileSync(logFile, `[${new Date().toISOString()}] backpressure-failure-tracker: ${msg}\n`);
}

const command = data?.tool_input?.command || '';
// Failure capture is liberal: any matched verification segment -> FAIL
// (over-blocking on a chained `verify && other` failure is fail-safe).
const { isVerification, type } = classifyVerification(command, cwd);
log(`Command: ${command}`);
log(`Is verification: ${isVerification}, type: ${type}`);

if (isVerification) {
  const statusFile = join(stateDir, 'backpressure-status');
  const failFile = join(stateDir, 'backpressure-last-fail');
  const short = command.length > 80 ? command.substring(0, 80) + '...' : command;

  writeFileSync(statusFile, 'FAIL');
  writeFileSync(failFile, `${type}: ${short}`);
  log(`Recorded FAIL (${type}): ${short}`);
}

process.exit(0);
