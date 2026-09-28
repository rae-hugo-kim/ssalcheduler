# Seed Evolution Policy

## 목적

구현 도중 seed.yaml을 안전하게 수정할 수 있는 규칙을 정의한다.
kickoff 재실행 없이도 seed를 진화시킬 수 있되, 무분별한 변경을 방지한다.

## 허용되는 수정 시점

| 시점 | 예시 |
|------|------|
| startdev RED 단계 | AC가 테스트로 표현 불가능 → AC 수정 |
| 구현 중 새로운 제약 발견 | 외부 API 제한 발견 → constraints 추가 |
| 구현 중 새로운 리스크 발견 | 동시성 문제 발견 → risks 추가 |
| 사용자 명시적 요구 | "스코프 바꿔야 해" → 해당 필드 수정 |

## 수정 절차 (MUST)

1. **seed.yaml 편집** — 해당 필드만 수정
2. **version +1** — 수정할 때마다 반드시 증가
3. **audit.jsonl에 기록** — 아래 형식으로 append:
   ```json
   {"ts":"<ISO>","event":"seed_revised","actor":"assistant","meta":{"from_version":1,"to_version":2,"changed_fields":["acceptance_criteria"],"reason":"AC #3이 테스트 불가능하여 구체화"}}
   ```
4. **current-scope.md 동기화** — seed.yaml이 원본, current-scope.md는 파생물이므로 함께 갱신

## rubric 재판정 (SHOULD)

| 변경 범위 | 재판정 |
|-----------|--------|
| AC 문구 수정, 리스크 추가 | 불필요 |
| goal 변경, constraints 대폭 수정 | 재판정 권장 |
| out_of_scope 변경 | 반드시 재판정 |

## 금지 사항 (MUST NOT)

| 금지 | 이유 |
|------|------|
| out_of_scope 항목 삭제/축소 | scope creep 방지. 추가만 허용 |
| version을 올리지 않는 수정 | 변경 추적 불가 |
| reason 없는 수정 | audit에 사유가 없으면 되돌릴 근거도 없음 |
| status를 approved에서 draft로 되돌리기 | 승인 철회는 kickoff 재실행으로 |
| status를 **손으로** 종료상태에서 되돌리기 | 같은-기능 재개는 `thread-scope open`이 수행(done→approved, version+1, audit `seed_reopened`) — 손편집 말 것 |

**종료 전이**: `approved → done`은 작업 완료 시 **closeout 절차**(`closeout_contract.md`)가 마킹한다(`completed: <date>` 동반). 이 종료 전이는 위 "version 안 올리는 수정 금지" 규칙에서 **면제**된다 — 내용 revision이 아니라 생명주기 종료이며 `audit.jsonl`의 `task_closed`가 기록을 남긴다. `done`/`superseded`는 **쉼 상태**다 — 같은 기능의 반복은 `thread-scope open`이 제자리 reopen(done→approved, version+1, `seed_reopened` 기록 + git이 종료 이력 보존); 진짜 새 기능만 새 kickoff(새 task_id).

## 예외: out_of_scope 축소가 필요한 경우

out_of_scope 항목을 제거해야 하는 상황이 생기면:

1. 사용자에게 명시적 확인을 받는다
2. audit.jsonl에 `scope_expansion_approved` 이벤트를 기록한다:
   ```json
   {"ts":"<ISO>","event":"scope_expansion_approved","actor":"user","meta":{"removed_item":"payment integration","reason":"MVP에 결제 필수로 변경"}}
   ```
3. rubric 재판정을 실시한다

## startdev 연동

startdev 진행 중 seed 수정이 필요하면:

1. 현재 TDD 사이클을 완료하거나 중단점을 명시한다
2. 이 policy에 따라 seed.yaml을 수정한다
3. Gate 1(Test Plan)을 수정된 seed 기준으로 갱신한다
4. 다음 RED 단계부터 새 seed 기준을 적용한다
