# Closeout Contract

작업이 **main에 도달하는 순간**(= `compr` PR 생성 또는 `compush` 직접 푸시) 추적 중인 작업을 마감(closeout)해 staleness를 막는다. closeout은 git 액션이 아니라 **상태(seed/AC 완료)에 키잉**한다 — `compush`는 중간 푸시일 수 있으므로.

이것은 **트리거 레인**(do, 에이전트 실행, best-effort)이다. "실제로 닫혔는지"는 별도 **검증 레인**(docs-drift, pre-push)이 트리거를 신뢰하지 않고 독립 검사한다(cf. `closeout-freshen` 설계). 즉 *authoring ≠ verification*.

## 절차 (compr/compush가 **스테이징 직전** 실행)

### 1. 활성 작업 판별 — `docs/harness/seed.yaml`의 top-level `status`
- seed 없음, 또는 `status`가 `approved`가 **아님**(`draft`/`done`/`superseded`/부재) → **추적 중 아님 → closeout skip**(no-op). 빠른 비-kickoff 작업은 여기서 끝(마찰 0).
- `status: approved` → 활성 작업, 계속.

### 2. 완료 판별 — `docs/harness/current-scope.md`의 `## Acceptance Criteria` 체크박스
완료 조건은 **`total > 0 && unchecked == 0`** (체크박스가 1개 이상이고 전부 `[x]`).
- `current-scope.md` 없음 → 완료 확인 불가 → **advisory**("approved seed인데 current-scope.md 없음 — closeout 생략") 후 skip.
- `## Acceptance Criteria` 섹션 부재 / 빈 섹션 / **체크박스 0개** → **advisory** 후 skip. (체크박스가 없으면 "전부 `[x]`"가 공허참이 되어 미완 작업을 오-마감하는 것을 막는다.)
- 체크박스 ≥1개이고 **전부 `- [x]`**(미체크 `- [ ]` 0개) → **작업 완료 → closeout 실행**(§3).
- `- [ ]` 존재 → **미완 → advisory**("AC N/M 미충족 — 완료면 current-scope.md에서 체크 후 재실행, 중간 작업이면 그대로 진행") 후 skip. **자동으로 닫지 않는다.**

### 3. Closeout 동작 (완료일 때만)
a. `docs/harness/seed.yaml`: top-level `status`를 `done`으로, `completed: <YYYY-MM-DD>` 추가(`seed_evolution_policy.md`의 `approved → done` 전이). **이 종료 전이는 `version +1` 규칙에서 면제된다**(내용 revision이 아니라 생명주기 종료이며 `task_closed`가 감사 기록).
b. `docs/harness/current-scope.md` **삭제**(작업 추적 은퇴 — seed `done` + audit가 기록이므로 아카이브 불필요).
c. `docs/harness/audit.jsonl`에 append(없으면 생성): `{"ts":"<ISO>","event":"task_closed","actor":"assistant","meta":{"task_id":"<task_id>","name":"<name>"}}`. **`task_id`가 안정적 식별자**(seed의 `name`은 필수 필드 아님); seed에 `task_id`가 없으면 `name`만 기록.
d. a–c의 변경은 **이 커밋에 함께 포함**되어(스테이징 직전 실행) 마감이 원자적으로 landing한다. acceptance-gate는 이 커밋의 내용(plain commit은 인덱스, `-a`는 워크트리)에서 a·b·c **셋 모두**를 확인할 때만 closeout landing으로 allow한다 — HEAD의 seed가 `approved`이고 커밋되는 seed가 `done`, 커밋 트리에 `current-scope.md`가 없고, 커밋되는 `audit.jsonl`에 `task_closed` 행이 추가됨(디스크의 seed는 이미 `done`이므로 "닫힌 seed 위 코드" 백스톱과 구분하는 근거는 커밋 내용이다 — #48-1). seed 한 줄만 바꾸거나 scope를 남기거나 audit 행이 없으면 마감이 아니며, 코드 변경이 함께 있으면 백스톱에 걸린다(빠진 항목을 `HARNESS WARNING`으로 안내).

### 4. 스킬 sync 점검 (freshness)
이번 작업이 `.omp/skills/<name>/`를 수정했다면 전역 미러 `~/.claude/skills/<name>/`도 동기화한다 (OMC 스킬은 OMP에서도 `~/.claude`에서 디스커버리됨). **전역이 stale하면 그게 실행될 수 있다**(cf. `seed_evolution_policy.md`는 아니고 skill-sync 메모리). 양쪽이 동일해야 한다.
**방향 규칙**: SoT는 omp 템플릿(`.omp/skills/`)이다 — 편집은 항상 템플릿에서 하고, 전역(`~/.claude/skills/`)은 복사로만 갱신하는 미러다. 전역을 직접 편집하지 않는다.

## 비고
- closeout은 **종료상태 전이**다. 같은 기능의 반복은 `thread-scope open`이 그 seed를 제자리 reopen(done→approved, version+1, audit `seed_reopened`); 진짜 새 기능만 새 `kickoff`. 종료 이력은 `task_closed`/`seed_reopened` + git이 보존.
- 검증 레인(docs-drift, PR-4): `current-scope.md` 전부 `[x]`인데 seed `done` 아님(closeout pending) / seed `done`인데 scope 잔존(half-closed) / scope 있는데 seed `approved` 아님(orphan) → WARNING.
