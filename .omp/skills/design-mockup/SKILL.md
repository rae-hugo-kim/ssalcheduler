---
name: design-mockup
argument-hint: <design intent or comparison brief>
description: Generate a self-contained interactive HTML mockup with sliders/knobs for design parameter tuning. Use when the user says "design-mockup", "디자인 시안", "파라미터 튜닝", "6개 시안 비교", "slider 목업".
---

# Design Mockup — Interactive HTML for Design Iteration

## Goal

코드 컨텍스트 안에서 디자인 파라미터를 즉시 조작할 수 있는 단일 HTML 파일을
생성한다. 사용자가 슬라이더/노브로 값을 조정하고, 만족스러운 파라미터를
"copy to prompt" 버튼으로 다시 에이전트에게 전달할 수 있도록 한다.

## Scope (Convention, Not Gate-Enforced)

아래 규칙은 *작성·리뷰 시점*의 컨벤션이다. 게이트 차원의 강제는 없음 —
룰 위반은 PR 리뷰에서 잡는다. gate-level
enforcement는 `.omp/rules/harness-doc_standards.md` 백로그 항목으로 남김.

| Rule | 위반 시 (리뷰 시점 차단) |
|------|------------------------|
| **스코프 한정** | mockup·파라미터 튜닝 전용. 스펙·계획·리뷰·일반 산출물 생성 금지 |
| **단일 파일** | 산출물은 단일 self-contained HTML. 외부 JS/CSS 의존성 금지 (Google Fonts 예외) |
| **copy 버튼 필수** | 최소 1개의 "copy to prompt" 또는 "copy JSON/CSS" 버튼 |
| **출력 위치 고정** | `artifacts/design/<YYYY-MM-DD>-<topic>.html` |
| **assets/ 활용** | 보일러플레이트는 [`assets/playground-template.html`](assets/playground-template.html) 복사 후 placeholder 치환 |

## Inputs

- `$ARGUMENTS` — 사용자 인자(`User: <args>` 형태로 덧붙어 전달됨): 디자인 의도. 예시:
  - `"결제 버튼 6가지 변형"` → 6-grid 비교 mockup
  - `"hover 애니메이션 easing 튜닝"` → slider 기반 파라미터 mockup
  - `"카드 컴포넌트 spacing/radius 비교"` → 단일 컴포넌트 + 다축 슬라이더

## Process

### 1. 의도 분류

| 입력 패턴 | 산출물 형태 |
|----------|-----------|
| "N가지 변형 비교" | 그리드 레이아웃, 각 셀 라벨 (어떤 트레이드오프) |
| "파라미터 튜닝" | 단일 미리보기 + 슬라이더/노브, 실시간 반영 |
| "애니메이션 실험" | 재생/일시정지 + duration/easing 슬라이더 + curve 시각화 |

### 2. 템플릿 복사

```bash
mkdir -p artifacts/design
cp .omp/skills/design-mockup/assets/playground-template.html \
   "artifacts/design/$(date +%Y-%m-%d)-<topic>.html"
```

### 3. Placeholder 치환

`playground-template.html`의 placeholder를 실제 컨텐츠로 채운다:
- `__TITLE__` — mockup 제목
- `__PREVIEW_BODY__` — 미리보기 영역의 HTML (변형 그리드 또는 단일 컴포넌트)
- `__CONTROLS__` — slider/knob 컨트롤 마크업
- `__COPY_FORMAT__` — copy 버튼이 클립보드에 넣을 텍스트 포맷 (예: "padding: ${pad}px; border-radius: ${r}px;")

### 4. 사용자에게 전달

산출물 경로를 명시하고 브라우저로 열도록 안내:
```
artifacts/design/2026-05-22-payment-button.html 생성. 브라우저로 열어 슬라이더 조작 후
"Copy to Prompt" 버튼으로 파라미터 복사 → 다음 프롬프트에 붙여넣기.
```

## Output Convention

- 위치: `artifacts/design/<YYYY-MM-DD>-<topic>.html`
- gitignore 대상 (1회성 사람용 산출물)
- docs SST 미포함 (HTML은 `artifacts/` 격리 — `.omp/rules/harness-doc_standards.md` R4)

## Examples

### Example 1: 6-grid 비교

```
사용자: "온보딩 화면 디자인 방향 6가지를 한눈에 비교하고 싶어"
스킬:
  - 6-cell 그리드 mockup 생성
  - 각 셀에 (레이아웃, 톤, 정보 밀도) 트레이드오프 레이블
  - "이 셀의 파라미터 복사" 버튼 셀당 1개
```

### Example 2: 단일 컴포넌트 + 슬라이더

```
사용자: "결제 버튼 hover 애니메이션 튜닝, duration·easing 조정"
스킬:
  - 단일 버튼 미리보기
  - duration 슬라이더 (100-800ms), easing 4-point bezier 컨트롤
  - 재생 버튼, "CSS 복사" 버튼
```

### Example 3: 컬러 토큰 비교

```
사용자: "primary 색상 후보 4개 + 텍스트 대비 미리보기"
스킬:
  - 4-cell 그리드, 각 셀에 버튼/배경/텍스트 샘플
  - 색상 picker, contrast ratio 표시
  - "OKLCH 값 복사" 버튼
```

## Related

- `docs/harness/seed.yaml` AC3 — 본 스킬의 정의 원본
- `artifacts/README.md` — 출력 디렉터리 정책
- `.omp/rules/harness-doc_standards.md` R4 — 1회성 HTML 격리 정책
