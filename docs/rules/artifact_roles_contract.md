# Artifact Roles Contract

## Purpose
`docs/harness/`의 세 아티팩트(`seed.yaml`·`current-scope.md`·`audit.jsonl`)는 생명주기·성장 특성·권위가 서로 다르다. 이 문서는 세 아티팩트의 **역할(role)을 tier로 고정**하고, 에이전트가 이들을 혼동 없이 사용하도록 규칙을 명문화한다.

이 문서의 목표는 두 가지다.

- **R1 (역할 분리)**: 작업 중 에이전트가 *체크할 SSOT 파일*(`seed.yaml`)과 *이번 스레드의 작업목표 파일*(`current-scope.md`)을 혼동 없이 쓰도록, 각 파일이 *무엇에 대해 권위가 있는지*를 고정한다.
- **R2 (추적성)**: 사후에 어떤 커밋/스레드가 *어떤 seed version을 근거로*·*어떤 AC를 겨냥해* 이뤄졌고 *실제 산출이 그것을 만족했는지*를 `audit.jsonl`로 추적 가능하게 한다.

근거: `claudedocs/harness-auto-capture-analysis.md` Q7(SSOT 경계)·Q8(역할 분리 2-tier + 원장).

## Scope
이 계약은 `docs/harness/seed.yaml`·`docs/harness/current-scope.md`·`docs/harness/audit.jsonl`의 **상호 역할과 성장 정책**, 그리고 그 앞단 입력인 `docs/handoff/handoff_*.md`의 **보관 정책**(§Handoff)에 적용된다.

비목표:
- 각 파일의 내부 스키마(필수 필드·검증 규칙) — `seed_contract.md`가 정의한다.
- seed 수정 절차·금지 사항 — `seed_evolution_policy.md`가 정의한다.
- 작업 마감(closeout) 절차 — `closeout_contract.md`가 정의한다.

이 문서는 위 계약들을 **대체하지 않고 교차참조**한다. 충돌 시 각 파일의 내부 계약이 그 파일에 대해 우선한다.

## The Three Tiers

| 아티팩트 | tier | 생명주기 | 성장 | 충족 |
|---|---|---|---|---|
| `seed.yaml` | **durable 작업단위 SSOT** (체크 대상) | feature 단위 durable; revise=`version +1`; `done`/`superseded`로 종료, 같은 기능 반복은 제자리 reopen | bounded — 무관 반복 누적 금지 | R1 "체크할 파일" |
| `current-scope.md` | **이번 스레드 작업목표** (체크리스트) | 스레드마다 재생성; closeout에서 삭제(은퇴) | bounded — live AC 윈도우만 | R1 "스레드 목표" |
| `audit.jsonl` | **provenance + satisfaction 원장** | append-only, 영구 | **유일하게 성장이 올바른 곳** | R2 추적 |

두 파일의 역할은 직교한다: `seed.yaml`은 *무엇이 맞는가(truth-to-check)*, `current-scope.md`는 *지금 무엇을 하는가(this-thread goal)*. 성장은 `audit.jsonl` 한 곳으로만 흐른다.

### `seed.yaml` — durable feature-spec SSOT
- **에이전트가 작업의 옳고 그름을 *대조하는* 1급 진실원**이다. 실행 판단(AC 충족 여부, 제약 위반 여부, scope drift 여부)은 항상 `seed.yaml` 기준으로 한다.
- **bounded**: 하나의 feature 단위 명세(`goal` 1개 + 그 AC 집합). 한 파일에 여러 목표를 섞지 않는다.
- **revise = `version +1`**: 구현 중 명세가 바뀌면 해당 필드만 수정하고 version을 올린 뒤 `audit.jsonl`에 `seed_revised`를 기록한다(절차: `seed_evolution_policy.md`).
- **종료 가능**: 작업이 main에 도달하면 closeout이 `status`를 `approved → done`으로 마킹한다(`closeout_contract.md`). `done`/`superseded`는 쉼 상태다.
- **reopen 가능**: 같은 기능의 반복은 새 kickoff가 아니라 `thread-scope open`이 닫힌 seed를 *제자리* reopen한다(`done → approved`, `version +1`, `completed` 제거, `audit.jsonl`에 `seed_reopened`). 종료 이력은 audit + git이 보존한다.
- **새 기능 = 새 seed**: 기존 seed와 무관한 새 작업단위는 새 `kickoff`로 별도 seed(새 `task_id`)를 만든다. 기존 seed에 무관 작업을 **누적하지 않는다**(아래 Growth Policy).

