---
description: "Markdown as source of truth, docs/sum untracked policy, HTML as derived artifact only"
---
# Documentation Standards

저작 매체는 마크다운(SST). HTML은 *파생* 산출물 또는 *1회성* 사람용 아티팩트에만
허용한다. 본 표준은 마크다운을 **뷰어 독립적으로** 유지한다 — 같은 파일이 raw
텍스트, Obsidian vault, GitHub 렌더, OMP TUI(ASCII 다이어그램) 어디서든 읽혀야 한다.

## Rules

### R1. 다이어그램은 Mermaid 기본, ASCII는 코드 코멘트 한정

- 문서 본문의 다이어그램은 ```` ```mermaid ```` 코드펜스를 사용.
- ASCII 다이어그램은 **코드 코멘트 안 5–10줄 짧은 흐름**에 한해 허용.
- ASCII 아트로 그린 그래프·플로우차트를 문서 본문에 두지 않는다.
- 저장 시점 검증: 하네스 익스텐션(`.omp/extensions/harness/mermaid-check.ts`)이
  OMP 내장 파서로 `.md` 저장 직후 syntax 오류를 잡아 경고를 주입함.
- 지원 타입은 OMP 내장 파서 기준: `graph`/`flowchart`, `stateDiagram(-v2)`,
  `sequenceDiagram`, `classDiagram`, `erDiagram`, `xychart`. 이 외(gantt, pie 등)는
  게이트가 거부하므로 쓰지 않는다.

### R2. 긴 문서(대략 200줄+)는 상단 요약 강제

- 200줄을 넘어가는 문서는 **TL;DR** 또는 **요약 (200자 내외)** 섹션을 상단에 둔다.
- 200줄은 hard cap이 아닌 trigger threshold. 가능하면 400줄 이전에 분할.
- 요약은 결정사항·결론을 담고, 본문은 근거·논거·구체적 데이터를 담는다.

### R3. GFM 표 정렬

- 표는 GitHub Flavored Markdown 형식 (`|---|---|`) 사용.
- `prettier --parser markdown` 또는 IDE 자동 포맷터로 정렬 유지.
- raw 마크다운에서 보더라도 컬럼이 어긋나지 않게 둔다.

### R4. 사람용 1회성 HTML은 `artifacts/`로

- 1회성 explainer·mockup·design preview·PR 시각화 등은 `artifacts/` 트리에 둔다.
- `docs/` 안에 HTML 파일을 두지 않는다 (SST 오염; md 뷰어의 대상도 아님).
- `artifacts/` 정책: 전부 gitignore(`artifacts/*`), 단 `README.md`·`<subdir>/README.md`는
  구조 문서화 목적으로 추적 허용. 영속이 필요한 산출물은 `docs/` 안의 MD로 승격한다.
  (`artifacts/`는 소비 리포 공간이라 동기화되지 않으므로 정책을 여기 인라인한다.)

### R5. 스킬 정의 파일은 대문자 `SKILL.md`

- 스킬 디렉터리의 entry 파일은 반드시 `SKILL.md` (대문자 S, K, I, L, L, M, D).
- 소문자 `skill.md`는 Linux 환경에서 silent failure
  ([anthropics/skills#314](https://github.com/anthropics/skills/issues/314)).
- 글로벌(`~/.claude/skills/` — OMC 스킬은 OMP에서도 여기서 로드됨)·로컬(`.omp/skills/`) 양쪽 모두 동일.

### R6. 시점 기록 문서는 경로 이동 뒤에도 옛 경로 인용을 유지

- 원본 스냅샷(`claudedocs/CLAUDE_original.md`), 분석·업그레이드 기록, `docs/handoff/`, 보관 seed(`docs/harness/archive/`), CHANGELOG 과거 항목, `docs/sum/`은 작성 시점을 인용하는 문서다. 파일이 옮겨져도(예: 2026-09-26 `rules/` → `.omp/rules/harness-*.md`) 이들 안의 경로는 치환하지 않는다 — 살아 있는 문서(AGENTS.md, README, 스킬, 규칙, 현행 계약)만 치환한다.

## Local Archives (untracked + vault backup)

세션 서사 아카이브 — `docs/sum/`(세션 요약), `docs/reviews/`(리뷰 문서),
`docs/brainstorming/`(발산 기록) — 는 **프로젝트 레포에 추적하지 않는다**:

- **정책**: 서사에는 내부 의사결정·시행착오·경로가 담기므로 레포(특히 public)에
  올리지 않는다. 추적으로 승격할 문서는 **sanitize 후** `claudedocs/` 같은 추적
  티어로 옮긴다 (레포가 public이면 sanitize 필수).
- **백업**: 로컬-온리의 소실 위험은 중앙 **sum-vault**(PRIVATE 저장소, 위치 규약
  `~/projects/workspace/sum-vault`, env `SUM_VAULT_DIR`)가 담당 — `/skill:sum`이
  저장 직후 자동 복사·커밋·푸시한다 (fail-open). vault를 Obsidian으로 열면 전
  프로젝트 서사를 한 곳에서 열람.
- **강제 지점** (gitignore는 발견 차단일 뿐 `add -f`·legacy 추적을 못 막는다):
  ① `archive-guard`(commit-gates 자식) — staged/swept 아카이브 커밋 BLOCK, legacy
  추적은 WARN. ② `.githooks/pre-push` — 추적 아카이브 존재 시 push BLOCK (활성화:
  `git config core.hooksPath .githooks`). ③ `compush`/`compr` 스킬 — push 전 검사.
  ④ `bootstrap`/`migrate` — 파생 레포에 ignore 블록 + hooksPath 보장.

## View

- 뷰어: **Obsidian** — vault 루트 = repo 루트 (`.omp/rules/`·`checklists/`·`docs/` 크로스링크 유지).
  WSL 경로: `\\wsl.localhost\<distro>\...\omp`
- 권장 설정: 기본 보기 모드 Reading / 위키링크 끄기 + 링크 형식 상대 경로 / 가독 폭 켜기
- 진입점: `docs/README.md` (섹션별 안내 색인). vault 설정 디렉터리 `.obsidian/`은 gitignore.
- 링크 무결성: `scripts/docs-drift` (뷰어 무관, 상대 링크 + 앵커 검사)

## Related

- 본 표준의 원 출처는 docs-viewer 미션(2026-06) seed의 AC였다 — 이후 `seed.yaml`은
  미션별로 회전하므로 현행 원본은 본 문서다. (mdBook+mmdc 파이프라인은 2026-07
  Obsidian 전환으로 폐지, 검증은 하네스 게이트로 이관)
- `.omp/rules/harness-change_control.md` — 최소 변경 원칙 (본 표준의 over-prescription 방지)
- `artifacts/` — 1회성 HTML 산출물 격리 위치 (R4에 정책 인라인; 디렉터리 README는 소비 리포 소유)
- `docs/handoff/` — 세션 간 핸드오프 문서. 위치·커밋 시점·마감 후 처분은
  `docs/rules/artifact_roles_contract.md` §Handoff 가 정의한다(seed의 전신, 3-tier 밖 입력).
