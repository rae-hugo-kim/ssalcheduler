#!/usr/bin/env node
// risk-assess.mjs - Shared risk assessment module for harness gates
// Not a hook itself — imported by other hooks.
// Usage: import { assessRisk } from './risk-assess.mjs';

import { execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, lstatSync } from 'fs';
import { join } from 'path';

// harness-sync provenance (handoff 2026-09-02, option C; hardened after reviews 2026-09-05).
// The sync writes the tag checkout's whitelisted paths as blob/tree objects into this repo's
// object store and pins them with `refs/harness/<ver>` (the authority; the two newest versions
// are kept). harness-manifest.json is an index for humans that names the version. A changed
// file is EXCLUDED from risk scoring only when
//   1. its path is a harness asset path (the sync whitelist shape — nothing under src/ etc.
//      can ever be exempted, whatever a manifest claims),
//   2. the manifest names the HIGHEST refs/harness/* version present and its tree_sha is
//      exactly that ref's tree (a stale manifest cannot re-arm an older tree — no downgrade;
//      a manifest naming a ref this repo does not have exempts nothing),
//   3. the committed entry (index for a staged commit; worktree content for -a; both for an
//      unverifiable form) has the SAME blob sha AND mode as that tree at the path — or the
//      entry deletes a path that the PREVIOUS synced tree carried and the current one does not
//      (an upstream removal; a consumer-owned file under a harness prefix was never in any
//      synced tree, so deleting it is scored).
// Only the remaining files decide the level, so user code mixed into a sync commit, or a
// synced file edited in place, is scored exactly as before. Forging this needs blob/tree
// objects written and a ref moved by hand inside the repo — deliberate, outside the threat
// model (a hasty agent, not an evasive adversary).
const MANIFEST_REL = '.omp/extensions/harness/harness-manifest.json';

// Mirrors scripts/harness-version-bump.sh HARNESS_PATHS (the shape of the sync whitelist).
// "dir/" entries are prefixes; glob entries match the basename only (never across "/");
// others exact. Kept static on purpose: the gate must not read the whitelist from a
// worktree file it is trying not to trust.
const HARNESS_ASSET_PATHS = [
  'checklists/', 'templates/', '.omp/rules/harness-*.md', 'AGENTS.md', 'INDEX.md', 'EXAMPLES.md',
  '.omp/extensions/harness/', '.githooks/', 'scripts/harness-version-bump.sh', 'scripts/harness-sync.sh',
  'scripts/harness-audit.sh', 'scripts/test-harness-audit.sh', '.omp/skills/', '.omp/agents/',
  'docs/rules/', 'docs/prompt-writing-handbook.md', 'docs/templates/', 'docs/checklists/',
];
const globToRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
const isHarnessAssetPath = (f) => HARNESS_ASSET_PATHS.some((p) =>
  (p.includes('*') || p.includes('?')) ? globToRe(p).test(f) : p.endsWith('/') ? f.startsWith(p) : f === p);

function readManifest(cwd) {
  const p = join(cwd, MANIFEST_REL);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8'));
    if (!m || typeof m !== 'object') return null;
    if (typeof m.version !== 'string' || !/^\d{4}\.\d+$/.test(m.version)) return null;
    if (typeof m.tree_sha !== 'string' || !/^[0-9a-f]{40}$/.test(m.tree_sha)) return null;
    return { version: m.version, treeSha: m.tree_sha };
  } catch { return null; }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// Version order as a (year, seq) tuple — no arithmetic packing, so seq never overflows the year.
const versionParts = (v) => { const m = /^(\d{4})\.(\d+)$/.exec(v || ''); return m ? [+m[1], +m[2]] : null; };
const compareVersions = (a, b) => { const x = versionParts(a), y = versionParts(b); return (x[0] - y[0]) || (x[1] - y[1]); };

// refs/harness/* present in this repo, highest version first.
function provenanceRefs(cwd) {
  try {
    return git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/harness/'])
      .split('\n').filter(Boolean)
      .map((r) => ({ ref: r, version: r.slice('refs/harness/'.length) }))
      .filter((r) => versionParts(r.version) !== null)
      .sort((a, b) => compareVersions(b.version, a.version));
  } catch { return []; }
}

