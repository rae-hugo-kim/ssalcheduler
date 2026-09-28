# Startdev Seed Contract

## Purpose
`startdev`는 자유 형식 산문을 해석하는 단계가 아니라, `kickoff`가 만든 구조화 명세를 실행 계획으로 바꾸는 단계다.

이 문서는 `startdev`가 `docs/harness/seed.yaml`을 어떻게 읽고 사용할지 정의한다.

## Primary Input

기본 입력 파일:

```text
docs/harness/seed.yaml
```

보조 입력 파일:

- `docs/harness/kickoff-summary.md`
- `docs/harness/rubric-report.md`

우선순위:

1. `seed.yaml`
2. `rubric-report.md`
3. `kickoff-summary.md`

## Required Preflight Checks

`startdev` 시작 전에 아래를 확인한다.

- `seed.yaml` 존재
- YAML 파싱 성공
- 필수 필드 존재
- `acceptance_criteria` 최소 1개
- `status`가 `draft` 또는 `approved` (active)
  - `done`/`superseded`(종료상태)면 완료/대체된 작업이므로 seed 무효가 아니라 **새 `kickoff`로 새 작업(새 task_id) 생성**을 유도

실패 시:
- 바로 중단
- `kickoff` 또는 `kickoff --revision`을 요구

## How Each Field Is Used

### `goal`
- 구현 목표의 기준점
- 작업 중 scope drift 판단 기준

### `constraints`
- 비협상 구현 제약
- TDD, 검증, 변경통제 판단에 우선 반영

### `acceptance_criteria`
- TODO/checklist의 소스
- 테스트 플랜의 기본 단위
- 최종 완료 판단의 기준

### `out_of_scope`
- 이번 작업에서 하지 않는 일 (prose). scope drift 방지용
- 에이전트가 구현 중 다시 읽어 자체 제한 (자동 차단 게이트 아님 — scope-gate 폐기됨)

### `assumptions`
- anti-hallucination 검토 입력
- 구현 전에 확인하거나 명시적으로 유지할 전제

### `risks`
- 테스트 우선순위 후보
- 회귀/엣지케이스 탐색 출발점

### `references`
- 브라운필드 탐색 출발점
- 관련 파일과 문서를 좁히는 힌트

## Required Startdev Outputs

`startdev`는 최소한 아래를 내부적으로 또는 문서적으로 생성할 수 있어야 한다.

- acceptance criteria 체크리스트
- 구현 계획 또는 테스트 계획
- scope guard 기준
- assumption 확인 목록
- risk 기반 검증 포인트

## Operational Rules

- `acceptance_criteria`는 가능한 한 개별 작업 단위로 쪼갠다.
- `out_of_scope`는 구현 중 다시 읽을 수 있어야 한다.
- `assumptions` 중 확인이 필요한 것은 초기에 질문 또는 검토 대상으로 올린다.
- `risks`는 검증 순서나 테스트 작성 우선순위에 반영한다.

## Failure Modes

아래 상황은 즉시 중단하거나 수정 요청 대상으로 본다.

- `goal`이 추상적이라 구현 결과가 보이지 않음
- `acceptance_criteria`가 테스트 불가능한 문장뿐임
- `out_of_scope`가 비어 있음
- `assumptions`가 너무 많아 사실상 미정 사항이 대부분임

## Recommended Startdev Behavior

1. `seed.yaml` 파싱
2. 필수 필드 검증
3. `acceptance_criteria`를 구현/테스트 체크리스트로 변환
4. `constraints`와 `out_of_scope`를 guardrail로 노출
5. `assumptions`를 사전 확인 목록으로 정리
6. `risks`를 검증 항목 후보로 정리
7. 구현 착수

## Example

예를 들어 아래 seed가 있으면:

```yaml
acceptance_criteria:
  - 인증 없이 보호 엔드포인트 접근 시 401 반환
  - 유효한 토큰으로 요청 시 정상 응답

out_of_scope:
  - OAuth 도입

risks:
  - 공개 엔드포인트까지 보호될 수 있음
```

`startdev`는 최소한 다음과 같이 읽어야 한다.

- 테스트 1: 무인증 요청 -> 401
- 테스트 2: 유효 토큰 요청 -> 정상 응답
- scope 주의: OAuth 설계로 새로 새지 말 것
- 위험 검증: 공개 엔드포인트 회귀 테스트 추가
