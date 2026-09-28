#!/usr/bin/env node
// backpressure-tracker.mjs - PostToolUse hook for Bash
// Purpose: Track build/test/lint results (for backpressure-gate)

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, appendFileSync } from 'fs';
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
const historyFile = join(stateDir, 'test-history.json');

function log(msg) {
  if (!process.env.HARNESS_DEBUG) return;
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `[${timestamp}] backpressure-tracker: ${msg}\n`);
}

log('Hook started');

const command = data?.tool_input?.command || '';
log(`Command: ${command}`);

// Classify via the shared leading-token matcher (backpressure-patterns.mjs),
// which only matches a verification command at the start of a shell segment —
// not `echo "npm test"` or `grep -r "npm test"`.
const { isVerification, type: verificationType, passReliable } = classifyVerification(command, cwd);

log(`Is verification: ${isVerification}, type: ${verificationType}, passReliable: ${passReliable}`);

// Only record PASS when the verification command controls the overall exit
// (passReliable). A piped / `|| true` / `;`-chained success can mask a real
// failure, so skip rather than record a false PASS that would clear protection.
if (isVerification && !passReliable) {
  log('Verification matched but exit unreliable (piped / || / ;), not recording PASS');
}

if (isVerification && passReliable) {
  const statusFile = join(stateDir, 'backpressure-status');
  const now = new Date();
  const timeStr = now.toTimeString().substring(0, 5);

  let history = { runs: [] };
  if (existsSync(historyFile)) {
    try {
      history = JSON.parse(readFileSync(historyFile, 'utf-8'));
    } catch {
      history = { runs: [] };
    }
  }

  // PostToolUse fires only on success; a failing verification run routes to
  // PostToolUseFailure (handled by backpressure-failure-tracker.mjs). So
  // reaching here means the command's overall shell exit was 0 -> PASS.
  const run = {
    time: timeStr,
    type: verificationType,
    cmd: command.length > 50 ? command.substring(0, 50) + '...' : command,
    result: 'PASS'
  };

  history.runs.push(run);
  history.lastResult = 'PASS';
  history.lastTime = now.toISOString();

  writeFileSync(historyFile, JSON.stringify(history, null, 2));
  writeFileSync(statusFile, 'PASS');
  try { unlinkSync(join(stateDir, 'backpressure-last-fail')); } catch {}

  log(`Added to history: ${JSON.stringify(run)}`);
}

process.exit(0);
