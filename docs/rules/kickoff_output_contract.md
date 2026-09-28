# Kickoff Output Contract

## Purpose
`kickoff`는 인터뷰를 끝내는 것으로 완료되지 않는다. 후속 단계가 바로 사용할 수 있는 산출물을 남겨야 완료다.

이 문서는 `kickoff`가 생성해야 하는 결과물과 최소 품질 기준을 정의한다.

## Required Outputs

`kickoff` 종료 시 아래 파일이 있어야 한다.

1. `docs/harness/kickoff-summary.md`
2. `docs/harness/seed.yaml`
3. `docs/harness/rubric-report.md`
4. `docs/harness/audit.jsonl`

## Output Roles

### `kickoff-summary.md`
- 사람 중심 문서
- 맥락, 의사결정 이유, 예외사항 설명

### `seed.yaml`
- 하네스 중심 문서
- `startdev`와 후속 자동화 입력

### `rubric-report.md`
- kickoff 품질 판정 보고서
- 무엇이 충분한지/부족한지 기록

### `audit.jsonl`
- append-only 감사 로그
- 상태 전이와 override 흔적 기록

## Completion Definition

아래를 모두 만족해야 `kickoff completed`로 간주한다.

- `kickoff-summary.md` 생성 완료
- `seed.yaml` 생성 완료
- `rubric-report.md` 생성 완료
- `audit.jsonl`에 `kickoff_completed` 또는 동등한 이벤트 기록

## Rubric Gate

4차원 rubric:

- `goal_clarity`
- `constraint_clarity`
- `success_criteria_clarity`
- `context_clarity`

운영 규칙:

- 하나라도 `LOW`면 기본 동작은 추가 질문
- 전부 `HIGH` 또는 `MEDIUM`이면 통과
- `LOW`가 있어도 사용자가 명시적으로 원하면 override 가능

## Override Rule

override가 발생하면 아래를 반드시 남긴다.

- `rubric-report.md`에 override 사유
- `audit.jsonl`에 override 이벤트

예:

```json
{"event":"seed_override_approved","meta":{"reason":"Proceeding despite LOW success criteria clarity"}}
```

## Failure Conditions

아래 중 하나라도 해당하면 `kickoff`는 미완료다.

- `seed.yaml`이 없음
- 필수 필드 누락
- rubric 결과가 없음
- `LOW`가 있는데 follow-up 또는 override 기록이 없음
- `kickoff-summary.md`와 `seed.yaml`이 서로 다른 목표를 가리킴

## Recommended Flow

1. 인터뷰 진행
2. 요약 생성
3. `seed.yaml` 구조화
4. rubric 판정
5. 부족하면 추가 질문
6. 통과 또는 override
7. audit 기록

## Revision Rule

별도 `seed revision` 스킬은 만들지 않는다.

revision이 필요하면:

- `kickoff --revision docs/harness/seed.yaml`
- 또는 기존 seed를 컨텍스트로 재실행

결과:

- `kickoff-summary.md` 갱신
- `seed.yaml` 갱신
- `rubric-report.md` 재생성
- `audit.jsonl`에 `seed_revised` 기록

## Notes

- kickoff의 목표는 예쁜 문서를 만드는 것이 아니라, 후속 단계의 오해를 줄이는 것이다.
- 산문과 구조화 명세는 둘 다 필요하다.
