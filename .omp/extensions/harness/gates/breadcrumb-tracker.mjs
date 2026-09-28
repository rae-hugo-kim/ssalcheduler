#!/usr/bin/env node
// breadcrumb-tracker.mjs - tool_result hook (Bash | Write/Edit)
// Purpose (seed AC1, analysis Q1.5): append a low-cost, NO-LLM session breadcrumb so a
// later session (or a manual `sum`) can resume from "what happened" without re-deriving it.
// Records only signal-rich events — commits, verification PASS/FAIL, file edits — to an
// append-only `.omp/harness-state/session-log.jsonl`. Mirrors backpressure-tracker.
//
// This is NOT a blocking gate: it always exits 0. It records facts, never judges.

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { isGitCommit } from './git-commit-detect.mjs';
import { classifyVerification } from './backpressure-patterns.mjs';

let data;
try {
  data = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0); // never block on bad input
}

const cwd = data?.session_state?.cwd || process.cwd();
const tool = data?.tool_name || '';
const input = data?.tool_input || {};

// Build the breadcrumb entry for this tool result (null = nothing worth recording).
function entry() {
  if (tool === 'Bash') {
    const command = String(input.command || '');
    if (!command) return null;
    // index.ts passes the bash outcome through tool_input: `pending` for a background-start
    // result (no verdict yet — the job finishes via onUpdate, never a tool_result), `failed`
    // for a non-zero exit / isError, and for commits `landed` + `hash` from its HEAD snapshot
    // of the TARGET repo (`git -C other …` names the other repo — #22). PENDING never becomes
    // PASS/FAIL in this log: the agent must rerun a backgrounded verification in the
    // foreground for backpressure to see it. `landed: false` means the target repo gained no
    // commit — a gate-blocked (or no-op) commit, whatever the shell exit said (#48-6) — so no
    // hash is recorded. Without `landed` the target repo could not be resolved (`cd x && git
    // commit`, `$VAR` in -C …): the exit code decides FAIL vs UNVERIFIED, and NO hash is
    // guessed — the session cwd's HEAD is exactly the #22 misattribution.
    if (isGitCommit(command)) {
      const cmd = command.slice(0, 80);
      if (input.pending) return { kind: 'commit', result: 'PENDING', cmd };
      if (input.landed === false) return { kind: 'commit', result: 'BLOCKED', cmd };
      if (input.landed === true) return { kind: 'commit', hash: input.hash, cmd };
      if (input.failed) return { kind: 'commit', result: 'FAIL', cmd };
      return { kind: 'commit', result: 'UNVERIFIED', cmd };
    }
    const { isVerification, type } = classifyVerification(command, cwd);
    if (isVerification) {
      return { kind: 'test', type, result: input.pending ? 'PENDING' : input.failed ? 'FAIL' : 'PASS' };
    }
    return null; // ordinary bash (ls/cat/...) is noise — skip
  }
  if (tool === 'Write' || tool === 'Edit') {
    const fp = String(input.file_path || '');
    if (!fp) return null;
    let rel = fp;
    try { rel = relative(cwd, fp) || fp; } catch {}
    // an edit to the live scope file is an AC-toggle proxy (Q1.5 "AC 토글")
    const kind = basename(rel) === 'current-scope.md' ? 'scope' : 'edit';
    return { kind, file: rel };
  }
  return null;
}

const e = entry();
if (e) {
  try {
    const stateDir = join(cwd, '.omp', 'harness-state');
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n';
    appendFileSync(join(stateDir, 'session-log.jsonl'), line);
  } catch { /* best-effort: a breadcrumb is advisory; never block on FS errors */ }
}

process.exit(0);