### `current-scope.md` — this thread's bounded objective
- **이번 스레드의 작업목표/체크리스트**다. 무엇이 *옳은가*가 아니라 무엇을 *이번에 할 것인가*를 담는다.
- **seed에서 파생**: `seed.yaml`이 원본이고 `current-scope.md`는 그 파생물이다. seed가 바뀌면 함께 갱신한다(`seed_evolution_policy.md` §수정 절차 4).
- **스레드마다 재생성**: active seed에서 `thread-scope.mjs open`이 `current-scope.md`를 재생성하고 `audit.jsonl`에 `thread_opened`를 기록한다. (kickoff-only 생성이던 과거 갭을 메운 P2 thread-scope 복원.)
- **bounded live 윈도우**: 이번 스레드가 겨냥하는 AC만 담는다. 완료분을 영구 적재하지 않는다.
- **closeout에서 은퇴**: 작업이 마감되면 closeout이 이 파일을 **삭제**한다(`closeout_contract.md` §3b). 기록은 seed `done` + audit가 보존하므로 아카이브가 불필요하다.

### `audit.jsonl` — append-only provenance/satisfaction ledger
- **유일하게 무한 성장이 올바른 아티팩트**다. seed/scope를 bounded로 유지하기 위해, 역사·전이·만족 판정은 전부 이 원장에 흘려보낸다.
- **append-only**: 기존 내용을 덮어쓰지 않고 반드시 append한다(`read` 후 합쳐 `write`, 또는 `>>`).
- 각 줄은 `{"ts":"<ISO>","event":"<name>","actor":"<who>","meta":{…}}` 형식이다.

이벤트 family(생성처):

| family | 이벤트(예) | 기록처 | 의미 |
|---|---|---|---|
| **kickoff** | `kickoff_completed`·`seed_generated`·`rubric_evaluated`·`seed_override_approved`·`brainstorm_referenced` | kickoff 스킬 | 초기화·rubric 판정·override 흔적 |
| **seed** | `seed_revised`·`seed_reopened` | seed 편집·reopen | 명세 진화 provenance(`from/to_version`·`changed_fields`·`reason`) |
| **scope** | `scope_amended`·`scope_expansion_approved` | P2 amend·out_of_scope 축소 | 스코프 변경 흔적(사용자 승인 포함) |
| **thread** | `thread_opened`·`thread_closed` | `thread-scope.mjs` | 스레드 provenance + satisfaction verdict(R2 핵심) |
| **closeout** | `task_closed` | closeout 절차 | 종료상태 전이 기록 |

## R1 — Role Separation (혼동 없이)

핵심 원칙: **`seed.yaml`은 진실(무엇이 맞는가)에 권위가 있고, `current-scope.md`는 이번 스레드의 목표(무엇을 할 것인가)에 권위가 있다.** 두 파일을 서로의 역할로 쓰지 않는다.

| 묻는 것 | 권위 있는 파일 | 비고 |
|---|---|---|
| 이 변경이 AC를 충족하나? | `seed.yaml` | AC 충족·검증의 진실원 |
| 제약/비범위를 어겼나? (scope drift) | `seed.yaml` | `constraints`·`out_of_scope` 기준 |
| 명세가 옳은가 / 무엇이 명세인가 | `seed.yaml` | 단일 진실원(SSOT) |
| 이번 스레드에서 무엇을 하나? | `current-scope.md` | 작업목표/체크리스트 |
| 이번 스레드의 진척(체크오프) | `current-scope.md` | live AC `[ ]`/`[x]` 토글 |
| 과거 무엇이·왜·만족했나 | `audit.jsonl` | provenance/satisfaction 원장(R2) |

