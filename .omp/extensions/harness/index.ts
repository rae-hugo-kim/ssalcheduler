// harness/index.ts — OMP extension that wires the harness gates (gates/*.mjs)
// into the OMP event model. This replaces the Claude Code registration that
// lived in `.claude/settings.json` (PreToolUse/PostToolUse/... hooks).
//
// Event mapping (Claude Code -> OMP):
//   PreToolUse  Edit|Write   -> tool_call  edit|write            : context-gate (blocking; an
//     xd://ast_edit device write pre-gates the paths named in its JSON body — read-before-edit holds)
//   PreToolUse  Bash         -> tool_call  bash                 : destructive-guard (advisory), commit-gates (blocking)
//   PreToolUse  mcp__*       -> tool_call  mcp__*               : mcp-gate (advisory)
//   PostToolUse Read         -> tool_result read                : read-tracker
//   PostToolUse Grep         -> tool_result grep                 : read-tracker (batched; search-minted [path#TAG] anchors satisfy context-gate)
//   PostToolUse Bash         -> tool_result bash (ok)           : backpressure-tracker
//   PreToolUse  Bash (git commit) -> tool_call bash            : HEAD snapshot of the target repo (landed-vs-blocked, #48/#22)
//   PostToolUse Bash (landed git commit) -> tool_result bash   : harness-version-check (1h window; drift appended to result) + cycle-boundary note
//   BeforeAgentStart -> before_agent_start                      : harness-version-check (1h window; agent-facing reminder) + kickoff-detector
//   PostToolUseFailure Bash  -> tool_result bash (isError)      : backpressure-failure-tracker
//   (none)      Bash (background start, details.async.state "running") : breadcrumb PENDING only — no verdict, no tracker (#40)
//   PostToolUse Edit|Write   -> tool_result edit|write           : mutationRoute -> write-tracker + backpressure-invalidator + mermaid-check
//     (v17 xd:// dispatches ride `write`: ast_edit preview only invalidates backpressure, the REAL
//      apply is tracked via the xd://resolve dispatch envelope; xd grep/ast_grep results record read anchors)
//   UserPromptSubmit         -> before_agent_start              : kickoff-detector (message injection)
//   SessionStart             -> session_start                   : harness-version-check
//
// The gate scripts are unchanged stdin-JSON CLIs (exit 0 = allow, stderr
// "HARNESS WARNING" = advisory; exit 2 = block, stderr = reason) so the
// existing test suite under .omp/extensions/harness/tests/ (synced with the gates) keeps covering them directly.
//
// Requires `node` on PATH (gates are spawned with node, NOT process.execPath —
// inside OMP, process.execPath is the omp binary itself).
//
// Exception: the mermaid check (mermaid-check.ts) runs IN-PROCESS, not as a
// spawned gate — it needs omp's bundled @oh-my-pi/pi-utils parser, which only
// resolves inside the compiled omp binary. It appends a warning chunk to the
// tool result (fail-open, never blocks).
//
// Infra failures (node missing, gate crash, timeout) fail OPEN with a loud warning: every
// gate wired HERE is advisory or edit-scoped (destructive-guard, mcp-gate, context-gate,
// trackers). Only gate exit code 2 is a verdict-block. Commit enforcement is NOT on this
// path any more — .githooks/pre-commit owns it and implements its own fail-closed policy —
// so this layer no longer needs a safety-boundary exception. The bash handler still fails
// closed on its own adapter errors, because a commit may be in flight when it runs.

import { spawn } from "node:child_process";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitBypassTripwire, commitTargetDir, isGitCommit, isWipCommit } from "./gates/git-commit-detect.mjs";
import { mutationCallTargets, mutationRoute, readTarget, searchTrackTargets } from "./gates/read-path.mjs";
import { checkMermaidFile, MERMAID_SUPPORTED } from "./mermaid-check";

const GATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "gates");
const GATE_TIMEOUT_MS = 3_000;
// (The commit gates are no longer spawned from this layer: .githooks/pre-commit runs them
// at index-commit time, in the repo actually being committed to — see AC1/AC6.)
const VERSION_CHECK_TIMEOUT_MS = 15_000;

/** Tools that create or mutate files (Claude Code's Edit|Write matcher). v17 moved
 *  ast_edit behind the xd:// device transport, so it arrives as `write` here. */
const isEditToolName = (name: string): boolean => name === "edit" || name === "write";

interface ContentChunk {
	type: string;
	text?: string;
}

