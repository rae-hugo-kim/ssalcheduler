---
name: init
argument-hint: <project-name> [--private]
description: Create a new project from the omp template repository
---

# Init - New Project from Template

## Goal

템플릿 리포지토리(rae-hugo-kim/omp)에서 새 프로젝트를 생성하고, 바로 작업 가능한 상태로 만든다.

## Inputs

- `$ARGUMENTS` — 사용자 인자(`User: <args>` 형태로 덧붙어 전달됨): 프로젝트 이름 (필수)
  - `"my-app"` → public repo 생성
  - `"my-app --private"` → private repo 생성
  - 이름 없이 실행 → `ask` 도구로 물어봄

## Non-Negotiables

| Rule | Violation = STOP |
|------|------------------|
| **프로젝트 이름 필수** | 이름 없으면 물어봐야 함 |
| **gh CLI 인증 확인** | 미인증이면 안내 후 중단 |
| **플레이스홀더 정리** | 이전 프로젝트 흔적 남기지 않음 |

## Workflow

### Phase 0: Pre-flight

```
1. gh auth status 확인 → 실패 시 "! gh auth login을 실행하세요" 안내 후 중단
2. $ARGUMENTS에서 프로젝트 이름 추출
3. 이름 없으면 `ask` 도구로 물어봄
4. --private 플래그 확인
```

### Phase 1: Repository 생성

```bash
gh repo create <project-name> --template rae-hugo-kim/omp [--private] --clone
cd <project-name>
```

생성 실패 시:
- 이미 존재하는 repo → 알림 후 중단
- 네트워크 오류 → 재시도 안내

### Phase 2: 플레이스홀더 정리

하네스 파일들을 깨끗한 상태로 초기화:

