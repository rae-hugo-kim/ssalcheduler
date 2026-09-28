#!/usr/bin/env node
// backpressure-patterns.mjs - shared build/test/lint command detection.
// Not a hook itself — imported by backpressure-tracker (PostToolUse) and
// backpressure-failure-tracker (PostToolUseFailure) so both classify a
// command identically.
//
// classifyVerification(command, cwd?) -> { isVerification, type, passReliable }
//
// Project registry (#48-3): `<cwd>/docs/harness/verify-commands.json` adds LITERAL leading-
// token prefixes per kind — `{"test": ["bash bpy/bench/run.sh"], "lint": [...], "build": [...]}`
// — for verification commands the built-in table cannot know (a bench runner, a repo script).
// A registered prefix matches the unwrapped segment on a token boundary, exactly like the
// built-ins (no regex, no substring: `bash bpy/bench/run.sh --quick` matches, `bash
// bpy/bench/run.shx` does not) and is consulted BEFORE the built-ins so a project can name
// `make test` a test. The file is optional; a missing/unreadable/malformed file or a
// non-string entry contributes nothing (fail open to the defaults, never a crash). Without a
// cwd only the built-ins apply.
//
// The command is split into top-level shell segments by a QUOTE-AWARE scanner
// (splitTopLevel): operators && || ; | & inside single/double quotes or after a
// backslash are NOT treated as delimiters. Each segment is trimmed and unwrapped
// of VAR=val / env / time / sudo / nice / npx / a leading (subshell), then
// matched on its LEADING TOKEN anchored with (?=\s|$) — never a raw substring.
// `bash -c "<inner>"` / `sh -c "<inner>"` is classified by RECURSING on <inner>
// so the inner command's own operators count toward reliability too. So
// `echo "x; npm test && ok"`, `grep "npm test" f`, `npx tsc-alias`,
// `make-release.sh` do NOT match, while `npm test`, `npm t`,
// `CI=1 pnpm test:unit`, `time ./gradlew test`, `python -m pytest`,
// `cd x && npm run build`, and `bash -c "npm test"` do.
//
// passReliable: whether a *success* should be trusted as a passing verification.
// PostToolUse fires when the OVERALL shell exit is 0, which does NOT imply the
// verification command itself passed when its exit is swallowed downstream:
//   `npm test || true`   (|| swallows failure)
//   `npm test; echo ok`  (;  overall exit is the last command's)
//   `npm test | tee log` (|  pipeline-HEAD exit discarded, no pipefail)
//   `npm test &`         (&  backgrounded; shell returns 0 immediately)
// and the same operators nested inside `bash -c "..."`. passReliable is true
// only when every operator after the matched segment (at every recursion level)
// is `&&`. Otherwise the success tracker must NOT record PASS (leaving status
// unverified is fail-safe). Not handled (treated as unreliable / fail-safe):
// `set -o pipefail`, command substitution, and recursion past MAX_DEPTH.
//
// Failure capture is intentionally LIBERAL (isVerification alone): for a chained
// `npm test && deploy` that fails, the failure may be `deploy`, not the test —
// recording FAIL over-blocks, which is fail-safe (operator re-runs a clean
// verification), so we accept that misattribution rather than miss a real failure.

import { openSync, fstatSync, readSync, closeSync, constants } from 'fs';
import { join } from 'path';

const MAX_DEPTH = 5;

const VERIFY_KINDS = ['test', 'lint', 'build'];
const MAX_PROJECT_PREFIX = 200;
const MAX_REGISTRY_BYTES = 64 * 1024;
// A prefix made only of launchers / package managers / VCS and options would bless EVERY
// command run through it (`{"test":["bash"]}`, `["/usr/bin/bash"]`, `["node -e"]` → anything =
// PASS). A registration must carry a concrete runner token (`bash bpy/bench/run.sh`,
// `node bench.mjs`, `my-bench`); launchers are recognized by basename, case-insensitively.
const GENERIC_LAUNCHERS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'node', 'deno', 'bun', 'python', 'python3', 'ruby',
  'perl', 'php', 'java', 'git', 'npm', 'pnpm', 'yarn', 'npx', 'pipx', 'uv', 'uvx', 'poetry', 'make', 'cargo', 'go', 'mvn',
  'gradle', 'docker', 'podman', 'env', 'sudo', 'time', 'xargs', 'exec', 'eval', 'source', '.', 'command', 'builtin',
  // launch-mode SUBCOMMANDS of the package managers: `npm run` / `pnpm exec` / `npx`-style words name no script either
  'run', 'run-script', 'x', 'dlx']);

