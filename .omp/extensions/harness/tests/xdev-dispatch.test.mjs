// xdev-dispatch.test.mjs — v17 xd:// 디바이스 디스패치의 원장 배선.
//
// Regression (omp 17.0.1, 2026-07-16 라이브 프로브로 재현): v17에서 ast_edit/ast_grep/
// resolve가 xd:// 디바이스로 이동해 `write` tool_result로 도착한다. 구 배선은
// ① toolName==="resolve"|"ast_edit"|"ast_grep" 분기가 영원히 미발화 → 적용 파일이
//    write-tracker/backpressure-invalidator/breadcrumb에 누락 (검증 상태가 신선한 척 유지),
// ② editTargets가 디바이스 경로를 resolve(cwd, "xd://…")로 오염 →
//    session-log에 {kind:'edit', file:'xd:/ast_edit'}, read-log에 `<cwd>/xd:/…` 쓰레기 등록.
//
// 수리는 라우팅을 순수 함수(mutationRoute)로 추출해 "xdev 봉투 우선, 파일 타깃은 그 뒤"
// 순서를 구조로 고정한다 — index.ts는 이 함수의 결과에 게이트만 물린다.

import test from 'node:test';
import assert from 'node:assert';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	xdevEnvelope,
	localFileTarget,
	astEditResultFiles,
	resolvedAstEditFiles,
	searchTrackTargets,
	editTargets,
	mutationCallTargets,
	mutationRoute,
	readTarget,
} from '../gates/read-path.mjs';

const CWD = '/work';
// XdevDispatch.mode는 실행 디스패치에서 "execute" (tools/resolve.ts writeDeviceDispatch 계약).
const env = (tool, inner) => ({ xdev: { tool, mode: 'execute', inner } });

// ── xdevEnvelope: write tool_result의 details.xdev 봉투

test('xdevEnvelope: 유효한 봉투를 반환', () => {
	const details = env('resolve', { action: 'apply' });
	assert.deepEqual(xdevEnvelope(details), details.xdev);
});

test('xdevEnvelope: tool/mode 누락·비객체·부재는 null', () => {
	assert.equal(xdevEnvelope(undefined), null);
	assert.equal(xdevEnvelope({}), null);
	assert.equal(xdevEnvelope({ xdev: null }), null);
	assert.equal(xdevEnvelope({ xdev: 'resolve' }), null);
	assert.equal(xdevEnvelope({ xdev: { tool: 'resolve' } }), null);        // mode 없음
	assert.equal(xdevEnvelope({ xdev: { mode: 'execute' } }), null);        // tool 없음
});

// ── 라우터: xd://resolve apply → 실제 적용 파일이 "apply"로 (advisory 케이스 1)

test('route: resolve apply는 실파일 목록의 apply', () => {
	const details = env('resolve', {
		action: 'apply', reason: 'r', sourceToolName: 'ast_edit',
		sourceResultDetails: { files: ['/abs/a.mjs', 'rel/b.mjs'] },
	});
	assert.deepEqual(
		mutationRoute('write', { path: 'xd://resolve', content: 'why' }, details, '', CWD),
		{ kind: 'apply', files: ['/abs/a.mjs', resolve(CWD, 'rel/b.mjs')] },
	);
});

test('route: reject(discard)·비ast_edit 소스는 device (기록 없음)', () => {
	const discard = env('reject', { action: 'discard', reason: 'r', sourceToolName: 'ast_edit' });
	assert.deepEqual(mutationRoute('write', { path: 'xd://reject' }, discard, '', CWD), { kind: 'device' });
	const other = env('resolve', { action: 'apply', reason: 'r', sourceToolName: 'custom_stage' });
	assert.deepEqual(mutationRoute('write', { path: 'xd://resolve' }, other, '', CWD), { kind: 'device' });
});

// ── 라우터: xd://ast_grep → read 앵커 (advisory 케이스 2)

test('route: ast_grep 디바이스는 inner.files를 read-anchors로', () => {
	const details = env('ast_grep', { files: ['/abs/hit.ts', 'src/hit2.ts'] });
	assert.deepEqual(
		mutationRoute('write', { path: 'xd://ast_grep' }, details, '', CWD),
		{ kind: 'read-anchors', files: ['/abs/hit.ts', resolve(CWD, 'src/hit2.ts')] },
	);
});

