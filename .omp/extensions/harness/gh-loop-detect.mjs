#!/usr/bin/env node
// gh-loop-detect.mjs — auto-detect gh-loop findings from a source and PLAN the issues to open
// (autonomy Q2.7-4). It does NOT create issues: it turns a source (Q1 breadcrumb FAILs, or a generic
// findings list from lint/review/tests) into a deduped/throttled PLAN that the gh-loop skill's
// existing Stage-1 path then creates via `gh issue create`. Source reads and `gh` calls are SEAMS, so
// the extraction + planning logic is unit-testable with no live GitHub.
//
//   fromBreadcrumb(entries) -> findings[]     (FAIL test/commit; a test FAIL later followed by a PASS
//                                              of the same type is treated as RESOLVED and dropped)
//   planIssues(findings, { existing, cap }) -> [{ finding, action, payload? }]
//                                              (one decideIssue() per finding; batch creates accumulate
//                                              into `existing` so duplicates within the batch also dedup;
//                                              throttle via cap — all reused from gh-loop-issue.mjs)
//
// CLI (for the skill):
//   node gh-loop-detect.mjs detect --from breadcrumb [--log <path>] [--existing-json J] [--cap N]
//   node gh-loop-detect.mjs detect --from json --findings-json '[{"title","body","labels"}]' [...]
//   -> prints the plan JSON on stdout. A SUPPLIED but unparseable --existing-json fails CLOSED
//      (empty plan) so a corrupt `gh issue list` never causes duplicate creates.

import { readFileSync } from 'fs';
import { decideIssue } from './gh-loop-issue.mjs';

// Read an append-only JSONL breadcrumb log into entries; bad/blank lines are skipped (best-effort).
export function readBreadcrumb(path) {
  let text = '';
  try { text = readFileSync(path, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}

// breadcrumb session-log.jsonl -> findings. Each FAIL (test/commit) becomes a finding. We do NOT
// suppress a FAIL that has a later PASS: the breadcrumb `type` is COARSE (test/lint/build — every test
// runner collapses to 'test'; see backpressure-patterns), so a PASS of one suite cannot prove a
// DIFFERENT failing suite was fixed. Masking on that coarse signal would drop real failures
// (false-negative) — the worse failure mode for a detector. Instead: emit, then dedup (one issue per
// distinct title) + throttle (cap) + human/loop triage closes the already-fixed ones. (Precise
// FAIL->fixed suppression would need the breadcrumb to record the command, not just the coarse type.)
export function fromBreadcrumb(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const findings = [];
  for (const e of list) {
    if (!e) continue;
    // A commit that did not land is recorded as FAIL (non-zero exit) or BLOCKED (the target repo
    // recorded no commit — gate block, masked exit; #48-6): both are a failed commit here.
    if (e.result !== 'FAIL' && !(e.kind === 'commit' && e.result === 'BLOCKED')) continue;
    if (e.kind === 'test') {
      const type = String(e.type || 'test').trim().toLowerCase() || 'test';
      findings.push({
        source: 'breadcrumb',
        title: `Verification failing: ${type}`,
        body: `A '${type}' verification recorded FAIL in the session breadcrumb${e.ts ? ` (${e.ts})` : ''}. The breadcrumb type is coarse — confirm it is still failing before acting.`,
        labels: ['failing-check'],
      });
    } else if (e.kind === 'commit') {
      const cmd = String(e.cmd || '').slice(0, 80);
      findings.push({
        source: 'breadcrumb',
        title: `Commit failed: ${cmd}`,
        body: `A commit recorded ${e.result} in the session breadcrumb${e.ts ? ` (${e.ts})` : ''}: ${cmd}`,
        labels: ['failing-check'],
      });
    }
  }
  return findings;
}

// findings -> per-finding issue-create plan. Reuses decideIssue (dedup against `existing` + the
// running batch, throttle via cap). Returns a plan array; the caller creates issues for action=create.
export function planIssues(findings, { existing = [], cap = Infinity, kind = 'finding' } = {}) {
  const seen = Array.isArray(existing) ? [...existing] : [];
  let created = 0;
  const plan = [];
  for (const f of (Array.isArray(findings) ? findings : [])) {
    const d = decideIssue({
      kind, title: f && f.title, body: (f && f.body) || '', labels: (f && f.labels) || [],
      existing: seen, created, cap,
    });
    plan.push({ finding: f, action: d.action, reason: d.reason, ...(d.dup != null ? { dup: d.dup } : {}), ...(d.payload ? { payload: d.payload } : {}) });
    if (d.action === 'create') {
      created++;
      // record the just-planned create so an identical finding later IN THIS BATCH dedups against it
      seen.push({ title: d.payload.title, body: d.payload.body });
    }
  }
  return plan;
}

// --- CLI ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') o.from = argv[++i];
    else if (a === '--log') o.log = argv[++i];
    else if (a === '--findings-json') o.findingsJson = argv[++i];
    else if (a === '--existing-json') { o.existingSeen = true; o.existingJson = argv[++i]; }
    else if (a === '--cap') o.cap = Number(argv[++i]);
  }
  return o;
}

import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  if (process.argv[2] !== 'detect') {
    console.error('gh-loop-detect: usage — detect --from breadcrumb|json [--log p] [--findings-json J] [--existing-json J] [--cap N]');
    process.exit(1);
  }
  const o = parseArgs(process.argv.slice(2));

  // existing: omitted -> []; supplied-but-invalid -> fail CLOSED (empty plan, no creates).
  let existing = [];
  if (o.existingSeen) {
    let parsed;
    try { parsed = JSON.parse(o.existingJson); } catch { parsed = undefined; }
    if (!Array.isArray(parsed)) {
      process.stdout.write(JSON.stringify({ error: 'invalid --existing-json (supplied but not a JSON array)', plan: [] }));
      process.exit(0);
    }
    existing = parsed;
  }

  let findings = [];
  if (o.from === 'breadcrumb') {
    findings = fromBreadcrumb(readBreadcrumb(o.log || '.omp/harness-state/session-log.jsonl'));
  } else if (o.from === 'json') {
    let p;
    try { p = JSON.parse(o.findingsJson || '[]'); } catch { p = undefined; }
    if (!Array.isArray(p)) { // supplied but invalid -> fail closed (don't silently look like "no findings")
      process.stdout.write(JSON.stringify({ error: 'invalid --findings-json (not a JSON array)', plan: [] }));
      process.exit(0);
    }
    findings = p;
  } else {
    console.error('gh-loop-detect: --from must be breadcrumb or json');
    process.exit(1);
  }

  const plan = planIssues(findings, { existing, cap: Number.isFinite(o.cap) ? o.cap : 5 });
  const creates = plan.filter((p) => p.action === 'create').length;
  process.stdout.write(JSON.stringify({ findings: findings.length, creates, plan }));
  process.exit(0);
}