interface ToolCallEvent {
	toolName: string;
	toolCallId?: string;
	input?: Record<string, unknown>;
}

interface ToolResultEvent extends ToolCallEvent {
	content?: ContentChunk[];
	isError?: boolean;
	details?: { exitCode?: number; applied?: boolean; async?: { state?: string; jobId?: string } } & Record<string, unknown>;
}

/**
 * OMP's bash tool reports a non-zero command exit as a SUCCESSFUL tool result
 * (isError stays false) and carries the code in `details.exitCode` — the field
 * is absent entirely on exit 0. Treat either signal as a failed run so failing
 * verifications route to backpressure-failure-tracker, never to a false PASS.
 */
function bashRunFailed(event: ToolResultEvent): boolean {
	if (event.isError) return true;
	const exitCode = event.details?.exitCode;
	return typeof exitCode === "number" && exitCode !== 0;
}

/**
 * HEAD of the repo a `git commit` targets, captured at tool_call and compared at tool_result.
 * "Commit succeeded" used to be read off the overall shell exit (bashRunFailed), which a
 * `… | tail` / `; echo` / `|| true` masks — a gate-BLOCKED commit then produced the
 * cycle-boundary note and a breadcrumb carrying the OLD HEAD as if it were the new commit
 * (#48-5/6). The ground truth is the TARGET repo (`git -C other …`, #22) RECORDING a commit:
 * its HEAD reflog gained a `commit` entry (`commit:`, `commit (amend):`, `commit (initial):`,
 * `commit (merge):`) during the call. The snapshot counts the lines of `logs/HEAD` (verbatim);
 * at result every line beyond those counts — `commit && checkout -b`, a post-commit hook
 * moving HEAD, `checkout --orphan` all keep the commit line, while a `reset`, `checkout`,
 * `pull`, or `rebase` beside a blocked commit appends no commit line. If every snapshot line
 * was expired under us (auto-gc), the entry timestamps bound the call instead. Backends without
 * `logs/HEAD` (reftable) use `git reflog show --date=unix` with the time window; a repo that
 * keeps no reflog at all falls back to a `rev-list old..new` ancestry test — documented
 * residuals. Keyed by toolCallId (the tool_result carries the same id); without one there is no
 * snapshot (a command-string key could consume a stale sibling's entry). Bounded so a result
 * that never arrives (adapter crash) cannot grow the map.
 */
interface HeadSnapshot {
	dir: string;
	/** Full OID, or null for an unborn HEAD (a valid repo with no commit yet). */
	head: string | null;
	/** Wall clock (unix seconds) at snapshot — the fallback "written by this call" boundary. */
	sinceSec: number;
	/**
	 * How the HEAD reflog is read: "file" = `logs/HEAD` (append-only; `known` counts its lines,
	 * verbatim), "show" = `git reflog show` (reftable or other backends; time window only),
	 * "none" = the repo keeps no reflog (born HEAD, nothing logged) → ancestry test.
	 */
	mode: "file" | "show" | "none";
	known: Map<string, number>;
}
const HEAD_SNAPSHOTS = new Map<string, HeadSnapshot>();
const MAX_HEAD_SNAPSHOTS = 64;
/** Reflog entries one bash call may plausibly write; past this the outcome is "unknown". */
const MAX_REFLOG_WALK = 50;
/** Tail of `logs/HEAD` inspected at result time — far beyond what one call can append. */
const REFLOG_TAIL_BYTES = 256 * 1024;
const GIT_QUERY_TIMEOUT_MS = 3_000;

