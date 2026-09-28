# Glossary Policy

## 목적

프로젝트 전체에서 동일한 개념을 동일한 이름으로 부르게 한다.
에이전트, 훅, 문서, 사람 사이의 용어 불일치(ontological drift)를 방지한다.

## 파일 위치

| 파일 | 역할 |
|------|------|
| `docs/glossary.yaml` | 프로젝트의 정식 용어집 (권위 있는 원본) |
| `docs/templates/glossary.template.yaml` | 새 프로젝트용 빈 템플릿 |

## 언제 갱신하는가

| 시점 | 행동 |
|------|------|
| `/skill:kickoff` 완료 후 | 새 도메인 용어가 등장하면 추가 |
| 코드 리뷰 중 | 같은 개념에 다른 이름이 쓰이면 canonical term 정의 |
| 에이전트 간 혼동 발견 시 | aliases에 혼동된 이름 추가 |
| 용어가 더 이상 쓰이지 않을 때 | deprecated 표시 또는 삭제 |

## 작성 규칙

### MUST

1. **term은 canonical name이다** — 코드, 문서, seed.yaml에서 이 이름을 쓴다.
2. **aliases에는 실제로 혼동되는 이름만 넣는다** — 억지로 채우지 않는다.
3. **meaning은 한 문장이다** — 길어지면 별도 문서로 링크한다.
4. **새 프로젝트는 template에서 복사해 시작한다** — 빈 terms: []로 시작해도 된다.

### SHOULD

1. **context 필드로 "어디서 쓰이는지" 명시** — 파일 경로, 명령어, 스킬명 등.
2. **한국어와 영어 alias를 함께 관리** — 이 프로젝트는 이중 언어.
3. **kickoff 인터뷰 Phase 0(JTBD)에서 핵심 용어 3-5개 식별** — glossary 갱신 후보.

### MUST NOT

1. **glossary를 백과사전으로 만들지 않는다** — 프로젝트에서 실제로 혼동되는 용어만.
2. **일반 프로그래밍 용어를 넣지 않는다** — "function", "class" 같은 건 불필요.
3. **meaning에 구현 세부사항을 넣지 않는다** — "무엇인가"만, "어떻게 동작하는가"는 안 됨.

## 통합 경로 (향후)

현재는 수동 관리. 프로젝트가 커지면 아래를 고려:

| 단계 | 내용 | 조건 |
|------|------|------|
| 1 (현재) | 수동 관리, kickoff 때 리마인더 | 기본 |
| 2 | seed.yaml `references`에 glossary.yaml 링크 | seed에서 참조 필요 시 |
| 3 | kickoff 스킬이 자동으로 glossary 갱신 제안 | 반복적 용어 추가 발생 시 |

## YAML 스키마

```yaml
version: 1        # 스키마 버전

terms:
  - term: string           # canonical name (필수)
    aliases: [string]      # 대체 이름 (선택)
    meaning: string        # 한 문장 정의 (필수)
    context: string        # 사용 위치 (선택)
```
