// Unit tests for classifyVerification() — the shared build/test/lint classifier used
// by backpressure-tracker (PostToolUse) and backpressure-failure-tracker.
//
// Run: node --test .omp/extensions/harness/tests/backpressure-patterns.test.mjs
//
// Regression focus: a `2>&1` (or `>&2`, `&>file`) redirection must NOT be mistaken for
// a backgrounding `&` operator by the top-level splitter, otherwise a reliable `&&`
// chain like `npm test 2>&1 && deploy` is wrongly judged passReliable=false and a real
// PASS is never recorded (fail-safe, but needless friction — it forces a skip override).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVerification } from '../gates/backpressure-patterns.mjs';

test('classifies verification commands by type', () => {
  for (const [cmd, type] of [
    ['npm test', 'test'],
    ['npm t', 'test'],
    ['pnpm test:unit', 'test'],
    ['node --test', 'test'],
    ['node --test tests/x.test.mjs', 'test'],
    ['pytest', 'test'],
    ['python -m pytest', 'test'],
    ['jest', 'test'],
    ['vitest', 'test'],
    ['npm run lint', 'lint'],
    ['tsc --noEmit', 'lint'],
    ['eslint', 'lint'],
    ['npm run build', 'build'],
    ['tsc', 'build'],
    ['make', 'build'],
  ]) {
    const r = classifyVerification(cmd);
    assert.equal(r.isVerification, true, `should be verification: ${cmd}`);
    assert.equal(r.type, type, `type for: ${cmd}`);
  }
});

test('non-verification commands are not classified', () => {
  for (const cmd of [
    'echo "npm test"',          // quoted data
    'grep "npm test" file',
    'git commit -m "run npm test"',
    'npx tsc-alias',            // not tsc
    './make-release.sh',        // not make
    'cd src && ls',
    '',
  ]) {
    assert.equal(classifyVerification(cmd).isVerification, false, `should NOT be verification: ${cmd}`);
  }
});

test('passReliable is true only when success is trustworthy', () => {
  for (const cmd of [
    'npm test',                              // bare
    'npm test && deploy',                    // && chain
    'cd app && npm test',                    // matched segment last, no trailing op
    'npm test > out.log',                    // redirection only
    'npm test 2>&1',                         // fd-dup redirection (the & is NOT an operator)
    'npm test 2>&1 && deploy',               // <-- regression: 2>&1 must not break the && chain
    'npm test >out 2>&1 && echo ok',
    'npm test >& out.log',                   // >& redirection
    'npm test &> out.log',                   // &> redirection
    'bash -c "npm test"',                    // reliable inner
  ]) {
    assert.equal(classifyVerification(cmd).passReliable, true, `should be passReliable: ${cmd}`);
  }
});

test('passReliable is false when an operator can swallow the failure', () => {
  for (const cmd of [
    'npm test || true',          // || swallows failure
    'npm test ; echo ok',        // ; — overall exit is the last command
    'npm test | tee log',        // pipe head exit discarded
    'npm test 2>&1 | tail -5',   // redirection then a real pipe
    'npm test &',                // genuinely backgrounded
    'npm test & echo started',   // backgrounded then next
    'npm test 2>&1 &',           // backgrounded AFTER a redirect — still unreliable
    'npm test \\>& echo ok',     // escaped literal `>` then real backgrounding `&` (not a redirect)
  ]) {
    const r = classifyVerification(cmd);
    assert.equal(r.isVerification, true, `still a verification: ${cmd}`);
    assert.equal(r.passReliable, false, `should NOT be passReliable: ${cmd}`);
  }
});