// Bounded, FIFO-safe read: O_NONBLOCK makes a writer-less FIFO fail instead of hang (the
// tracker would otherwise time out and record nothing — a stale PASS would survive a real
// failure), fstat rejects anything that is not a regular file, the size cap bounds the read.
function readRegistry(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_REGISTRY_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.toString('utf-8', 0, off);
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* nothing to release */ } }
}

// [[type, prefix]] from docs/harness/verify-commands.json; [] without a cwd or on any problem.
// Entries are validated one by one (an invalid entry or kind is skipped, the rest still apply).
function projectPatterns(cwd) {
  if (!cwd) return [];
  const raw = readRegistry(join(cwd, 'docs', 'harness', 'verify-commands.json'));
  if (raw === null) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out = [];
  for (const type of VERIFY_KINDS) {
    if (!Array.isArray(parsed[type])) continue;
    for (const p of parsed[type]) {
      if (typeof p !== 'string') continue;
      // ASCII trim only: JS trim() would strip a NBSP that bash treats as part of the word.
      const prefix = p.replace(/^[ \t]+|[ \t]+$/g, '');
      if (!prefix || prefix.length > MAX_PROJECT_PREFIX || /[\n\r]/.test(prefix)) continue;
      // A registration must name a CONCRETE runner: at least one token that is neither a generic
      // launcher / launch-mode word (by basename, case-insensitive — `/usr/bin/bash`, `./node`,
      // `Bash`, `npm run`, `.`, `command`) nor an option or an option's bare value (`node -e`,
      // `bash -c`, `python3 -m`, `node --input-type module` are launch modes, not runners).
      // No quotes in a registration: the prefix is matched literally against the command text, and
      // a quoted argument with spaces would also defeat the token analysis below.
      if (/["'`]/.test(prefix)) continue;
      const toks = prefix.split(/[ \t]+/);
      // Launchers by basename, case-insensitive, version-qualified interpreters included
      // (`python3.12`, `/usr/bin/python3.12`, `node22`, `ruby3.3`).
      const isLauncher = (t) => {
        const base = t.slice(t.lastIndexOf('/') + 1).toLowerCase();
        return GENERIC_LAUNCHERS.has(base) || /^(python|node|ruby|perl|php|bash|sh|zsh|pypy)[\d.]*$/.test(base);
      };
      const isOption = (t) => t.startsWith('-') || t.startsWith('+');
      // A token right after an option is (usually) that option's VALUE (`node --input-type module`,
      // `git -C /tmp`, `bash --rcfile x`): it counts as the runner only when it looks like a
      // script file or a dotted module (`bench/run.ts`, `tests.bench`), never a bare word or dir.
      const scriptLike = (t) => /\.(sh|bash|zsh|mjs|cjs|js|ts|mts|cts|py|rb|pl|php|jar|exe)$/i.test(t) || /^[\w-]+(\.[\w-]+)+$/.test(t);
      const concrete = toks.some((t, i) => !isOption(t) && !isLauncher(t) && (i === 0 || !isOption(toks[i - 1]) || scriptLike(t)));
      if (!concrete) continue;
      out.push([type, prefix]);
    }
  }
  return out;
}

// Token boundary = ASCII shell whitespace only (`[ \t]`): a NBSP / U+2003 / form feed is part of
// the word to bash, so `bash bpy/bench/run.sh<NBSP>copy` runs a DIFFERENT script.
const prefixMatches = (s, prefix) =>
  s.startsWith(prefix) && (s.length === prefix.length || s[prefix.length] === ' ' || s[prefix.length] === '\t');

const VERIFY = [
  // order matters: lint before build so `tsc --noEmit` labels as lint, not build.
  ['test',  /^(npm (run )?(t|test)|pnpm (run )?test[\w:.-]*|yarn (run )?test[\w:.-]*|jest|vitest|pytest|python3? -m pytest|node --test|cargo test|go test|mvn test|gradle test|(\.\/)?gradlew test|(\.\/)?mvnw test)(?=\s|$)/],
  ['lint',  /^(npm run lint|pnpm (run )?lint[\w:.-]*|yarn (run )?lint[\w:.-]*|eslint|prettier (--check|-c)|tsc --noEmit|cargo clippy|golangci-lint)(?=\s|$)/],
  ['build', /^(npm run build|pnpm (run )?build[\w:.-]*|yarn (run )?build[\w:.-]*|tsc|make|cargo build|go build|mvn compile|gradle build|(\.\/)?gradlew build|(\.\/)?mvnw compile)(?=\s|$)/],
];

// Quote-aware split into top-level segments + the operators between them.
// Returns { segs, ops } with ops.length === segs.length - 1; ops[i] is the
// operator between segs[i] and segs[i+1] (one of && || ; | &).
function splitTopLevel(cmd) {
  const segs = [], ops = [];
  let cur = '', i = 0, q = null; // q = "'" or '"' while inside that quote
  let prevGt = false;            // last emitted char was an UNescaped, UNquoted top-level `>`
  while (i < cmd.length) {
    const c = cmd[i], n = cmd[i + 1];
    if (q === "'") { cur += c; if (c === "'") q = null; prevGt = false; i++; continue; }
    if (q === '"') {
      if (c === '\\' && n !== undefined) { cur += c + n; prevGt = false; i += 2; continue; }
      cur += c; if (c === '"') q = null; prevGt = false; i++; continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; prevGt = false; i++; continue; }
    if (c === '\\' && n !== undefined) { cur += c + n; prevGt = false; i += 2; continue; }
    if (c === '&' && n === '&') { segs.push(cur); ops.push('&&'); cur = ''; prevGt = false; i += 2; continue; }
    if (c === '|' && n === '|') { segs.push(cur); ops.push('||'); cur = ''; prevGt = false; i += 2; continue; }
    if (c === ';') { segs.push(cur); ops.push(';'); cur = ''; prevGt = false; i++; continue; }
    if (c === '|') { segs.push(cur); ops.push('|'); cur = ''; prevGt = false; i++; continue; }
    // A `&` that is part of a redirection (`2>&1`, `>&2`, `&>file`) is NOT a
    // backgrounding operator — keep it in the segment so it doesn't break an
    // otherwise-reliable `&&` chain (e.g. `npm test 2>&1 && deploy`). Decide on the
    // emitted-token flag (not cur.endsWith('>')) so an escaped/quoted `\>` is not
    // mistaken for a redirection (which would risk recording a false PASS).
    if (c === '&' && (prevGt || n === '>')) { cur += c; prevGt = false; i++; continue; }
    if (c === '&') { segs.push(cur); ops.push('&'); cur = ''; prevGt = false; i++; continue; }
    cur += c; prevGt = (c === '>'); i++;
  }
  segs.push(cur);
  return { segs, ops };
}

// Peel leading wrappers that don't change which program controls the exit.
// (bash -c "..." is handled separately, by recursion, in classifySegment.)
function unwrap(seg) {
  let s = seg.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''); // ASCII trim: a NBSP at the edge is part of the word to bash
  if (s.startsWith('(')) s = s.replace(/^\(\s*/, '').replace(/\s*\)\s*$/, ''); // (subshell)
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');       // VAR=val ...
    s = s.replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, ''); // env VAR=val ...
    s = s.replace(/^(?:time|sudo|nice|ionice)\s+/, '');
    s = s.replace(/^npx\s+/, '');
  } while (s !== prev);
  return s;
}