/** stdout + exit status of a bounded `git -C dir …`; status null on spawn error / timeout. */
function gitQuery(dir: string, args: string[]): Promise<{ status: number | null; out: string }> {
	const { promise, resolve: settle } = Promise.withResolvers<{ status: number | null; out: string }>();
	let out = "";
	try {
		const child = spawn("git", ["-C", dir, ...args], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_QUERY_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on("error", () => settle({ status: null, out }));
		child.on("close", (status: number | null) => settle({ status, out: out.trim() }));
	} catch {
		settle({ status: null, out });
	}
	return promise;
}

/**
 * HEAD of `dir` as a full OID. `--verify -q` separates the three outcomes the snapshot needs:
 * exit 0 = a commit; exit 1 = an unborn HEAD (valid repo, first commit pending) → null;
 * anything else (128 not a repo / wrong dir, spawn error, timeout) → undefined = unknown.
 */
async function readHead(dir: string): Promise<string | null | undefined> {
	const { status, out } = await gitQuery(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
	if (status === 0 && out) return out;
	if (status === 1) return null;
	return undefined;
}

interface ReflogEntry {
	oid: string;
	subject: string;
	/** Entry timestamp (unix seconds); NaN when unavailable. */
	ts: number;
	/** The verbatim `logs/HEAD` line (file mode) — exact identity incl. old oid, ident, tz. */
	line: string;
}
const isCommitAction = (subject: string): boolean => /^commit\b/.test(subject);

/** `logs/HEAD` of the repo at `dir` (worktree/GIT_DIR aware), or undefined when git cannot say. */
async function reflogFile(dir: string): Promise<string | undefined> {
	const { status, out } = await gitQuery(dir, ["rev-parse", "--git-path", "logs/HEAD"]);
	return status === 0 && out ? resolve(dir, out) : undefined;
}

/**
 * Parsed lines of `logs/HEAD`, oldest-first, from at most the last REFLOG_TAIL_BYTES of the
 * file. null when the file does not exist; undefined on any other read error.
 */
async function readReflogFile(path: string): Promise<ReflogEntry[] | null | undefined> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - REFLOG_TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		const { bytesRead } = await handle.read(buf, 0, buf.length, start);
		let text = buf.toString("utf8", 0, bytesRead);
		if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the cut first line
		const entries: ReflogEntry[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			// <old-oid> <new-oid> <ident> <unix-ts> <tz>\t<subject> — `[^\n]` (not `.`): a subject may
			// carry U+2028/U+2029, which `.` refuses; the ident is matched lazily up to the ts/tz pair.
			const m = /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) [^\n]*? (\d+) [+-]\d{4}\t([^\n]*)$/.exec(line);
			entries.push(m ? { oid: m[1], subject: m[3], ts: Number(m[2]), line } : { oid: "", subject: "", ts: Number.NaN, line });
		}
		return entries;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
	} finally {
		await handle?.close();
	}
}

/**
 * Newest-first entries via `git reflog show` (backend-independent), or undefined when git
 * could not walk it (spawn error, timeout, unborn HEAD). `--no-show-signature` keeps a
 * `log.showSignature=true` config from prefixing the lines; `--date=unix` makes `%gd` carry
 * the entry timestamp (`HEAD@{<unix>}`).
 */
async function readReflogShow(dir: string, limit: number): Promise<ReflogEntry[] | undefined> {
	const { status, out } = await gitQuery(dir, ["reflog", "show", "--no-show-signature", "--date=unix", "--format=%H%x00%gd%x00%gs", "-n", String(limit), "HEAD"]);
	if (status !== 0) return undefined;
	const entries: ReflogEntry[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [oid, selector, subject] = line.split("\0");
		const ts = /\{(\d+)\}/.exec(selector ?? "")?.[1];
		if (oid) entries.push({ oid, subject: subject ?? "", ts: ts ? Number(ts) : Number.NaN, line });
	}
	return entries;
}

async function snapshotHead(event: ToolCallEvent, command: string, sessionCwd: string): Promise<void> {
	if (!event.toolCallId) return; // no id to pair on
	HEAD_SNAPSHOTS.delete(event.toolCallId); // a reused id must never consume an orphaned entry
	if (event.input?.async === true) return; // the result never carries a verdict
	// Unnormalized join: realpath inside commitTargetDir must see `link/..` before `..` is folded.
	const cwdInput = typeof event.input?.cwd === "string" ? event.input.cwd : "";
	const toolCwd = !cwdInput ? sessionCwd : isAbsolute(cwdInput) ? cwdInput : `${sessionCwd}/${cwdInput}`;
	const dir = commitTargetDir(command, toolCwd);
	if (!dir) return; // unresolvable target: the result falls back to the exit code
	const head = await readHead(dir);
	if (head === undefined) return; // not a repo / git unavailable: nothing to compare against
	const sinceSec = Math.floor(Date.now() / 1000);
	const path = await reflogFile(dir);
	if (!path) return; // git unavailable NOW: no snapshot, never a guessed verdict
	const lines = await readReflogFile(path);
	let snap: HeadSnapshot;
	if (lines === undefined) return;
	if (lines !== null) {
		const known = new Map<string, number>();
		for (const e of lines) known.set(e.line, (known.get(e.line) ?? 0) + 1);
		snap = { dir, head, sinceSec, mode: "file", known };
	} else if (head === null) {
		snap = { dir, head, sinceSec, mode: "file", known: new Map() }; // unborn, no file yet: whatever appears in it is this call's
	} else {
		const shown = await readReflogShow(dir, 1);
		if (shown === undefined) return;
		snap = { dir, head, sinceSec, mode: shown.length ? "show" : "none", known: new Map() };
	}
	HEAD_SNAPSHOTS.set(event.toolCallId, snap);
	while (HEAD_SNAPSHOTS.size > MAX_HEAD_SNAPSHOTS) {
		const oldest = HEAD_SNAPSHOTS.keys().next().value;
		if (oldest === undefined) break;
		HEAD_SNAPSHOTS.delete(oldest);
	}
}