// The manifest must name the HIGHEST provenance ref and match its tree exactly.
// Returns { current, previous } refs or null.
function verifiedTrees(cwd, manifest) {
  const refs = provenanceRefs(cwd);
  if (refs.length === 0 || refs[0].version !== manifest.version) return null;
  try {
    const tree = git(cwd, ['rev-parse', '-q', '--verify', `${refs[0].ref}^{tree}`]).trim();
    if (tree !== manifest.treeSha) return null;
  } catch { return null; }
  return { current: refs[0].ref, previous: refs[1]?.ref ?? null };
}

// path -> { mode, sha } in the tag's tree for the given paths (missing paths are absent).
function tagEntries(cwd, ref, files) {
  const out = new Map();
  try {
    const text = git(cwd, ['ls-tree', '-r', '-z', ref, '--', ...files]);
    for (const rec of text.split('\0')) {
      const m = /^(\d{6}) blob ([0-9a-f]{40})\t(.+)$/.exec(rec);
      if (m) out.set(m[3], { mode: m[1], sha: m[2] });
    }
  } catch { /* leave empty: nothing matches, nothing is excluded */ }
  return out;
}

// path -> { mode, sha } for the staged index entries of `files` (stage 0 only).
function indexEntries(cwd, files) {
  const out = new Map();
  try {
    const text = git(cwd, ['ls-files', '-s', '-z', '--', ...files]);
    for (const rec of text.split('\0')) {
      const m = /^(\d{6}) ([0-9a-f]{40}) 0\t(.+)$/.exec(rec);
      if (m) out.set(m[3], { mode: m[1], sha: m[2] });
    }
  } catch { /* leave empty */ }
  return out;
}

// path -> blob sha of the WORKTREE content of `files` (missing/deleted files are absent).
function worktreeBlobs(cwd, files) {
  const out = new Map();
  const present = files.filter((f) => existsSync(join(cwd, f)));
  if (present.length === 0) return out;
  try {
    const shas = git(cwd, ['hash-object', '--', ...present]).trim().split('\n');
    present.forEach((f, i) => { if (/^[0-9a-f]{40}$/.test(shas[i] || '')) out.set(f, shas[i]); });
  } catch { /* leave empty */ }
  return out;
}

// Returns the subset of changedFiles that are byte-exact synced copies of the verified tree.
// `ranges` is diffRanges(form): '--cached' means the index is what gets committed, 'HEAD'
// means the worktree is; the unverifiable union requires BOTH to match.
function syncedSubset(cwd, changedFiles, ranges) {
  const manifest = readManifest(cwd);
  if (!manifest) return { synced: [], version: null };
  const refs = verifiedTrees(cwd, manifest);
  if (!refs) return { synced: [], version: manifest.version, unverified: true };
  const candidates = changedFiles.filter(isHarnessAssetPath);
  if (candidates.length === 0) return { synced: [], version: manifest.version };

  const needIndex = ranges.includes('--cached');
  const needTree = ranges.includes('HEAD') || ranges.includes('');
  const current = tagEntries(cwd, refs.current, candidates);
  const previous = refs.previous ? tagEntries(cwd, refs.previous, candidates) : new Map();
  const head = previous.size ? tagEntries(cwd, 'HEAD', candidates) : new Map();
  const idx = indexEntries(cwd, candidates);
  const tree = needTree ? worktreeBlobs(cwd, candidates) : null;

  const synced = candidates.filter((f) => {
    const want = current.get(f);
    const staged = idx.get(f);
    const onDisk = tree ? tree.get(f) : undefined;
    if (!want) {
      // Not in the current synced tree: exempt only as an UPSTREAM DELETION — the previous
      // synced tree carried it, what HEAD holds IS that synced copy (a consumer-edited copy
      // is scored — review 2026-09-05 r3), and the commit removes it everywhere we can see.
      const prev = previous.get(f);
      const atHead = head.get(f);
      return Boolean(prev && atHead && atHead.sha === prev.sha && atHead.mode === prev.mode) && !staged && !existsSync(join(cwd, f));
    }
    if (needIndex && (!staged || staged.sha !== want.sha || staged.mode !== want.mode)) return false;
    if (needTree && (onDisk !== want.sha || !staged || staged.mode !== want.mode)) return false;
    return true;
  });
  return { synced, version: manifest.version, tree: manifest.treeSha };
}