test('route: ast_grep files 부재 시 렌더된 [path#TAG] 앵커 폴백', () => {
	const details = env('ast_grep', {});
	const text = 'no files detail\n[src/anchor.ts#AB12]\n42: hit';
	assert.deepEqual(
		mutationRoute('write', { path: 'xd://ast_grep' }, details, text, CWD),
		{ kind: 'read-anchors', files: [resolve(CWD, 'src/anchor.ts')] },
	);
});

// ── 라우터: ast_edit 디바이스 — 프리뷰 vs 직접 적용

test('route: ast_edit 프리뷰는 디바이스 인자 paths의 preview', () => {
	const input = { path: 'xd://ast_edit', content: '{"ops":[],"paths":["p.mjs","xd://nope"]}' };
	assert.deepEqual(
		mutationRoute('write', input, env('ast_edit', { applied: false }), '', CWD),
		{ kind: 'preview', files: [resolve(CWD, 'p.mjs')] },
	);
});

test('route: ast_edit 직접 적용(dryRun:false)은 inner.files의 apply', () => {
	const details = env('ast_edit', { applied: true, files: ['x.mjs'] });
	assert.deepEqual(
		mutationRoute('write', { path: 'xd://ast_edit' }, details, '', CWD),
		{ kind: 'apply', files: [resolve(CWD, 'x.mjs')] },
	);
});

// ── 라우터: 기타 디바이스는 무시, 일반 파일 쓰기는 files (순서 회귀 고정)

test('route: 기타 xd 디바이스(generate_image 등)는 device', () => {
	assert.deepEqual(
		mutationRoute('write', { path: 'xd://generate_image' }, env('generate_image', {}), '', CWD),
		{ kind: 'device' },
	);
});

test('route: 일반 파일 write/edit는 files — xdev 검사가 항상 선행', () => {
	assert.deepEqual(
		mutationRoute('write', { path: 'src/a.ts' }, { some: 'detail' }, '', CWD),
		{ kind: 'files', files: [resolve(CWD, 'src/a.ts')] },
	);
	assert.deepEqual(
		mutationRoute('edit', { path: 'src/b.ts' }, undefined, '', CWD),
		{ kind: 'files', files: [resolve(CWD, 'src/b.ts')] },
	);
});

test('route: 봉투 없는 xd:// write는 files지만 스킴 가드로 빈 목록', () => {
	assert.deepEqual(
		mutationRoute('write', { path: 'xd://resolve' }, undefined, '', CWD),
		{ kind: 'files', files: [] },
	);
});

// ── editTargets: URI 스킴이 로컬 경로로 오염되지 않음 (advisory 케이스 3)

test('editTargets: xd://·local:// 타깃은 제외', () => {
	assert.deepEqual(editTargets('write', { path: 'xd://resolve' }, CWD), []);
	assert.deepEqual(editTargets('write', { path: 'local://plan.md' }, CWD), []);
	assert.deepEqual(editTargets('write', { path: 'src/a.ts' }, CWD), [resolve(CWD, 'src/a.ts')]);
});

test('editTargets: edit의 direct/paths/hashline 헤더 전부 스킴 가드', () => {
	const input = {
		path: 'xd://weird',
		paths: ['src/c.ts', 'memory://m'],
		input: '[src/d.ts#AB12]\nSWAP 1.=1:\n+x\n[xd://dev#FFFF]\n',
	};
	assert.deepEqual(
		editTargets('edit', input, CWD).sort(),
		[resolve(CWD, 'src/c.ts'), resolve(CWD, 'src/d.ts')].sort(),
	);
});

// ── 저수준 헬퍼 계약

test('localFileTarget: URI 스킴은 null, 파일 경로는 절대화', () => {
	assert.equal(localFileTarget('xd://resolve', CWD), null);
	assert.equal(localFileTarget('local://plan.md', CWD), null);
	assert.equal(localFileTarget('memory://abc', CWD), null);
	assert.equal(localFileTarget('src/a.ts', CWD), resolve(CWD, 'src/a.ts'));
	assert.equal(localFileTarget('/abs/b.ts', CWD), '/abs/b.ts');
	assert.equal(localFileTarget('', CWD), null);
	assert.equal(localFileTarget(42, CWD), null);
});

