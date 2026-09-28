#!/usr/bin/env node
// acceptance-gate.mjs - PreToolUse hook for Bash(git commit*)
// Purpose: Block commits if acceptance criteria not met
// Logic: Pass if (all checkboxes checked) OR (acceptance-done flag exists)
// Exit 0 = allow, Exit 2 = block (uses stderr for messages)

import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { isGitCommit, isWipCommit, parseCommitForm } from './git-commit-detect.mjs';
import { assessRisk } from './risk-assess.mjs';

// Use project-local state directory
function getStateDir(cwd) {
  const dir = join(cwd, '.omp', 'harness-state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const input = readFileSync(0, 'utf-8');

let data;
try {
  data = JSON.parse(input);
} catch (e) {
  console.error('HARNESS WARNING: Hook received invalid input, skipping check.');
  process.exit(0);
}

const cwd = data?.session_state?.cwd || process.cwd();
const stateDir = getStateDir(cwd);
const logFile = join(stateDir, 'hook-debug.log');

function log(msg) {
  if (!process.env.HARNESS_DEBUG) return;
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `[${timestamp}] acceptance-gate: ${msg}\n`);
}

log('Hook started');

const command = data?.tool_input?.command || '';
// (The dispatcher's static `-C` attribution was retired with AC3 — hook mode judges the
// repo it fires in, so no redirect bookkeeping reaches the gates any more.)
log(`Command: ${command}`);

// Hook mode (AC6): spawned by the pre-commit dispatcher — there is no command string;
// the hook firing is the commit. Only check for git commit commands otherwise.
const isHookMode = data?.mode === 'hook';
// Hook-mode wip (A-4): pre-commit cannot see the commit message (COMMIT_EDITMSG holds the
// PREVIOUS commit's message — scraping it is forbidden). The one-shot flag is the canonical
// wip declaration, OMP_COMMIT_WIP=1 the env convenience; consumption happens post-commit.
const hookWip = isHookMode
  && (existsSync(join(stateDir, 'commit-wip')) || process.env.OMP_COMMIT_WIP === '1');
const isWip = () => hookWip || isWipCommit(command);
// Observability for the WIP lane (audit symmetry with review_override): in hook mode, queue an
// `acceptance_wip` audit intent for post-commit to append into docs/harness/audit.jsonl — a
// direct append here would be swept into the commit by `git commit -a` (the same TOCTOU the
// review-gate defers around via pending-consume). The message-prefix wip on the non-hook path
// is self-documenting in commit history and is not separately audited.
const queueWipAudit = (reason) => {
  if (!hookWip) return;
  try {
    const pendDir = join(stateDir, 'pending-consume');
    mkdirSync(pendDir, { recursive: true });
    const event = {
      ts: new Date().toISOString(),
      event: 'acceptance_wip',
      actor: process.env.USER || 'unknown',
      meta: { mechanism: process.env.OMP_COMMIT_WIP === '1' ? 'env' : 'flag', reason },
    };
    writeFileSync(join(pendDir, 'append-audit-acceptance-wip.json'), JSON.stringify(event) + '\n');
  } catch { /* observability only — never block or unblock the lane */ }
};
// Same synthetic form the other gates use in hook mode: the staged index is the commit's
// content (git already materialized -a/pathspec into the inherited temporary index), and
// Content already in HEAD is out of scope (including under --amend) — a documented residual.
const hookForm = isHookMode
  ? { all: false, verifiable: true }
  : null;
if (!isHookMode && !isGitCommit(command)) {
  log('Not a git commit, allowing');
  process.exit(0);
}

log('Git commit detected, checking acceptance criteria');
log(`CWD: ${cwd}`);

// Support test mode with custom paths
const isTestMode = process.env.ACCEPTANCE_GATE_TEST === 'true';
const scopeFilePath = isTestMode
  ? process.env.TEST_SCOPE_FILE
  : join(cwd, 'docs', 'harness', 'current-scope.md');
const flagFilePath = isTestMode
  ? process.env.TEST_FLAG_FILE
  : join(cwd, 'docs', 'harness', 'acceptance-done');
const seedPath = isTestMode
  ? process.env.TEST_SEED_FILE
  : join(cwd, 'docs', 'harness', 'seed.yaml');

// L2 backstop (analysis Q6.2 / seed AC6): when a commit reaches a "no active acceptance
// criteria" allow-path (closed/empty seed, or seed-with-AC but no current-scope), a CODE
// change must not pass silently — surface it so the iteration (P2) gets a thread-scope.
// Doc/config-only commits (risk=low) and WIP/override pass unchanged. Risk can't be assessed
// without git (tests, detached): fail OPEN (unknown -> allow) so the backstop never blocks
// blindly and the existing active-seed gating is untouched.
function backstop(reason, opts = {}) {
  let level;
  if (process.env.TEST_RISK_LEVEL) {
    level = process.env.TEST_RISK_LEVEL;        // test seam: deterministic risk without a git repo
  } else {
    // Scope risk to the diff the commit actually captures — NOT the staged∪unstaged union,
    // or unrelated unstaged code over-counts a docs commit. In hook mode there is no command
    // string to parse, so the same synthetic form the other gates use applies (3-pass review,
    // medium: the union re-appeared here and falsely blocked docs commits).
    try { level = assessRisk(cwd, hookForm ?? parseCommitForm(command)).level; } catch { level = 'unknown'; }
  }
  const codeTouching = level === 'medium' || level === 'high' || level === 'critical';
  if (!codeTouching) {
    log(`backstop(${reason}): risk=${level} not code-touching -> allow`);
    process.exit(0);
  }
  if (isWip()) {
    queueWipAudit(`backstop:${reason}`);
    log(`backstop(${reason}): wip marker -> allow`);
    process.exit(0);
  }
  log(`BACKSTOP BLOCK: code change with no active AC (${reason}), risk=${level}`);
  console.error('HARNESS BACKSTOP: 코드 변경인데 이를 추적할 active acceptance criteria가 없습니다.');
  console.error(`  reason: ${reason}`);
  console.error('  반복(P2) 작업이 충실도 추적 없이 커밋되려 합니다. 다음 중 하나:');
  if (opts.closed) {
    console.error('  1. 같은 기능 반복이면 seed 재개(reopen): node .omp/extensions/harness/thread-scope.mjs open');
    console.error('     (genuinely 새 기능이면 /kickoff로 새 seed)');
  } else {
    console.error('  1. thread-scope 열기: node .omp/extensions/harness/thread-scope.mjs open');
  }
  console.error(isHookMode
    ? '  2. trivial이면 WIP 선언: `.omp/harness-state/commit-wip` 생성 또는 `OMP_COMMIT_WIP=1 git commit …` (pre-commit 시점에는 커밋 메시지를 볼 수 없어 `wip:` 접두사는 효력이 없습니다), 또는 docs/harness/acceptance-done 생성(override)'
    : '  2. trivial이면 `wip:` 커밋, 또는 docs/harness/acceptance-done 생성(override)');
  process.exit(2);
}

// Closeout landing (#48-1): closeout_contract.md §3 puts the seed `approved -> done` transition
// (a), the current-scope.md retirement (b) and the `task_closed` audit row (c) IN THE SAME
// COMMIT as the code that completed the task (d). At pre-commit time the seed on disk already
// says `done`, so the closed-seed branch above would read it as "dead seed + new code" and
// backstop-block — the contract and the gate contradicted each other, and only the WIP lane got
// the commit through. The distinguishing facts are in the commit's own CONTENT, and all three
// closeout parts must be there (review 2026-09-26: the seed flip alone would let unmet AC be
// "closed" by editing one line): HEAD's seed is `approved` and the committed seed is `done`,
// the committed tree carries no current-scope.md, and the committed audit.jsonl gains a
// `task_closed` row. Scoped to the content the commit captures (index, or worktree for -a); an
// unverifiable standalone form (pathspec, --amend, bash -c …) is not inspected — it falls
// through to the backstop as before. Test mode (custom file paths) never claims a closeout.
// Top-level, exact scalar (balanced quotes or bare), a trailing YAML comment allowed only after
// whitespace (`status: done  # closed 2026-09-26`); `done#x`, `"done`, `done-later` never match.
const STATUS_LINE = (status) => new RegExp(`^status:\\s*(?:"${status}"|'${status}'|${status})(?:\\s+#.*)?\\s*$`, 'm');
// Returns 'closeout' (all three parts present), a string naming the FIRST missing part when the
// seed transition is there but the closeout is incomplete (surfaced in the backstop so a hasty
// `git commit -am` that silently left an untracked audit.jsonl behind is pointed at the file,
// not at reopen/WIP), or null when this is not a closeout attempt at all.
function closeoutState() {
  if (isTestMode) return null;
  const form = hookForm ?? parseCommitForm(command);
  if (!form.verifiable) return null;
  // `--no-color --no-ext-diff` on the diff itself: color.diff=always / diff.external override a
  // `-c color.ui=never` and would hide the `+` lines from the regex (fail-closed, but needless).
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  const diff = (...args) => git('diff', '--no-color', '--no-ext-diff', ...args);
  const tracked = (rel) => git('ls-files', '--', rel).trim() !== '';
  // What the commit will carry for `rel`: the index blob (plain), or the worktree file when it is
  // tracked (-a stages tracked edits/deletions, never an untracked copy). null = absent.
  const committed = (rel) => {
    if (form.all) return tracked(rel) && existsSync(join(cwd, rel)) ? readFileSync(join(cwd, rel), 'utf-8') : null;
    try { return git('show', `:${rel}`); } catch { return null; }
  };
  // Membership in the COMMITTED TREE, not the raw index: an intent-to-add entry (`git add -N`)
  // sits in the index but is not committed, and `git diff --cached` already reports exactly that.
  const inCommittedTree = (rel) => {
    if (form.all) return tracked(rel) && existsSync(join(cwd, rel));
    const status = diff('--cached', '--name-status', '--', rel).trim().split(/\s+/)[0] ?? '';
    if (status === 'A') return true;
    if (status === 'D') return false;
    return git('ls-tree', '--name-only', 'HEAD', '--', rel).trim() !== '';
  };
  try {
    const headSeed = git('show', 'HEAD:docs/harness/seed.yaml');
    if (!STATUS_LINE('approved').test(headSeed)) return null;
    if (!STATUS_LINE('done').test(committed('docs/harness/seed.yaml') ?? '')) {
      // The on-disk seed IS done (that is how we got here) but the commit does not carry the
      // transition: the classic mis-staging. Name it instead of the generic reopen/WIP advice.
      if (form.all || !STATUS_LINE('done').test(existsSync(seedPath) ? readFileSync(seedPath, 'utf-8') : '')) return null;
      return 'docs/harness/seed.yaml approved -> done is in the worktree but not staged for this commit (closeout_contract.md §3a)';
    }
    // (b) scope retired: not in the committed tree.
    if (inCommittedTree('docs/harness/current-scope.md')) {
      return 'docs/harness/current-scope.md is still in the commit (closeout_contract.md §3b deletes it)';
    }
    // (c) audit row added by this commit (any JSON whitespace around the colon).
    const auditDiff = form.all ? diff('HEAD', '--', 'docs/harness/audit.jsonl') : diff('--cached', '--', 'docs/harness/audit.jsonl');
    if (!/^\+.*"event"\s*:\s*"task_closed"/m.test(auditDiff)) {
      return 'no task_closed row is added to docs/harness/audit.jsonl in this commit (closeout_contract.md §3c; `git commit -a` does not add an untracked audit.jsonl — `git add` it)';
    }
    return 'closeout';
  } catch { return null; }
}

// Check 1: Flag file exists (manual override)
if (existsSync(flagFilePath)) {
  log('acceptance-done flag exists, allowing (manual override)');
  process.exit(0);
}

// Check 2: seed.yaml AC existence check
if (existsSync(seedPath)) {
  let seedContent;
  try { seedContent = readFileSync(seedPath, 'utf-8'); }
  catch { log('seed.yaml read failed (race), allowing'); process.exit(0); }
  // Closeout landing is judged on the COMMIT'S content (HEAD approved -> committed done + scope
  // retired + task_closed row), before the on-disk status is consulted: an unstaged edit made
  // after staging a complete closeout (the seed already flipped back for the next task) must
  // not revive the closeout/backstop contradiction, and an on-disk `done` with an incomplete
  // commit must name the missing part.
  const closeout = closeoutState();
  if (closeout === 'closeout') {
    log('closeout landing: this commit carries seed approved -> done, scope retired, task_closed row; allowing');
    console.error('HARNESS NOTE: closeout landing (seed approved -> done, current-scope.md retired, task_closed audited in this commit) — acceptance-gate allowing.');
    process.exit(0);
  }
  // A CLOSED seed carries no ACTIVE acceptance criteria: `done` = the task completed
  // (closeout), `superseded` = replaced by a newer seed. Either way its criteria belong
  // to a finished/obsolete task and must not gate new, unrelated work. (cf. seed_contract.md)
  const statusMatch = seedContent.match(/^status:\s*["']?(\w+)/m);  // tolerate quoted YAML
  const status = statusMatch ? statusMatch[1].toLowerCase() : null;
  if (status === 'done' || status === 'superseded') {
    if (closeout) console.error(`HARNESS WARNING: this looks like a closeout (seed approved -> done) but it is incomplete: ${closeout}.`);
    log(`seed.yaml status=${status} (closed), no active AC, allowing`);
    backstop(`closed seed (status:${status})`, { closed: true });
  }
  const hasAC = /^acceptance_criteria:\s*\n\s+-/m.test(seedContent);
  if (hasAC) {
    log('AC found in seed.yaml, checking completion via flag or scope file checkboxes');
  } else {
    log('seed.yaml exists but no AC defined, allowing with warning');
    console.error('HARNESS WARNING: seed.yaml has no acceptance_criteria. Run /kickoff to define them.');
    backstop('seed has no acceptance_criteria');
  }
}

// Check 3: Scope file exists (checkbox-based completion tracking)
if (!existsSync(scopeFilePath)) {
  if (existsSync(seedPath)) {
    log('seed.yaml has AC but no current-scope.md for checkbox tracking, allowing with warning');
    console.error('HARNESS WARNING: AC defined in seed.yaml but no current-scope.md for completion tracking.');
    backstop('seed defines AC but no current-scope.md');
  }
  log('No current-scope.md found, allowing with warning');
  console.error('HARNESS WARNING: No scope file. Run /kickoff to define acceptance criteria.');
  process.exit(0);
}

// Read scope file
let scopeContent;
try { scopeContent = readFileSync(scopeFilePath, 'utf-8'); }
catch { log('current-scope.md read failed (race), allowing'); process.exit(0); }

// Extract Acceptance Criteria section
const acceptanceMatch = scopeContent.match(/## Acceptance Criteria\s*\n([\s\S]*?)(?=\n##|\n*$)/i);
if (!acceptanceMatch) {
  log('No Acceptance Criteria section found, allowing with warning');
  console.error('HARNESS WARNING: No Acceptance Criteria section in scope file.');
  process.exit(0);
}

const acceptanceSection = acceptanceMatch[1];

// Find all checkboxes
const checkboxes = acceptanceSection.match(/- \[[ x]\]/g) || [];
const checked = acceptanceSection.match(/- \[x\]/gi) || [];
const unchecked = acceptanceSection.match(/- \[ \]/g) || [];

log(`Checkboxes: total=${checkboxes.length}, checked=${checked.length}, unchecked=${unchecked.length}`);

if (checkboxes.length === 0) {
  log('No checkboxes defined, allowing');
  backstop('current-scope has no acceptance-criteria checkboxes');
}

if (unchecked.length === 0) {
  log('All acceptance criteria met, allowing');
  process.exit(0);
}

// WIP commits are intentional in-progress checkpoints. Without this, every commit during a
// tracked task is blocked until ALL AC are checked, pushing people to the blunt
// `acceptance-done` flag (which disables the gate). In HOOK mode the declaration is the
// one-shot flag `.omp/harness-state/commit-wip` or `OMP_COMMIT_WIP=1` — pre-commit runs before
// the commit message exists, so a `wip:` marker cannot be read there (scraping COMMIT_EDITMSG
// would return the PREVIOUS commit's message). The message marker still applies on the
// non-hook/standalone path. (cf. closeout_contract.md — closeout runs on completion.)
if (isWip()) {
  queueWipAudit(`unchecked:${unchecked.length}`);
  log(`WIP commit, ${unchecked.length} unchecked criteria but allowing (wip marker)`);
  console.error(`HARNESS WARNING: WIP commit with ${unchecked.length} unmet acceptance criteria (allowed by wip marker).`);
  process.exit(0);
}

// Unchecked items exist and no flag file = block
log(`BLOCKED: ${unchecked.length} unchecked criteria, no override flag`);

const uncheckedItems = [];
const lines = acceptanceSection.split('\n');
for (const line of lines) {
  if (line.match(/- \[ \]/)) {
    uncheckedItems.push(line.replace(/- \[ \]/, '').trim());
  }
}

console.error(`HARNESS BLOCK: Cannot commit. ${unchecked.length} acceptance criteria not met:`);
uncheckedItems.slice(0, 3).forEach(item => console.error(`  - [ ] ${item}`));
if (uncheckedItems.length > 3) {
  console.error(`  ... and ${uncheckedItems.length - 3} more`);
}
console.error('');
console.error('Options:');
console.error('  1. Check off completed criteria in docs/harness/current-scope.md');
console.error('  2. Create docs/harness/acceptance-done to override');
if (isHookMode) {
  console.error('  3. WIP checkpoint: create .omp/harness-state/commit-wip or run OMP_COMMIT_WIP=1 git commit …');
  console.error('     (a `wip:` message prefix cannot work here — pre-commit runs before the message exists)');
}
// An AC that can only be true AFTER this commit ("PR opened", "tag pushed", "merged") is not an
// AC by .omp/rules/harness-cycle_definition.md — it circles with this gate (true only once the commit it gates
// has landed) and pushes people to check it falsely or reach for the WIP lane (#48-4). Name the
// fix here rather than inventing a marker syntax for it.
console.error('  If an item is true only AFTER this commit (open PR, tag, merge, deploy): it is not an acceptance');
console.error('  criterion — move it out of the checkboxes into a follow-up step (.omp/rules/harness-cycle_definition.md: "AC는 커밋 시점에 판정 가능해야 한다").');

process.exit(2);
