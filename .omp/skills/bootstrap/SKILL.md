---
name: bootstrap
argument-hint: [--skip-optional]
description: Bootstrap development environment with OMC discovery and MCP servers
---

# Bootstrap - Development Environment Setup

## Goal

이 하네스 템플릿을 사용하기 위한 개발 환경을 구축한다.
기존 OMC 설치 확인(OMP가 자동 발견), OMP MCP 설정에 범용 MCP 서버 등록,
선택적 MCP 서버 안내를 한 번에 처리.

## Non-Negotiables

| Rule | Violation = STOP |
|------|------------------|
| **npm/npx 필수** | Node.js 없으면 안내 후 중단 |
| **기존 설정 덮어쓰지 않음** | 이미 등록된 MCP 서버는 스킵 |

## Inputs

- `$ARGUMENTS` — 사용자 인자(`User: <args>` 형태로 덧붙어 전달됨):
  - (없음) → 전체 플로우 실행
  - `"--skip-optional"` → 선택적 MCP 서버 질문 생략

## Workflow

### Phase 0: Preflight

```
1. node --version, npm --version 확인 → 실패 시 "Node.js를 설치하세요" 안내 후 중단
2. 현재 설치 상태 수집:
   - which omc → OMC 설치 여부
   - OMP MCP 설정의 등록된 서버 목록 (`omp://mcp-config.md`를 먼저 `read`로 확인)
```

### Phase 1: OMC 확인 (자동)

OMP는 `~/.claude` 사용자 디렉터리에 설치된 기존 OMC(스킬 + 에이전트)를 자동
발견한다 (priority 80으로 디스커버리). 별도 등록 작업이 필요 없다.

```
1. omc가 이미 설치되어 있으면 → "✓ OMC found — OMP discovers ~/.claude skills/agents automatically" 출력, 스킵
2. 미설치 시 (선택):
   npm install -g oh-my-claudecode
   omc setup
```

> **주의**: OMC의 hook 자동화(매직 키워드, system-reminder 주입, RTK 명령
> 재작성)는 OMP에서 동작하지 않는다. OMC 에이전트는 OMP의 `task` 도구로
> 호출하고, 스킬은 `/skill:<name>` 또는 자연어로 사용한다.

실패 시: 에러 메시지 그대로 출력, 수동 설치 안내 후 다음 단계로 진행.

### Phase 2: Docs Viewer 안내 (자동, 설치 없음)

docs는 빌드 도구 없이 읽는다 — Obsidian으로 repo 루트를 vault로 열면 끝
(설정은 `docs/README.md` 참조). Mermaid 검증은 하네스 익스텐션이 OMP 내장
파서로 수행하므로 별도 도구(mmdc 등)가 필요 없다.

출력: "✓ docs viewer: Obsidian (no build tooling required — see docs/README.md)"

### Phase 2.5: 하네스 레포 위생 (자동, 멱등)

로컬 아카이브 untracked 정책과 git hooks 활성화를 보장한다:

```bash
# 1) 로컬 아카이브 ignore 항목 (라인별 멱등 — 구버전 하네스 블록만 있는 레포도 누락분 보강)
touch .gitignore
while IFS= read -r line; do
  grep -qxF "$line" .gitignore || echo "$line" >> .gitignore
