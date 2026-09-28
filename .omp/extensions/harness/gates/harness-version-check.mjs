#!/usr/bin/env node
// harness-version-check.mjs - drift probe (SessionStart + turn-start reminder + post-commit recheck)
// Purpose: Notify when local harness is behind the source remote, and TELL the
// agent to resolve it via /skill:harness-check (resolution beats reporting).
//
// Skip logic: if harness-meta.json has no `source_remote`, this IS the source
// repo. Consumer projects get `source_remote` + `commit_sha` written by the
// bootstrap skill.
//
// Version compare: primary = tag name (harness/YYYY.N), fallback = commit SHA.
// Cache: .omp/state/harness-version-check.json — 24h default window; callers may
// pass a smaller `max_age_ms` in the stdin payload (turn-start/commit rechecks use
// 1h). Failed probes write a short-lived marker (FAILURE_TTL_MS) so per-turn
// callers never re-stall on a dead network every invocation.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;   // shared by the hooks-inactive and policy-shadow probes

let stdin = '';
try { stdin = readFileSync(0, 'utf-8'); } catch { /* no stdin is fine */ }
let data = {};
try { data = JSON.parse(stdin); } catch { /* ignore */ }

const force = process.argv.includes('--force');
const cwd = data?.session_state?.cwd || process.cwd();

// Freshness window: stdin payload `max_age_ms` overrides the 24h default (0 = always refetch).
const rawMaxAge = data?.max_age_ms;
const maxAgeMs = typeof rawMaxAge === 'number' && Number.isFinite(rawMaxAge) && rawMaxAge >= 0 ? rawMaxAge : CACHE_TTL_MS;

// Log rotation: rotate hook-debug.log if it exceeds 1MB
const debugLogPath = join(cwd, '.omp', 'harness-state', 'hook-debug.log');
try {
  if (existsSync(debugLogPath) && statSync(debugLogPath).size > 1048576) {
    renameSync(debugLogPath, debugLogPath + '.old');
  }
} catch { /* ignore rotation errors */ }

const metaPath = join(cwd, '.omp/extensions/harness/harness-meta.json');
if (!existsSync(metaPath)) process.exit(0);

let meta;
try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch { process.exit(0); }
// Hook activation probe (#26): `core.hooksPath` is LOCAL git config, so no file sync
// (init template copy, harness-sync) can ever propagate it. A repo that ships
// `.githooks/` but never pointed git at it has the whole commit/push gate layer
// declared in AGENTS.md silently dead. Runs before the source-repo skip on purpose:
// the probe is one `git config` read and applies to every repo carrying hooks.
emitIfHooksInactive(cwd);
// Policy shadow probe (#35): OMP's native provider (priority 100) REPLACES a root
// AGENTS.md at the same depth when a non-empty `.omp/AGENTS.md` exists, so the harness
// policy is silently absent from the session. Runs before the source-repo skip.
emitIfPolicyShadowed(cwd);

const sourceRemote = meta.source_remote;
if (!sourceRemote) process.exit(0);

const cachePath = join(cwd, '.omp/state/harness-version-check.json');
const now = Date.now();

if (!force && existsSync(cachePath)) {
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const window = cached.failed ? FAILURE_TTL_MS : maxAgeMs;
    // A checkedAt in the FUTURE means the wall clock stepped backwards since the cache was written
    // (WSL2 measured: -1.8s steps). `now - checkedAt` is then negative and satisfies ANY window,
    // including max_age_ms 0 — the caller asked for a refetch and got a stale hit. Treat it as stale.
    const age = now - cached.checkedAt;
    if (cached.checkedAt && age >= 0 && age < window) {
      // A failure marker preserves the last-known remote info (below) — a KNOWN drift
      // keeps being reported through failure windows instead of going silent for
      // FAILURE_TTL_MS; only the re-probe is backed off.
      if (cached.remoteLatestVersion) emitIfDrift(meta, cached);
      process.exit(0);
    }
  } catch { /* stale/corrupt cache — refetch */ }
}

let remote;
try {
  const output = execFileSync(
    'git',
    ['ls-remote', '--tags', sourceRemote, 'refs/tags/harness/*'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
  );
  remote = parseRemoteTags(output);
} catch {
  // Network/auth failure: record a short-lived failure marker so frequent callers
  // (turn-start recheck) back off instead of stalling on ls-remote every time.
  // Carry over the previous cache's remote fields — never clobber last-known-good
  // drift data with a bare marker — and still EMIT a known drift on this very call:
  // a failed probe must never silence a directive we already know applies.
  let keep = {};
  try {
    const prev = JSON.parse(readFileSync(cachePath, 'utf-8'));
    if (prev && typeof prev === 'object') keep = prev;
  } catch { /* no prior cache */ }
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ ...keep, checkedAt: now, failed: true, source: sourceRemote }, null, 2));
  } catch { /* ignore cache write failure */ }
  if (keep.remoteLatestVersion) emitIfDrift(meta, keep);
  process.exit(0);
}

if (!remote?.remoteLatestVersion) process.exit(0);

try {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    checkedAt: now,
    remoteLatestVersion: remote.remoteLatestVersion,
    remoteLatestSha: remote.remoteLatestSha,
    source: sourceRemote,
  }, null, 2));
} catch { /* ignore cache write failure */ }

emitIfDrift(meta, remote);
process.exit(0);

