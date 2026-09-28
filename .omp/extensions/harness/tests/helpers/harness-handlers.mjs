// harness-handlers.mjs — load the REAL extension entry (index.ts) in-process and capture the
// handlers it registers, so wiring tests can drive `tool_call` / `tool_result` with event
// fixtures and observe what actually happens (gate spawns, returned patches, state files)
// instead of matching index.ts source text (#46: a source-regex test stays green under an
// `if (false) return;` mutant; a captured handler does not).
//
// index.ts imports `./mermaid-check`, which only resolves inside the omp bundle (it needs
// omp's @oh-my-pi/pi-utils parser). A module-resolution hook substitutes an inert stub for
// that ONE specifier; everything else (gates, git-commit-detect, read-path) is the real code
// and the gates are really spawned with `node` — the tests run them against temp repos.
//
// Requires Node's built-in TypeScript type stripping (>= 22.18 / >= 23.6, on by default) to
// import index.ts in-process; the pre-commit hook already requires node on PATH. Older nodes
// fail loudly here rather than silently skipping the wiring tests.
//
// Usage:
//   const { handlers } = await loadHarness();
//   await handlers.tool_call[0](event, ctx);  await handlers.tool_result[0](event, ctx);

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = `
export async function resolve(spec, ctx, next) {
  if (spec === './mermaid-check') {
    return { url: 'data:text/javascript,export const MERMAID_SUPPORTED="";export async function checkMermaidFile(){return []}', shortCircuit: true };
  }
  return next(spec, ctx);
}`;

let registered = false;
export async function loadHarness() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error(`harness-handlers: Node >= 22.18 (type stripping) required to import index.ts in-process; running ${process.versions.node}`);
  }
  if (!registered) {
    register('data:text/javascript,' + encodeURIComponent(HOOK));
    registered = true;
  }
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts');
  const mod = await import(pathToFileURL(indexPath).href);
  const handlers = {};
  const pi = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    setLabel() {},
    logger: { warn() {}, info() {}, error() {} },
  };
  mod.default(pi);
  return { handlers };
}

/** Minimal HarnessCtx for a session rooted at `cwd`. */
export function ctxFor(cwd) {
  return { cwd, hasUI: false };
}
