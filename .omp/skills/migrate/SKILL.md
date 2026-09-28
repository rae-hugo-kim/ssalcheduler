---
name: migrate
argument-hint: (run inside the project you want to migrate)
description: Migrate an existing Claude Code project to the OMP native harness (full cutover with a git insurance tag). Use when the user says "migrate", "이주", "omp로 옮겨", "컷오버", "cut over to omp", or wants to switch a legacy .claude/CLAUDE.md project to OMP.
---

# Migrate - Claude Code → OMP Cutover

## Goal

기존 Claude Code 프로젝트(`.claude/` + `CLAUDE.md` 레이어)를 **그 프로젝트 안에서** OMP 네이티브 하네스로 전환한다. 일괄 이주 대신, "이 프로젝트를 omp로 작업하고 싶다"가 된 순간에 1회 실행하는 풀 컷오버.

원칙: **git 보험 태그를 먼저 박고**(언제든 1줄로 복귀) → 하네스 동기화는 `harness-sync.sh` 엔진을 재사용 → Claude Code 레이어만 제거. 사용자 코드(`src/`, `docs/`, ...)는 절대 건드리지 않는다.

## When to use / not use

| 상황 | 스킬 |
|------|------|
| Claude Code 프로젝트의 **최초 컷오버** (.claude/CLAUDE.md 제거 + 하네스 이식 + 보험 태그) | **이 스킬** |
| 이미 OMP인 프로젝트의 **버전 드리프트 동기화** (이주 후 유지보수) | `/skill:harness-check` |
| **새** 프로젝트를 템플릿에서 생성 | `/skill:init` |

## Non-Negotiables

| Rule | Violation = STOP |
|------|------------------|
| **git 레포여야 함** | 비-git 디렉토리면 중단 (보험 태그 불가) |
| **보험 태그 먼저** | 하네스 파일을 건드리기 전에 `pre-omp-migration` 태그를 박는다 |
| **커스텀 정책 보존** | sync는 `.omp/rules/harness-*.md`·AGENTS.md를 무조건 덮어쓴다 — 프로젝트 고유 커스텀은 덮어쓰기 전에 사용자 확인 |
| **사용자 코드 불가침** | 화이트리스트(하네스 자산)만 변경. `src/`·`docs/` 등은 건드리지 않음 |

## Workflow

### Phase 0: Pre-flight

```bash
# 1. git 레포 확인 (보험 태그 전제)
git rev-parse --show-toplevel >/dev/null || { echo "git 레포가 아닙니다 — 중단"; exit 1; }

# 2. Claude Code 레이어 감지 (이주 대상인지)
ls -d .claude CLAUDE.md 2>/dev/null   # 둘 다 없으면 아래 안내 후 중단

# 3. gh 인증 (보험 태그 원격 push용)
gh auth status

# 4. 소스 최신 harness 태그 해석 + 임시 클론 (Phase 2 감사 + Phase 3 부트스트랩에 재사용)
SRC="git@github.com:rae-hugo-kim/omp.git"
TAG=$(git ls-remote --tags "$SRC" 'refs/tags/harness/*' | awk '{print $2}' \
  | sed 's|refs/tags/harness/||; s|\^{}$||' | sort -u -t. -k1,1n -k2,2n | tail -1)
TMPL=$(mktemp -d)
git clone --quiet --depth 1 --branch "harness/$TAG" "$SRC" "$TMPL"
```

`.claude/`도 `CLAUDE.md`도 없으면: "이 프로젝트엔 Claude Code 레이어가 없습니다. 이미 OMP면 `/skill:harness-check`, 새 프로젝트면 `/skill:init`을 쓰세요." 안내 후 중단.

### Phase 1: 보험 스냅샷 (먼저!)

현재 작업 트리 전부를 커밋하고 태그를 박아, 언제든 복귀 가능한 정확한 복원점을 만든다 (dirty 파일도 전부 보존 — 보험이 바이트 단위로 정확해짐).

```bash
git add -A
git commit -m "chore: OMP 마이그레이션 직전 스냅샷" || echo "(커밋할 변경 없음 — 현재 HEAD에 태그)"
git tag pre-omp-migration
git push
git push origin pre-omp-migration
```

복귀 방법(사용자에게 안내): `git checkout pre-omp-migration -- .claude CLAUDE.md .gitignore` 또는 전체 열람 `git switch --detach pre-omp-migration`.

### Phase 2: 커스텀 정책 감사 (sync가 덮어쓰기 전에 — STOP 게이트)

`harness-sync.sh`는 `.omp/rules/harness-*.md checklists/ templates/ AGENTS.md INDEX.md EXAMPLES.md`를 **무조건 원격본으로 덮어쓴다**(remote wins). 프로젝트 고유 커스텀이 있으면 사라지므로, 먼저 diff로 드러낸다. Claude Code 시절 레포의 `rules/`는 이제 하네스 디렉터리가 아니다 — 그 안의 커스텀도 같은 감사 대상이다.

