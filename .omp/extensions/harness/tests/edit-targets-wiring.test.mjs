// edit-targets-wiring.test.mjs — editTargets의 hashline `edit` 타깃 소스 계약.
//
// OMP >=16.1.17 exposes every parsed hashline target on the extension event as
// `event.input.paths` (and `event.input.path` for single-file calls). The adapter
// must consult that native list FIRST — it is the only source that can carry an
// `MV DEST` path (v16.2.0 op), which never appears in a `[path#TAG]` header — while
// KEEPING the header-regex fallback for hosts that don't expose parsed targets.
//
// v17 적응에서 editTargets가 read-path.mjs로 이동·export되어, 과거의 소스-텍스트
// 검사(regex on index.ts)를 실제 행동 테스트로 대체한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { editTargets } from '../gates/read-path.mjs';

const CWD = '/work';

test('edit는 native parsed-target(input.paths)을 병합 — MV DEST처럼 헤더에 없는 경로 포함', () => {
	const input = {
		paths: ['src/a.ts', 'dest/moved.ts'],           // host-parsed list (MV DEST는 여기에만 온다)
		input: '[src/a.ts#AB12]\nMV dest/moved.ts\n',    // 헤더에는 소스 파일만
	};
	const targets = editTargets('edit', input, CWD);
	assert.ok(targets.includes(resolve(CWD, 'dest/moved.ts')),
		'native paths의 MV DEST가 타깃에 포함되어야 함 (헤더 폴백만으로는 불가능)');
	assert.ok(targets.includes(resolve(CWD, 'src/a.ts')));
});

test('paths 미제공 호스트에서는 [path#TAG] 헤더 폴백이 타깃을 복원', () => {
	const input = { input: '[src/only-header.ts#AB12]\nSWAP 1.=1:\n+x\n' };
	assert.deepEqual(editTargets('edit', input, CWD), [resolve(CWD, 'src/only-header.ts')]);
});

test('direct path 필드(find/replace형 edit)가 존중됨', () => {
	assert.deepEqual(editTargets('edit', { path: 'src/direct.ts' }, CWD), [resolve(CWD, 'src/direct.ts')]);
});

test('세 소스가 중복 없이 합집합으로 병합됨', () => {
	const input = {
		path: 'src/a.ts',
		paths: ['src/a.ts', 'src/b.ts'],
		input: '[src/a.ts#AB12]\n[src/c.ts#CD34]\n',
	};
	assert.deepEqual(
		editTargets('edit', input, CWD).sort(),
		[resolve(CWD, 'src/a.ts'), resolve(CWD, 'src/b.ts'), resolve(CWD, 'src/c.ts')].sort(),
	);
});