// Template bootstrap commit (#35-2). `init` clones a GitHub template copy — exactly ONE commit,
// the template's "Initial commit" — deletes the source-only assets, replaces the READMEs, injects
// harness-meta.json, and commits. That diff is hundreds of deleted lines (and, in the source
// tree, a `docs/plans/*credentials*` prose file), so it scored critical and review-gate +
// backpressure-gate blocked a commit whose content is known and whose verification cannot even
// be recorded from the parent-directory session that runs init (#35-3). The window is narrow and
// identified from repo state alone (hook mode sees no command string):
//   1. HEAD is the only commit (`rev-list --count HEAD` = 1), the repo is NOT shallow, and no
//      ref exists under refs/harness/ — the second commit of a fresh repo, before any sync.
//      (A `--depth 1` clone of an established consumer also has count 1 and no local
//      refs/harness/*, which is why shallowness alone closes the window — review 2026-09-23.)
//   2. harness-meta.json makes the TEMPLATE -> CONSUMER transition in this very commit: the
//      copy at HEAD lacks `bootstrapped_at`, the copy being committed carries `bootstrapped_at`
//      + `source_remote` (init Phase 3 writes them; the source repo never has them, and a
//      consumer that already has them at HEAD — any later clone — cannot re-open the window);
//   3. the path is a DELETION of a SOURCE-ONLY asset (init Phase 2: docs/, claudedocs/,
//      scripts/docs-drift, CHANGELOG.md — never a harness asset path, so deleting
//      `.omp/extensions/harness/index.ts`, `.githooks/*` or `.omp/rules/harness-*` inside the window is
//      scored like any other change), or one of the files init edits.
// Everything else in that commit is scored exactly as before: user code mixed into the
// bootstrap commit, an edit to AGENTS.md, or a harness-asset deletion is never covered.
const META_REL = '.omp/extensions/harness/harness-meta.json';
const BOOTSTRAP_EDITED_PATHS = new Set([
  'README.md', 'README.en.md', META_REL, 'docs/glossary.yaml', 'docs/harness/audit.jsonl',
]);
// The Phase 2 cleanup set (init/SKILL.md): consumer-space prefixes plus two source-only files.
// `docs/rules/`, `docs/templates/`, `docs/checklists/`, `docs/prompt-writing-handbook.md` are
// harness asset paths and fall out through isHarnessAssetPath.
const BOOTSTRAP_CLEANUP_PREFIXES = ['docs/', 'claudedocs/'];
const BOOTSTRAP_CLEANUP_FILES = new Set(['scripts/docs-drift', 'CHANGELOG.md']);
const isBootstrapCleanupPath = (f) =>
  !isHarnessAssetPath(f) && (BOOTSTRAP_CLEANUP_FILES.has(f) || BOOTSTRAP_CLEANUP_PREFIXES.some((p) => f.startsWith(p)));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const isBootstrapped = (meta) => isPlainObject(meta) && nonEmpty(meta.bootstrapped_at) && nonEmpty(meta.source_remote);
// HEAD is a template copy only if its meta carries NO bootstrap marker KEY at all — a half-written
// marker (one key, an empty string, null, false, a number, …) is still "already a consumer", never a
// reason to reopen the window (3-pass review 2026-09-23, C-1 rounds 2–3: key presence, not type).
const carriesBootstrapMarker = (meta) => Object.hasOwn(meta, 'bootstrapped_at') || Object.hasOwn(meta, 'source_remote');

// harness-meta.json must be a REGULAR file wherever it is observed: a symlink entry (mode 120000)
// whose target text happens to parse as JSON must never satisfy the transition (review round 4).
const REGULAR_BLOB = '100644';
const headMetaMode = (cwd) => (/^(\d{6}) blob /.exec(git(cwd, ['ls-tree', 'HEAD', '--', META_REL])) || [])[1];
const indexMetaMode = (cwd) => (/^(\d{6}) [0-9a-f]{40} 0\t/.exec(git(cwd, ['ls-files', '-s', '--', META_REL])) || [])[1];

