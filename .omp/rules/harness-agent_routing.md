---
description: "When to delegate to reviewer/verifier/other subagents; model and effort tiers; dispatch preflight"
---
# Agent Routing Policy

프로젝트 전용 서브에이전트의 호출 기준을 정의한다.
이 에이전트들은 `.omp/agents/`에 정의되어 있다. OMC 에이전트(executor, architect, verifier 등)는 OMP의 task 도구가 디스커버리해 호출한다 — OMC의 훅 자동화(매직 키워드, system-reminder 주입 등)는 OMP에서 동작하지 않으며, 라우팅은 본 정책과 에이전트 정의로만 이뤄진다.

## 라우팅 기준

### 판단 흐름

```
구현 완료 후 검증 필요?
  → verifier (AC/하네스 기반 완료 검증)
high/critical 위험 코드 변경의 품질 리뷰 필요?
  → reviewer (3-pass 적대적 리뷰; low/medium은 셀프 리뷰로 충분)
그 외 (탐색/조사/구현)?
  → 직접 처리 또는 빌트인 에이전트 사용 (scout, task, OMC executor 등)
```

### 에이전트별 트리거

| 에이전트 | 트리거 조건 | 비트리거 (직접 처리) |
|----------|-------------|---------------------|
| **reviewer** | high/critical 위험 코드 변경 후 품질 리뷰 (3-pass: self + 이종 모델 adversary + code-reviewer — 셋 다 `.omp/agents/` 프로젝트 정의, OMC 불요) | low/medium 위험 변경(셀프 리뷰로 충분), 단순 문서/설정 변경 |
| **verifier** | 구현 완료 주장 전 AC/하네스/테스트 검증 | AC가 정의되지 않은 탐색적 작업 |

### 검증 에이전트 호출 기준

- **reviewer**: SHOULD `risk-assess` 기준 **high/critical** 변경(보안/인증/마이그레이션 파일 접촉, 또는 코드 100줄 초과 변경)일 때 호출. low/medium 변경은 셀프 리뷰(추가 스폰 없음)로 충분하다 — `review-gate`가 이종 모델 리뷰 증거를 강제하는 것도 high/critical 커밋뿐이다(review-gate.mjs). 결과는 `docs/reviews/`에 자동 기록.
- **reviewer 실행 토폴로지(Pass 2/3 중첩 스폰)**: reviewer는 frontmatter `spawns: adversary, code-reviewer`로 두 패스를 네이티브 중첩 스폰하며, OMP의 재귀 캡(`task.maxRecursionDepth`, 기본 2) 때문에 task 툴을 보유하려면 depth 1 이하에서 기동해야 한다. 리뷰 진입점은 아래 우선순위를 따른다.
  1. **depth 0 (top-level 세션)**: reviewer 에이전트를 스폰한다 — reviewer가 Pass 2/3를 depth 2로 중첩 스폰하는 기존 네이티브 경로가 그대로 동작한다.
  2. **depth 1 워커 세션 (vibe 등)**: reviewer 에이전트를 스폰하지 않는다. 대신 task capability를 가진 good급 세션이 `.omp/agents/reviewer.md` 프로토콜을 직접 수행한다 — Pass 1은 세션이 셀프 분석으로, Pass 2/3(adversary·code-reviewer)만 depth 2로 batch 스폰한다. 이것이 vibe 모드의 표준 단일 진입점이다. 수행 주체가 세션이어도 불변식은 동일하다([`.omp/rules/harness-adversarial_review.md`](harness-adversarial_review.md)의 "3-pass 코드 리뷰 불변식" 참조).
  3. **task 툴이 없는 세션**: 그 세션에서는 리뷰를 진행하지 않는다. top-level `omp -p`로 탈출해 1번 경로로 재실행한다.
