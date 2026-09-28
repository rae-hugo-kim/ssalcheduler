#!/usr/bin/env node
// review-gate.mjs - PreToolUse hook for Bash (git commit)
// Purpose: Enforce review based on change risk level
// - critical/high risk + no accepted evidence → BLOCK
// - critical/high risk + FAIL review covering the diff → BLOCK
// - medium risk + no review → WARNING (recommend reviewer)
// - low risk → PASS (docs/config don't need adversarial review)
//
// MACHINE EVIDENCE IS JSON, NEVER MARKDOWN. Seven adversarial review rounds each produced a fresh
// CommonMark quoting/hiding bypass against the previous line-based markdown evidence parser
// (fences, tabs, blockquotes, indented code, list indents, comment-manufactured openers, lazy
// continuation, opener/closer state inversion). Emulating a markdown renderer line-by-line was
// judged non-convergent as a security boundary, so the gate no longer reads .md files AT ALL.
// Review markdown under docs/reviews/ is a human report; the gate reads only the same-basename
// .json sidecar.
//
// Evidence sidecar — docs/reviews/review-<YYYY-MM-DD-HHMMSS>.json — is a single FIXED-ARITY
// POSITIONAL JSON ARRAY (tuple). A tuple has no keys, so duplicate-key last-wins injection
// ({"verdict":"FAIL",…,"verdict":"PASS"} under JSON.parse) is structurally impossible and no
// hand-rolled raw-text scanning is needed:
//   ["omp-review-evidence/v1",
//    "<diff_hash: 64 lowercase hex>",
//    "<verdict: PASS | PASS WITH NOTES | FAIL>",
//    ["<model>", "<model>", …] | null,       // models: transcript-MEASURED, >=2 distinct families
//    "<human_reviewed_by>" | null,           // a person's identity — never a model name
//    "<reviewer>"]                           // who produced the evidence (non-empty)
// Validation = JSON.parse + Array.isArray + exact arity + per-position type/enum/pattern checks.
// Anything else — object form, wrong magic, extra/missing elements, unknown verdict, non-hex hash,
// an unparseable model token, a single-family models list, unfilled <placeholder> values, or a
// PASS-family verdict with both evidence axes null — makes the FILE invalid: it is ignored with a
// warning (fail-closed; an ignored file grants nothing). A FAIL verdict is exempt from the
// evidence-axis requirement: it is a block signal, not a grant, and an honest FAIL must stay
// valid so a covering PASS can never outrank it.
//
// Accepted evidence for HIGH/CRITICAL — the verification axis and the approval axis are separate:
//   (1) heterogeneous model review [verification] — a covering evidence tuple (diff_hash matches
//       the effective committed diff) whose models array names >=2 distinct model families,
//       written only after the reviewer transcript-verified the adversary's resolved family.
//   (2) human review [verification] — a covering evidence tuple whose human_reviewed_by is a real
//       identity (not a model name). For single-model deployments that cannot honestly produce
//       (1), the USER reading the diff is the second perspective.
//   (3) audited override [approval, no verification] — docs/harness/review-skip containing the
//       override tuple ["omp-review-override/v1", "<reason>", "<approved_by>", "<diff_hash>"].
//       The gate binds it to THIS commit's diff, appends a `review_override` event to
//       docs/harness/audit.jsonl ({ts,event,actor,meta} — the adversarial_override precedent),
//       and consumes the flag. A BARE or non-tuple review-skip file bypasses nothing: there is
//       deliberately no unaudited escape hatch.
// A covering tuple with verdict FAIL blocks regardless of any covering PASS (the block signal
// wins); when the diff hash cannot be computed the gate fails closed on high/critical.
// Exit 0 = allow, Exit 2 = block

