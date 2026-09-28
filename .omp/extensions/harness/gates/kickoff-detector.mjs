#!/usr/bin/env node
// kickoff-detector.mjs - UserPromptSubmit hook
// Purpose: Detect new project/feature requests and remind about kickoff

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const input = readFileSync(0, 'utf-8');

let data;
try {
  data = JSON.parse(input);
} catch (e) {
  console.error('HARNESS WARNING: Hook received invalid input, skipping check.');
  process.exit(0);
}

const prompt = data?.prompt || '';
if (!prompt) process.exit(0);

// Patterns indicating new work that might need kickoff (Korean and English)
const newWorkPatterns = /새 프로젝트|새로운 프로젝트|새 기능|새로운 기능|만들어|구현해|개발해|new project|new feature|create|implement|build me|I want/i;

if (newWorkPatterns.test(prompt)) {
  const cwd = data?.session_state?.cwd || process.cwd();
  const kickoffFile = join(cwd, 'docs', 'harness', 'kickoff-done');

  if (!existsSync(kickoffFile)) {
    console.log(
      'HARNESS REMINDER: New work detected. Apply cycle intake (.omp/rules/harness-cycle_definition.md): ' +
      'write the one-line completion check FIRST; if the request spans multiple cycles, propose a ' +
      'numbered decomposition (each cycle with its own check sentence) before implementing. ' +
      'For project/feature-scale scope, recommend /kickoff (scope MUST/SHOULD/NOT + acceptance criteria).'
    );
  }
}

process.exit(0);