// harness-meta.json at HEAD as a plain object; null when absent/unparseable/not an object/not a
// regular file (a template copy always carries a JSON object here — anything else is not one).
function headMeta(cwd) {
  try {
    if (headMetaMode(cwd) !== REGULAR_BLOB) return null;
    const parsed = JSON.parse(git(cwd, ['show', `HEAD:${META_REL}`]));
    return isPlainObject(parsed) ? parsed : null;
  } catch { return null; }
}

// harness-meta.json as the commit will carry it: the index for '--cached', the worktree for
// 'HEAD'/'' — the unverifiable union must satisfy both. null when any copy is missing/invalid or
// not a regular file (index mode for the index copy, lstat for the worktree copy).
function committedMeta(cwd, ranges) {
  let meta = null;
  for (const r of ranges) {
    let text;
    try {
      if (r === '--cached') {
        if (indexMetaMode(cwd) !== REGULAR_BLOB) return null;
        text = git(cwd, ['show', `:${META_REL}`]);
      } else {
        const p = join(cwd, META_REL);
        if (!lstatSync(p).isFile()) return null;
        text = readFileSync(p, 'utf-8');
      }
    } catch { return null; }
    try { meta = JSON.parse(text); } catch { return null; }
    if (!isBootstrapped(meta)) return null;
  }
  return meta;
}

// path -> single diff status letter across `ranges`: 'D' deleted, 'M' modified, 'A' added, 'T' type
// change, …; 'X' when the ranges disagree (unverifiable union: e.g. index M + worktree D). A staged
// deletion whose path was re-created in the worktree is untracked there, so the '' range emits
// nothing for it and the D stands — such a re-add is scored on its own commit, never on this one.
// null when git fails: the caller then closes the window (never judge by a partial view).
function changeStatuses(cwd, ranges) {
  const status = new Map();
  for (const r of ranges) {
    let text;
    try { text = git(cwd, ['diff', ...(r ? [r] : []), '--no-renames', '--name-status', '-z']); } catch { return null; }
    const parts = text.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      const f = parts[i + 1];
      if (!f) continue;
      status.set(f, status.get(f) === undefined || status.get(f) === s ? s : 'X');
    }
  }
  return status;
}

// Returns the subset of changedFiles covered by the bootstrap window, or [] outside it. Checks are
// ordered cheapest-first so the common case (an established repo) exits before any history walk:
// refs/harness/* (one ref scan) -> a parent of HEAD (one object lookup) -> shallowness -> meta.
function bootstrapSubset(cwd, changedFiles, ranges) {
  try {
    if (git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/harness/']).trim()) return [];
    if (git(cwd, ['rev-list', '--max-count=2', 'HEAD']).trim().split('\n').length !== 1) return [];
    if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') return [];
  } catch { return []; }
  const head = headMeta(cwd);
  if (!head || carriesBootstrapMarker(head)) return [];   // not a template copy, or already a consumer
  if (!committedMeta(cwd, ranges)) return [];
  const status = changeStatuses(cwd, ranges);
  if (!status) return [];
  // Exemption is keyed on the exact status: a DELETION is judged only by the cleanup allowlist
  // (so a deleted harness-meta.json under -a is scored — review C-4), a MODIFICATION only by the
  // init-edited list; anything else (added, type change, ranges disagreeing) is scored.
  return changedFiles.filter((f) => {
    const s = status.get(f);
    if (s === 'D') return isBootstrapCleanupPath(f);
    if (s === 'M') return BOOTSTRAP_EDITED_PATHS.has(f);
    return false;
  });
}

// Secret/material: a credential, token, password, or key/secret file is high-risk in ANY file
// type — these can be leaked into prose too, so they are checked BEFORE the doc exemption.
const HIGH_RISK_MATERIAL_PATTERNS = [
  /\.(env|pem|key|secret)$/i,
  /password|credential|token/i,
];

// Topic: filename substrings that indicate security-adjacent CODE/config. Noisy against prose
// (a `*_policy.md` doc, an `author-guide.md`), so passive prose docs are exempt from THESE — but
// real code (.ts/.sql/...) named for the topic stays high-risk.
const HIGH_RISK_TOPIC_PATTERNS = [
  /auth/i,
  /rls|policy|policies/i,
  /migration/i,
  /schema/i,
];

const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.sql', '.sh',
];