```
1. docs/harness/ 정리:
   - seed.yaml → 삭제 (kickoff에서 새로 생성)
   - rubric-report.md → 삭제
   - audit.jsonl → 비움 (빈 파일로)
   - kickoff-summary.md → 삭제
   - kickoff-done → 삭제 (있으면)
   - current-scope.md → 삭제 (있으면)
   - README.md → 유지

2. docs/glossary.yaml → 템플릿에서 복사하여 terms: [] 로 초기화

3. docs/sum/ → 비움 (이전 세션 기록 제거)

4. README 교체 (템플릿 README가 derived repo에 새지 않도록):
   - README.md, README.en.md를 아래 placeholder로 덮어쓴다.
   - `<!-- claude-template-placeholder -->` 마커는 `/kickoff`(OMP: `/skill:kickoff`)이 "아직 사용자가 손대지 않음"을 판별하는 데 사용된다.

5. 소스 리포 전용 자산 제거 (GitHub 템플릿 복사는 소스 트리 전체를 가져온다):
   - scripts/docs-drift          → 삭제. 소스 전용 문서 감사기. 소비 리포에 남으면 harness-sync
                                   화이트리스트 밖이라 영원히 구버전으로 남고, .githooks/pre-push가
                                   이를 실행해 소스 전용 링크(claudedocs/, docs/decisions/) 부재를
                                   FAIL로 판정 → push 차단 (#26)
   - claudedocs/                 → 삭제 (AGENTS.md 한국어 미러 등 소스 리포 문서)
   - docs/harness/handoff_*.md   → 삭제 (있으면; 소스 리포 세션 간 인수인계 문서)
   - CHANGELOG.md                → 삭제 (하네스 릴리스 히스토리; harness-sync PATHS 밖이라 소비 리포에서 영구 stale)
   (artifacts/README.md는 소비자 자산 — 유지)
   판단 기준: `scripts/harness-sync.sh`의 PATHS 배열이 "소비 리포가 가져야 할 하네스 파일"의
   SoT다. 그 밖의 하네스성 파일이 템플릿에서 딸려왔다면 같은 이유로 제거 대상이다.
   (하네스 게이트 테스트는 `.omp/extensions/harness/tests/`에 있어 게이트와 같은 태그로
   동기화된다 — 삭제하지 않는다. 검증: `node --test .omp/extensions/harness/tests/*.test.mjs`)
```

**README.md placeholder**:

```markdown
**[English](README.en.md)**

# <project-name>

> TODO — 프로젝트 설명. `/kickoff` 실행 시 kickoff 결과로 자동 채워집니다.

<!-- claude-template-placeholder -->
```

**README.en.md placeholder**:

```markdown
**[한국어](README.md)**

# <project-name>

> TODO — Project description. Will be auto-filled when you run `/kickoff`.

<!-- claude-template-placeholder -->
```

`<project-name>`은 Phase 0에서 추출한 이름으로 치환한다.

### Phase 3: 하네스 메타 주입

`source_remote`, `commit_sha`, `bootstrapped_at`을 `.omp/extensions/harness/harness-meta.json`에 주입.
이 필드들이 있으면 `session_start` 이벤트에서 하네스 익스텐션이 원격 버전을 확인할 수 있고, 없으면(=템플릿 자체일 때) 스킵됨.

`commit_sha`는 **템플릿 HEAD가 아니라 `harness/<version>` 태그의 peeled commit SHA**여야 한다.
`harness-version-check.mjs`는 버전이 같으면 이 값을 원격 태그의 peeled SHA와 비교하는데, 템플릿 HEAD는
마지막 bump 이후의 문서 커밋만큼 태그보다 앞서 있어 `rev-parse HEAD`를 넣으면 매 세션 `HARNESS DRIFT`
오탐이 나고 덮어쓰기 sync를 유도한다 (blender 실측, #35). `harness-sync.sh`가 기록하는 값과 같은 정의다.

```bash
# 소스 레포 URL (SSH 형식 권장 — 비공개 접근 호환)
SOURCE_REMOTE="git@github.com:rae-hugo-kim/omp.git"

# 템플릿이 담고 있는 하네스 버전 (harness-meta.json의 version)
HARNESS_VERSION=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(".omp/extensions/harness/harness-meta.json","utf8")).version)')

# 그 버전 태그의 peeled commit SHA (annotated 태그는 `^{}` 행, lightweight 태그는 태그 행 자체가 commit)
COMMIT_SHA=$(git ls-remote --tags "$SOURCE_REMOTE" "refs/tags/harness/${HARNESS_VERSION}^{}" | cut -f1)
[ -n "$COMMIT_SHA" ] || COMMIT_SHA=$(git ls-remote --tags "$SOURCE_REMOTE" "refs/tags/harness/${HARNESS_VERSION}" | cut -f1)
[ -n "$COMMIT_SHA" ] || { echo "harness/${HARNESS_VERSION} 태그를 원격에서 찾지 못했습니다"; exit 1; }

# ISO 8601 UTC
BOOTSTRAPPED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

기존 `harness-meta.json`에 다음 필드 추가 (기존 `version`, `updated`, `description`은 유지):

```json
{
  "version": "<existing>",
  "updated": "<existing>",
  "description": "<existing>",
  "source_remote": "git@github.com:rae-hugo-kim/omp.git",
  "commit_sha": "<COMMIT_SHA>",
  "bootstrapped_at": "<BOOTSTRAPPED_AT>"
}
```

`edit` 툴로 JSON 파일 직접 수정 (마지막 `}` 앞에 세 필드 삽입).

### Phase 4: 하네스 훅 활성화

`core.hooksPath`는 **로컬 git 설정**이라 템플릿 복사로는 전파되지 않는다 (`harness-sync.sh`는 8단계에서 멱등 설정하지만, 첫 sync 전인 init 시점에는 이 단계가 유일한 활성화 경로다).
이 단계가 없으면 AGENTS.md가 선언하는 pre-commit/pre-push 게이트가 처음부터 비활성이다 (#26).
bootstrap/migrate와 동일한 명령:

```bash
[ -d .githooks ] && git config core.hooksPath .githooks
git config --get core.hooksPath   # → .githooks
```

### Phase 5: 초기 커밋

```bash
git add -A
git commit -m "chore: initialize from omp template"
git push
```

커밋은 이제 활성화된 `.githooks/pre-commit`을 통과해야 한다. 이 커밋은 `risk-assess`의 **템플릿
부트스트랩 창**에 들어간다 — (1) HEAD가 템플릿 "Initial commit" 하나뿐이고(shallow clone 아님)
`refs/harness/` 아래 ref가 없으며, (2) HEAD의 `harness-meta.json`에는 `bootstrapped_at`·`source_remote` 키가
아예 없고 스테이징된 사본에는 두 값이 비어 있지 않은 문자열로 있으며(템플릿→소비자 전이가 바로 이 커밋),
(3) 변경이 **소스 전용 자산의 삭제**(docs/·claudedocs/·scripts/docs-drift·CHANGELOG.md — 단
docs/rules/·docs/templates/·docs/checklists/ 같은 하네스 자산 경로는 제외)이거나
README.md·README.en.md·harness-meta.json·docs/glossary.yaml·docs/harness/audit.jsonl 편집일 때
그 파일들은 채점에서 제외되어 커밋 전체가 low로 판정된다(`HARNESS WARNING: No scope file`은
뜨지만 차단 아님). **같은 커밋에 다른 파일(사용자 코드, AGENTS.md 편집, 새 파일, 하네스 자산
삭제 — `.omp/extensions/harness/`·`.githooks/`·`.omp/rules/harness-*.md` 등)을 섞으면 그 나머지가
평소대로 채점**되어 review-gate/backpressure-gate에 걸릴 수 있다 — 초기 커밋은 Phase 2~3의 결과만
담고, 프로젝트 고유 변경은 `/kickoff` 이후 별도 커밋으로 한다. Phase 3에서 `bootstrapped_at`을
빠뜨렸거나 `git commit`이 세 번째 커밋이면 창이 닫혀 실제 위험도로 채점된다.
push는 `.githooks/pre-push`의 archive-guard를 지나며, Phase 2-5를 건너뛰었다면 여기서 docs-drift
FAIL로 막힌다.

### Phase 6: 안내

```markdown
## Project Ready: <project-name>

- Repository: https://github.com/<owner>/<project-name>
- Local path: <path>

### Next Steps
1. `cd <project-name>`
2. `/kickoff` — 프로젝트 스코프 정의
3. `/startdev` — TDD 기반 구현 시작

### Included
- Skills (`.omp/skills/`): bootstrap, init, kickoff, startdev, sum, compr, compush
- Harness gates (`.omp/extensions/harness/gates/`, registered by the `.omp/extensions/harness/index.ts` extension): context-gate, acceptance-gate, backpressure-gate, kickoff-detector, read-tracker, backpressure-tracker (the full template registers more)
- Agents (`.omp/agents/`), AGENTS.md, rules, templates, glossary

### Your project's own policy (survives `harness-check` sync)
- `.omp/rules/<name>.md` — project rules (`alwaysApply: true` / `globs` / `condition`); use unique names such as `<project>-hard.md`, `<project>-context.md` for sticky requirements and project background
- `.omp/RULES.md` — short sticky hard requirements (shadowed when a user-level `~/.omp/agent/RULES.md` exists — both carry the fixed name `RULES`; prefer `.omp/rules/<name>.md` with `alwaysApply: true`)
- `.omp/agents/<custom>.md`, `.omp/skills/<custom>/` — custom agents/skills
Do NOT create `.omp/AGENTS.md` (any non-empty file makes OMP's native provider replace the root AGENTS.md at the same depth — the harness policy silently disappears). Do NOT name a project rule `harness-*` and do NOT add files under the harness skill/agent names — the next sync deletes or overwrites them. See AGENTS.md "Consumer extension points".
```

## Error Handling

| Condition | Action |
|-----------|--------|
| gh 미설치 | "gh CLI를 설치하세요: https://cli.github.com" |
| gh 미인증 | "! gh auth login을 실행하세요" |
| repo 이름 충돌 | "이미 존재합니다. 다른 이름을 사용하세요" |
| template 접근 불가 | "rae-hugo-kim/omp 접근 권한을 확인하세요" |
| clone 실패 | 네트워크 확인 안내 |