// Classify a single segment -> { type, reliable } or null.
// `reliable` reflects ONLY this segment's internal structure (e.g. operators
// hidden inside a bash -c payload); the caller combines it with outer operators.
function classifySegment(seg, depth, project) {
  const s = unwrap(seg);
  const m = s.match(/^(?:bash|sh)\s+-c\s+(['"])([\s\S]*)\1\s*$/); // bash -c "<inner>"
  if (m) {
    if (depth >= MAX_DEPTH) return null; // pathological nesting -> fail-safe no-match
    const inner = classify(m[2], depth + 1, project);
    return inner.isVerification ? { type: inner.type, reliable: inner.passReliable } : null;
  }
  for (const [type, prefix] of project) {
    if (prefixMatches(s, prefix)) return { type, reliable: true };
  }
  for (const [type, re] of VERIFY) {
    if (re.test(s)) return { type, reliable: true };
  }
  return null;
}

function classify(command, depth, project) {
  if (!command || typeof command !== 'string') {
    return { isVerification: false, type: '', passReliable: false };
  }
  const { segs, ops } = splitTopLevel(command);
  let matchIdx = -1, type = '', reliable = true;
  for (let i = 0; i < segs.length; i++) {
    const r = classifySegment(segs[i], depth, project);
    if (r) { matchIdx = i; type = r.type; reliable = r.reliable; break; }
  }
  if (matchIdx === -1) {
    return { isVerification: false, type: '', passReliable: false };
  }
  // Reliable iff this segment is internally reliable AND every operator after
  // it (at this level) is `&&`.
  let passReliable = reliable;
  for (let j = matchIdx; j < ops.length && passReliable; j++) {
    if (ops[j] !== '&&') passReliable = false;
  }
  return { isVerification: true, type, passReliable };
}

export function classifyVerification(command, cwd) {
  return classify(command, 0, projectPatterns(cwd));
}