test('resolvedAstEditFiles / astEditResultFiles: 파일 목록 정규화', () => {
	const inner = { sourceResultDetails: { files: ['/abs/a.mjs', { path: 'rel.mjs' }] } };
	assert.deepEqual(resolvedAstEditFiles(inner, CWD), ['/abs/a.mjs', resolve(CWD, 'rel.mjs')]);
	assert.deepEqual(resolvedAstEditFiles({ action: 'apply' }, CWD), []);
	assert.deepEqual(astEditResultFiles({ files: ['x.mjs'] }, CWD), [resolve(CWD, 'x.mjs')]);
	assert.deepEqual(astEditResultFiles(undefined, CWD), []);
});

test('결과 payload의 files에 URI 항목이 섞여도 원장 오염 없음 (V1)', () => {
	const inner = { sourceResultDetails: { files: ['xd://resolve', 'local://x.md', 'ok.mjs'] } };
	assert.deepEqual(resolvedAstEditFiles(inner, CWD), [resolve(CWD, 'ok.mjs')]);
	assert.deepEqual(astEditResultFiles({ files: ['xd://ast_edit', 'ok2.mjs'] }, CWD), [resolve(CWD, 'ok2.mjs')]);
	assert.deepEqual(searchTrackTargets({ files: ['memory://m', '/abs/ok.ts'] }, '', CWD), ['/abs/ok.ts']);
});

test('단일 슬래시 정규화형 가상 URI도 원장에 못 들어간다 (r2 — session-log:315 xd:/retain 반례)', () => {
	// omp 이벤트 배관 어딘가에서 xd://가 xd:/ 단일 슬래시로 정규화되어 도착할 수 있다 —
	// `://` 부분문자열 검사만으로는 통과해 팬텀 edit이 기록됐다 (2026-07-16 12:33 실측).
	assert.equal(localFileTarget('xd:/retain', CWD), null);
	assert.equal(localFileTarget('local:/plan.md', CWD), null);
	assert.equal(localFileTarget('memory:/abc', CWD), null);
	assert.deepEqual(editTargets('write', { path: 'xd:/retain' }, CWD), []);
	assert.deepEqual(
		mutationRoute('write', { path: 'xd:/retain' }, undefined, '', CWD),
		{ kind: 'files', files: [] },
	);
	assert.deepEqual(resolvedAstEditFiles({ sourceResultDetails: { files: ['xd:/x', 'ok.mjs'] } }, CWD),
		[resolve(CWD, 'ok.mjs')]);
	// 통상 상대 경로는 계속 추적된다 (콜론 없는 경로 오탐 없음)
	assert.equal(localFileTarget('src/a.ts', CWD), resolve(CWD, 'src/a.ts'));
});

// ── tool_call 측: xd://ast_edit 바디의 paths가 pre-edit 게이트 대상 (advisory — V2)

test('mutationCallTargets: xd://ast_edit 바디 paths를 게이트 대상으로 추출', () => {
	const input = { path: 'xd://ast_edit', content: '{"ops":[],"paths":["src/x.ts","xd://nope"]}' };
	assert.deepEqual(mutationCallTargets('write', input, CWD), [resolve(CWD, 'src/x.ts')]);
});

test('mutationCallTargets: 타 디바이스·비JSON 바디는 빈 목록, 일반 경로는 editTargets 위임', () => {
	assert.deepEqual(mutationCallTargets('write', { path: 'xd://resolve', content: 'why' }, CWD), []);
	assert.deepEqual(mutationCallTargets('write', { path: 'xd://ast_edit', content: 'not json' }, CWD), []);
	assert.deepEqual(mutationCallTargets('write', { path: 'src/a.ts', content: 'x' }, CWD), [resolve(CWD, 'src/a.ts')]);
	assert.deepEqual(mutationCallTargets('edit', { path: 'src/b.ts' }, CWD), [resolve(CWD, 'src/b.ts')]);
});

test('mutationCallTargets: path 별칭(file_path/filePath)으로 온 디바이스도 게이트 대상 (review M1)', () => {
	const body = '{"ops":[],"paths":["src/x.ts"]}';
	assert.deepEqual(mutationCallTargets('write', { file_path: 'xd://ast_edit', content: body }, CWD), [resolve(CWD, 'src/x.ts')]);
	assert.deepEqual(mutationCallTargets('write', { filePath: 'xd://ast_edit', content: body }, CWD), [resolve(CWD, 'src/x.ts')]);
});

