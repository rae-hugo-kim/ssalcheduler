---
description: "When and how to use each MCP server (Supabase migrations, web search, retired Context7)"
---
# MCP Server Policies

This document defines when and how to use MCP (Model Context Protocol) servers.

> **OMP registration note**: MCP 서버는 OMP 자체의 MCP config에 등록해야 인식된다 (`omp://mcp-config.md` 참조) — Claude Code의 `~/.claude.json`은 OMP가 읽지 않는다. 아래 정책(어떤 서버를 언제 쓰는가)은 그대로 유지된다. LSP의 경우 OMP는 빌트인 `lsp` 도구를 모델에 직접 노출한다(`omp://tools/lsp.md`); 아래 레이어 A/B 및 `mcp__plugin_oh-my-claudecode_t__lsp_*` 도구명은 Claude Code 시절 기준 표기다.

## Priority Order

When multiple tools can accomplish the same task:

1. **MCP tools** (specialized, maintained) over generic alternatives
2. **Source-verified lookups** (`librarian` 에이전트의 소스 직독, 공식 문서 `read`) over live web search

---

## LSP Layering (Code Navigation & Symbols)

**Purpose**: 세 개의 독립 LSP 레이어가 공존할 때 어느 레이어를 언제 쓰는지 규정한다.

### 3 Layers

| Layer | What | Model-visible? | 활성 조건 |
|---|---|---|---|
| **A. Claude Code native LSP** | Claude Code 본체(v2.0.74+)가 내부적으로 쓰는 심볼 룩업/진단(~50ms) | ✗ (툴 비노출) | 자동 — 설치된 언어 서버를 런타임이 인식 |
| **B. Official plugins** (e.g. `typescript-lsp`) | 레이어 A에 언어 서버 바이너리를 바인딩하는 Claude 공식 플러그인 | ✗ (A 경유) | 플러그인 설치 + 전역 바이너리 설치 (예: `npm i -g typescript-language-server typescript`) |
| **C. OMC MCP LSP** (`mcp__plugin_oh-my-claudecode_t__lsp_*`) | 모델이 직접 호출하는 LSP 원시 API (hover, goto_definition, find_references, diagnostics, diagnostics_directory, document_symbols, workspace_symbols, rename, prepare_rename, code_actions, code_action_resolve, servers) | ✓ | 언어 서버 바이너리가 PATH에 있을 때 자동 스폰 |

(구 레이어 D — Serena 의미 편집 — 는 정책 폐기. 하단 "Serena — 정책 폐기" 참조.)

### Call-priority ordering

1. **편집기 내부 룩업·진단(투명)** → 레이어 A 자동. 모델이 호출할 일 없음.
2. **단순 LSP 원시 질의** (hover / goto_definition / find_references / code_actions) → 레이어 C
3. **프로젝트 전역 진단** → 레이어 C의 `lsp_diagnostics_directory`
4. **심볼 단위 편집** → `edit` 직접 수행 (라인 앵커가 위치 정밀성 보장). 위치가 불확실하면 레이어 C로 정의/참조를 먼저 확인
5. **새 파일 숙지** → 레이어 C `lsp_document_symbols`로 구조 확인 → 필요한 범위만 `read`

### Completion evidence (복원)

완료 주장 시 최소 하나의 LSP 기반 증거를 포함한다:
- "Implemented" → `lsp_diagnostics` 또는 `lsp_diagnostics_directory` 결과 clean
- "Refactored" → 영향 심볼에 대한 `lsp_find_references` 결과 일관됨
- "Fixed" → 재현 테스트 pass + 변경 파일 진단 0건

(근거: `claudedocs/CLAUDE_original.md:355`에서 회귀된 증거 요건을 현행 규칙으로 복원)

### Overlap suppression

- `typescript-lsp` 공식 플러그인(B)과 OMC LSP(C)가 같은 TS 서버를 각각 별도 프로세스로 띄울 수 있음. 메모리 중복은 의도적 허용, 기능 충돌 없음.

### Language-server absence fallback

필요한 언어 서버 바이너리가 PATH에 없어 레이어 B·C가 비활성일 때:
- 모델 호출 가능한 원시 LSP 기능은 부재 → `grep`/`read`로 전환
- 진단: `mcp__plugin_oh-my-claudecode_t__lsp_servers`로 설치 상태 일괄 조회
- 복구: 해당 언어 서버 전역 설치 (예: `npm i -g typescript-language-server typescript`)

### Search vs LSP 판단 로직

**원칙**: 질의가 **구조적**(심볼·타입·참조)인가 **문자열 기반**(리터럴·패턴)인가를 먼저 분류한다.