- **디스패치 preflight (MUST)**: reviewer를 스폰하거나 프로토콜을 직접 수행하기 전에, 호출자는 자신의 depth와 task 툴 가용성을 확인해야 한다. 조건은 세션 종류가 아니라 capability다 — task 툴이 없으면 그 세션에서 리뷰 진행 금지. (실측 주석: fast급 워커 세션은 task 툴이 전면 비활성('Allowed: none')일 수 있다.) 이 preflight가 없으면 경로 규칙이 문서로 존재해도 generic 스폰이 그대로 실행된다 — 2026-07-22 vibe 세션 실측: depth 1 워커가 스폰한 reviewer는 depth 2에서 task 툴 없이 기동했고, 블로킹 task 호출 안에 있던 caller는 자식의 sibling 스폰 요청(hub)에 응답 불능이라 교착했다(제3 세션 릴레이로 회복, 라운드당 수십 분 손실). 같은 이유로 "caller가 sibling 스폰 결과를 reviewer에게 공급"하는 구 폴백은 폐기했다 — 블로킹 caller는 그 공급을 수행할 수 없다.
- 형제 batch → aggregator 2단계 DAG 경로는 표준에 넣지 않는다 — 계약 표면 최소화. 병렬 필요가 실측되면 그때 해당 경로만 재도입한다(아래 "재도입 트리거"와 같은 패턴).
- 어느 경로든 사이드카의 models 배열은 자식 트랜스크립트의 `model_change` 실측 후에만 기재한다. codex CLI 폴백은 제거되었다 — thread id는 게이트 증거가 아니다.
- **verifier**: MUST 작업 완료를 사용자에게 보고하기 전에 호출. AC가 있는 경우 필수. `task` 스폰은 논블로킹(비동기 job 배달)이므로 **스폰만으로는 완료가 아니다 — verifier의 verdict가 실제로 도착한 뒤에만 완료를 선언한다.**
- **운영 팁**: 완료된 서브에이전트는 잠시 idle로 살아있다(이후 parked). reviewer/verifier 후속 질의는 재스폰 대신 `write agent://<id>`로 메시지를 보내고 `wait`로 응답을 받으면 컨텍스트를 보존한다(브로드캐스트는 `agent://all`). `hub` 툴은 omp 18.3.0에서 폐기됐다(2026-09-24, #41).
- **adversary 모델 선택**: adversary는 `@advisor` 롤을 따른다. 이종(비-primary) 계열 보장이 필요하면 사용자 설정 `modelRoles.advisor`에 GPT 계열 모델을 지정한다 — 계열이 겹치면 verdict가 이종 리뷰 증거로 인정되지 않는다(review-gate). **`advisor` 미설정 시 omp 18.2.1부터 `@slow`로 폴백한다**(이전엔 primary 상속) — 즉 reviewer와 같은 모델이 되어 이종 증거가 자동으로 불성립하므로, 소비 리포는 `modelRoles.advisor`를 명시하지 않으면 high/critical 커밋에서 아래 두 경로 중 하나를 써야 한다. 단일 계열 환경에서 이종 리뷰가 불가능하면 게이트의 나머지 두 경로를 쓴다: human-review(오늘자 `docs/reviews/review-<ts>.json` 사이드카에 `["omp-review-evidence/v1", <hash>, "PASS", null, <이름>, <이름>]` — 게이트는 마크다운을 파싱하지 않는다) 또는 감사된 override(`docs/harness/review-skip`에 `["omp-review-override/v1", <사유>, <승인자>, <hash>]` — `audit.jsonl`에 `review_override`로 기록·소비). bare/비-tuple `review-skip` 파일만으로는 더 이상 우회되지 않는다.
- **reviewer 모델 선택**: reviewer는 `@slow` 롤을 따른다. `@slow`는 `modelRoles.slow` 미설정 시 default 롤을 상속하므로, 리뷰를 primary보다 강한(또는 명시적으로 의도한) 모델로 돌리려면 `modelRoles.slow`를 직접 지정한다.
- **라우팅 기준의 근거**: 이 절의 기준값(모델 롤·에포트·reviewer 임계)을 바꿀 때는 `node .omp/extensions/harness/estimate-report.mjs` 출력(인테이크 예상 × `risk-assess` 실측 교차표, (등급·깊이·모델) 셀별 건수·FAIL 합 — `docs/harness/audit.jsonl`의 `estimate_vs_actual`)을 근거로 인용한다. 표는 사람이 읽는 원자료다 — 자동 추천은 없고, 표본이 적은 개인 하네스에서는 셀당 의미 있는 수가 모이는 데 수개월이 걸린다(`.omp/rules/harness-cycle_definition.md` "예상 레코드").

## 폐기된 MCP 라우팅 (2026-06-10)

researcher(Exa)/db-worker(Supabase)/refactorer(Serena)/full-context(복합) 4종의
MCP 위임 라우팅과 에이전트 정의를 제거했다.

- **근거**: 전 프로젝트·전 기간 세션 로그 실측에서 위임 0회 (같은 기간
  OMC executor 1,044회 — 작업량 부재가 아니라 라우팅 자체가 한 번도 선택되지
  않음). 외부 조사·DB·리팩터링 작업은 빌트인(explore(현 scout)/task/web_search)과
  직접 MCP 호출이 흡수했다.
- **재도입 트리거**: 특정 MCP 도메인 작업이 반복되며 직접 처리의 마찰이
  관측될 때, 해당 도메인 1종만 우선 복원(전체 매트릭스 부활 금지).
  복원은 git history의 에이전트 정의(구 `.claude/agents/`, 현 `.omp/agents/`) 참조.
