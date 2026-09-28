// Tests for mcp-gate.mjs (PreToolUse: MCP tools, advisory).
//
// Run: node --test .omp/extensions/harness/tests/mcp-gate.test.mjs
//
// Focus: audit P3 precision — the destructive name patterns included `create_`
// and `update_`, which fired on benign additive/edit tools across Slack / Gmail /
// Notion / Serena / Supabase and produced almost all of this gate's noise. The
// set is now scoped to remove/replace/deploy operations; DDL via execute_sql is
// still caught by inspecting the query.
//
// Advisory (always exit 0); we assert on whether a "Destructive" warning fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates', 'mcp-gate.mjs');

function warns(toolName, toolInput = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  try {
    const r = spawnSync('node', [GATE], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_state: { cwd: dir } }),
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, 'gate is advisory and must always exit 0');
    return /Destructive/.test(r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- benign additive/edit tools no longer warn (the fixed false positives) ---

test('create_ tools do not warn (slack canvas)', () => {
  assert.equal(warns('mcp__claude_ai_Slack__slack_create_canvas'), false);
});

test('create_ tools do not warn (gmail draft)', () => {
  assert.equal(warns('mcp__claude_ai_Gmail__create_draft'), false);
});

test('update_ tools do not warn (gmail label)', () => {
  assert.equal(warns('mcp__claude_ai_Gmail__update_label'), false);
});

test('create_ infra tools do not warn (supabase branch)', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__create_branch'), false);
});

// --- genuinely destructive operations still warn ---

test('delete_ tools warn', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__delete_branch'), true);
});

test('apply_migration warns', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__apply_migration'), true);
});

test('deploy_ tools warn', () => {
  assert.equal(warns('mcp__claude_ai_Vercel__deploy_to_vercel'), true);
});

test('drop_ tools warn (underscore-delimited name, not \\b)', () => {
  // Regression guard: `\bdrop_` never matched `..__drop_table` because `_` is a
  // word char. Must use (^|_) anchoring.
  assert.equal(warns('mcp__claude_ai_Supabase__drop_table'), true);
});

test('truncate_ tools warn', () => {
  assert.equal(warns('mcp__some_server__truncate_table'), true);
});

test('reset_branch tools warn', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__reset_branch'), true);
});

// --- execute_sql is judged by the query (DDL), not the name ---

test('execute_sql with DDL (DROP) warns', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__execute_sql', { query: 'DROP TABLE users;' }), true);
});

test('execute_sql with a plain SELECT does not warn', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__execute_sql', { query: 'SELECT * FROM users;' }), false);
});

test('execute_sql whose identifiers merely contain DDL words does not warn', () => {
  // Word-bounded DDL match: CREATED_AT / DROPDOWN / ALTERATION are not DDL.
  assert.equal(warns('mcp__claude_ai_Supabase__execute_sql', { query: 'SELECT created_at, dropdown FROM forms;' }), false);
});

test('a read-only tool does not warn', () => {
  assert.equal(warns('mcp__claude_ai_Supabase__list_tables'), false);
});
