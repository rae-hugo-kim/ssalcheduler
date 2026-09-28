---
description: "In-repo design/DESIGN.md and tokens are the only UI truth; how agents consume them"
---
# Design Contract (저장소 안 디자인 계약)

UI 디자인의 진실의 원천을 외부 툴이 아니라 **저장소 안 파일**에 둔다. 에이전트가
화면을 만들거나 고칠 때 참조하는 것은 `design/DESIGN.md`(계약)·`design/tokens.css`
(값)·`design/reference/`(스크린샷) 세 가지뿐이다. 결정론은 생성 툴에서 오지 않고
"산출물이 git에 코드로 있는가"에서 온다 — Claude Design / Stitch / OpenDesign 어느
툴을 붙여도 결과는 이 세 파일로 수렴해야 한다.

집행 주체: `owner: local-policy` — 자동 게이트 없음. 행동 규칙이지 커밋 게이트가
아니며, 리뷰(self-check 포함)와 화면 작업의 확인 문장에서 적용한다.

## 계약 파일

| 파일 | 역할 | 형식 |
|---|---|---|
| `design/DESIGN.md` | 계약 본문 — 원칙·색·타이포·간격·컴포넌트 규칙·금지 사항 | `templates/DESIGN.md`로 시작 |
| `design/tokens.css` | 계약의 값 — CSS 커스텀 프로퍼티(`--color-*`, `--space-*`, `--font-*`) | 코드가 import하는 유일한 값 원천 |
| `design/reference/` | 계약을 따른 화면의 스크린샷 | `<screen>_<YYYY-MM-DD>.png` |

토큰 형식은 프로덕트 리포의 스택을 따른다(CSS 변수가 기본, Tailwind config·디자인
토큰 JSON도 같은 역할이면 허용). 어느 형식이든 **값 원천은 파일 하나**다.

## Rules (MUST)

### R1. UI 코드는 계약만 참조한다

- 화면을 생성·수정할 때 `design/DESIGN.md`와 `design/tokens.css`를 먼저 읽는다.
- 계약에 없는 색·폰트·간격·반경·그림자 **리터럴을 컴포넌트 소스에 넣지 않는다**.
  `#3b82f6`, `16px`, `'Inter'` 같은 값은 토큰(`var(--color-primary)`,
  `var(--space-4)`)으로만 쓴다.
- 필요한 값이 계약에 없으면 코드에 임시값을 넣지 말고 R3의 계약 변경 사이클을 연다.

### R2. 생성 툴 산출물은 참고 자료다

- Claude Design·Stitch 등 생성 툴의 출력(코드·이미지·프로토타입)은 **탐색용
  입력**이다. 저장소에 들어오는 것은 계약에 맞춰 **재작성된 코드**뿐이다.
- 툴 출력을 그대로 붙여 넣지 않는다 — 툴이 만든 리터럴은 R1 위반이다.
- 툴 출력 자체를 보존할 이유가 있으면 `design/reference/`에 스크린샷으로만 남긴다.

### R3. 계약 변경은 화면 작업과 별도 사이클이다

- 색·폰트·간격·컴포넌트 규칙을 바꾸는 작업은 `design/` 3파일만 건드리는 **독립
  사이클**로 연다(`harness-cycle_definition.md`). 화면 사이클 안에서 계약을 슬쩍 고치지
  않는다.
- 계약 변경의 확인 문장은 "`tokens.css` 변경분 + 영향 화면 목록 + 사용자 승인"이다.

### R4. 화면 작업의 확인 문장은 "스크린샷 + 계약 준수"다

- 화면 사이클의 완료 확인은 두 가지를 함께 낸다: ① 재생성/수정된 화면의 스크린샷
  (`design/reference/`에 저장) ② 컴포넌트 소스에 계약 밖 리터럴이 0건이라는 확인
  (grep 결과 또는 이탈 리포트 스크립트 출력).
- 스크린샷 없이 "계약대로 했다"는 주장은 확인이 아니다.

### R5. 계약 없는 프로젝트에는 계약 작성을 먼저 역제안한다

- `design/DESIGN.md`가 없는 리포에 UI 작업 지시가 오면, 화면을 만들기 전에 **계약
  작성 사이클**을 역제안한다: 기존 코드에서 실제 사용 중인 색·폰트·간격을 추출해
  `design/` 3파일을 만드는 작업이 먼저다.
- 사용자가 "그냥 진행"을 택하면 그 결정은 최종이다(`harness-cycle_definition.md`의 역제안
  규칙과 같다). 이때도 새로 넣는 값은 최소한 `tokens.css`에 먼저 선언한다.

## Self-Check

화면 작업을 완료로 표시하기 전에:

- `design/DESIGN.md`·`tokens.css`를 이번 사이클에서 실제로 읽었는가.
- 변경한 컴포넌트 소스에 hex/rgb 색상, px 간격, 폰트 패밀리 리터럴이 있는가
  (`grep -nE '#[0-9a-fA-F]{3,8}\b|[0-9]+px|font-family:' <files>`로 확인).
- 스크린샷이 `design/reference/`에 저장됐는가.
- 계약을 고쳤다면 별도 사이클이었는가.

## 비범위

- 생성 툴(OpenDesign·Penpot 등)의 설치·연동 — 재검토 트리거는 사람 디자이너 협업,
  픽셀 단위 통제, 다프로덕트 토큰 거버넌스가 생길 때.
- 자동 픽셀 회귀 비교, 토큰 → 디자인 툴 역동기화.
- 계약 준수의 커밋 게이트화 — 이탈 리포트까지만.
- 컴포넌트 라이브러리 선택 — 프로덕트 리포가 결정한다.

## Related

- `../../templates/DESIGN.md` — `design/DESIGN.md` 시작 템플릿(각 섹션에 "무엇을/왜" + 예시 값)
- `harness-cycle_definition.md` — 계약 변경 사이클·역제안 규칙의 근거
- `harness-change_control.md` — 화면 사이클에서 계약을 건드리지 않는 최소 변경 원칙