test('mutationCallTargets: 정규화·대소문자 변형 디바이스 경로도 게이트 대상 (r3 adversary medium)', () => {
	// 이벤트 배관의 단일 슬래시 정규화(xd:/recall 실측, session-log:331-332)가 tool_call에
	// 나타나면 정확 일치 비교는 분기를 놓쳐 read-before-edit가 통째로 우회된다.
	const body = '{"ops":[],"paths":["src/unread.ts"]}';
	for (const p of ['xd:/ast_edit', 'XD://ast_edit', ' xd://ast_edit ']) {
		assert.deepEqual(mutationCallTargets('write', { path: p, content: body }, CWD),
			[resolve(CWD, 'src/unread.ts')], p);
	}
});

test('read/search 원장 경로도 단일 슬래시 가상 URI를 거부한다 (r3 adversary low)', () => {
	assert.equal(readTarget({ path: 'xd:/retain' }, CWD), '');
	assert.equal(readTarget({ path: 'memory:/abc:5-10' }, CWD), '');
	assert.equal(readTarget({ path: 'src/a.ts:5-10' }, CWD), resolve(CWD, 'src/a.ts'));
	assert.deepEqual(searchTrackTargets({ files: ['memory:/m', 'src/a.ts'] }, '', CWD),
		[resolve(CWD, 'src/a.ts')]);
	assert.deepEqual(searchTrackTargets(undefined, '[xd:/foo#AB12]\n[src/b.ts#CD34]\n', CWD),
		[resolve(CWD, 'src/b.ts')]);
});

test('스킴 유사 정당 POSIX 경로는 가상으로 오분류하지 않는다 (r4 adversary — 게이트·원장 동시 탈락 방지)', () => {
	// POSIX는 파일명에 ':'를 허용한다 — `pkg:/danger.ts`(디렉토리명 `pkg:`)를 가상으로
	// 버리면 read-before-edit와 write-tracker에서 동시에 빠진다(팬텀보다 나쁜 방향).
	// 단일 슬래시 거부는 알려진 가상 스킴 allowlist로만.
	assert.equal(localFileTarget('pkg:/danger.ts', CWD), resolve(CWD, 'pkg:/danger.ts'));
	assert.equal(readTarget({ path: 'src:/app.ts' }, CWD), resolve(CWD, 'src:/app.ts'));
	assert.deepEqual(editTargets('write', { path: 'pkg:/danger.ts' }, CWD), [resolve(CWD, 'pkg:/danger.ts')]);
	assert.deepEqual(searchTrackTargets({ files: ['pkg:/a.ts'] }, '', CWD), [resolve(CWD, 'pkg:/a.ts')]);
	// 알려진 가상 스킴의 단일 슬래시 형은 계속 거부 (r2/r3 계약 유지)
	for (const v of ['xd:/retain', 'local:/plan.md', 'memory:/abc', 'artifact:/7', 'agent:/id', 'mcp:/x', 'skill:/s', 'history:/h']) {
		assert.equal(localFileTarget(v, CWD), null, v);
	}
});

// ── 게이트 통합 (V2): xd://ast_edit 대상이 context-gate의 read-before-edit를 그대로 받는다

const GATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'gates');
const runGate = (script, payload) =>
	spawnSync('node', [join(GATES, script)], { input: JSON.stringify(payload), encoding: 'utf-8' });

test('context-gate 통합: xd://ast_edit 대상 미read → BLOCK, read 후 → 통과', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'xdev-gate-'));
	try {
		writeFileSync(join(tmp, 't.mjs'), 'console.log("x")\n');
		const input = { path: 'xd://ast_edit', content: '{"ops":[],"paths":["t.mjs"]}' };
		const targets = mutationCallTargets('write', input, tmp);
		assert.equal(targets.length, 1);
		const payload = (fp) => ({ tool_name: 'Edit', tool_input: { file_path: fp }, session_state: { cwd: tmp } });

		// negative: 미read 기존 파일 → exit 2 (read-before-edit 불변식이 디바이스 경유에도 적용)
		const blocked = runGate('context-gate.mjs', payload(targets[0]));
		assert.equal(blocked.status, 2, `expected BLOCK, got ${blocked.status}: ${blocked.stderr}`);

		// positive: read-tracker로 read 기록 후 → 통과
		const tracked = runGate('read-tracker.mjs', { tool_name: 'Read', tool_input: { file_path: targets[0] }, session_state: { cwd: tmp } });
		assert.equal(tracked.status, 0);
		const allowed = runGate('context-gate.mjs', payload(targets[0]));
		assert.equal(allowed.status, 0, `expected allow, got ${allowed.status}: ${allowed.stderr}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
