---
name: kickoff
argument-hint: [project name or feature description]
description: Project/feature kickoff interview (JTBD -> Context -> Scope -> Acceptance -> Backpressure)
---

# Kickoff - Project/Feature Start Interview

## Goal

Gather essential information before any implementation begins. Ensures work starts with clear purpose, scope, and success criteria.

No coding. Only information gathering + state file saving to `docs/harness/`.

## Non-Negotiables

| Rule | Violation = STOP |
|------|------------------|
| **No implementation** | This is interview only |
| **No guessing** | Discover from repo, not assume |
| **All 5 phase outputs** | Skipping an output = STOP. doc-ingest derives them; interview fills only gaps |
| **User confirmation per phase** | Each phase needs explicit approval |
| **Output must be saved** | Kickoff summary required |

## Inputs

- `$ARGUMENTS` — the user-provided argument (appended as `User: <args>`): Project name or feature description
  - `"새 프로젝트"` / `"new project"` → full kickoff (Vision + all phases)
  - `"로그인 기능"` / `"add feature X"` → feature kickoff (skip Vision, start at JTBD)
  - **문서 경로** (예: `docs/PRD.md`) 또는 **붙여넣은 포괄 스펙** (다중 섹션 산문) → **doc-ingest 모드** (Phase -2): 인터뷰 대신 문서에서 요구를 추출, 인터뷰는 구멍메우기로 축소

## Workflow

### Phase -2: Doc-Ingest (조건부)

`$ARGUMENTS`에 **포괄 상위 문서 경로**(PRD·스펙·설계문서)가 있거나 사용자가 **다중 섹션 스펙을 붙여넣었으면** doc-ingest 모드로 시작한다. 둘 다 없으면 즉시 Phase -1로 건너뛴다 — **인터뷰-우선 폴백 경로는 그대로 유지**된다.

> **모드 자동결정** (플래그 없음): 문서/스펙 제공 → **인제스트-우선**(인터뷰는 구멍메우개) · 미제공 → **엘리시트-우선**(Phase -1~4 풀 인터뷰). 본 스킬은 P1 초기화 경로를 다룬다 (active seed 있는 P2 반복은 thread-scope가 담당).

**진입 신호 판별**:

1. **경로 인자**: `$ARGUMENTS`가 읽을 수 있는 문서 파일(`.md`/`.txt` 등)을 가리킴 → `read`로 전체 로드
2. **붙여넣은 스펙**: 한 줄 기능 설명이 아니라 **제목/섹션이 있는 산문 블록** → 그대로 입력으로 사용
3. 둘 다 아니면(한 줄 설명·프로젝트명) → doc-ingest 아님, **Phase -1로** (브레인스토밍 → 풀 인터뷰)

**Agent가 수행** (completeness-first — *그럴듯한 부분집합 금지*):

1. 문서를 **섹션별로 파싱**한다 (헤딩·번호목록·불릿 단위). 각 섹션에 안정 앵커 부여: `<문서경로>#<헤딩 슬러그 또는 §번호>`.
2. 섹션별로 요구사항을 **열거**한다 — `R1, R2, … Rn`. 각 `Ri`에 출처 앵커를 붙인다. (요구 = 시스템이 *해야 하는 것*·제약·성공조건. 배경·동기 산문은 요구 아님.)
3. 열거된 요구별로 **AC를 도출**한다:
   - **불변식**: 모든 `Ri`는 (a) ≥1개의 `acceptance_criteria`로 매핑되거나 (b) `out_of_scope`로 명시 배제된다. **제3의 상태 금지** — "문서에 있는데 추출 안 함"(=그럴듯한 부분집합)은 completeness contract 위반.
   - 도출한 각 AC에 **per-AC `source:` 앵커**를 단다 (AC3; 컨벤션은 Step 3 참조).
4. **요구→AC 매핑표**를 메모리에 구성한다 (Step 4 `coverage` rubric · Step 5 잔차 처리의 입력):

   | Req | 출처 앵커 | 매핑 AC | 상태 |
   |---|---|---|---|
   | R1 | `docs/PRD.md#auth` | AC1, AC2 | mapped |
   | R2 | `docs/PRD.md#audit-log` | — | **residual** |
   | R3 | `docs/PRD.md#oauth` | — | out_of_scope |

