---
name: compush
argument-hint: [repo-url]
description: Stages, commits, and pushes all changes with an auto-generated commit message. Use when the user says "compush", "커밋", "푸시해", "변경사항 올려", or wants quick commits without PR.
---

# Compush - Automatic Commit and Push

## Goal

Stage, commit, and push changes safely with a concise English commit message.

## Inputs

- `$ARGUMENTS` — the user-provided argument (appended as `User: <args>`): Repository URL (optional). If provided, set/verify remote origin.

## Constraints

| Rule | Rationale |
|------|-----------|
| Respect .gitignore | Never stage ignored files |
| No secrets | Abort if sensitive files detected |
| No force push | Never use `--force` |
| Confirm risky push | Ask before pushing to main/master |
| No archive push | push 전 tracked 로컬 아카이브(sum/reviews/brainstorming) 검사 — 있으면 중단 |

## Process

### 1. Pre-flight checks

```bash
git status
git diff --stat
```

Check for:
- Any changes exist?
- Sensitive files? (`.env`, `*secret*`, `*.key`, `*.pem`)
- Large files (>10MB)?
- Merge conflict markers?

### 2. Remote verification (if URL provided)

```bash
git remote -v
```

If remote differs from provided URL → ask user for action.

**HTTPS to SSH conversion**:
`https://github.com/user/repo` → `git@github.com:user/repo.git`

### 2.5 Closeout check (스테이징 직전)

추적 중인 작업이 완료됐으면 마감한다 — `docs/rules/closeout_contract.md` 절차를 따른다(compr와 동일): seed `status: approved` + `docs/harness/current-scope.md`의 AC 전부 `[x]`이면 → seed `status: done` + `completed: <date>`, `current-scope.md` 삭제, `docs/harness/audit.jsonl`에 `task_closed` append(아래 커밋에 포함). AC 미충족/비추적이면 advisory 후 skip(no-op). `.omp/skills/` 수정 시 전역 미러 동기화. *(compush는 중간 푸시일 수 있으니 git 액션이 아니라 완료 상태에만 키잉됨에 유의.)*

**Sum nudge (마감 시에만)**: 위에서 작업을 실제로 마감(`status: done`)했고, 세션에 결정·교훈·미결이 쌓였는데 `docs/sum/`에 이 세션의 기록이 없으면 — push 완료 후 `sum` 실행을 제안한다. 제안만, 자동 실행 금지 (승격은 사용자 확인이 필요한 흐름). 중간 푸시(마감 없음)에는 발화하지 않는다.

### 2.6 Doc freshness check (스테이징 전)

diff가 **이름 있는 것**(기능, 명령, env 키, 스케줄, 절차, 파일)을 제거하거나 개명했으면, 그 이름으로 문서(`README*`, `AGENTS.md`, `CLAUDE.md`, `docs/**`)를 grep한다. 잔재가 있으면 같은 커밋에서 갱신을 제안한다 — 제거된 것에 대한 낡은 서술은 실제 사고 클래스다. 히트 없으면 무언급 통과(마찰 0).

### 3. Stage changes

```bash
git add -A
git diff --cached --name-only
```

If sensitive files detected → unstage and abort.

### 4. Generate commit message

Format: `<type>: <short description>`

**Types**: feat, fix, refactor, docs, style, test, chore

**Rules**:
- Imperative mood ("add" not "added")
- Under 50 characters
- No period at end

**Issue linking** (해당할 때만, 마찰 0 원칙):
- 원격이 GitHub이고 `gh` 사용 가능하면 `gh issue list --state open --limit 20`으로 열린 이슈를 확인
- 이 커밋이 열린 이슈를 진전시키면 두 번째 `-m`으로 본문에 `Refs #N`, 완결시키면 사용자 확인 후 `Closes #N`
- 매치 없으면 무언급 통과. **이슈를 새로 만들지 않는다** — 생성은 sum(세션 마감)의 소관, compush는 소비만 담당

### 5. Risk assessment

| Risk | Detection | Action |
|------|-----------|--------|
| Push to main/master | Branch check | Confirm with user |
| Large commit (>20 files) | File count | Warn, ask to proceed |
| Behind remote | git status | Require pull first |

### 6. Commit and push

커밋 게이트는 `.githooks/pre-commit`에서 **스테이징된 인덱스**를 판정한다(2026-07-30 재설계).
따라서 `git add … && git commit`처럼 동반 명령이 있어도 안전하다 — 게이트는 add가 끝난 뒤의
인덱스를 본다. 다만 아래처럼 **커밋과 푸시는 분리**하는 편이 낫다: 푸시 전 아카이브 검사를
독립적으로 수행하고, 게이트 차단 시 푸시가 딸려 실패하지 않는다.
`--no-verify`는 사람용 비상구이며 에이전트 호출에서는 tripwire가 차단한다.

```bash
git commit -m "<message>"
```

이슈 링크가 있으면 두 번째 `-m "Refs #N"`(또는 확인된 `Closes #N`)을 **같은 커밋 호출**에 추가한다.

푸시는 아카이브 유출 검사와 함께 **별도 호출**로:

```bash
# 로컬 아카이브 유출 검사 — 서사는 레포가 아니라 sum-vault에 백업된다 (.omp/rules/harness-doc_standards.md)
if [ -n "$(git ls-files docs/sum docs/reviews docs/brainstorming)" ]; then
  echo "push 중단: 로컬 아카이브가 git에 추적 중 — git rm -r --cached docs/sum docs/reviews docs/brainstorming 후 .gitignore 등재"
  exit 1
fi
git push --follow-tags
```

`--follow-tags` ensures annotated tags (e.g., a deliberate harness version bump via `scripts/harness-version-bump.sh`) are pushed with the branch in one operation.

`--follow-tags` push가 non-ff로 거부됐다면 **태그는 이미 올라갔을 수 있다**(브랜치와 태그 push는 원자적이지 않다). rebase 전에 `git ls-remote --tags origin 'refs/tags/harness/*'`로 원격 태그의 커밋을 확인한다. rebase로 그 커밋이 고아가 되면 태그를 강제 이동하지 말고(이미 sync한 소비 리포에 DRIFT 유발) **다음 버전을 새로 발행**한다. (2026-09-05 harness/2026.74 실측)

### 7. Output

Show:
- Files committed (count + summary)
- Commit message used
- Push result
- Remote URL

## Verification

```bash
git status
git log -1 --oneline
```

Confirm working tree clean and commit exists.

## Error Handling

| Condition | Action |
|-----------|--------|
| No changes | Report and exit |
| Sensitive file | List files, abort |
| Push rejected (non-ff) | 원격 태그 상태 확인(`git ls-remote --tags`) 후 `git pull --rebase`; 고아가 된 태그는 이동 대신 새 버전 발행 |
| Push rejected (auth) | Suggest SSH key check |
| Behind remote | Require pull first |
| Detached HEAD | Warn, suggest creating branch |