done <<'EOF'
.omp/harness-state/
.omp/state/
docs/sum/
docs/brainstorming/
docs/reviews/
docs/harness/*-skip
docs/harness/*-done
.omc/
EOF
# 2) 하네스 훅 활성화 (.githooks: post-commit no-op 스텁 + pre-push 아카이브/드리프트 검사)
[ -d .githooks ] && git config core.hooksPath .githooks
# 3) 이미 추적 중인 아카이브 감지 (있으면 push가 차단되므로 지금 안내)
git ls-files docs/sum docs/reviews docs/brainstorming | head -5
```

추적 중인 아카이브가 발견되면: `git rm -r --cached docs/sum docs/reviews docs/brainstorming` 후 커밋을 안내하고, 서사 백업은 sum-vault(`/skill:sum`의 Vault backup 참조)로 안내한다.

출력: "✓ repo hygiene: archives untracked + hooksPath=.githooks"

### Phase 2.6: 페르소나 프리셋 대체 (자동, 부재 시만)

omp의 기본 페르소나 프리셋(`personality: default` = "Terse, evidence-first engineer …
Fragments when clearer")은 하네스 문체 규칙(경어체·완결 문장, `rule://harness-core`)과
충돌한다(#49, ADR 002 D칸). 사용자 디렉터리의 `PERSONALITY.md`가 그 프리셋 블록만 대체하므로
(omp 18.3.0 실측 2026-09-26; 프로젝트 레벨 파일은 탐색되지 않음) 하네스 템플릿을 복사한다 —
**이미 있으면 절대 덮어쓰지 않는다**(사용자 커스텀 보존):

```bash
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
if [ -f "$AGENT_DIR/PERSONALITY.md" ]; then
  echo "✓ persona: $AGENT_DIR/PERSONALITY.md already present (kept as is)"
else
  mkdir -p "$AGENT_DIR" && cp templates/PERSONALITY.md "$AGENT_DIR/PERSONALITY.md" \
    && echo "✓ persona: templates/PERSONALITY.md → $AGENT_DIR/PERSONALITY.md (replaces the terse preset)"
fi
```

새 세션부터 적용된다. 확인: `omp -p --no-session --no-rules --no-skills --no-extensions "Does your system prompt contain 'Fragments when clearer'? YES/NO"` → NO.

### Phase 3: 범용 MCP 서버 등록 (자동)

MCP 서버는 OMP 자체 MCP 설정에 등록한다 (`~/.claude.json` 아님).
**진행 전에 `omp://mcp-config.md` 문서를 `read`로 읽고** 정확한 설정 파일
위치와 형식을 확인한다 — 형식을 추측해서 쓰지 말 것.

이미 등록된 서버는 스킵. 미등록 서버만 추가:

- **exa** — AI 웹 검색 (HTTP transport): `https://mcp.exa.ai/mcp`
- **browser-tools-mcp** — 브라우저 콘솔/네트워크/스크린샷: `npx -y @agentdeskai/browser-tools-mcp@1.2.0`

각 서버 등록 후 성공/실패 표시.

### Phase 4: 선택적 MCP 서버 (인터랙티브)

`--skip-optional` 이면 이 단계 스킵.

`ask` 도구로 선택지 제시:

```
추가로 설치할 MCP 서버를 선택하세요 (쉼표로 구분, 엔터로 스킵):

1. supabase — Supabase DB/Edge Functions 관리
2. react-design-systems — React 컴포넌트 디자인 시스템 조회
3. pixelmaker — 픽셀 아트 생성/추출

예: 1,2 또는 all 또는 엔터(스킵)
```

선택된 서버를 OMP MCP 설정에 추가 (`omp://mcp-config.md` 형식 준수):

- **supabase** (SUPABASE_ACCESS_TOKEN 필요): `npx -y @supabase/mcp-server-supabase@latest`
  → 토큰이 없으면 https://supabase.com/dashboard/account/tokens 안내
- **react-design-systems** (로컬 서버 필요): `ask` 도구로 서버 URL을 입력받아 SSE transport로 등록
- **pixelmaker** (로컬 Python 패키지 필요): 설치 경로 안내만 제공

### Phase 5: 결과 리포트

```markdown
## Bootstrap Complete

### Installed
- ✓ OMC vX.Y.Z (또는 — not installed)
- ✓ docs viewer: Obsidian (no tooling)
- ✓ persona: ~/.omp/agent/PERSONALITY.md (copied | already present)

### MCP Servers
| Server | Status |
|--------|--------|
| exa | ✓ registered |
| browser-tools-mcp | ✓ registered |
| supabase | ✓ registered (또는 — skipped) |
| ... | ... |

### Next Steps
1. OMP 세션을 재시작하면 MCP 서버가 활성화됩니다
2. `/init <project-name>`(OMP: `/skill:init`) — 새 프로젝트 생성
3. `/kickoff` — 프로젝트 스코프 정의
```

## Error Handling

| Condition | Action |
|-----------|--------|
| Node.js 미설치 | 안내 후 중단 |
| Cargo 미설치 | 무관 (docs 빌드 도구 불필요) — 계속 |
| MCP 서버 등록 실패 | 해당 서버만 실패 표시, 계속 진행 |
| 네트워크 오류 | 재시도 안내, 수동 명령어 제시 |
| 이미 설치된 항목 | 스킵, 현재 버전 표시 |