5. 채택한 문서 경로를 메모리에 보존 → Step 3 seed.yaml `references`에 포함, Step 7 audit.jsonl에 `doc_ingested` 이벤트로 기록.

**Gate**: 모든 요구가 `mapped` 또는 `out_of_scope`로 분류될 때까지. residual이 남으면 → 그것만 Phase 0–4 인터뷰가 메운다.

**후속 phase에서의 사용 — 인터뷰는 "구멍메우기"로 축소**:

문서 제공 시 Phase 0–4를 **풀로 강제하지 않는다**. 매핑표에서 **residual·모호·충돌** 항목만 골라 인터뷰한다 (Q6.3 임계: 테스트가능 AC 없음 / 기존 constraint·out_of_scope 충돌 / 경계 모호 / coverage 잔차 — **스타일·nit엔 질문 안 함**). doc-ingest 시 Phase -1(브레인스토밍 신호)은 문서에 흡수되므로 건너뛴다 — 사용자가 별도 캡처를 지목한 경우만 signal로 병합.

| Phase | doc-ingest 시 동작 |
|---|---|
| 0 JTBD | 문서에서 User·Problem·Success 추출; 누락 시에만 질문 |
| 1 Context | 문서가 명시한 스택·제약은 repo 증거로 **검증만**; 공백만 탐색 |
| 2 Scope | 매핑표의 mapped→MUST/SHOULD, out_of_scope→OUT OF SCOPE 자동 채움; 경계 모호분만 질문 |
| 3 Acceptance | 도출된 AC를 그대로 사용; **residual·모호 요구만** AC 질문 |
| 4 Backpressure | 문서가 검증 방법을 명시했으면 채택; 아니면 질문 |

문서가 **없으면** Phase -1(브레인스토밍) → Phase 0–4 풀 인터뷰가 그대로 폴백 경로다 (변경 없음).

**금지 사항** (completeness contract 정합):

- **그럴듯한 부분집합 금지**: 큰 문서를 "핵심만" 추려 일부 요구만 AC화하는 것 = contract 위반. 모든 요구는 mapped 또는 out_of_scope.
- 요구가 아닌 배경 산문을 AC로 승격하지 않음 (노이즈 유입 금지).
- 원본 문서를 후처리·재구조화하지 않음 (read-only 인제스트 — Phase -1 보존 정책과 동일).
- 문서가 모호하면 단정하지 말고 residual로 표시 → 인터뷰로 되돌림 (push→pull).

---

### Phase -1: Brainstorm Discovery (조건부)

이전에 `/brainstorm`(OMP: `/skill:brainstorm`) 모드로 작성된 캡처가 있으면 발판 삼아 시작한다. 없으면 즉시 Phase 0으로 건너뛴다.

**Agent가 수행**:

1. `docs/brainstorming/*.md`를 `glob`로 나열 (가장 최근 파일이 먼저 오도록 mtime 또는 파일명 timestamp로 정렬)
2. 비어있으면 → 이 phase 건너뛰고 Phase 0으로
3. 있으면 → `ask` 도구로 옵션 제시:
   - **최신 파일 사용** (파일명 + 첫 줄 topic 미리보기)
   - **다른 파일 사용** — 추가 파일이 있을 경우 (3개 이상이면 최근 3개만 표시)
   - **백지로 시작** (브레인스토밍 무시)

**사용자가 파일을 선택한 경우**:

4. 선택된 파일을 `read`로 전체 읽기
5. 캡처에서 다음 **signal**을 메모리에 정리 (파일 수정 X):
   - **반복 갈래**: 여러 turn에서 다시 언급된 주제
   - **명시 발언**: 사용자가 "X가 중요/필요/불필요/보류"라고 직접 표명한 항목
   - **암묵 가정**: 자연스럽게 전제한 기술 스택/사용자/제약
   - **열린 질문**: 끝까지 답이 나오지 않은 보류 항목
6. 채택된 파일 경로를 메모리에 보존 → Step 3 seed.yaml `references`에 포함, Step 7 audit.jsonl에 `brainstorm_referenced` 이벤트로 기록.

**Gate**: 사용자가 fresh를 선택했거나 파일 선택을 완료할 때까지.

**후속 phase에서의 사용**:

후속 Phase 0–4 질문에 signal을 **soft hook**으로 녹인다. **결정은 사용자**가 한다 — 캡처 내용을 산출물 필드에 자동 복사하지 않는다.

| Phase | Signal 활용 예 |
|---|---|
| 0 JTBD | "브레인스토밍에서 'X 상황에서 답을 못 찾는다' 갈래가 반복됐는데, 그게 user/problem과 어떻게 연결되나요?" |
| 1 Context | 캡처에서 언급된 기술/패턴/제약을 Repo 탐색의 hypothesis로 활용 후 증거로 검증 |
| 2 Scope | "브레인스토밍에서 'Y는 지금 하지 말자' 보류 항목이 있었는데, OUT OF SCOPE 또는 MUST NOT으로 넣을까요?" |
| 3 Acceptance | "브레인스토밍에서 'Z가 작동하면 성공'이라는 신호가 있었는데, 그걸 AC로 정의할 수 있을까요?" |
| 4 Backpressure | (덜 관련됨, signal 있으면만) |

**금지 사항** (brainstorm 스킬의 보존 정책과 정합):

- 캡처 파일을 후처리/재구조화하지 않음
- 사용자가 결정해야 할 항목을 캡처에서 추출해 단정하지 않음 ("브레인스토밍에서 X라고 하셨으니 MUST는 X" 같은 단정 금지)
- 사용자가 fresh를 선택하면 signal 일절 인용하지 않음 (실수로 누설 금지)

---

### Phase 0: JTBD (Job To Be Done)

**질문** (`ask` 도구 사용):
1. 이 작업의 최종 사용자는 누구인가?
2. 사용자가 해결하려는 문제는 무엇인가?
3. 성공했을 때 사용자의 상태는 어떻게 달라지는가?

**Gate**: 성공 기준이 1-2문장으로 정리될 때까지 진행하지 않음

**Output**:
```markdown
### JTBD
- User: <who>
- Problem: <what>
- Success: <measurable outcome>
```

---

### Phase 1: Context Discovery

**Agent가 수행** (사용자에게 묻지 않음):
1. 프로젝트 구조 파악 (`glob`, `read`)
2. 기존 패턴 확인 (package.json, AGENTS.md, README)
3. 기술 스택 확인
4. 빌드/테스트/린트 명령어 발견

**Gate**: 증거 없이 추측하지 않음. 모르면 "확인 필요"로 표시.

**Output**:
```markdown
### Context
- Repo type: <monorepo/single/docs-only>
- Tech stack: <discovered or "N/A">
- Build cmd: <discovered or "N/A">
- Test cmd: <discovered or "N/A">
- Existing patterns: <list or "none found">
- Risks/constraints: <list>
```

---

### Phase 2: Scope Definition

**질문** (`ask` 도구 사용):
1. 이번에 반드시 해야 하는 것은? (MUST)
2. 하면 좋지만 필수는 아닌 것은? (SHOULD)
3. 명시적으로 하지 않을 것은? (MUST NOT)
4. 관련 있지만 별도 처리할 것은? (OUT OF SCOPE)

**Gate**: MUST가 최소 1개, OUT OF SCOPE가 최소 1개 정의될 때까지

**Output**:
```markdown
### Scope
- MUST: <list>
- SHOULD: <list>
- MUST NOT: <list>
- OUT OF SCOPE: <list>
```

---

### Phase 3: Acceptance Criteria

**질문** (`ask` 도구 사용):
1. 이 기능이 동작한다는 것을 어떻게 증명할 수 있는가?
2. 엣지 케이스는 무엇인가?
3. 실패 시나리오는 어떻게 처리해야 하는가?

**Gate**: 최소 3개의 구체적인 수락 기준이 정의될 때까지. **각 기준은 커밋 시점에 판정 가능해야 한다** — "PR을 연다", "태그를 푸시한다", "머지한다"처럼 그 커밋 *뒤에* 참이 되는 항목은 AC가 아니라 후속 절차로 적는다(`.omp/rules/harness-cycle_definition.md`; acceptance-gate와 순환해 거짓 체크나 WIP 우회를 유도한다).