const DOCS_EXTENSIONS = ['.md', '.txt', '.mdx'];

// Passive prose extensions exempt from TOPIC high-risk matching. Excludes `.mdx` — MDX can import
// components and execute JSX, so it is not treated as passive here even though it counts as docs
// for the lower-stakes docs-only classification.
const PROSE_DOC_EXTENSIONS = ['.md', '.txt'];

const CONFIG_EXTENSIONS = ['.json', '.yaml', '.yml', '.toml', '.xml', '.ini'];

const CI_BUILD_PATTERNS = [
  /package\.json$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /tsconfig.*\.json$/,
  /\.github\/workflows\//,
  /\.gitlab-ci\.yml$/,
  /Dockerfile/,
  /docker-compose/,
  /\.env\.example$/,
  /Makefile$/,
];

// Case-insensitive file-extension test — paths can be any case, classification never should be.
const endsWithExt = (filePath, exts) => {
  const lower = filePath.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
};

// Classify a single path as security-high-risk. Order matters:
//  1. Secret/material (credential/token/password/key/secret) is high-risk in ANY file type,
//     including prose — a secret leaked into a .md/.txt must NOT slip through. Checked first.
//  2. Passive prose docs (.md/.txt) are then exempt from the noisy TOPIC substrings
//     (auth/policy/migration/schema): editing a doc ABOUT auth is not a live security change.
//     This is what fixes the footgun where `*_policy.md` / `author-guide.md` were misclassified
//     CRITICAL, forcing test-verification + adversarial review on prose (the primary activity in a
//     policy-doc repo).
//  3. Everything else — code/config, and .mdx (which can execute JSX) — is matched on topic.
// Real security code/config is never a prose extension, so the exemption adds no false-negative
// for live security files. Matching is case-insensitive on both sides. A non-doc topic substring
// (e.g. a hypothetical `author.ts`) is intentionally left matching — a safety gate prefers a
// false-positive over a missed real file.
export function isHighRiskFile(filePath) {
  if (HIGH_RISK_MATERIAL_PATTERNS.some((p) => p.test(filePath))) return true;
  if (endsWithExt(filePath, PROSE_DOC_EXTENSIONS)) return false;
  return HIGH_RISK_TOPIC_PATTERNS.some((p) => p.test(filePath));
}

// The diff scope the commit will ACTUALLY capture, mirroring review-gate's hash scope
// so risk is assessed on the same content that gets committed (parseCommitForm result):
//   plain commit  -> the staged index only        (git diff --cached)
//   -a / --all     -> all tracked modifications     (git diff HEAD)
//   any other/unknown form, or no form passed -> the conservative union of staged +
//     unstaged, so an unverifiable form (or a caller that does not know the form) never
//     UNDER-estimates risk. The previous staged∪unstaged union over-counted a plain
//     commit: unrelated unstaged changes inflated its risk and could falsely BLOCK it.
function diffRanges(form) {
  if (form && form.verifiable) return [form.all ? 'HEAD' : '--cached'];
  return ['--cached', ''];          // '' selects the unstaged working tree
}

