---
name: compr
argument-hint: [branch-name]
description: Creates a feature branch, commits changes, pushes, and opens a pull request. Use when the user says "compr", "PR 만들어", "풀리퀘", "PR 올려", or is ready to submit work for review.
---

# Compr - Commit and Pull Request

## Goal

Create a feature branch, commit changes, push, and open a pull request — all in one command.

## Inputs

- `$ARGUMENTS` — the user-provided argument (appended as `User: <args>`): Branch name (optional). If not provided, auto-generate from commit type.

## Constraints

| Rule | Rationale |
|------|-----------|
| Respect .gitignore | Never stage ignored files |
| No secrets | Abort if sensitive files detected |
| No force push | Never use `--force` |
| One PR per branch | Check existing PRs first |
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
- Already on feature branch?

If no changes → abort with "Nothing to commit".

### 2. Determine target branch

```bash
gh repo view --json defaultBranchRef -q '.defaultBranchRef.name'
```

Use repo's default branch (usually `main` or `master`).

### 3. Create branch

```bash
git fetch origin
git checkout <target-branch>
git pull origin <target-branch>
git checkout -b <branch-name>
```

**Auto-generate branch name** (if not provided):
- `feat/<description>` — New features
- `fix/<description>` — Bug fixes
- `docs/<description>` — Documentation
- `refactor/<description>` — Refactoring
- `chore/<description>` — Maintenance

### 3.5 Closeout check (스테이징 직전)

추적 중인 작업이 완료됐으면 마감한다 — `docs/rules/closeout_contract.md` 절차를 따른다:
seed `status: approved` + `docs/harness/current-scope.md`의 AC가 전부 `[x]`이면 → seed를 `status: done` + `completed: <date>`로 갱신, `current-scope.md` 삭제, `docs/harness/audit.jsonl`에 `task_closed` append(이 변경들은 아래 커밋에 포함된다). AC 미충족/비추적(seed 부재 또는 `approved` 아님)이면 advisory 후 skip(no-op). `.omp/skills/`를 수정했다면 전역 미러도 동기화.

**Sum nudge (마감 시에만)**: 위에서 작업을 실제로 마감(`status: done`)했고, 세션에 결정·교훈·미결이 쌓였는데 `docs/sum/`에 이 세션의 기록이 없으면 — PR 생성 후 `sum` 실행을 제안한다. 제안만, 자동 실행 금지 (승격은 사용자 확인이 필요한 흐름).

### 3.6 Doc freshness check (스테이징 전)

diff가 **이름 있는 것**(기능, 명령, env 키, 스케줄, 절차, 파일)을 제거하거나 개명했으면, 그 이름으로 문서(`README*`, `AGENTS.md`, `CLAUDE.md`, `docs/**`)를 grep한다. 잔재가 있으면 같은 커밋에서 갱신을 제안한다 — 제거된 것에 대한 낡은 서술은 실제 사고 클래스다. 히트 없으면 무언급 통과(마찰 0).

### 4. Stage and commit

```bash
git add -A
git diff --cached --name-only
```

Verify no sensitive files. Generate commit message:
- Format: `<type>: <short description>`
- Imperative mood, under 50 chars, no period

```bash
git commit -m "<message>"
```

### 5. Push and create PR

```bash
# 로컬 아카이브 유출 검사 — 서사는 레포가 아니라 sum-vault에 백업된다 (.omp/rules/harness-doc_standards.md)
if [ -n "$(git ls-files docs/sum docs/reviews docs/brainstorming)" ]; then
  echo "push 중단: 로컬 아카이브가 git에 추적 중 — git rm -r --cached docs/sum docs/reviews docs/brainstorming 후 .gitignore 등재"
  exit 1
fi
git push -u --follow-tags origin <branch-name>
gh pr create --base <target> --head <branch> --title "<title>" --body "<body>"
```

`--follow-tags` ensures annotated tags (e.g., a deliberate harness version bump via `scripts/harness-version-bump.sh`) are pushed with the branch.

`--follow-tags` push가 non-ff로 거부됐다면 **태그는 이미 올라갔을 수 있다**(브랜치와 태그 push는 원자적이지 않다). rebase 전에 `git ls-remote --tags origin 'refs/tags/harness/*'`로 원격 태그의 커밋을 확인한다. rebase로 그 커밋이 고아가 되면 태그를 강제 이동하지 말고(이미 sync한 소비 리포에 DRIFT 유발) **다음 버전을 새로 발행**한다. (2026-09-05 harness/2026.74 실측)

**PR body format**:
```markdown
## Summary
<2-3 bullet points>

## Changes
- <file1>: <what changed>

## Test
- [ ] <suggested test>
```

**Issue linking** (해당할 때만, 마찰 0 원칙):
- `gh issue list --state open --limit 20`으로 열린 이슈를 확인
- 이 PR이 이슈를 완결하면 본문 끝에 `Closes #N`(병합 시 자동 닫힘), 일부만 진전시키면 `Refs #N` — 후자는 병합 후 이슈에 남은 범위를 코멘트로 좁혀 기록한다
- 매치 없으면 무언급 통과. **이슈를 새로 만들지 않는다** — 생성은 sum(세션 마감)의 소관

### 6. Output

Show:
- Branch created: `<branch-name>`
- Commit: `<hash> <message>`
- PR created: `<PR-URL>`

## Error Handling

| Condition | Action |
|-----------|--------|
| No changes | Report and exit |
| Sensitive file detected | List files, abort |
| Branch exists | Suggest alternative or reuse |
| PR already exists | Show existing PR URL, abort |
| Push rejected | Suggest fetch + rebase |
| gh not authenticated | Suggest `gh auth login` |