**Output**:
```markdown
### Acceptance Criteria
1. <specific, testable criterion>
2. <specific, testable criterion>
3. <specific, testable criterion>

### Edge Cases
- <case 1>
- <case 2>
```

---

### Phase 4: Backpressure Setup

**Agent가 확인 + 사용자 질문**:
1. Context에서 발견한 테스트/빌드 명령어 확인
2. 자동화된 검증이 없으면 → 수동 검증 방법 질문

**Gate**: 검증 방법이 최소 1개 정의될 때까지

**Output**:
```markdown
### Backpressure
- Verification method: <test cmd / manual checklist / rubric>
- How to run: <command or steps>
```

---

### Completion: Save & Signal (MANDATORY)

**⚠️ 이 단계를 건너뛰면 안 됨. 반드시 모든 Step을 완료해야 kickoff 완료.**

#### Step 1: kickoff-done 플래그 생성
```bash
echo "$(date -Iseconds)" > docs/harness/kickoff-done
```

#### Step 2: kickoff-summary.md 저장
`write` 도구로 `docs/harness/kickoff-summary.md`에 아래 Output Format 전체 저장.

#### Step 3: seed.yaml 생성

`docs/templates/seed.template.yaml`을 참조하여 `docs/harness/seed.yaml`을 생성한다.

**필드 매핑:**
- `version`: 1
- `status`: draft
- `task_id`: 자동 생성 (`YYYYMMDD-HHMMSS-<4자리 랜덤 hex>`, Bash `date +%Y%m%d-%H%M%S`-`openssl rand -hex 2`)
- `goal`: Phase 0 JTBD의 Success 기준에서 추출
- `constraints`: Phase 2 MUST NOT + Phase 1에서 발견한 기술 제약
- `acceptance_criteria`: Phase 3의 모든 수락 기준 (doc-ingest 시 Phase -2 매핑표의 도출 AC; **각 AC에 `source:` 앵커 부여 — AC3**, 아래 컨벤션 참조)
- `out_of_scope`: Phase 2 OUT OF SCOPE
- `assumptions`: Phase 1 Context 중 증거 없이 전제한 항목
- `risks`: Phase 1 Risks + Phase 3 Edge Cases
- `references`: kickoff-summary.md + 관련 파일 경로 + (doc-ingest 시 원본 상위 문서 경로) + (Phase -1에서 채택한 brainstorm 캡처 경로, 있을 때만)
- `estimate` (선택, `.omp/rules/harness-cycle_definition.md` "예상 레코드"): 인터뷰가 끝난 시점의 **예측** — `risk` (low|medium|high|critical, risk-assess taxonomy), `files` (정수), `depth` (low|high, 추론 깊이 — risk와 독립 축), `model`, `effort`. Step 6에서 `.omp/harness-state/cycle-estimate`로 파생되어 커밋 착지 시 실측과 대조된다. 판정에 관여하지 않는다.

**per-AC `source:` 컨벤션** (AC3 — 출처추적 / coverage 역매핑의 기계적 근거):

- doc-ingest로 도출한 각 AC는 출처 문서 섹션 앵커를 인용한다. richer 스키마(현 `seed.yaml` 선례)에서는 AC 객체에 `source:` 필드를 단다:

  ```yaml
  acceptance_criteria:
    - id: AC1-...
      title: ...
      source: "docs/PRD.md#authentication"   # 또는 "docs/PRD.md §3.2"
      must: [...]
      verify: [...]
  ```

- flat string 스키마(`seed_contract.md` 기본형)를 쓸 경우 앵커를 문장에 인라인한다: `"... (src: docs/PRD.md#authentication)"`.
- 이 앵커가 Step 4 `coverage` 판정과 verifier coverage 역매핑(AC ↔ 원본 doc)의 기계적 근거다 — 앵커 없으면 누락의 기계적 확인 불가(Q4.3).

**생성 후 자체 검증:**
- YAML 파싱 가능한가 (Read로 다시 읽어서 확인)
- 필수 필드 10개 (version, status, task_id, goal, constraints, acceptance_criteria, out_of_scope, assumptions, risks, references) 모두 존재하는가
- acceptance_criteria가 1개 이상인가
- `docs/rules/seed_contract.md` 기준에 부합하는가
- (doc-ingest 시) 원본 요구가 전부 AC≥1 또는 `out_of_scope`로 매핑됐는가 — 매핑표 잔차 0 (`coverage`; Step 4 연동)
- (doc-ingest 시) 도출 AC가 각각 출처 앵커(`source:`)를 보유하는가 (AC3)