export function assessRisk(cwd, form) {
  const ranges = diffRanges(form);
  let allChanged;
  try {
    // --no-renames: a deleted path must always surface as itself, never be folded into a rename.
    const names = ranges.flatMap((r) =>
      execSync(`git diff ${r} --no-renames --name-only`, { cwd, encoding: 'utf-8' }).trim().split('\n')
    );
    allChanged = [...new Set(names)].filter(Boolean);
  } catch {
    return { level: 'unknown', reason: 'git diff failed', files: [], synced: [] };
  }

  if (allChanged.length === 0) {
    return { level: 'none', reason: 'no changes', files: [], synced: [] };
  }

  const { synced, version, tree: syncTree } = syncedSubset(cwd, allChanged, ranges);
  const afterSync = synced.length ? allChanged.filter((f) => !synced.includes(f)) : allChanged;
  // The two windows are disjoint: bootstrap requires NO refs/harness/*, sync requires one.
  const bootstrap = afterSync.length && !synced.length ? bootstrapSubset(cwd, afterSync, ranges) : [];
  const changedFiles = bootstrap.length ? afterSync.filter((f) => !bootstrap.includes(f)) : afterSync;
  const note = synced.length
    ? `${synced.length} file(s) are byte-exact harness-sync copies of harness/${version ?? '?'} (excluded)`
    : bootstrap.length ? `${bootstrap.length} file(s) are template-bootstrap cleanup (excluded)` : null;

  if (changedFiles.length === 0) {
    return {
      level: 'low',
      reason: bootstrap.length
        ? `template bootstrap: all ${bootstrap.length} changed file(s) are init cleanup (deletions + README/meta edits)`
        : `harness-sync: all ${synced.length} changed file(s) match the harness/${version ?? '?'} manifest`,
      files: [],          // `files` is always the SCORED remainder; the copies are in `synced`
      synced,
      bootstrap,
      syncVersion: version,
      syncTree,
      diffSize: 0,
    };
  }

  // Score only the non-exempt remainder; diff size is measured over that pathspec too.
  const result = scoreFiles(cwd, ranges, changedFiles, changedFiles.length < allChanged.length ? changedFiles : null);
  result.synced = synced;
  result.bootstrap = bootstrap;
  result.syncVersion = version;
  result.syncTree = syncTree;
  if (note) result.reason = `${result.reason}; ${note}`;
  return result;
}

function scoreFiles(cwd, ranges, changedFiles, pathspec) {
  const hasCIBuild = changedFiles.some(f =>
    CI_BUILD_PATTERNS.some(p => p.test(f))
  );

  const isDocsOnly = changedFiles.every(f =>
    endsWithExt(f, DOCS_EXTENSIONS) || f.toLowerCase().startsWith('docs/')
  );

  const isConfigOnly = changedFiles.every(f =>
    endsWithExt(f, CONFIG_EXTENSIONS) || endsWithExt(f, DOCS_EXTENSIONS)
  );

  const hasCode = changedFiles.some(f => endsWithExt(f, CODE_EXTENSIONS));

  const hasHighRisk = changedFiles.some(isHighRiskFile);

  let diffSize = 0;
  try {
    for (const r of ranges) {
      const args = ['diff', ...(r ? [r] : []), '--no-renames', '--shortstat', ...(pathspec ? ['--', ...pathspec] : [])];
      const stat = execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
      const insertions = stat.match(/(\d+) insertion/);
      const deletions = stat.match(/(\d+) deletion/);
      if (insertions) diffSize += parseInt(insertions[1]);
      if (deletions) diffSize += parseInt(deletions[1]);
    }
  } catch { /* ignore */ }

  if (hasHighRisk) {
    return {
      level: 'critical',
      reason: 'security/auth/migration files changed',
      files: changedFiles,
      diffSize,
    };
  }

  if (hasCode && diffSize > 100) {
    return {
      level: 'high',
      reason: `${diffSize}+ lines of code changed`,
      files: changedFiles,
      diffSize,
    };
  }

  if (hasCode) {
    return {
      level: 'medium',
      reason: 'code changes detected',
      files: changedFiles,
      diffSize,
    };
  }

  if (isDocsOnly) {
    return {
      level: 'low',
      reason: 'documentation only',
      files: changedFiles,
      diffSize,
    };
  }

  if (isConfigOnly) {
    if (hasCIBuild) {
      return { level: 'medium', reason: 'CI/build config changed', files: changedFiles, diffSize };
    }
    return {
      level: 'low',
      reason: 'config/docs only',
      files: changedFiles,
      diffSize,
    };
  }

  return {
    level: 'medium',
    reason: 'mixed changes',
    files: changedFiles,
    diffSize,
  };
}