```bash
for d in checklists templates; do
  [[ -d "$d" ]] && diff -rq "$d" "$TMPL/$d" 2>/dev/null
done
# legacy rules/<name>.md vs the template's .omp/rules/harness-<name>.md
for f in rules/*.md; do
  [[ -f "$f" ]] || continue; n=$(basename "$f" .md)
  if [[ -f "$TMPL/.omp/rules/harness-$n.md" ]]; then diff -q "$f" "$TMPL/.omp/rules/harness-$n.md" || true
  else echo "consumer-only: $f"; fi
done
[[ -f CLAUDE.md ]] && diff CLAUDE.md "$TMPL/AGENTS.md" 2>/dev/null | head -50
```

- 차이가 **하네스 표준 텍스트 차이뿐**(claude판 서술 vs omp판 서술)이면 → 그대로 진행.
- 차이에 **프로젝트 고유 정책/용어/규칙**이 있으면 → **STOP**. 사용자에게 보여주고 결정:
  - 하네스 레벨 개선이면 → 템플릿(omp 레포)에 기여 후 진행.
  - 프로젝트 고유 맥락이면 → sync 대상이 **아닌** 곳으로 이동(`docs/`, kickoff `seed.yaml`, `claudedocs/`). **AGENTS.md·`.omp/rules/harness-*` 이름에 두면 다음 sync에서 사라짐**을 명시. 프로젝트 규칙은 `.omp/rules/<name>.md`(`harness-` 접두사 금지)에 두면 sync가 건드리지 않는다.
  - 명시적 "진행" 확인 전까지 다음 단계로 가지 않는다.

### Phase 3: 하네스 동기화 (엔진 재사용)

```bash
mkdir -p scripts
cp "$TMPL/scripts/harness-sync.sh" scripts/harness-sync.sh
bash scripts/harness-sync.sh        # 최신 태그 재클론 → 화이트리스트 전부 덮어쓰기/추가 + meta 주입
```

이 한 번으로 들어오는 것: `AGENTS.md INDEX.md EXAMPLES.md .omp/rules/harness-*.md checklists/ templates/ .omp/extensions/harness/(게이트 + index.ts) .omp/skills/(전부) .omp/agents/ scripts/harness-*.sh .githooks/post-commit` + `harness-meta.json`(unregistered면 `source_remote`를 default로 등록 → 이후 `session_start`마다 드리프트 알림).

**레거시 `rules/` 정리 (ADR 002)**: 하네스 규칙은 `.omp/rules/harness-<name>.md`로 옮겨졌고 `rules/`는 더 이상 화이트리스트 디렉터리가 아니다. sync 스크립트 7c 단계가 직전 동기화 트리(`refs/harness/<prev>`)와 blob이 같은 파일만 지우고, 소비자가 고치거나 추가한 파일은 남긴 채 advisory를 낸다. 직전 트리가 없는 레포(`refs/harness/*` 부재)는 아무것도 지우지 않으므로 Phase 2 diff 결과대로 손으로 정리한다. 프로젝트 문서가 `rules/<name>.md`를 링크하고 있으면 치환한다:

```bash
# perl -pi: BSD/macOS sed has no portable in-place -E. `git grep -z` scopes to TRACKED files
# (node_modules etc. excluded) and NUL-delimits names; `--` keeps an odd name from being read
# as a perl option. Boundary: a path char before `rules/` (docs/rules/, .omp/rules/, lint-rules/)
# is left alone; a leading `./` is accepted.
while IFS= read -r -d '' f; do
  perl -pi -e 's#(^|[^A-Za-z0-9_./-])((?:\./)?(?:\.\./)*)rules/([a-z_]+)\.md#$1$2.omp/rules/harness-$3.md#g' -- "$f"
done < <(git grep -lzE '(^|[^A-Za-z0-9_./-])(\./)?(\.\./)*rules/[a-z_]+\.md' -- '*.md' ':!docs/rules/*')
```

### Phase 4: Claude Code 레이어 제거

```bash
git rm -r --quiet .claude 2>/dev/null; rm -rf .claude
git rm --quiet CLAUDE.md 2>/dev/null; rm -f CLAUDE.md
git rm -r --quiet .omc/harness-state 2>/dev/null; rm -rf .omc/harness-state
```

- `.claude/`, `CLAUDE.md` = 구 하네스 레이어 → 제거 (보험 태그에 그대로 보존됨).
- `.omc/harness-state` = 구 OMC 게이트 상태 → 제거. (나머지 `.omc/`는 새 `.gitignore`가 무시하지만, 이미 추적 중이던 파일의 untrack 여부는 사용자 판단에 맡김 — project-memory 등이 있을 수 있음.)
- `claudedocs/`는 **유지**(참조 문서, sync 대상 아님).