운영 규칙:

- **권위 우선순위**: spec 진실은 `seed.yaml`이, 실행 윈도우는 `current-scope.md`가 권위를 가진다. 둘이 어긋나면(파생물 drift) `seed.yaml`이 원본이며 `current-scope.md`를 재생성/동기화한다.
- `current-scope.md`를 진실원으로 취급하지 않는다 — 그것은 seed의 bounded 투영(projection)일 뿐이다.
- `current-scope.md`가 없거나 닫힌 작업이라도 진실은 `seed.yaml`에 남는다. 반복 스레드는 `thread-scope open`으로 목표 파일을 다시 확보한다.

## R2 — Traceability (provenance + satisfaction)

목표: **각 커밋/스레드 → seed version → 겨냥한 AC → verdict**를 `audit.jsonl`만으로 역추적할 수 있어야 한다.

추적 체인:

```
commit  ──(메시지의 thread/task_id 링크)──▶  thread_id
thread_id ──▶ seed_task_id + seed_version   (provenance: 어느 seed의 어느 버전을 근거로)
            └▶ ac_targeted                  (무엇을 겨냥했나)
            └▶ verdict                      (실제 산출이 만족했나: PASS|FAIL|…)
```

`thread-scope.mjs`가 이 체인을 다음 두 이벤트로 남긴다.

```json
{"ts":"<ISO>","event":"thread_opened","actor":"assistant","meta":{"thread_id":"<id>","seed_task_id":"<task_id>","seed_version":2,"ac_targeted":["AC4","AC6"]}}
{"ts":"<ISO>","event":"thread_closed","actor":"assistant","meta":{"thread_id":"<id>","verdict":"PASS"}}
```

- **provenance**(근거): `thread_opened`가 `seed_task_id`·`seed_version`·`ac_targeted`를 고정 — 이 스레드가 *어느 seed의 어느 버전*을, *어떤 AC*를 겨냥했는지.
- **satisfaction**(만족): `thread_closed`가 `verdict`를 기록 — 산출이 실제로 그 AC를 만족했는지(verifier가 판정 주체).
- **커밋 링크**: 커밋 메시지에 `thread_id`(또는 `task_id`)를 남겨 git 이력과 audit를 잇는다. `task_id`가 안정적 식별자다(`seed`의 `name`은 필수 필드가 아니므로).
- seed 자체의 변경 provenance는 `seed_revised`/`seed_reopened`(`from/to_version`·`changed_fields`·`reason`)가 보완한다 — version 증가의 *이유*까지 역추적 가능.

## Growth Policy

불변식: **`seed.yaml`과 `current-scope.md`는 bounded로 유지하고, 성장(역사)은 `audit.jsonl` + git이 흡수한다.**

| 아티팩트 | 늘어나나? | 무엇이 흡수하나 |
|---|---|---|
| `seed.yaml` | ✗ (bounded) | feature 단위 명세만; revise는 `version +1`(내용 교체, 누적 아님) |
| `current-scope.md` | ✗ (bounded) | live AC 윈도우만; 완료분은 closeout이 삭제·은퇴 |
| `audit.jsonl` | ✓ (유일 성장처) | 모든 전이·provenance·verdict |
| git 이력 | ✓ | 종료된 seed/scope 내용의 시점별 스냅샷 |

규칙(MUST / MUST NOT):

- **seed에 무관 작업을 누적하지 않는다.** 기존 feature의 연장·수정은 seed revise + thread-scope로, **진짜 새 기능은 새 seed(새 `kickoff`)**로 만든다. "스레드 경계"(연장 vs 새 기능)는 L1 자가감지가 겸판한다.
- **완료 AC를 seed/scope에 영구 적재하지 않는다.** 완료분은 closeout이 은퇴시키고 역사는 `audit.jsonl`에 남는다. (누적 파일은 closeout 판정 `unchecked == 0`을 깨뜨리고 verifier coverage를 O(total)로 부풀린다 — Q7.1.)
- **`audit.jsonl`은 append만.** 덮어쓰기·정리(truncate)는 금지. 무한 성장이 이 파일에서는 올바른 동작이다.
- seed/scope의 "연속성"은 목표가 아니다. 역할 tiering + 원장이 R1/R2를 충족하면 파일은 작게 유지된다.