// --- #48-3: project registry docs/harness/verify-commands.json (literal leading-token prefixes)
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withRegistry(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-registry-'));
  mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
  if (content !== null) writeFileSync(join(dir, 'docs', 'harness', 'verify-commands.json'), content);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('registry: a registered prefix classifies on a token boundary, before the built-ins', () => {
  withRegistry(JSON.stringify({ test: ['bash bpy/bench/run.sh', 'make test'] }), (dir) => {
    assert.deepEqual(classifyVerification('bash bpy/bench/run.sh', dir), { isVerification: true, type: 'test', passReliable: true });
    assert.deepEqual(classifyVerification('bash bpy/bench/run.sh --scene mug', dir), { isVerification: true, type: 'test', passReliable: true });
    assert.equal(classifyVerification('bash bpy/bench/run.shx', dir).isVerification, false, 'no substring match');
    assert.equal(classifyVerification('bash bpy/bench/run.sh | tail', dir).passReliable, false, 'operators still govern reliability');
    assert.equal(classifyVerification('CI=1 bash bpy/bench/run.sh && echo ok', dir).passReliable, true, 'unwrap + && still apply');
    assert.equal(classifyVerification('make test', dir).type, 'test', 'project registration wins over the built-in table (make -> build)');
    assert.equal(classifyVerification('bash bpy/bench/run.sh\u00a0copy', dir).isVerification, false, 'NBSP is part of the word to bash, not a boundary');
    assert.equal(classifyVerification('bash bpy/bench/run.sh\u00a0', dir).isVerification, false, 'a trailing NBSP names a different file — not trimmed away');
    assert.equal(classifyVerification('bash -c "bash bpy/bench/run.sh"', dir).type, 'test', 'bash -c recursion carries the registry');
  });
});

test('registry: unregistered commands and a missing/invalid file fall back to the built-ins only', () => {
  withRegistry(null, (dir) => {
    assert.equal(classifyVerification('bash bpy/bench/run.sh', dir).isVerification, false);
    assert.equal(classifyVerification('npm test', dir).type, 'test');
  });
  for (const bad of ['{not json', '[]', '"str"', JSON.stringify({ test: 'bash x' }), JSON.stringify({ test: [1, '', '  ', null] }), JSON.stringify({ deploy: ['bash x'] })]) {
    withRegistry(bad, (dir) => {
      assert.equal(classifyVerification('bash x', dir).isVerification, false, bad);
      assert.equal(classifyVerification('npm test', dir).type, 'test', bad);
    });
  }
  assert.equal(classifyVerification('bash bpy/bench/run.sh').isVerification, false, 'no cwd -> built-ins only');
});

test('registry: launcher-only prefixes (bare, path-qualified, cased, launcher + option) are rejected; a concrete runner token is required', () => {
  withRegistry(JSON.stringify({ test: ['bash', ' node ', 'git', 'npm', '/usr/bin/bash', './node', 'Bash', 'node -e', 'bash -c', 'python3 -m', 'sudo env node', 'npm run', 'pnpm exec', '.', 'source', 'command', 'builtin', 'node --input-type module', 'bash --rcfile /dev/null', 'git -C /tmp', 'npm --prefix web run', 'npm run-script', 'pnpm dlx', 'bun x', 'npm --prefix "web app" run', 'python3.12', '/usr/bin/python3.12 -m', 'bash +e', 'bash +o pipefail', 'my-bench', 'node bench.mjs', 'npm run bench', 'python3 -m tests.bench', 'node --experimental-strip-types bench/run.ts'] }), (dir) => {
    for (const cmd of ['bash harmless.sh', 'node harmless.mjs', 'git --version', 'npm --version', '/usr/bin/bash --version', './node --version', 'Bash --version', 'node -e "1"', 'bash -c true', 'python3 -m platform', 'sudo env node x.js', 'npm run', 'npm run format', 'pnpm exec prettier', '. ./setup.sh', 'source env.sh', 'command true', 'builtin true', 'node --input-type module -e 0', 'bash --rcfile /dev/null -c true', 'git -C /tmp --version', 'npm --prefix web run', 'npm run-script format', 'pnpm dlx prettier', 'bun x prettier', 'npm --prefix "web app" run', 'python3.12 --version', '/usr/bin/python3.12 -m platform', 'bash +e -c true', 'bash +o pipefail -c true']) {
      assert.equal(classifyVerification(cmd, dir).isVerification, false, cmd);
    }
    assert.equal(classifyVerification('my-bench --quick', dir).type, 'test');
    assert.equal(classifyVerification('node bench.mjs', dir).type, 'test');
    assert.equal(classifyVerification('npm run bench', dir).type, 'test', 'a named script is concrete');
    assert.equal(classifyVerification('python3 -m tests.bench -q', dir).type, 'test', 'a dotted module after -m is a runner');
    assert.equal(classifyVerification('node --experimental-strip-types bench/run.ts', dir).type, 'test', 'a path after an option is a runner');
  });
});

test('registry: a FIFO or directory at the registry path never hangs the classifier — built-ins still apply; a non-regular file is ignored even when readable', () => {
  // A FIFO WITH a writer delivers valid JSON to a non-blocking reader; the content stays out
  // twice over — isFile() rejects it, and the fstat-sized read of a FIFO (size 0) reads nothing.
  const fdir = mkdtempSync(join(tmpdir(), 'bp-registry-'));
  let writer;
  try {
    mkdirSync(join(fdir, 'docs', 'harness'), { recursive: true });
    const fifo = join(fdir, 'docs', 'harness', 'verify-commands.json');
    if (spawnSync('mkfifo', [fifo]).status === 0) {
      writer = spawn('sh', ['-c', `printf '%s' '{"test":["my-bench"]}' > "${fifo}"`], { stdio: 'ignore' });
      const until = Date.now() + 1500;
      let seen = false;
      while (Date.now() < until && !seen) { seen = classifyVerification('my-bench', fdir).isVerification; if (!seen) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
      assert.equal(seen, false, 'JSON arriving through a FIFO must be ignored (not a regular file)');
    }
  } finally { writer?.kill('SIGKILL'); rmSync(fdir, { recursive: true, force: true }); }
  withRegistry(null, (dir) => {
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ test: ['my-bench'] }));
    symlinkSync(join(dir, 'registry.json'), join(dir, 'docs', 'harness', 'verify-commands.json'));
    assert.equal(classifyVerification('my-bench', dir).type, 'test', 'symlink to a regular file is honored');
  });
  const dir = mkdtempSync(join(tmpdir(), 'bp-registry-'));
  try {
    mkdirSync(join(dir, 'docs', 'harness'), { recursive: true });
    const fifo = join(dir, 'docs', 'harness', 'verify-commands.json');
    const r = spawnSync('mkfifo', [fifo]);
    if (r.status !== 0) return; // no mkfifo: nothing to pin here
    const started = Date.now();
    assert.equal(classifyVerification('npm test', dir).type, 'test');
    assert.equal(classifyVerification('bash x', dir).isVerification, false);
    assert.ok(Date.now() - started < 1000, 'a writer-less FIFO must not block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  withRegistry(null, (dir) => {
    mkdirSync(join(dir, 'docs', 'harness', 'verify-commands.json'));
    assert.equal(classifyVerification('npm test', dir).type, 'test');
  });
});

test('registry: a registered prefix ending in NBSP is NOT normalized away — it names a different file than the plain one', () => {
  withRegistry(JSON.stringify({ test: ['my-bench\u00a0'] }), (dir) => {
    assert.equal(classifyVerification('my-bench', dir).isVerification, false, 'plain command must not match the NBSP-suffixed registration');
    assert.equal(classifyVerification('my-bench\u00a0 --quick', dir).type, 'test');
  });
});

test('registry: entries are validated one by one — an invalid sibling kind does not disable the valid ones', () => {
  withRegistry(JSON.stringify({ test: ['bash bpy/bench/run.sh'], lint: 'eslint' }), (dir) => {
    assert.equal(classifyVerification('bash bpy/bench/run.sh', dir).type, 'test');
  });
});