interface CommitOutcome {
	/** true = the target repo recorded a commit; false = it did not (blocked/no-op); null = unknown (no snapshot / git error). */
	landed: boolean | null;
	hash?: string;
}

async function shortHash(dir: string, oid: string): Promise<string> {
	const { status, out } = await gitQuery(dir, ["rev-parse", "--short", oid]);
	return status === 0 && out ? out : oid.slice(0, 7);
}

/**
 * No reflog to consult: only a HEAD that moved onto new commits is decidable ("the new HEAD
 * carries commits the old one did not"); an unchanged HEAD is unknown (a blocked commit and
 * `commit && reset --hard HEAD~1` look alike without a log).
 */
async function ancestryOutcome(snap: HeadSnapshot, after: string | null): Promise<CommitOutcome> {
	if (after === null || after === snap.head) return { landed: null };
	if (snap.head === null) return { landed: true, hash: await shortHash(snap.dir, after) };
	const { status, out } = await gitQuery(snap.dir, ["rev-list", "--count", `${snap.head}..${after}`]);
	if (status !== 0) return { landed: null };
	return Number(out) > 0 ? { landed: true, hash: await shortHash(snap.dir, after) } : { landed: false };
}

/** Decide from the entries this call wrote (oldest-first). `complete` = the set is known to be whole. */
async function decide(snap: HeadSnapshot, written: ReflogEntry[], complete: boolean): Promise<CommitOutcome> {
	const commit = written.findLast((e) => e.oid && isCommitAction(e.subject));
	if (commit) return { landed: true, hash: await shortHash(snap.dir, commit.oid) };
	return complete ? { landed: false } : { landed: null };
}

async function commitOutcome(event: ToolResultEvent): Promise<CommitOutcome> {
	if (!event.toolCallId) return { landed: null };
	const snap = HEAD_SNAPSHOTS.get(event.toolCallId);
	HEAD_SNAPSHOTS.delete(event.toolCallId);
	if (!snap) return { landed: null };
	const after = await readHead(snap.dir);
	if (after === undefined) return { landed: null }; // repo vanished / git error: unknown, not "blocked"
	if (snap.mode === "none") return ancestryOutcome(snap, after);
	if (snap.mode === "file") {
		// `logs/HEAD` is append-only apart from expiry of OLDER entries, so every line beyond the
		// snapshot's per-line count (a multiset — a byte-identical commit line CAN recur when a
		// reset-and-recommit reproduces the same oid in the same second) was written by this
		// call: `commit && checkout -b`, a post-commit hook moving HEAD, `checkout --orphan` (the
		// file survives an unborn HEAD) all keep the commit line. If NONE of the snapshot lines
		// survive (the whole log expired under us) the entry timestamps bound the call instead,
		// not known whole.
		const path = await reflogFile(snap.dir);
		if (!path) return { landed: null };
		const lines = await readReflogFile(path);
		if (lines === undefined) return { landed: null };
		if (lines === null) {
			// Still no file: a repo that logs nothing (or the file was deleted). Nothing to read —
			// only HEAD can speak: unborn → nothing happened; born from unborn → ancestry test.
			if (snap.known.size > 0) return { landed: null };
			return after === null ? { landed: false } : ancestryOutcome(snap, after);
		}
		const seen = new Map<string, number>();
		const written: ReflogEntry[] = [];
		let survivors = 0;
		for (const e of lines) {
			const n = (seen.get(e.line) ?? 0) + 1;
			seen.set(e.line, n);
			if (n <= (snap.known.get(e.line) ?? 0)) survivors++;
			else written.push(e);
		}
		if (snap.known.size > 0 && survivors === 0) return decide(snap, lines.filter((e) => e.ts >= snap.sinceSec), false);
		return decide(snap, written, true);
	}
	// "show": no file to anchor on — the entry timestamps bound the call.
	if (after === null) return { landed: null };
	const shown = await readReflogShow(snap.dir, MAX_REFLOG_WALK);
	if (shown === undefined) return { landed: null };
	const written = shown.filter((e) => e.ts >= snap.sinceSec).reverse();
	return decide(snap, written, written.length < MAX_REFLOG_WALK);
}