## Handoff — seed의 전신 (pre-seed 입력)

다른 세션(주로 chats 리포)이 omp 작업 세션으로 문제 정의·분석·후보안을 넘길 때 쓰는 문서다. **3-tier 밖의 입력**이며, 어느 tier의 권위도 갖지 않는다.

| 항목 | 규칙 |
|---|---|
| 위치 | `docs/handoff/handoff_<YYYY-MM-DD>_<topic>.md`. `docs/harness/`(런타임 아티팩트)에 두지 않는다. |
| 커밋 시점 | **이슈 발행과 동시에 커밋**한다. 이슈 본문은 요약 + 이 파일 링크만 담는다. 미추적 상태로 워크트리에 남겨 두지 않는다(다른 워크트리·머신에서 보이지 않는다). |
| 역할 | kickoff의 입력. kickoff가 이 문서에서 `seed.yaml`을 만들면 **권위는 seed로 넘어간다** — 이후 핸드오프와 seed가 어긋나면 seed가 원본이다. |
| 마감 후 | **삭제하지 않는다.** 구현이 main에 도달하면 첫 줄 아래 상태 행을 `- 상태: 마감 (#N / <sha>)`로 갱신한다. 배경·기각 대안의 기록이므로 보존하되, **지시로 읽지 않는다** — 마감된 핸드오프는 참고 자료다. |
| 상태 행 | 문서 상단 메타 블록에 `- 상태: …` 한 줄. 작성 시 `합의 완료, 구현 미착수 (#N)`처럼 진행 상태를, 마감 시 위 형식을 쓴다. |

`current-scope.md`와 달리 은퇴(삭제)하지 않는 이유: scope는 seed의 투영이라 seed + audit가 내용을 보존하지만, 핸드오프의 배경 분석·기각 대안은 다른 어디에도 남지 않는다. 성장 속도는 사이클당 최대 1건이라 bounded 우려는 낮다.

## Anti-Patterns

- 무관한 반복 작업을 기존 seed에 계속 append해 seed를 무한 성장시키기 (→ 새 seed).
- `current-scope.md`를 진실원으로 삼아 AC 충족을 거기서 판정하기 (→ 진실은 `seed.yaml`).
- 완료된 AC `[x]`를 `current-scope.md`/`seed.yaml`에 영구 보관하기 (→ closeout 은퇴 + audit).
- `audit.jsonl`을 덮어쓰거나 정리하기 (→ append-only).
- 커밋 메시지에 `thread_id`/`task_id`를 남기지 않아 git ↔ audit 링크가 끊기기 (→ R2 위반).
- 핸드오프를 `docs/harness/`에 두거나 미추적 상태로 워크트리에만 남기기 (→ `docs/handoff/` + 이슈 발행 시 커밋).
- 마감된 핸드오프를 현행 스펙으로 읽고 작업하기 (→ 진실은 `seed.yaml`; 핸드오프는 배경 참고).

## Cross-References

- `seed_contract.md` — `seed.yaml` 내부 스키마·필수 필드·검증 규칙(이 문서가 가리키는 "체크 대상"의 정의).
- `seed_evolution_policy.md` — seed revise 절차(`version +1`·`seed_revised`)·금지 사항·reopen(`seed_reopened`) 규칙.
- `closeout_contract.md` — 작업 마감 시 seed `approved → done`·`current-scope.md` 삭제·`task_closed` 기록(은퇴 메커니즘).
- `kickoff_output_contract.md` — kickoff family 이벤트(`kickoff_completed`·`seed_generated`·`rubric_evaluated`)와 4산출물 역할.