function parseRemoteTags(output) {
  const re = /^([0-9a-f]{40})\s+refs\/tags\/harness\/(\d{4})\.(\d+)(\^\{\})?$/gm;
  let best = null;
  let m;
  while ((m = re.exec(output)) !== null) {
    const [, sha, yr, seq, caret] = m;
    const version = `${yr}.${seq}`;
    const peeled = Boolean(caret);
    // Annotated tags list the tag-object line before the peeled `^{}` line; prefer the
    // peeled COMMIT sha on equal rank — harness-sync stores `rev-parse HEAD` (a commit
    // sha) in meta, so comparing against the tag-object sha would report drift forever.
    if (!best || versionGreater(version, best.version) || (version === best.version && peeled && !best.peeled)) {
      best = { version, sha, peeled };
    }
  }
  return best ? { remoteLatestVersion: best.version, remoteLatestSha: best.sha } : null;
}

// (year, seq) tuple compare — no arithmetic packing, so seq never overflows the year.
function versionParts(v) {
  const m = /^(\d{4})\.(\d+)$/.exec(v || '');
  return m ? [+m[1], +m[2]] : null;
}
function versionGreater(a, b) {
  const x = versionParts(a), y = versionParts(b);
  if (!x || !y) return false;
  return x[0] !== y[0] ? x[0] > y[0] : x[1] > y[1];
}

function emitIfDrift(localMeta, remoteInfo) {
  const lv = localMeta.version;
  const rv = remoteInfo.remoteLatestVersion;
  const lsha = localMeta.commit_sha;
  const rsha = remoteInfo.remoteLatestSha;

  const primaryDrift = versionGreater(rv, lv);
  const fallbackDrift = !primaryDrift && lsha && rsha && lsha !== rsha;

  if (primaryDrift) {
    console.log(`HARNESS STALE: local harness ${lv} → remote ${rv}. Before starting the next task, run /skill:harness-check to sync (working tree dirty? ask the user first). Do not silently ignore this.`);
  } else if (fallbackDrift) {
    console.log(`HARNESS DRIFT: version matches (${lv}) but commit SHA differs from source. Before starting the next task, run /skill:harness-check (working tree dirty? ask the user first).`);
  }
}

// Emit at most once per NOTICE_TTL_MS (marker: .omp/state/harness-hooks-check.json)
// unless --force. Silent when: no `.githooks/` dir, not a git work tree, or
// core.hooksPath already resolves to that directory. Never throws, never exits.
function emitIfHooksInactive(root) {
  const hooksDir = join(root, '.githooks');
  if (!existsSync(hooksDir)) return;

  let top;
  try {
    top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch { return; }
  if (!top) return;

  let configured = '';
  try {
    configured = execFileSync('git', ['-C', root, 'config', '--get', 'core.hooksPath'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch { /* unset => exit 1 => stays '' */ }
  // A relative hooksPath is resolved by git against the work-tree top. Compare REAL paths:
  // `--show-toplevel` is canonical while `root` may be a symlinked session cwd (review 2026-09-05).
  const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
  if (configured && real(resolve(top, configured)) === real(hooksDir)) return;

  const markerPath = join(root, '.omp/state/harness-hooks-check.json');
  if (noticeThrottled(markerPath)) return;
  writeNoticeMarker(markerPath, { configured: configured || null });

  const state = configured ? `points at \`${configured}\`` : 'is not set';
  console.log(`HARNESS HOOKS INACTIVE: .githooks/ exists but core.hooksPath ${state}, so the pre-commit/pre-push gates declared in AGENTS.md never run. Before the next commit, run \`git config core.hooksPath .githooks\` (local git setting — file sync alone cannot carry it) or /skill:harness-check, whose sync sets it idempotently and verifies the effective value.`);
}

// Emit at most once per NOTICE_TTL_MS (marker: .omp/state/harness-policy-check.json)
// unless --force. Silent when there is nothing to shadow. Never throws, never exits.
//
// Measured on omp 18.2.5 (`omp -p --no-extensions` marker probes, 2026-09-23):
//   - a `.omp/AGENTS.md` with ANY bytes — content, a single newline, whitespace only — displaces
//     the same-depth root AGENTS.md; only a 0-byte file is ignored by the native provider. The
//     probe therefore keys on size > 0, never on trimmed content (review round 4).
//   - a project `.omp/RULES.md` and the user `~/.omp/agent/RULES.md` are BOTH loaded (the docs'
//     "same rule name RULES, user wins" collision no longer holds), so `.omp/RULES.md` is a valid
//     consumer extension point and is NOT probed.
function emitIfPolicyShadowed(root) {
  if (!existsSync(join(root, 'AGENTS.md'))) return;
  let st;
  try { st = statSync(join(root, '.omp', 'AGENTS.md')); } catch { return; }
  if (!st.isFile() || st.size === 0) return;   // a directory of that name is not a context file

  const markerPath = join(root, '.omp/state/harness-policy-check.json');
  if (noticeThrottled(markerPath)) return;
  writeNoticeMarker(markerPath, { file: '.omp/AGENTS.md' });

  console.log('HARNESS POLICY SHADOWED: `.omp/AGENTS.md` exists, so OMP\'s native provider (priority 100) replaces `AGENTS.md` at the same depth — the harness policy is NOT in this session\'s context. Move its content to `.omp/rules/<project>-context.md` (frontmatter `alwaysApply: true`), delete `.omp/AGENTS.md`, then restart the session (/new) so the policy loads (AGENTS.md "Consumer extension points").');
}

// Notice window shared by the health probes: true when a marker inside NOTICE_TTL_MS exists and
// --force is absent. A stale, corrupt, or FUTURE-dated marker (wall clock stepped back, or a
// hand-written suppressor) re-emits — same rule as the drift cache above.
function noticeThrottled(markerPath) {
  if (force || !existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    const age = Date.now() - marker.notifiedAt;
    return Boolean(marker.notifiedAt) && age >= 0 && age < NOTICE_TTL_MS;
  } catch { return false; }
}

function writeNoticeMarker(markerPath, extra) {
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ notifiedAt: Date.now(), ...extra }, null, 2));
  } catch { /* ignore marker write failure */ }
}