#### Step 3.5: Plan Attack Gate (적대적 검증)

seed.yaml 생성 후 자동 실행. 정책: [`.omp/rules/harness-adversarial_review.md`](../../../.omp/rules/harness-adversarial_review.md)

```
1. audit.jsonl에서 현재 task_id의 adversarial_plan_attack 이벤트 수를 세어 run_count 결정
2. critic 에이전트 (opus) 호출:
   - seed.yaml 전체를 입력으로 제공
   - 구조적 공격 템플릿:
     a) "이 goal이 달성 불가능한 이유 3가지"
     b) "이 acceptance criteria가 불충분한 이유"
     c) "이 scope에서 빠진 치명적 항목"
   - 각 발견에 심각도 부여 (CRITICAL / HIGH / MEDIUM)
   - CRITICAL 판정 기준: 3조건 동시 충족
     (1) 요구사항 미충족/보안 취약점/데이터 손실 가능성
     (2) 수정 없이 진행하면 후속 단계에서 반드시 실패
     (3) 구체적 증거 제시 (seed.yaml 필드 인용)
3. 결과를 docs/harness/plan-attack-report.md에 저장
4. audit.jsonl에 append:
   {"ts":"<ISO>","event":"adversarial_plan_attack","actor":"critic","meta":{"task_id":"<id>","run_count":<N>,"result":"<PASS|WARN|BLOCK>","findings":[...]}}
5. 판정:
   - run_count=1: WARN (결과를 사용자에게 표시, 진행 가능)
   - run_count≥2: CRITICAL 발견 시 BLOCK → 사용자에게 보완 요구
     - 사용자가 "그냥 진행해" → override 허용
     - audit.jsonl에 adversarial_override 이벤트 기록
   - CRITICAL 없으면: PASS
```

#### Step 4: Rubric 판정

seed.yaml 내용을 기반으로 **5개 차원**(clarity 4축 + `coverage`)을 판정한다.

| 차원 | HIGH | MEDIUM | LOW |
|------|------|--------|-----|
| `goal_clarity` | 구현 결과가 구체적으로 보임 | 목표는 있으나 약간 모호 | 추상적이거나 목표 없음 |
| `constraint_clarity` | 제약이 구체적이고 실행 가능 | 제약 있으나 일부 모호 | 제약 없거나 전부 모호 |
| `success_criteria_clarity` | 모든 AC가 테스트/관찰 가능 | 일부만 테스트 가능 | 테스트 가능한 AC 없음 |
| `context_clarity` | 기술 스택, 패턴, 참조 충분 | 부분적 컨텍스트 | 최소한의 발견 |
| `coverage` | 모든 원본 요구가 ≥1 AC로 매핑, 잔차 0 | 대부분 매핑, 소수 잔차를 명시 | 다수 요구 미매핑 / 매핑표 부재 |

결과를 `docs/templates/rubric-report.template.md` 형식에 맞춰 `docs/harness/rubric-report.md`에 저장.

> **`coverage` 측정** (AC2 — Q9.2 authoring-time coverage; *원본 doc가 전부 AC로 추출됐나*):
> - **doc-ingest 시**: Phase -2 요구→AC 매핑표 기준. 매핑률 = `mapped / (전체 요구 − out_of_scope)`, 잔차 = 미매핑 요구 목록.
> - **인터뷰-only 시**: 원본 문서가 없으므로 Scope(MUST/SHOULD) 항목 → AC 매핑률로 측정.
> - 미매핑 잔차는 `rubric-report.md`의 **`coverage` 줄 + "Unmapped Requirements (Residual)" 목록**에 기록한다.

#### Step 5: Rubric 결과 처리