interface ToolCallBlock {
	block: true;
	reason: string;
}

/** tool_result middleware patch: returned `content` replaces the original. */
interface ToolResultPatch {
	content: ContentChunk[];
}

interface AgentStartMessage {
	message: {
		customType: string;
		content: string;
		display: boolean;
	};
}

interface SessionMessageLike {
	role?: string;
	content?: unknown;
}

interface SessionEntryLike {
	message?: SessionMessageLike;
	role?: string;
	content?: unknown;
}

interface HarnessCtx {
	cwd: string;
	hasUI: boolean;
	ui?: {
		notify?(message: string, type?: string): void;
	};
	sessionManager?: {
		getBranch?(): SessionEntryLike[];
	};
}

interface HarnessLogger {
	warn?(message: string): void;
	info?(message: string): void;
}

interface HarnessExtensionApi {
	setLabel?(label: string): void;
	logger?: HarnessLogger;
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: HarnessCtx) => Promise<ToolCallBlock | undefined>): void;
	on(event: "tool_result", handler: (event: ToolResultEvent, ctx: HarnessCtx) => Promise<ToolResultPatch | undefined>): void;
	on(event: "before_agent_start", handler: (event: unknown, ctx: HarnessCtx) => Promise<AgentStartMessage | undefined>): void;
	on(event: "session_start", handler: (event: unknown, ctx: HarnessCtx) => Promise<void>): void;
}

/** Freshness window for mid-session drift rechecks (turn start, post-commit). */
const DRIFT_RECHECK_MAX_AGE_MS = 60 * 60 * 1000;

/** Agent-facing cycle-boundary nudge appended to every successful non-WIP `git commit` result.
 *  A successful commit is the cycle-end marker (.omp/rules/harness-cycle_definition.md); the nudge re-arms
 *  the intake discipline mid-session even after compaction has evicted the always-on rule.
 *  `wip:` checkpoints stay quiet — they are mid-implementation, the exact moment
 *  context_management.md says NOT to break. */
const CYCLE_BOUNDARY_NOTE =
	"HARNESS NOTE: commit succeeded — cycle boundary (.omp/rules/harness-cycle_definition.md). " +
	"If this completes the current cycle: update the instruction doc / cycle queue " +
	"(check the box, record deferrals), then suggest the user run /clear and resume with the next cycle.";

/** stdin payload in the shape the Claude Code hook protocol fed the gates. */
interface GatePayload {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	prompt?: string;
	max_age_ms?: number;
	session_state: { cwd: string };
}

interface GateRun {
	status: number | null;
	stdout: string;
	stderr: string;
	/** Spawn-level failure (node missing, ...), not a gate verdict. */
	failure?: string;
}

function runGate(script: string, payload: GatePayload, timeoutMs = GATE_TIMEOUT_MS): Promise<GateRun> {
	const { promise, resolve: settle } = Promise.withResolvers<GateRun>();
	let stdout = "";
	let stderr = "";
	try {
		const child = spawn("node", [join(GATES_DIR, script)], {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeoutMs,
			// SIGKILL: a SIGTERM-catching child could swallow the timeout and exit 0. Every gate on
			// THIS path is advisory or edit-scoped, but an uncatchable kill keeps the budget a hard
			// ceiling (the commit gates enforce their own fail-closed policy inside the hook).
			killSignal: "SIGKILL",
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err: Error) => settle({ status: null, stdout, stderr, failure: err.message }));
		child.on("close", (status: number | null) => settle({ status, stdout, stderr }));
		// A gate that exits before draining stdin (early no-op paths, cached verdicts) closes the
		// pipe under our pending write. The resulting EPIPE is not a gate failure — the verdict
		// arrives via `close` — but with no listener it is an UNCAUGHT stream error that takes the
		// whole omp process down (observed on omp 18.1.13, which no longer swallows it).
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(payload));
	} catch (err) {
		settle({ status: null, stdout, stderr, failure: err instanceof Error ? err.message : String(err) });
	}
	return promise;
}

function textChunks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const chunk of content) {
		if (chunk && typeof chunk === "object" && (chunk as ContentChunk).type === "text") {
			const part = (chunk as ContentChunk).text;
			if (part) text += (text ? "\n" : "") + part;
		}
	}
	return text;
}