| 질의 유형 | 우선 툴 |
|---|---|
| 심볼 정의·참조·타입·진단 | **MUST** 레이어 C (`lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`) |
| 심볼 단위 편집 (바디 치환·삽입·삭제) | **MUST** `edit` (라인 앵커; 레이어 C로 참조 선확인) |
| 새 파일 또는 >500줄 파일의 구조 파악 | **SHOULD** 레이어 C `lsp_document_symbols` |
| 문자열·주석·에러 메시지·환경변수·설정값 | **MUST** `grep` |
| 파일·디렉토리 이름 패턴 | **MUST** `glob` |
| 심볼명 모름 (의도 기반 탐색, 코드베이스 <100파일 또는 키워드 확정적) | **SHOULD** `grep`에 관련 키워드 복수(OR)로 후보 추림 → 레이어 C로 정밀화 |
| **콜드스타트 + 의도 기반 (코드베이스 >500파일, AGENTS.md/CLAUDE.md로 미해결)** | **SHOULD** `grepai search` Top-5 → 레이어 C로 정밀화 (trial) |
| **유저가 "grepai"·"의미 기반 검색"을 명시** | **MUST** `grepai search` 경유 |
| 동적 디스패치·설정 주도·폴리글롯 코드의 call 추적 | **MAY** `grepai trace callers/callees` — 단일언어 정적코드는 `lsp_find_references` 우선 |

**MUST NOT**:
- LSP 가용 상태에서 심볼 참조를 `grep` 단독으로 결론 (주석·유사 식별자 오탐 위험)
- 파일 전체 `read` 후 눈으로 심볼 탐색 — `lsp_document_symbols` 선행
- 심볼명·파일경로·리터럴이 유저 프롬프트에 이미 주어졌는데 `grepai` 호출 (LSP/grep 직행)
- `grepai` 랭킹만으로 작업 결론 — 상위 1–2개를 LSP/read로 검증해야 함

**MAY skip LSP** when:
- 수정 위치가 이미 정확히 특정된 단일 라인 편집
- 비코드 파일(md / yaml / json) — grep·read로 충분

**비고 — 시맨틱 검색 레이어 (grepai, 이벤트 기반 시범)**:
CLI + Skill 래퍼 경로로 도입(MCP 서버 아님 → context tax 0). 상세 라우팅은 `.omp/skills/grepai-search/SKILL.md`. 시범 평가는 시간이 아니라 **트리거 이벤트** 기준: 전제조건(>500파일 unfamiliar 코드베이스 콜드스타트)이 충족된 작업 3회 누적 후, (a) 오도 ≥ 유도 또는 (b) 트리거 충족에도 미호출이면 skill 디렉토리 삭제로 롤백. (구 "2주" 시간 조건은 2026-06-10까지 트리거 0회 — 전제 미발생으로 평가 자체가 불성립해 교체.) 배경: `docs/sum/session_2026-04-21_grepai-adoption-decision.md`.

---

## Context7 — 정책 폐기 (2026-08-26)

Context7 MCP에 대한 MUST 정책(신규 외부 API/SDK·버전 민감 문법 시 문서 조회)과
`rules/context7_policy.md`를 제거했다.

- **근거**: 102세션 트랜스크립트 실측 — 언급 8회, 최근(07-30 이후 9세션) 1회,
  게이트·스킬 배선 0. 서버 자체가 현 세션에 미마운트(OMP MCP 등록부는 exa·tavily뿐).
  직무는 `librarian` 에이전트(라이브러리 소스 직독 — source-verified), 공식 문서
  `read` 직독, web search(내장 + Exa/Tavily)가 흡수한다 — Serena와 동형 구도
  (특화 MCP의 고유 기능이 내장 도구 + 에이전트 조합에 흡수).
- **서버는 폐기하지 않음**: ad-hoc 등록·사용은 MAY (`omp://mcp-config.md`).
- **재도입 트리거**: 버전 민감 API 오구현이 librarian/직독 경로에서 반복
  관측될 때. 복원은 git history의 `rules/context7_policy.md`와 이 섹션 참조.

---

## Serena — 정책 폐기 (2026-06-10)

Serena MCP에 대한 MUST/SHOULD 정책(구 레이어 D, 심볼 단위 의미 편집 우선)을 제거했다.

- **근거**: 전 프로젝트·전 기간 세션 로그에서 Serena 도구 호출 0회. 고유 기능(의미
  편집)은 실재하나, agentic 편집은 블록 재생성 + `edit` 라인 앵커가 흡수하고
  (context-gate의 read-before-edit 강제로 "안 읽고 편집"이라는 전제 자체가 불성립),
  탐색·rename·진단 수요는 레이어 A/C가 흡수한다 — 정책이 가치를 벌지 못함.