- 전부 HIGH 또는 MEDIUM → "통과. startdev 진행 가능"
- LOW가 1개 이상 →
  - `ask` 도구로 해당 차원의 보완 질문을 던진다
  - 보완 후 → seed.yaml 갱신, rubric 재판정
  - **`coverage` LOW 특수 처리** (AC2 — 기존 ask/followup 메커니즘 *재사용*, 신규 없음): 잔차 목록의 미매핑 요구를 push→pull로 되돌린다 —
    - 자동 도출 가능(테스트가능·명확)하면 AC를 **추가 추출**해 매핑 (Phase -2 도출 반복)
    - 모호·충돌이면 `ask`로 질문(Q6.3 임계) → 답을 AC로 흡수하거나 `out_of_scope`로 명시 배제
    - 잔차 0이 될 때까지 추출·배제 반복 후 `coverage` 재판정 (clarity LOW의 "보완 질문→재판정" 루프와 동형 — 단 *재워딩*이 아니라 *추가 추출*)
  - 사용자가 명시적으로 "그냥 진행해" → override 허용
    - `rubric-report.md`의 Override Reason에 사유 기록
    - `audit.jsonl`에 `seed_override_approved` 이벤트 기록

#### Step 6: current-scope.md 저장 (호환성 유지)
`write` 도구로 `docs/harness/current-scope.md`에 Scope 섹션만 추출하여 저장:

```markdown
# Current Scope: <project/feature name>

**Created**: <date>

## MUST
<list>

## SHOULD
<list>

## MUST NOT
<list>

## OUT OF SCOPE
<list>

## Acceptance Criteria
- [ ] <AC 1>
- [ ] <AC 2>
- [ ] <AC 3>
```

> **참고**: current-scope.md는 기존 훅 호환성을 위해 유지한다. seed.yaml이 권위 있는 원본이며, current-scope.md는 파생물이다.

**예상 레코드 파생** (seed에 `estimate`가 있을 때): `.omp/harness-state/cycle-estimate`에 한 줄로 쓴다 — `["omp-estimate/v1", <risk>, <files>, <depth>, <model>, <effort>, "<ts>"]` (`ts`는 존 지정자가 있는 ISO 8601, `date -u +%Y-%m-%dT%H:%M:%SZ`). `current-scope.md`와 같은 관계(seed가 원본, 레코드는 파생물). 채팅 인테이크 경로(cycle intake)에서는 seed 없이 이 레코드만 쓴다.

#### Step 7: audit.jsonl 기록

`docs/harness/audit.jsonl`에 아래 이벤트를 append한다 (한 줄에 JSON 하나):

```
{"ts":"<ISO>","event":"kickoff_completed","actor":"assistant","meta":{"topic":"<작업 주제>"}}
{"ts":"<ISO>","event":"seed_generated","actor":"assistant","meta":{"seed_path":"docs/harness/seed.yaml","status":"draft","version":1}}
{"ts":"<ISO>","event":"rubric_evaluated","actor":"assistant","meta":{"goal":"<H/M/L>","constraints":"<H/M/L>","success":"<H/M/L>","context":"<H/M/L>","coverage":"<H/M/L>"}}
```

override가 있었다면 추가:
```
{"ts":"<ISO>","event":"seed_override_approved","actor":"user","meta":{"reason":"<사유>"}}
```

Phase -1에서 brainstorm 캡처를 채택했다면 추가:
```
{"ts":"<ISO>","event":"brainstorm_referenced","actor":"user","meta":{"path":"docs/brainstorming/<file>.md"}}
```

Phase -2에서 doc-ingest를 사용했다면 추가:
```
{"ts":"<ISO>","event":"doc_ingested","actor":"user","meta":{"path":"<원본 문서 경로>","requirements":<N>,"mapped":<M>,"residual":<R>}}
```

> **주의**: 기존 audit.jsonl 내용을 덮어쓰지 말고 반드시 append. `bash`로 `echo '...' >> docs/harness/audit.jsonl` 또는 기존 내용을 `read`한 후 합쳐서 `write`.

#### Step 8: README placeholder 채우기 (조건부)

`/init`이 만든 placeholder를 kickoff 결과로 채운다. **사용자가 이미 손댔으면 건드리지 않는다**.

**판별**:
- `README.md`에 `<!-- claude-template-placeholder -->` 마커가 있으면 placeholder 상태 → 채움
- 마커가 없으면 사용자가 수정한 것 → 건드리지 않고 Step 9로

**채움 (placeholder인 경우)**:

`README.md`을 아래 형식으로 덮어쓴다 (project name은 git remote 또는 디렉토리명에서 추출):