import { readFileSync, readSync, existsSync, appendFileSync, mkdirSync, opendirSync, unlinkSync, openSync, fstatSync, lstatSync, closeSync, writeFileSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { assessRisk } from './risk-assess.mjs';
import { isGitCommit, parseCommitForm } from './git-commit-detect.mjs';
import { ESTIMATE_FILE, parseEstimate, countFailsSince, buildEstimateEvent, SESSION_LOG_TAIL_BYTES } from './estimate.mjs';

function getStateDir(cwd) {
  const dir = join(cwd, '.omp', 'harness-state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Map a token to a model FAMILY, or null if it is not a single clean model name. Used to validate
// the models array (position 3) of an evidence tuple. The token must be ENTIRELY
// `[provider/]<alias><suffix?>` — the alias is a known model word; the suffix is analyzed
// SEGMENT BY SEGMENT (split on `-`/`.`), and every segment must be one of:
//   - a version segment starting with a digit ("4", "5.6", "8x7b") or letter+digit codename ("r1", "4o"),
//   - a same-family sub-alias ("claude-opus-4-8", "claude-3-5-sonnet"),
//   - a known variant descriptor ("o3-mini", "gemini-2.5-pro", "gpt-4-turbo"),
//   - or, once a version segment has appeared, any plain word codename ("gpt-5.6-sol").
// A NEGATION word anywhere ("not", "skipped", "unavailable", …) rejects the whole token — so
// "gpt-skipped", "claude-unavailable-5", "gpt-not-run-2" are negated declarations, not versions,
// no matter how many digits they carry. Empty segments ("claude...4", "gpt--5") are malformed and
// reject. Unknown words BEFORE any version digit reject (fail-closed: "octopus", "gptscript",
// bare providers all stay non-models).
// Codex folds into the gpt (OpenAI) family, so ["codex", "gpt-5"] is ONE family, while
// ["claude", "codex"] is two.
// fable/mythos: current-generation Anthropic codenames (cf. usage tiers in oh-my-pi
// claude.ts) — they sit BEFORE the version digit ("claude-fable-5"), which the
// pre-version fail-closed rule would otherwise reject (scope-add 2026-07-30).
const MODEL_ALIAS = /^(?:claude|sonnet|opus|haiku|fable|mythos|codex|gpt|o[1-9]|gemini|bard|grok|llama|mistral|mixtral|deepseek|qwen)$/;
const NEGATION_STEMS = 'not?|none|never|nil|null|na|void|skip|skipped|skipping|unavailable|unverified|unused|unrun|missing|absent|omitted|pending|disabled|failed|fail|failing|error|errored|without|run';
const NEGATION_WORD = new RegExp(`^(?:${NEGATION_STEMS})$`);
// Prefix form: a fused negation ("skippedrun", "notactuallyrun") or a negation-shaped provider
// ("skipped/gpt-5") is a negated declaration too — the freedom the codename/provider positions
// grant must not launder a negation word into a "model". Over-blocks exotic legit names that
// happen to start with a negation stem (e.g. a "nousresearch/" provider prefix); the reviewer can
// always write the bare canonical model id instead — fail-closed.
const NEGATION_PREFIX = new RegExp(`^(?:${NEGATION_STEMS})`);
const VARIANT_WORD = /^(?:mini|nano|micro|lite|tiny|small|medium|large|max|plus|ultra|pro|air|flash|turbo|preview|exp|experimental|latest|stable|beta|alpha|instruct|chat|coder|vision|thinking|reasoner|sonic|high|low)$/;
function familyOf(alias) {
  if (/^(?:claude|sonnet|opus|haiku|fable|mythos)$/.test(alias)) return 'claude';
  if (/^(?:codex|gpt|o[1-9])$/.test(alias)) return 'gpt';
  if (/^(?:gemini|bard)$/.test(alias)) return 'gemini';
  return alias; // grok | llama | mistral | mixtral | deepseek | qwen
}
function modelFamily(tok) {
  const raw = String(tok).toLowerCase().trim();
  const prov = raw.match(/^([a-z][a-z0-9.-]*)\//);                // at most one provider/ prefix
  if (prov && NEGATION_PREFIX.test(prov[1])) return null;         // "skipped/gpt-5" is a negation, not a provider
  const e = prov ? raw.slice(prov[0].length) : raw;
  const m = e.match(/^(claude|sonnet|opus|haiku|fable|mythos|codex|gpt|o[1-9]|gemini|bard|grok|llama|mistral|mixtral|deepseek|qwen)([-.][a-z0-9.-]*|\d[a-z0-9.-]*)?$/);
  if (!m) return null;
  const family = familyOf(m[1]);
  if (!m[2]) return family;
  let versionStarted = false;
  for (const seg of m[2].replace(/^[-.]/, '').split(/[-.]/)) {
    if (!seg) return null;                                        // "claude...4", "gpt--5": malformed
    if (NEGATION_WORD.test(seg)) return null;                     // negation anywhere kills the token
    if (/^\d|^[a-z]\d/.test(seg)) { versionStarted = true; continue; } // "4", "5", "8x7b", "r1", "4o"
    if (MODEL_ALIAS.test(seg)) {                                  // sub-alias must agree in family
      if (familyOf(seg) !== family) return null;
      continue;
    }
    if (VARIANT_WORD.test(seg)) continue;                         // "mini", "pro", "turbo", …
    if (versionStarted && /^[a-z][a-z0-9]*$/.test(seg) && !NEGATION_PREFIX.test(seg)) continue; // post-version codename ("5.6-sol"), never negation-shaped ("skippedrun")
    return null;                                                  // unknown word before a version: not a model
  }
  return family;
}

const EVIDENCE_MAGIC = 'omp-review-evidence/v1';
const OVERRIDE_MAGIC = 'omp-review-override/v1';
const HEX64 = /^[0-9a-f]{64}$/;
const VERDICTS = new Set(['PASS', 'PASS WITH NOTES', 'FAIL']);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
// An unfilled template placeholder ("<your name>", "<who accepts the risk>") pasted verbatim from
// the BLOCK message must never count as a real value — identities/reasons may not contain angle
// brackets at all (fail-closed; no plausible identity needs them).
const hasPlaceholder = (v) => /[<>]/.test(v);
// Zero-width/format characters can smuggle a model name past token checks ("\u200bclaude").
const stripInvisible = (v) => v.replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '');
// True when ANY whitespace token of the identity (punctuation-trimmed, invisibles stripped)
// parses as a model name — "OpenAI GPT-5" is a model description, not a person.
function namesAModel(identity) {
  return stripInvisible(identity).split(/\s+/).some((t) => {
    const tok = t.replace(/^[^0-9a-z]+|[^0-9a-z]+$/gi, '');
    return tok !== '' && modelFamily(tok) !== null;
  });
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Parse + validate one evidence sidecar. Returns
//   { ok: true, diffHash, verdict, families (Set|null), human (string|null), reviewer }
// or
//   { ok: false, problems: [...] }   — the caller warns and IGNORES the file (fail-closed).
// Every check is positional and exact: no key allowlists, no duplicate-key scanning, no
// case-folding, no markdown tolerance. The templates in evidenceHelp() carry the real hash;
// their <placeholder> parts MUST be filled in — pasting them verbatim is rejected, not accepted.
// Iterative (explicit-stack) container-depth probe — the guard itself must be recursion-free or a
// deep payload would blow OUR stack, which is the exact crash it exists to prevent. A legitimate
// tuple has containers at depth 1 (the tuple) and depth 2 (the models array) only.
function tooDeep(v, maxDepth) {
  const stack = [[v, 1]];
  while (stack.length > 0) {
    const [node, d] = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (d > maxDepth) return true;
    for (const child of (Array.isArray(node) ? node : Object.values(node))) {
      if (child !== null && typeof child === 'object') stack.push([child, d + 1]);
    }
  }
  return false;
}

function parseEvidence(text) {
  let t;
  try {
    t = JSON.parse(text); // a pathologically deep payload throws RangeError here — caught, invalid
  } catch (e) {
    return { ok: false, problems: [`not valid JSON (${clip(String(e.message), 120)})`] };
  }
  if (!Array.isArray(t)) return { ok: false, problems: ['not a JSON array — evidence is a positional tuple, not an object'] };
  if (t.length !== 6) return { ok: false, problems: [`wrong arity: expected exactly 6 elements, got ${t.length}`] };
  // Depth gate BEFORE any per-element work: everything below may only ever see flat values, so no
  // later step (including diagnostics) can recurse into attacker-shaped nesting.
  if (tooDeep(t, 2)) return { ok: false, problems: ['nesting too deep — a tuple holds only strings, null, and the flat models string array'] };
  const problems = [];
  if (t[0] !== EVIDENCE_MAGIC) problems.push(`element 0 must be the literal "${EVIDENCE_MAGIC}"`);
  if (typeof t[1] !== 'string' || !HEX64.test(t[1])) problems.push('element 1 (diff_hash) must be 64 lowercase hex chars (git diff … | shasum -a 256)');
  if (typeof t[2] !== 'string' || !VERDICTS.has(t[2])) problems.push('element 2 (verdict) must be exactly "PASS", "PASS WITH NOTES", or "FAIL"');
  let families = null;
  if (t[3] !== null) {
    if (!Array.isArray(t[3]) || t[3].length === 0) {
      problems.push('element 3 (models) must be null or a non-empty array of model-name strings');
    } else if (t[3].length > 16) {
      problems.push('element 3 (models) has implausibly many entries (max 16)');
    } else {
      families = new Set();
      for (let i = 0; i < t[3].length; i++) {
        const entry = t[3][i];
        if (typeof entry !== 'string') { problems.push(`element 3 (models) entry ${i} must be a string`); families = null; break; }
        const fam = modelFamily(entry);
        if (!fam) { problems.push(`element 3 (models) entry "${clip(entry, 60)}" is not a clean model name`); families = null; break; }
        families.add(fam);
      }
      if (families && families.size < 2) {
        problems.push('element 3 (models) must name >=2 DISTINCT model families (codex folds into gpt) — a single-family list is not heterogeneity evidence; use null and the human path instead');
        families = null;
      }
    }
  }
  let human = null;
  if (t[4] !== null) {
    if (!isNonEmptyString(t[4])) {
      problems.push('element 4 (human_reviewed_by) must be null or a non-empty identity string');
    } else if (hasPlaceholder(t[4])) {
      problems.push('element 4 (human_reviewed_by) looks like an unfilled template placeholder — write the actual identity, without angle brackets');
    } else if (namesAModel(t[4])) {
      problems.push(`element 4 (human_reviewed_by) "${clip(t[4], 60)}" names a model, not a person`);
    } else {
      human = t[4];
    }
  }
  // The evidence axis (measured models or a human identity) is required to GRANT anything —
  // i.e. for the PASS-whitelist verdicts. A FAIL is a block signal, not a grant: an honest FAIL
  // with both axes null must stay valid, or ignoring it would let a covering PASS win over a
  // covering FAIL (fail-open). Unknown verdicts already invalidate the file above.
  if (t[2] !== 'FAIL' && t[3] === null && t[4] === null) problems.push('one evidence axis is required for a PASS verdict: element 3 (models, >=2 families) or element 4 (human_reviewed_by)');
  if (!isNonEmptyString(t[5])) problems.push('element 5 (reviewer) must be a non-empty string');
  else if (hasPlaceholder(t[5])) problems.push('element 5 (reviewer) looks like an unfilled template placeholder — write the actual reviewer identity, without angle brackets');
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, diffHash: t[1], verdict: t[2], families, human, reviewer: t[5] };
}

// Validate the audited-override flag file (path 3) — the SAME strict-tuple grammar as evidence:
//   ["omp-review-override/v1", "<reason>", "<approved_by>", "<diff_hash | UNVERIFIABLE>"]
// diff_hash must equal the effective committed-diff hash, or be the literal UNVERIFIABLE when
// (and only when) no hash exists — binding each override to ONE specific commit so a stale or
// pre-written flag can never silently cover different content. Returns
//   { fields: {reason, approvedBy, diffHash} | null, problems: [...] }  ([] = valid).
function parseOverride(text, currentHash, form) {
  let t;
  try {
    t = JSON.parse(text);
  } catch (e) {
    return { fields: null, problems: [`not valid JSON (${clip(String(e.message), 120)}) — the override is a positional tuple, not key: value lines`] };
  }
  if (!Array.isArray(t)) return { fields: null, problems: ['not a JSON array — the override is a positional tuple, not an object'] };
  if (t.length !== 4) return { fields: null, problems: [`wrong arity: expected exactly 4 elements, got ${t.length}`] };
  if (tooDeep(t, 1)) return { fields: null, problems: ['nesting too deep — the override tuple holds only strings'] };
  const problems = [];
  if (t[0] !== OVERRIDE_MAGIC) problems.push(`element 0 must be the literal "${OVERRIDE_MAGIC}"`);
  if (!isNonEmptyString(t[1])) problems.push('element 1 (reason) must be a non-empty string — why review is being skipped');
  else if (hasPlaceholder(t[1])) problems.push('element 1 (reason) looks like an unfilled template placeholder — write the actual reason, without angle brackets');
  if (!isNonEmptyString(t[2])) problems.push('element 2 (approved_by) must be a non-empty string — who accepts the risk');
  else if (hasPlaceholder(t[2])) problems.push('element 2 (approved_by) looks like an unfilled template placeholder — write the actual approver, without angle brackets');
  const dh = t[3];
  if (!isNonEmptyString(dh)) {
    problems.push(`element 3 (diff_hash) must be ${currentHash ? `"${currentHash}"` : 'the literal "UNVERIFIABLE" for this commit form'}`);
  } else if (currentHash) {
    if (dh !== currentHash) problems.push(`diff_hash mismatch: the flag has ${dh} but the effective committed diff is ${currentHash} (the staged/committed content changed since the flag was written)`);
  } else if (dh !== 'UNVERIFIABLE') {
    problems.push(form.verifiable
      ? 'the effective diff hash could not be computed (git/shasum error) — write "UNVERIFIABLE" as element 3 to acknowledge overriding an unhashable commit'
      : 'this commit form is unverifiable (pathspec/--amend/compound line/...) so no hash exists — write "UNVERIFIABLE" as element 3 to acknowledge, or use a standalone plain `git commit`');
  }
  if (problems.length > 0) return { fields: null, problems };
  return { fields: { reason: t[1], approvedBy: t[2], diffHash: dh }, problems: [] };
}

// Decide whether today's evidence tuples cover the current diff and whether any covering tuple
// is a FAIL. `evidences` is [{ name, ev }] (already-valid parses only); `currentHash` is the
// effective committed-diff hash (or null when it could not be produced).
// - A tuple "covers" when its diff_hash equals currentHash. ALL of today's sidecars are scanned
//   (not just the lexicographically-last one), so several PRs landing the same day don't shadow
//   each other.
// - FAIL blocks only when it covers the current diff; if the hash is unknown ANY of today's valid
//   FAIL tuples still blocks (the explicit block signal fails closed).
// - matchedCurrent is true/false when a hash exists, or null when it could not be computed (the
//   gate treats null as "unverified" and fails closed on high/critical).
// - Schema validity guarantees a covering PASS-verdict tuple carries one evidence axis
//   (>=2-family models or a human identity), so acceptance = covering + PASS-whitelist verdict +
//   no covering FAIL. matchedHet/matchedHuman are reported for the log.
function evaluateEvidence(evidences, currentHash) {
  const covering = currentHash ? evidences.filter(({ ev }) => ev.diffHash === currentHash) : [];
  const failScope = currentHash ? covering : evidences;
  const hasFail = failScope.some(({ ev }) => ev.verdict === 'FAIL');
  const passing = covering.filter(({ ev }) => ev.verdict === 'PASS' || ev.verdict === 'PASS WITH NOTES');
  const matchedCurrent = currentHash ? passing.length > 0 : null;
  const matchedHet = currentHash ? passing.some(({ ev }) => ev.families !== null) : null;
  const matchedHuman = currentHash ? passing.some(({ ev }) => ev.human !== null) : null;
  return { hasFail, matchedCurrent, matchedHet, matchedHuman };
}

// The three accepted evidence paths, spelled out so a user blocked for the FIRST time can write
// path (2) or (3) from this message alone — single-model deployments cannot honestly produce (1),
// and this message is their entire UX. Always prints COPYABLE JSON tuples carrying the ACTUAL
// values (hash, today's date, the diff command this commit form is hashed with). The markdown
// report is for humans; the gate reads only .json. Placeholders are angle-bracketed on purpose:
// pasting them UNFILLED is rejected by the placeholder check, never silently accepted.
function evidenceHelp(currentHash, today, diffCmd) {
  const lines = [
    'A HIGH/CRITICAL commit needs ONE of (machine evidence is a JSON tuple — the gate does NOT read markdown):',
  ];
  if (currentHash) {
    lines.push(
      '  (1) heterogeneous model review [verification]: run the reviewer agent. It writes a human report',
      '      docs/reviews/review-<ts>.md PLUS the machine sidecar docs/reviews/review-<ts>.json containing exactly:',
      `        ["omp-review-evidence/v1", "${currentHash}", "PASS", ["<model1>", "<model2>"], null, "reviewer"]`,
      '      where <model1>/<model2> are replaced with the transcript-MEASURED model ids, >=2 distinct families',
      '      (e.g. ["claude-opus-4", "gpt-5"]; codex counts as gpt). If only your own family actually ran,',
      '      (1) cannot honestly be satisfied — use (2) or (3).',
      `  (2) human review [verification]: read the diff yourself (${diffCmd} — the diff this commit form captures), then create docs/reviews/review-${today}-HHMMSS.json (any HHMMSS) containing exactly:`,
      `        ["omp-review-evidence/v1", "${currentHash}", "PASS", null, "<your name>", "<your name>"]`,
      '      with <your name> replaced by your actual identity (verdict "PASS" or "PASS WITH NOTES" only;',
      '      the identity must be a person, not a model name, and unfilled <placeholders> are rejected)',
    );
  } else {
    lines.push('  (1)/(2) reviewer / human-review evidence is unavailable for this commit form (no diff hash to bind it to) — prefer a standalone plain `git commit` of the staged diff, which makes both usable.');
  }
  lines.push(
    '  (3) audited override [approval — accept the risk UNREVIEWED]: create docs/harness/review-skip containing exactly:',
    `        ["omp-review-override/v1", "<why review is being skipped>", "<who accepts the risk>", "${currentHash || 'UNVERIFIABLE'}"]`,
    '      with the <placeholders> replaced (unfilled ones are rejected). The gate records it as a `review_override` event in docs/harness/audit.jsonl and consumes the flag. A bare/incomplete review-skip file does NOT bypass this gate.',
  );
  return lines.join('\n');
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
  appendFileSync(logFile, `[${timestamp}] review-gate: ${msg}\n`);
}

log('Hook started');

const command = data?.tool_input?.command || '';

// Hook mode (AC6): spawned by the pre-commit dispatcher — no command string; the hook
// firing is the commit. The synthetic form pins the risk assessment and the effective-diff
// hash to the STAGED INDEX (`git diff --cached`): at pre-commit time git has already
// materialized `-a`/pathspec commits into a temporary GIT_INDEX_FILE (inherited from the
// hook environment), so --cached IS the exact content the commit will capture — and
// unrelated unstaged worktree noise must not drive the risk level (test-attack C-2).
const isHookMode = data?.mode === 'hook';

if (!isHookMode && !isGitCommit(command)) {
  log('Not a git commit, allowing');
  process.exit(0);
}

// Parse the commit form ONCE: it scopes both the risk assessment (assess only what the
// commit captures, not unrelated unstaged changes) and the effective-diff hash below.
const form = isHookMode
  ? { all: false, verifiable: true }
  : parseCommitForm(command);
const risk = assessRisk(cwd, form);
log(`Risk: ${risk.level} (${risk.reason}), ${risk.files.length} files, ~${risk.diffSize} lines`);

// Provenance audit (handoff 2026-09-02 AC3): a commit whose files are byte-exact harness-sync
// copies is scored by risk-assess without them. That exemption must leave a trace distinct
// from review_override, so a pure sync commit is visible in audit.jsonl as `harness_sync`.
// Hook mode only: the intent is queued for post-commit, so it lands iff the commit lands (the
// command layer no longer gates commits, and a pre-verdict append there would be a lie).
if (isHookMode && Array.isArray(risk.synced) && risk.synced.length > 0) {
  const event = {
    ts: new Date().toISOString(),
    event: 'harness_sync',
    actor: process.env.USER || 'unknown',
    meta: {
      version: risk.syncVersion ?? null,
      tag: risk.syncVersion ? `refs/harness/${risk.syncVersion}` : null,
      tree_sha: risk.syncTree ?? null,
      synced_files: risk.synced.length,
      synced: risk.synced,
      other_files: risk.files.length,
      other: risk.files,
      risk: risk.level,
    },
  };
  try {
    const pendDir = join(cwd, '.omp', 'harness-state', 'pending-consume');
    mkdirSync(pendDir, { recursive: true });
    writeFileSync(join(pendDir, 'append-audit-harness-sync.json'), JSON.stringify(event) + '\n');
    log(`harness_sync audit queued: ${risk.synced.length} synced file(s) excluded from risk`);
  } catch { /* observability only */ }
}

// I/O bounds. The dispatcher (commit-gates.mjs) kills a gate that exceeds its time/output budget
// and then FAILS CLOSED — a gate that cannot render a verdict blocks the commit. That closes the
// old drive-the-gate-over-budget review bypass, but it also turns an over-budget gate into a block
// on EVERY commit, so this gate must still stay inside those budgets on attacker-controlled files:
//   - readBounded opens with O_NOFOLLOW|O_NONBLOCK and fstat-checks the OPEN fd: a symlink (even
//     symlink→regular-file) fails the open, a FIFO/device/socket opens without blocking and is
//     rejected as not-a-regular-file. Evidence must be a plain regular file, nothing else.
//   - the read itself is capped at MAX_EVIDENCE_BYTES by a fixed-size readSync — a pre-read stat
//     check alone would race a concurrently growing file (see readBounded). A real sidecar/flag
//     is a one-line tuple, well under 1KiB.
//   - the docs/reviews scan is incremental and bounded: more than MAX_SIDECARS same-day sidecars
//     BLOCKS the moment the cap is crossed (an implausible volume that could push covering
//     evidence out of any bounded window — no subset selection, no push-out bypass), and more
//     than MAX_SCAN_ENTRIES directory entries of ANY name BLOCKS outright (see the scan below).
//   - never print more than MAX_FILE_WARNINGS per-file diagnostics (the rest are summarized).
// Rejected/unreadable files are IGNORED, which grants nothing — fail-closed.
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_SIDECARS = 32;
const MAX_SCAN_ENTRIES = 10000; // total docs/reviews entries the gate will enumerate before failing closed
const MAX_FILE_WARNINGS = 5;
function readBounded(path) {
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { ok: false, why: 'not a regular file (FIFO/device/socket rejected)' };
    // The size cap rides on the READ, not on a pre-read stat: readFileSync(fd) re-stats internally
    // and reads to EOF, so a file that grows between a stat check and the read (concurrent append)
    // would be read whole. POSIX permits short reads before EOF, so keep filling the fixed MAX+1
    // buffer until it is full or readSync returns zero; a short read can neither masquerade as EOF
    // nor hide overflow, and concurrent growth can never make the gate read beyond the buffer.
    const buf = Buffer.allocUnsafe(MAX_EVIDENCE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buf.length) {
      const n = readSync(fd, buf, bytesRead, buf.length - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead > MAX_EVIDENCE_BYTES) return { ok: false, why: `implausibly large (max ${MAX_EVIDENCE_BYTES} bytes) — a real tuple is one short line` };
    return { ok: true, text: buf.toString('utf-8', 0, bytesRead) };
  } catch (e) {
    return { ok: false, why: e && e.code === 'ELOOP' ? 'a symlink (evidence must be a plain regular file)' : 'the file could not be read' };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already reported */ }
  }
}

// The estimate reads below share this discipline (see the block that follows): the record via
// readBounded, the breadcrumb log via readTailBounded — same open flags, same isFile() check, no
// blocking open, no symlink following. A FIFO planted at either path would otherwise block the
// open past the dispatcher's kill and turn an observation-only step into a fail-closed BLOCK.
// Returns { text, partial }: `partial` is true when the window starts inside the file, so the first
// line may be cut and the counter must drop it.
function readTailBounded(path, tailBytes) {
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { text: '', partial: false };
    const start = Math.max(0, st.size - tailBytes);
    const buf = Buffer.alloc(Math.min(st.size, tailBytes));
    let bytesRead = 0;
    while (bytesRead < buf.length) {
      const n = readSync(fd, buf, bytesRead, buf.length - bytesRead, start + bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    return { text: buf.toString('utf-8', 0, bytesRead), partial: start > 0 };
  } catch {
    return { text: '', partial: false };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* nothing to report */ }
  }
}

// Estimate-vs-actual (seed 20260918-023000-e5a1, .omp/rules/harness-cycle_definition.md "예상 레코드"): pair the
// intake's prediction with the measured risk. Observation ONLY — placed before the low-risk exit so
// every landed commit is compared, wrapped so no failure here can reach the verdict, and deferred
// through pending-consume so the record is recorded and consumed iff the commit lands. A malformed
// record costs exactly one warning and stays on disk (a blocked observation must never block work).
if (isHookMode) {
  try {
    const estimatePath = join(stateDir, ESTIMATE_FILE);
    // lstat, not existsSync: existsSync follows links, so a dangling or self-looping symlink at the
    // record path read as "absent" and was skipped silently. Any entry — file, FIFO, symlink — is
    // handed to readBounded, which decides and names the reason.
    let present = false;
    try { lstatSync(estimatePath); present = true; } catch { /* ENOENT: no record this cycle */ }
    if (present) {
      const rec = readBounded(estimatePath);
      const { fields, problems } = rec.ok ? parseEstimate(rec.text) : { fields: null, problems: [rec.why] };
      if (fields) {
        const tail = readTailBounded(join(stateDir, 'session-log.jsonl'), SESSION_LOG_TAIL_BYTES);
        const event = buildEstimateEvent(fields, risk, countFailsSince(tail.text, fields.ts, tail.partial), process.env.USER || 'unknown');
        const pendDir = join(stateDir, 'pending-consume');
        mkdirSync(pendDir, { recursive: true });
        // 'wx' (O_CREAT|O_EXCL): the dispatcher cleared this directory at the start of the attempt,
        // so a pre-existing entry here is foreign (a planted FIFO/symlink the clear could not remove)
        // and O_EXCL fails it with EEXIST at once instead of blocking the open past the 3s budget.
        writeFileSync(join(pendDir, 'append-audit-estimate.json'), JSON.stringify(event) + '\n', { flag: 'wx' });
        writeFileSync(join(pendDir, `unlink-${ESTIMATE_FILE}`), `.omp/harness-state/${ESTIMATE_FILE}\n`, { flag: 'wx' });
        log(`estimate_vs_actual queued: predicted ${fields.risk}/${fields.files} files, actual ${risk.level}/${risk.files.length} files`);
      } else {
        // One line, always: a parse error echoes record text, so newlines are collapsed (a record
        // could otherwise print a second line shaped like a gate verdict).
        const why = problems.join('; ').replace(/[\r\n]+/g, ' ');
        console.error(`HARNESS WARNING: .omp/harness-state/${ESTIMATE_FILE} is not a valid estimate record (${why}); ignoring it — fix or delete the file (it is not consumed).`);
      }
    }
  } catch (e) {
    // Only the pending-consume writes can throw here (the reads never do). Say so on stderr:
    // silence would hide a record that is never going to be compared or consumed.
    console.error(`HARNESS WARNING: estimate comparison skipped (${e?.message || e}); the record was not consumed.`);
    log(`estimate comparison skipped: ${e?.message || e}`);
  }
}

if (risk.level === 'low' || risk.level === 'none') {
  log('Low/no risk, review not required');
  process.exit(0);
}

const reviewDir = join(cwd, 'docs', 'reviews');
const skipFile = join(cwd, 'docs', 'harness', 'review-skip');

// LOCAL date (not toISOString's UTC): reviewer docs are named by the author's local
// date, so a UTC "today" mismatched real reviews between local midnight and the UTC
// offset (e.g. 00:00–08:59 KST → still "yesterday" in UTC), falsely failing coverage.
// The scan window is today AND yesterday (#48-2): a sidecar written at 23:5x for a commit
// that lands after midnight is still the SAME diff — the hash binding (diff_hash ===
// currentHash) is what makes evidence relevant, the date only bounds the scan. Two days is
// the smallest window that removes the midnight edge; older sidecars stay out so a stale
// covering FAIL/PASS for an identical re-staged diff does not resurface weeks later.
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const today = localDate(now);
const yesterday = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
const inWindow = (f) => (f.startsWith(`review-${today}`) || f.startsWith(`review-${yesterday}`)) && f.endsWith('.json');

// Hash the EFFECTIVE committed diff. Computed BEFORE the override check because the override must
// bind to this hash, and every BLOCK message prints it so evidence can be written from the message
// alone. parseCommitForm tells us which diff the commit will capture:
//   all=true (-a/--all) -> all tracked changes  (git diff HEAD)
//   else (plain)        -> the staged index     (git diff --cached)
// This closes the gap where `git commit -a` pulled in tracked changes the staged-diff
// hash never saw, letting a stale PASS review match the wrong content. Every other
// form (pathspec, --amend, --include/-i, -p, --pathspec-from-file, a commit behind
// bash -c, >1 commit in one line, or a repo-redirecting global like -C) is UNVERIFIABLE:
// currentHash stays null and the gate fails closed on high/critical (see the
// matchedCurrent !== true branch below). execSync runs through a shell, so the pipe
// needs no `shell` option; both diff commands are constant (no user input on the line).
let currentHash = null;
const diffCmd = form.all ? 'git diff HEAD' : 'git diff --cached';
if (form.verifiable) {
  try {
    currentHash = execSync(`${diffCmd} | shasum -a 256`, { cwd, encoding: 'utf-8' }).trim().split(/\s+/)[0];
  } catch {
    currentHash = null;
  }
}

// Audited override (path 3). The flag file is the single write surface; the gate itself appends
// the audit event so the record cannot be forgotten. A valid override is consumed (unlink) and
// bypasses the remaining checks — including a covering FAIL — because it is the APPROVAL axis:
// the named approver accepts the risk on the record (cf. .omp/rules/harness-adversarial_review.md override).
// An INVALID flag fails closed on high/critical (it is kept in place so it can be fixed, not
// retyped); on medium it is ignored with a warning since medium never required review anyway.
//
// `-a/--all` TOCTOU (NON-HOOK path only): outside hook mode, consuming an override APPENDS
// to docs/harness/audit.jsonl and UNLINKS the flag BEFORE the commit runs. In hook mode both
// writes are DEFERRED to .githooks/post-commit (see the isHookMode branch below), so the
// sweep hazard described here cannot arise there — and hook mode never reports `all`, which
// makes the guard below unreachable from the hook path by construction.
// If either file is git-TRACKED, `git commit -a` sweeps those writes into the commit itself, so
// the committed diff would no longer be the diff the approver hashed. When that sweep is possible
// the override CANNOT be consumed for the -a form: high/critical fails closed with "stage + plain
// git commit" guidance (matching the gate's existing stance on odd commit forms), medium warns and
// ignores the flag (the flag is NOT consumed either way). Trackedness is checked live with
// `git ls-files` (in THIS repo audit.jsonl is tracked; review-skip is gitignored) — a repo that
// ignores both files has no sweep and keeps the -a override; a failed check fails closed.
if (existsSync(skipFile)) {
  let parsed;
  try {
    const r = readBounded(skipFile);
    parsed = r.ok ? parseOverride(r.text, currentHash, form)
      : { fields: null, problems: [`the flag file is ${r.why}`] };
  } catch {
    parsed = { fields: null, problems: ['the flag file could not be validated'] };
  }
  const { fields, problems } = parsed;
  let swept = [];
  if (problems.length === 0 && form.all) {
    try {
      swept = execSync('git ls-files -- docs/harness/audit.jsonl docs/harness/review-skip', { cwd, encoding: 'utf-8' })
        .split('\n').filter(Boolean);
    } catch {
      swept = ['docs/harness/audit.jsonl (tracking state unknown — failing closed)'];
    }
  }
  if (swept.length > 0) {
    if (risk.level === 'critical' || risk.level === 'high') {
      log(`BLOCKED: valid review-skip override, but git commit -a would sweep the gate's own writes (${swept.join(', ')}) into the commit`);
      console.error(`HARNESS BLOCK: the audited override cannot be consumed under \`git commit -a/--all\`: recording it writes ${swept.join(' and ')} (git-tracked) BEFORE the commit runs, so -a would sweep those writes into the commit and the committed diff would no longer match the approved diff_hash.`);
      console.error('Stage exactly what you intend to ship (git add ...), then use a plain `git commit`; the flag was NOT consumed and its diff_hash must match the STAGED diff (git diff --cached | shasum -a 256).');
      process.exit(2);
    }
    log('WARNING: valid review-skip override ignored under git commit -a (tracked audit/flag sweep); medium risk proceeds without it');
    console.error('HARNESS WARNING: docs/harness/review-skip is valid but cannot be consumed under `git commit -a` (the gate\'s audit/flag writes are git-tracked and would be swept into the commit); ignoring it — use a plain `git commit` of the staged diff to consume it.');
  } else if (problems.length === 0) {
    const harnessDir = join(cwd, 'docs', 'harness');
    mkdirSync(harnessDir, { recursive: true });
    const event = {
      ts: new Date().toISOString(),
      event: 'review_override',
      actor: fields.approvedBy,
      meta: { reason: fields.reason, diff_hash: currentHash || 'UNVERIFIABLE', risk: risk.level, risk_reason: risk.reason },
    };
    if (isHookMode) {
      // Deferred consumption (test-attack B-4): the pre-commit verdict may precede a commit
      // that never lands (empty-message abort). Leave the flag in place and write the
      // consumption INTENT; the post-commit backstop executes it once the commit exists —
      // and the verdict itself never mutates tracked files (U4 contract).
      const pendDir = join(cwd, '.omp', 'harness-state', 'pending-consume');
      mkdirSync(pendDir, { recursive: true });
      writeFileSync(join(pendDir, 'append-audit-review-override.json'), JSON.stringify(event) + '\n');
      writeFileSync(join(pendDir, 'unlink-review-skip'), 'docs/harness/review-skip\n');
      log(`review override accepted (approved_by: ${fields.approvedBy}), consumption deferred to post-commit`);
      console.error(`HARNESS NOTE: review override by ${fields.approvedBy} accepted — it will be recorded in docs/harness/audit.jsonl and consumed when the commit lands.`);
    } else {
      appendFileSync(join(harnessDir, 'audit.jsonl'), JSON.stringify(event) + '\n');
      unlinkSync(skipFile);
      log(`review override accepted (approved_by: ${fields.approvedBy}), audited + consumed`);
      console.error(`HARNESS NOTE: review override by ${fields.approvedBy} accepted — recorded as review_override in docs/harness/audit.jsonl; flag consumed.`);
    }
    process.exit(0);
  } else if (risk.level === 'critical' || risk.level === 'high') {
    log(`BLOCKED: invalid review-skip override (${problems.join('; ')})`);
    console.error(`HARNESS BLOCK: docs/harness/review-skip exists but is not a valid audited override — ${problems.join('; ')}.`);
    console.error([
      'An audited override is ONE JSON tuple (fix the file in place, it was NOT consumed):',
      `  ["omp-review-override/v1", "<why review is being skipped>", "<who accepts the risk>", "${currentHash || 'UNVERIFIABLE'}"]`,
      'Or delete the file and provide review evidence instead (reviewer agent / human review — see below).',
      evidenceHelp(currentHash, today, diffCmd),
    ].join('\n'));
    process.exit(2);
  } else {
    log(`WARNING: invalid review-skip override ignored on ${risk.level} risk (${problems.join('; ')})`);
    console.error(`HARNESS WARNING: docs/harness/review-skip is not a valid audited override (${problems.join('; ')}); ignoring it.`);
  }
}

// Machine evidence: the .json sidecars of today and yesterday (local date) ONLY. Same-basename
// .md files are human reports the gate never reads. Invalid sidecars are warned about and
// IGNORED (they grant nothing and they veto nothing) — fail-closed both ways.
//
// The scan is INCREMENTAL (opendirSync) with two fail-closed bounds, so the enumeration work
// itself stays bounded — a readdirSync of the whole directory would materialize and sort every
// entry BEFORE any cap could run, so a big enough flood could push the gate past the dispatcher
// budget without the cap ever firing (3rd-round review):
//   - the moment the (MAX_SIDECARS+1)th in-window sidecar is seen the gate BLOCKS: selecting any
//     bounded subset would let an attacker push a covering FAIL out of the window while a
//     covering PASS stays in (2nd-round review, CRITICAL 3), and no plausible legitimate day
//     produces this many sidecars;
//   - the moment the (MAX_SCAN_ENTRIES+1)th directory entry of ANY name is seen the gate BLOCKS:
//     a real docs/reviews/ is orders of magnitude smaller, so this only fires on a flood of
//     non-matching names built to burn the enumeration budget.
// Only the <= MAX_SIDECARS surviving matches are sorted — deterministic processing order.
let todaySidecars = [];
if (existsSync(reviewDir)) {
  let dirh = null;
  try {
    dirh = opendirSync(reviewDir);
    let scanned = 0;
    for (let ent = dirh.readSync(); ent !== null; ent = dirh.readSync()) {
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) {
        log(`BLOCKED: docs/reviews holds more than ${MAX_SCAN_ENTRIES} entries`);
        console.error(`HARNESS BLOCK: docs/reviews/ holds more than ${MAX_SCAN_ENTRIES} entries — an implausible volume the gate refuses to enumerate, so it fails closed. Clean docs/reviews/ and retry.`);
        process.exit(2);
      }
      const f = ent.name;
      if (!inWindow(f)) continue;
      todaySidecars.push(f);
      if (todaySidecars.length > MAX_SIDECARS) {
        log(`BLOCKED: ${todaySidecars.length} sidecars in the two-day window exceed the scan cap (${MAX_SIDECARS})`);
        console.error(`HARNESS BLOCK: ${todaySidecars.length} sidecars named review-${yesterday}*.json / review-${today}*.json exceed the scan cap (${MAX_SIDECARS}) — an implausible volume that could hide covering evidence, so the gate fails closed. Clean docs/reviews/ down to the real review sidecars of the last two days and retry.`);
        process.exit(2);
      }
    }
  } catch {
    console.error('HARNESS WARNING: docs/reviews could not be listed; treating as no evidence.');
    todaySidecars = [];
  } finally {
    if (dirh !== null) try { dirh.closeSync(); } catch { /* nothing left to release */ }
  }
  todaySidecars.sort();
}

const evidences = [];
let warned = 0;
const warnFile = (f, why) => {
  log(`WARNING: sidecar ${f} ignored (${why})`);
  if (warned < MAX_FILE_WARNINGS) console.error(`HARNESS WARNING: docs/reviews/${f} is not a valid evidence tuple (${clip(why, 300)}); ignoring it.`);
  warned += 1;
};
for (const f of todaySidecars) {
  const r = readBounded(join(reviewDir, f));
  if (!r.ok) {
    warnFile(f, `the file is ${r.why}`);
    continue;
  }
  let parsed;
  try {
    parsed = parseEvidence(r.text);
  } catch {
    parsed = { ok: false, problems: ['the file could not be validated'] }; // belt-and-braces: a parser bug must not crash the gate — the dispatcher fails closed on a crash, blocking every commit until the gate is fixed
  }
  if (!parsed.ok) {
    warnFile(f, parsed.problems.join('; '));
    continue;
  }
  evidences.push({ name: f, ev: parsed });
}
if (warned > MAX_FILE_WARNINGS) console.error(`HARNESS WARNING: ${warned - MAX_FILE_WARNINGS} more invalid sidecar(s) ignored (diagnostics suppressed).`);

if (evidences.length === 0) {
  if (risk.level === 'critical' || risk.level === 'high') {
    log(`BLOCKED: ${risk.level} risk with no valid review evidence`);
    console.error(`HARNESS BLOCK: ${risk.level} risk changes (${risk.reason}) require review evidence.`);
    console.error(evidenceHelp(currentHash, today, diffCmd));
    process.exit(2);
  }
  log(`WARNING: ${risk.level} risk with no review evidence`);
  console.error(`HARNESS WARNING: ${risk.level} risk changes without review. Consider running reviewer agent.`);
  process.exit(0);
}

const { hasFail, matchedCurrent, matchedHet, matchedHuman } = evaluateEvidence(evidences, currentHash);

// A FAIL verdict covering the current diff blocks regardless of risk level.
if (hasFail) {
  log('BLOCKED: a review verdict is FAIL for the current changes');
  console.error('HARNESS BLOCK: a review verdict is FAIL for the current changes. Fix issues before committing.');
  process.exit(2);
}

// Evidence must positively cover this diff. matchedCurrent === true means a today sidecar carries
// the current diff hash with a PASS-whitelist verdict (and, by schema, a valid evidence axis —
// >=2-family models or a human identity). Both false (no match) and null (hash could not be
// computed) mean "unverified" — high/critical fails closed, matching the harness's
// fail-closed-on-unknown stance (cf. backpressure-gate). The audited override (handled above) is
// the deliberate, recorded escape hatch.
if (matchedCurrent !== true) {
  const detail = currentHash
    ? 'no valid review evidence matches the current changes'
    : (form.verifiable
        ? 'could not compute the diff hash (git/shasum error)'
        : 'the commit form is unverifiable (an output redirection like `2>&1`, a compound `&&`/`;` line, a pathspec, --amend, or -a with unstaged changes) — run a STANDALONE `git commit` (no trailing `2>&1`/`; …`, no `cd … &&` prefix) so the staged diff can be hashed');
  if (risk.level === 'critical' || risk.level === 'high') {
    log(`BLOCKED: ${detail}`);
    console.error(`HARNESS BLOCK: ${detail}.`);
    console.error(evidenceHelp(currentHash, today, diffCmd));
    process.exit(2);
  }
  log(`WARNING: ${detail}`);
  console.error(`HARNESS WARNING: ${detail}. Consider re-running reviewer.`);
}

log(`Review check passed (${evidences.length} valid today, matchedCurrent=${matchedCurrent}, het=${matchedHet}, human=${matchedHuman})`);
process.exit(0);