### Phase 5: .gitignore 병합

`harness-sync.sh`는 `.gitignore`를 동기화하지 않으므로 여기서 보장한다. **라인별 멱등** — 구버전 블록이 이미 있는 레포도 누락 항목(예: `docs/sum/`)만 보강되고, 프로젝트 기존 항목은 보존.

```bash
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
```

훅 활성화(멱등): 동기화된 `.githooks/`(post-commit no-op 스텁 + pre-push 아카이브/드리프트 검사)를 켠다.

```bash
git config core.hooksPath .githooks
```

### Phase 6: 게이트 스모크 (확장이 실제로 배선됐는지 증명)

읽지 않은 기존 파일(AGENTS.md) 수정 시도를 context-gate에 직접 먹여 BLOCK(exit 2)을 확인 → 게이트가 로드·실행됨을 증명.

```bash
echo '{"tool_input":{"file_path":"'"$PWD"'/AGENTS.md"},"session_state":{"cwd":"'"$PWD"'"}}' \
  | node .omp/extensions/harness/gates/context-gate.mjs; echo "exit=$?"
# 기대: "HARNESS BLOCK: You must read '.../AGENTS.md' before editing it." + exit=2
```

`exit=2` + `HARNESS BLOCK` → OK. `exit=127`/module 에러 → node 미설치 또는 sync 실패(중단·진단). 구조도 병행 확인:

```bash
test -f AGENTS.md && test -d .omp/extensions/harness/gates && test -d .omp/agents \
  && grep -q source_remote .omp/extensions/harness/harness-meta.json && echo "structure OK"
```

### Phase 7: 컷오버 커밋 + 푸시

```bash
git add -A
git commit -m "feat(harness): OMP 네이티브 하네스로 컷오버 (harness/$TAG)"
git push --follow-tags
rm -rf "$TMPL"
```

> 주의: 타겟 프로젝트는 자체 `harness/*` 태그를 만들지 않는다 — 버전 provenance는 `harness-meta.json`(version/commit_sha)에만 기록. `harness/*` 태그는 템플릿 레포 소유.

### Phase 8: 안내

```markdown
## Migrated: <project> → OMP (harness/<TAG>)

- 보험 태그: `pre-omp-migration` (원격 푸시됨) — 복귀: `git checkout pre-omp-migration -- .claude CLAUDE.md .gitignore`
- 제거됨: `.claude/`, `CLAUDE.md`, `.omc/harness-state`
- 이식됨: AGENTS.md, 게이트, 에이전트, 스킬, .omp/rules/harness-*·checklists/templates

### 다음 단계
**하네스는 이 폴더에서 omp 세션을 새로 열어야 적용됩니다** (지금 세션 cwd엔 확장이 로드되지 않음):
1. `cd <project>` 후 omp 재시작
2. 작업 계속 — 게이트(context/acceptance/backpressure)가 자동 작동
3. 이후 하네스 갱신은 `/skill:harness-check`
```

## Error Handling

| Condition | Action |
|-----------|--------|
| 비-git 디렉토리 | 중단 — 보험 태그 불가. `git init` 후 재시도 권유 |
| `.claude`/`CLAUDE.md` 둘 다 없음 | 이주 대상 아님 — `harness-check`(기존 OMP) 또는 `init`(신규) 안내 |
| gh 미인증 | 보험 태그 원격 push 불가 — `gh auth login` 안내 (로컬 태그는 가능하나 원격 보험 권장) |
| `pre-omp-migration` 태그 이미 존재 | 이전 이주 흔적 — 사용자 확인 후 `git tag -d pre-omp-migration` 재생성 또는 중단 |
| 커스텀 정책 발견 | STOP — 사용자 결정 전 sync 금지 |
| sync 클론 실패 | 네트워크/인증 확인. 로컬 변경 없음(보험 태그 시점 상태 유지) |
| 게이트 스모크 exit≠2 | node PATH 확인 후 sync 재실행. 미해결 시 컷오버 커밋 보류·진단 |

## Notes

- 이 스킬은 **사용자 레벨(`~/.omp/agent/skills/migrate/`)에 설치**되어야 레거시 프로젝트(`.omp/skills` 없음)에서도 발견된다 (`init`과 동일 패턴).
- 보험 태그가 컷오버를 안전하게 만든다: `.claude/`·`CLAUDE.md`가 태그에 그대로 남으므로 복귀는 1줄.
- 여러 프로젝트는 각각에서 1회씩 — 일괄 이주의 N-레포 리스크를 시점 분산.
