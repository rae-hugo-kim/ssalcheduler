// Tests for destructive-guard.mjs (PreToolUse: Bash, advisory).
//
// Run: node --test .omp/extensions/harness/tests/destructive-guard.test.mjs
//
// Focus: audit P3 precision — the guard scanned the WHOLE command, so a
// destructive keyword inside a git commit MESSAGE produced a false warning. It
// now blanks only the -m/-am/--message value before the keyword scan, which is
// deliberately narrow: executed commands (including quoted `sh -c` payloads and
// mv/cp overwrite targets) are left intact and still warn — no false negatives.
//
// The guard is advisory (always exit 0); we assert on whether a "Destructive"
// warning is emitted to stderr.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'destructive-guard.mjs');

function warns(command) {
  const dir = mkdtempSync(join(tmpdir(), 'dg-'));
  try {
    const r = spawnSync('node', [GATE], {
      input: JSON.stringify({ tool_input: { command }, session_state: { cwd: dir } }),
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, 'guard is advisory and must always exit 0');
    return /Destructive/.test(r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- false positive that the commit-message carve-out removes ---

test('destructive keyword inside a commit message does NOT warn (-m)', () => {
  assert.equal(warns('git commit -m "remove the rm -rf call"'), false);
});

test('destructive keyword inside a commit message does NOT warn (-am combined)', () => {
  assert.equal(warns('git commit -am "remove the rm -rf call"'), false);
});

test('a code-tool keyword inside a commit message does NOT warn', () => {
  assert.equal(warns(`git commit -m 'mv old.ts new.ts was reverted'`), false);
});

test('a real destructive command after a clean commit message still warns', () => {
  // The message is blanked, but the real `rm -rf` after && must still warn.
  assert.equal(warns('git commit -m "tidy up" && rm -rf /tmp/build'), true);
});

// --- real destructive commands still warn (no false negatives) ---

test('rm -rf on an unquoted path warns', () => {
  assert.equal(warns('rm -rf /tmp/build'), true);
});

test('rm -rf wrapped in sh -c "..." still warns (payload is code, not a message)', () => {
  assert.equal(warns('bash -c "rm -rf /tmp/build"'), true);
});

test('mv overwriting a quoted code-file target still warns', () => {
  assert.equal(warns('mv tmp.ts "src/app.ts"'), true);
});

test('command substitution inside a -m message still warns (shell executes it)', () => {
  // $(...) runs before git sees the message, so it must NOT be blanked.
  assert.equal(warns('git commit -m "$(rm -rf /tmp/build)"'), true);
});

test('backtick command substitution inside a message still warns', () => {
  assert.equal(warns('git commit -m "`rm -rf /tmp/build`"'), true);
});

test('command substitution inside a --message value still warns', () => {
  assert.equal(warns('git commit --message "$(mv tmp.ts src/app.ts)"'), true);
});

test('rm -rf with only the path quoted still warns (flags are unquoted)', () => {
  assert.equal(warns('rm -rf "/tmp/my build dir"'), true);
});

test('git reset --hard warns', () => {
  assert.equal(warns('git reset --hard origin/main'), true);
});

test('sed -i warns even with a quoted script arg', () => {
  assert.equal(warns(`sed -i 's/a/b/' src/app.ts`), true);
});

test('mv overwriting a code file warns', () => {
  assert.equal(warns('mv tmp.ts src/app.ts'), true);
});

test('a benign command does not warn', () => {
  assert.equal(warns('git status'), false);
});
