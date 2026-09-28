// estimate.mjs — estimate-vs-actual helpers (seed 20260918-023000-e5a1, .omp/rules/harness-cycle_definition.md
// "예상 레코드"). Pure functions, imported by review-gate.mjs; never spawned.
//
// The intake writes .omp/harness-state/cycle-estimate as ONE strict positional tuple:
//   ["omp-estimate/v1", <risk>, <files>, <depth>, <model>, <effort>, <ts>]
// review-gate (hook mode) pairs it with the measured risk-assess result and queues an
// `estimate_vs_actual` audit intent + an unlink intent for post-commit. Observation only:
// nothing here may influence a verdict, and a malformed record must cost exactly one warning.

export const ESTIMATE_MAGIC = 'omp-estimate/v1';
export const ESTIMATE_FILE = 'cycle-estimate';
export const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
export const DEPTH_LEVELS = new Set(['low', 'high']);
// Bounded tail read of session-log.jsonl: the dispatcher kills a gate at ~3s, so the count
// must stay cheap on a log that has grown for months (170KB measured at 2026-09-18).
export const SESSION_LOG_TAIL_BYTES = 256 * 1024;

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
// ISO 8601 date-time with a zone designator — Date.parse alone accepts "2026", "0", or a prose date,
// none of which the intake rule (.omp/rules/harness-cycle_definition.md) allows for the record's ts.
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
// Shape alone lets a calendar overflow through (2026-02-30 parses as Mar 2 and shifts the FAIL
// window); the UTC round-trip must reproduce the same calendar day.
function isIsoTimestamp(v) {
  if (!nonEmpty(v) || !ISO_TS.test(v)) return false;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return false;
  const [y, m, d] = v.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse the record text. Returns { fields: {...} | null, problems: [] } — [] means valid. */
export function parseEstimate(text) {
  let t;
  try {
    t = JSON.parse(text);
  } catch (e) {
    return { fields: null, problems: [`not valid JSON (${String(e.message).slice(0, 120)})`] };
  }
  if (!Array.isArray(t)) return { fields: null, problems: ['not a JSON array — the record is a positional tuple'] };
  if (t.length !== 7) return { fields: null, problems: [`wrong arity: expected exactly 7 elements, got ${t.length}`] };
  const problems = [];
  if (t[0] !== ESTIMATE_MAGIC) problems.push(`element 0 must be the literal "${ESTIMATE_MAGIC}"`);
  if (!RISK_LEVELS.has(t[1])) problems.push('element 1 (risk) must be one of low|medium|high|critical');
  if (!Number.isInteger(t[2]) || t[2] < 0) problems.push('element 2 (files) must be a non-negative integer');
  if (!DEPTH_LEVELS.has(t[3])) problems.push('element 3 (depth) must be low|high');
  if (!nonEmpty(t[4])) problems.push('element 4 (model) must be a non-empty string');
  if (t[5] !== null && !nonEmpty(t[5])) problems.push('element 5 (effort) must be a non-empty string or null');
  if (!isIsoTimestamp(t[6])) problems.push('element 6 (ts) must be an ISO 8601 date-time with a zone (e.g. 2026-09-18T02:00:00Z)');
  if (problems.length > 0) return { fields: null, problems };
  return { fields: { risk: t[1], files: t[2], depth: t[3], model: t[4], effort: t[5], ts: t[6] }, problems: [] };
}

/** Count verification FAIL breadcrumbs ({kind:"test",result:"FAIL"}) whose ts is after `sinceTs`.
 *  `logText` is a tail window the caller already bounded by bytes (review-gate's readTailBounded);
 *  when `partial` is true the first line may be cut and is dropped. Malformed lines are skipped. */
export function countFailsSince(logText, sinceTs, partial = false) {
  const since = Date.parse(sinceTs);
  if (Number.isNaN(since) || typeof logText !== 'string' || logText === '') return 0;
  let text = logText;
  if (partial) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"FAIL"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && e.kind === 'test' && e.result === 'FAIL' && Date.parse(e.ts) > since) n++;
  }
  return n;
}

/** The audit event ({ts,event,actor,meta} convention shared with review_override/harness_sync). */
export function buildEstimateEvent(predicted, risk, failsSinceEstimate, actor) {
  return {
    ts: new Date().toISOString(),
    event: 'estimate_vs_actual',
    actor,
    meta: {
      predicted,
      actual: {
        risk: risk.level,
        diffSize: typeof risk.diffSize === 'number' ? risk.diffSize : null,
        files: Array.isArray(risk.files) ? risk.files.length : null,
        reason: risk.reason,
      },
      fails_since_estimate: failsSinceEstimate,
    },
  };
}