```markdown
**[English](README.en.md)**

# <project-name>

<JTBD.Success를 1-2문장으로 풀어쓴 한 줄 설명>

## 목표

<seed.yaml의 goal 필드>

## 수락 기준

- [ ] <AC 1>
- [ ] <AC 2>
- [ ] <AC 3>

## 제약

<seed.yaml의 constraints 항목들 — 없으면 섹션 생략>

## 상태

🚧 개발 중 — 자세한 컨텍스트는 `docs/harness/kickoff-summary.md` 참고.
```

`README.en.md`도 동일 구조로, 영문으로 덮어쓴다 (마커가 있는 경우에 한해):

```markdown
**[한국어](README.md)**

# <project-name>

<English one-liner from JTBD.Success>

## Goal

<goal>

## Acceptance Criteria

- [ ] <AC 1>
...

## Constraints

<list — omit section if empty>

## Status

🚧 In development — see `docs/harness/kickoff-summary.md` for full context.
```

> 영문 번역은 한국어 원문을 자연스러운 영어로 옮긴다. 기계 번역체 금지.

**audit 기록**:
```
{"ts":"<ISO>","event":"readme_initialized","actor":"assistant","meta":{"source":"kickoff"}}
```

마커가 없어 건너뛴 경우:
```
{"ts":"<ISO>","event":"readme_initialized","actor":"assistant","meta":{"skipped":"user_modified"}}
```

#### Step 9: 다음 단계 안내
저장 완료 후 출력:
> "Kickoff 완료. seed.yaml 생성됨 (status: draft). 구현을 시작하려면 `/startdev`를 사용하세요."

---

## Output Format

```markdown
## Kickoff Summary: <project/feature name>

**Date**: YYYY-MM-DD
**Type**: New Project / Feature

### JTBD
- User: <who>
- Problem: <what>
- Success: <measurable outcome>

### Context
- Repo type: <type>
- Tech stack: <stack>
- Build/Test: <commands>
- Patterns: <list>

### Scope
- MUST: <list>
- SHOULD: <list>
- MUST NOT: <list>
- OUT OF SCOPE: <list>

### Acceptance Criteria
1. <criterion>
2. <criterion>
3. <criterion>

### Backpressure
- Method: <verification>
- Command: <how to run>

---
Kickoff complete. Ready for implementation.
Next: `/startdev` or manual planning.
```

## State Management

| File | Purpose | When |
|------|---------|------|
| `docs/harness/kickoff-done` | Flag that kickoff completed | Created at end |
| `docs/harness/kickoff-summary.md` | 사람 중심 요약 | Created at end |
| `docs/harness/seed.yaml` | 하네스 중심 구조화 명세 (1급 입력) | Created at end |
| `docs/harness/plan-attack-report.md` | 적대적 계획 검증 결과 | Created at Step 3.5 |
| `docs/harness/rubric-report.md` | 명확도 4축 + `coverage` 판정 보고서 | Created at end |
| `docs/harness/current-scope.md` | 훅 호환용 scope 정의 (파생물) | Created at end |
| `docs/harness/audit.jsonl` | Append-only 감사 로그 | Appended throughout |

## Integration with Gates

- **kickoff-detector** (`before_agent_start`): 새 작업 감지 시 "/kickoff 먼저 실행하세요" 리마인더
- **out_of_scope** (seed.yaml): 자동 차단 게이트 아님 (scope-gate 폐기됨). 에이전트가 읽어 scope drift를 자체 방지하는 prose — 강제는 Surgical Changes 규칙 + PR 리뷰
- **acceptance-gate** (`tool_call`): git commit 시 Acceptance criteria 미충족이면 블록

## Contracts

- `docs/rules/seed_contract.md` — seed.yaml 스키마 및 유효성 규칙
- `docs/rules/kickoff_output_contract.md` — kickoff 산출물 정의
- `docs/rules/startdev_seed_contract.md` — startdev가 seed.yaml을 읽는 방법

## References

- `assets/kickoff_checklist.md` — 전체 체크리스트
- `temp/harness-master.md` — Harness 설계 문서

## Patterns Applied

`constraints_first`, `explicit_output_schema`, `staged_workflow`, `human_in_the_loop`, `evidence_first`