- **마운트도 제거 (2026-08-26)**: 원래는 "서버는 폐기하지 않음, ad-hoc MAY"였으나,
  bootstrap 스킬 Phase 3가 user 레벨(`~/.omp/agent/mcp.json`)에 자동 재등록해 폐기가
  무효화되는 문제가 확인됐다. bootstrap 목록에서는 상류에서 제거됐고(2026.72+),
  잔존하던 user config 엔트리도 제거했다.
  추가 근거: OMP 하네스에서 `mcp__*` 도구는 advisory mcp-gate만 통과하므로
  (`.omp/extensions/harness/index.ts`의 `isEditToolName`은 `edit`/`write`만 커버),
  serena의 편집/셸 도구는 context-gate(read-before-edit)와 destructive-guard를
  우회한다 — 마운트 자체가 게이트 모델을 약화시킨다.
  ad-hoc 사용이 필요하면 그때 `/mcp add`로 일시 등록 후 제거.
- **재도입 트리거**: 2000줄+ 파일 다수의 대형 레포 작업이 일상화되거나, 의미 편집이
  `edit` 대비 우위인 사례가 실제 관측될 때. 복원은 git history의 이 섹션 참조.

---

## Supabase (Database Management)

**Purpose**: Manage Supabase projects, execute SQL, apply migrations.

### MUST use migrations (`apply_migration`) for:
- Schema changes (CREATE, ALTER, DROP)
- Index creation/modification
- RLS policy changes

### MAY use direct SQL (`execute_sql`) for:
- Data queries (SELECT)
- Debugging and inspection
- One-off data fixes (with caution)

### Best Practices:
- Always check `get_advisors` for security/performance issues after DDL changes
- Use `generate_typescript_types` after schema changes
- Prefer branches for experimental changes

---

## Web Search (Exa / Tavily / web-search)

**Purpose**: Search the web for current information, error solutions, latest docs.

**Default (병행)**: Exa와 Tavily를 1차 웹 검색 엔진으로 병행한다. 심층 조사·비교·사실 검증은 둘 다 질의해 교차검증/종합하고, 단순 단건 확인은 둘 중 가용한 쪽 + 내장 web-search로 충분하다. 상세는 아래 "Exa & Tavily" 참조.

### SHOULD use when:
- Current events or recent releases (post knowledge cutoff)
- Error messages not found in the repo
- Comparing multiple solutions/approaches
- Finding community discussions or GitHub issues

### MAY skip when:
- Information is available in repo or offline knowledge
- The needed docs were already obtained via the librarian agent or direct doc reads
- Question is about stable, well-documented features

---

## Browser Tools (browser-tools-mcp)

**Purpose**: Browser automation, screenshots, DOM inspection.

### SHOULD use when:
- E2E testing requiring visual verification
- Capturing screenshots for documentation
- Debugging frontend rendering issues
- Inspecting live DOM state

### Caution:
- Requires browser extension running
- May not work in headless environments

---

## Exa & Tavily (AI Search)

**Purpose**: AI 시맨틱 웹 검색 (키워드 검색보다 관련도 높음). 두 엔진은 보완재 — Exa는 의미 유사도·개념 매칭, Tavily는 최신성·출처 신뢰도·본문 추출에 강하다. 둘 다 원격 MCP(`mcp.exa.ai` / `mcp.tavily.com`), OAuth 인증.

### SHOULD use when:
- Complex, nuanced queries
- Finding conceptually similar content
- Research requiring synthesis

### 병행 (use both):
- 심층 조사·사실 검증·비교 → **Exa + Tavily 둘 다** 질의 후 교차검증/종합.
- 가벼운 단건 조회 → 둘 중 가용한 하나로 충분 (중복 호출 회피).
- 미인증(OAuth 미완료) 시 → 내장 web-search로 폴백.

### MAY skip when:
- Simple keyword searches suffice
- Exact phrase matching needed

---

## React Design Systems (react-design-systems)

**Purpose**: Access design system components and patterns.

### SHOULD use when:
- Building UI components
- Looking for design tokens/variables
- Checking component APIs and props

### Note:
- Requires local server running at `http://10.39.60.65:3010`

---

## Stitch (Proxy)

**Purpose**: MCP proxy/aggregator.

### Usage:
- Transparent proxy layer
- No direct policy needed

---

## General Guidelines

1. **Check availability first**: Not all MCP servers may be running
2. **Prefer specialized tools**: Use the right tool for the job
3. **Cache awareness**: Some tools cache results; re-query if data may be stale
4. **Error handling**: If MCP tool fails, fall back to alternative methods
5. **Rate limits**: Some hosted services have rate limits; batch queries when possible