function latestUserText(event: unknown, ctx: HarnessCtx): string {
	const evt = event as { prompt?: unknown; text?: unknown } | undefined;
	if (typeof evt?.prompt === "string" && evt.prompt) return evt.prompt;
	if (typeof evt?.text === "string" && evt.text) return evt.text;
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		const message = entry.message ?? entry;
		if (message.role !== "user") continue;
		const text = textChunks(message.content);
		if (text) return text;
	}
	return "";
}

/** Append a HARNESS WARNING chunk when any mermaid block failed to parse. */
function mermaidResultPatch(event: ToolResultEvent, problems: string[]): ToolResultPatch | undefined {
	if (!problems.length) return undefined;
	const text = [
		"HARNESS WARNING: invalid mermaid diagram(s) in this edit — the OMP bundled parser rejected:",
		...problems.map((problem) => `  - ${problem}`),
		`Supported types: ${MERMAID_SUPPORTED}.`,
		"Fix the block(s) and re-save; docs are rendered by Obsidian/GitHub and the OMP TUI.",
	].join("\n");
	return { content: [...(event.content ?? []), { type: "text", text }] };
}

export default function harness(pi: HarnessExtensionApi): void {
	pi.setLabel?.("Harness Gates");

	const surface = (ctx: HarnessCtx, run: GateRun, gate: string): void => {
		const lines: string[] = [];
		if (run.failure) lines.push(`HARNESS WARNING: gate '${gate}' did not run (${run.failure}); skipping it.`);
		else if (run.status !== 0 && run.status !== 2) lines.push(`HARNESS WARNING: gate '${gate}' exited ${run.status}; skipping it.`);
		const stderr = run.stderr.trim();
		if (stderr && run.status !== 2) lines.push(stderr);
		if (!lines.length) return;
		const message = lines.join("\n");
		if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, "warning");
		else pi.logger?.warn?.(message);
	};

	pi.on("tool_call", async (event, ctx) => {
		// The bash-commit path fails CLOSED on adapter errors (its own catch below); the outer
		// catch keeps advisory hooks fail-open.
		if (event.toolName === "bash") {
			try {
				const session_state = { cwd: ctx.cwd };
				const command = String(event.input?.command ?? "");
				if (!command) return;
				const toolEnv =
					event.input?.env && typeof event.input.env === "object"
						? (event.input.env as Record<string, string>)
						: undefined;
				// Pass the bash tool's STRUCTURED inputs through: `cwd` changes where the command
				// runs, execution-sensitive `env` can change Git/config meaning, and `async`
				// defers execution past the verdict — the dispatcher must judge all three.
				const payload: GatePayload = {
					tool_name: "Bash",
					tool_input: {
						command,
						cwd: typeof event.input?.cwd === "string" ? event.input.cwd : undefined,
						env: toolEnv,
						async: event.input?.async === true,
					},
					session_state,
				};
				const guard = await runGate("destructive-guard.mjs", payload);
				surface(ctx, guard, "destructive-guard");
				// Enforcement moved to .githooks/pre-commit: it sees the real index, in the real
				// target repo, for every spelling and every author (agent or human). This layer
				// therefore keeps only the tripwire — a call that DECLARES a hook bypass or
				// relocation, which is the one thing the hook itself cannot observe.
				const bypass = commitBypassTripwire(command, toolEnv);
				if (bypass) {
					return {
						block: true,
						reason: [
							`HARNESS BLOCK: ${bypass}.`,
							"The commit gates run as .githooks/pre-commit; bypassing or relocating them is not an agent-available action.",
							"Run the commit plainly (git commit -m …) and fix whatever the gates report. A human may use --no-verify deliberately; the post-commit backstop records it.",
						].join("\n"),
					};
				}
				// Snapshot the target repo's HEAD so the result can tell a landed commit from a
				// gate-blocked one (see HEAD_SNAPSHOTS). Only commit commands pay the rev-parse.
				if (isGitCommit(command)) await snapshotHead(event, command, ctx.cwd);
			} catch (err) {
				// A commit may be in flight: an adapter bug here must NOT fail open.
				return { block: true, reason: `HARNESS BLOCK: bash commit-gate adapter error (failing closed): ${err instanceof Error ? err.message : String(err)}` };
			}
			return;
		}
		try {
			const session_state = { cwd: ctx.cwd };
			if (isEditToolName(event.toolName)) {
				for (const filePath of mutationCallTargets(event.toolName, event.input, ctx.cwd)) {
					const run = await runGate("context-gate.mjs", { tool_name: "Edit", tool_input: { file_path: filePath }, session_state });
					if (run.status === 2) return { block: true, reason: run.stderr.trim() || `HARNESS BLOCK: read '${filePath}' before editing it.` };
					surface(ctx, run, "context-gate");
				}
				return;
			}
			if (/^mcp__/.test(event.toolName)) {
				const run = await runGate("mcp-gate.mjs", { tool_name: event.toolName, tool_input: event.input ?? {}, session_state });
				surface(ctx, run, "mcp-gate");
			}
		} catch (err) {
			// Never fail closed on adapter bugs — gates block only via exit 2.
			pi.logger?.warn?.(`HARNESS WARNING: tool_call adapter error: ${err instanceof Error ? err.message : String(err)}`);
		}
		return;
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			const session_state = { cwd: ctx.cwd };
			if (event.toolName === "read" && !event.isError) {
				const filePath = readTarget(event.input, ctx.cwd);
				if (filePath) await runGate("read-tracker.mjs", { tool_name: "Read", tool_input: { file_path: filePath }, session_state });
				return;
			}
			// grep/ast_grep mint per-file [path#TAG] edit anchors backed by whole-file
			// snapshots, and OMP's edit tool accepts them ("from your latest read/search") —
			// record the anchored files as read or context-gate false-blocks a grep-anchored
			// edit (live-reproduced on omp 16.3.12, 2026-07-09). One batched spawn per result.
			if (event.toolName === "grep" && !event.isError) {
				const files = searchTrackTargets(event.details, textChunks(event.content), ctx.cwd);
				if (files.length) await runGate("read-tracker.mjs", { tool_name: "Read", tool_input: { file_paths: files }, session_state });
				return;
			}
			if (event.toolName === "bash") {
				const command = String(event.input?.command ?? "");
				if (!command) return;
				// Background-start result (`async: true`, or bash.autoBackground converting a run
				// that outlived its wait window): details.async.state is "running", isError false,
				// exitCode absent. The real outcome arrives later via onUpdate / the async job
				// manager — never as a tool_result — so this event carries NO verdict: leave
				// backpressure untouched (neither PASS nor FAIL) and record the breadcrumb as
				// PENDING. Routing it to a tracker recorded a failing `node --test` as PASS and
				// cleared backpressure-last-fail (live-reproduced on omp 18.3.0, 2026-09-24, #40).
				// A backgrounded `git commit` is not a commit yet either, so the post-commit drift
				// recheck / cycle-boundary note must not fire here.
				if (event.details?.async?.state === "running") {
					if (event.toolCallId) HEAD_SNAPSHOTS.delete(event.toolCallId);
					await runGate("breadcrumb-tracker.mjs", { tool_name: "Bash", tool_input: { command, pending: true }, session_state });
					return;
				}
				const payload: GatePayload = { tool_name: "Bash", tool_input: { command }, session_state };
				const tracker = bashRunFailed(event) ? "backpressure-failure-tracker.mjs" : "backpressure-tracker.mjs";
				await runGate(tracker, payload);
				// A commit "succeeded" only if the repo it targeted gained a commit; without a
				// snapshot (unresolvable target, e.g. `cd x && git commit`) the exit code decides.
				const commit = isGitCommit(command) ? await commitOutcome(event) : null;
				const landed = commit ? (commit.landed ?? !bashRunFailed(event)) : false;
				await runGate("breadcrumb-tracker.mjs", {
					tool_name: "Bash",
					tool_input: { command, failed: bashRunFailed(event), ...(commit?.landed === null ? {} : { landed: commit?.landed, hash: commit?.hash }) },
					session_state,
				});
				// Post-commit drift recheck (1h window): a bump published mid-session surfaces at
				// the next commit. Appended to the tool result so the AGENT sees it — surface()/
				// ui.notify is human-facing only. Non-blocking by design: a stale harness never
				// invalidates the commit itself (blocking here would force a remote-wins sync
				// onto a dirty tree — the exact hazard we avoid).
				if (landed) {
					const notes: string[] = [];
					const drift = await runGate("harness-version-check.mjs", { session_state, max_age_ms: DRIFT_RECHECK_MAX_AGE_MS }, VERSION_CHECK_TIMEOUT_MS);
					const driftNote = drift.stdout.trim();
					if (driftNote) notes.push(driftNote);
					// Cycle-boundary nudge: only non-WIP commits mark a cycle end (see CYCLE_BOUNDARY_NOTE).
					if (!isWipCommit(command)) notes.push(CYCLE_BOUNDARY_NOTE);
					if (notes.length) return { content: [...(event.content ?? []), { type: "text", text: notes.join("\n\n") }] };
				}
				return;
			}
			if (isEditToolName(event.toolName) && !event.isError) {
				// v17 xd:// device dispatches ride `write` (details.xdev envelope); mutationRoute
				// classifies them BEFORE plain file targets — structurally fixing the ordering that
				// let device writes fall into the generic branch and track only the bogus device
				// path (live-reproduced on omp 17.0.1, 2026-07-16; contract tests: xdev-dispatch).
				const route = mutationRoute(event.toolName, event.input, event.details, textChunks(event.content), ctx.cwd);
				// xd grep/ast_grep results mint [path#TAG] edit anchors exactly like the top-level
				// grep tool — record them as read or context-gate false-blocks an anchored edit.
				if (route.kind === "read-anchors") {
					if (route.files.length) await runGate("read-tracker.mjs", { tool_name: "Read", tool_input: { file_paths: route.files }, session_state });
					return;
				}
				// Staged ast_edit preview: backpressure-invalidator as a BEST-EFFORT early fallback
				// (from the device args' paths). The breadcrumb (phantom until apply, false on
				// discard) and write-tracker are deferred to the xd://resolve apply below.
				if (route.kind === "preview") {
					for (const filePath of route.files) {
						await runGate("backpressure-invalidator.mjs", { tool_name: "Write", tool_input: { file_path: filePath }, session_state });
					}
					return;
				}
				// Other xd devices (generate_image, MCP tools, …) touch no local files.
				if (route.kind === "device") return;
				// "apply" (the REAL write of a staged preview, resolved from the dispatch envelope's
				// inner file list) and "files" (plain write/edit) share full tracking.
				const mermaidProblems: string[] = [];
				for (const filePath of route.files) {
					const payload: GatePayload = { tool_name: "Write", tool_input: { file_path: filePath }, session_state };
					await runGate("write-tracker.mjs", payload);
					await runGate("backpressure-invalidator.mjs", payload);
					await runGate("breadcrumb-tracker.mjs", payload);
					for (const problem of await checkMermaidFile(filePath)) {
						mermaidProblems.push(`${relative(ctx.cwd, filePath)}: ${problem}`);
					}
				}
				return mermaidResultPatch(event, mermaidProblems);
			}
		} catch (err) {
			pi.logger?.warn?.(`HARNESS WARNING: tool_result adapter error: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const session_state = { cwd: ctx.cwd };
			const notes: string[] = [];
			// Turn-start drift reminder (1h window): cache hits are a fast local read; misses
			// probe ls-remote at most once per window, and failed probes back off via the
			// gate's failure marker. Returned as a message so the AGENT acts on it.
			const drift = await runGate("harness-version-check.mjs", { session_state, max_age_ms: DRIFT_RECHECK_MAX_AGE_MS }, VERSION_CHECK_TIMEOUT_MS);
			const driftNote = drift.stdout.trim();
			if (driftNote) notes.push(driftNote);
			const prompt = latestUserText(event, ctx);
			if (prompt) {
				const run = await runGate("kickoff-detector.mjs", { prompt, session_state });
				const note = run.stdout.trim();
				if (note) notes.push(note);
			}
			if (notes.length) return { message: { customType: "harness-reminder", content: notes.join("\n\n"), display: true } };
		} catch (err) {
			pi.logger?.warn?.(`HARNESS WARNING: before_agent_start adapter error: ${err instanceof Error ? err.message : String(err)}`);
		}
		return;
	});

	pi.on("session_start", async (_event, ctx) => {
		const session_state = { cwd: ctx.cwd };
		try {
			const run = await runGate("harness-version-check.mjs", { session_state }, VERSION_CHECK_TIMEOUT_MS);
			const note = `${run.stdout}\n${run.stderr}`.trim();
			if (note) { if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(note, "warning"); else pi.logger?.info?.(note); }
		} catch {
			// Version check is best-effort advisory; stay silent on infra errors.
		}
		try {
			const run = await runGate("breadcrumb-surface.mjs", { session_state });
			const note = run.stdout.trim();
			if (note) { if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(note, "info"); else pi.logger?.info?.(note); }
		} catch {
			// Surface is best-effort; prior summaries are a nicety, not a gate.
		}
	});
}
