---
name: sum
argument-hint: [filename]
description: Summarizes the current conversation to docs/sum/ and triages its knowledge (promote/keep/discard). Use when the user says "sum", "요약해줘", "정리해줘", "요약문서 만들어줘", "세션 저장", or wants to preserve session context.
---

# Sum — 세션 지식의 처분 (요약 + 승격 + 인덱스)

## Goal

세션 요약문서는 최종 산출물이 아니라 **시점 증거 + 승격 인박스**다. 이 스킬은 세 가지를 한다:

1. **기록** — 세션이 남긴 델타(결정·계약 변화·해결 과정·교훈)를 불변 시점 기록으로 남긴다
2. **처분** — 각 지식 항목을 승격/보관/폐기로 분류하고, 승격안을 제안해 확인받는다
3. **등재** — `INDEX.md`에 한 줄 등재해 발견 가능하게 만든다 (진입점 없는 문서는 존재하지 않는 문서다)

## Inputs

- `$ARGUMENTS` — the user-provided argument (appended as `User: <args>`): Custom filename (optional). Default: `session_YYYY-MM-DD_<topic>.md`

## Output Path

```
<project-root>/docs/sum/<filename>.md
<project-root>/docs/sum/INDEX.md   (매 실행 갱신)
```

링크드 워크트리에서 실행되면 7단계(Vault backup)가 메인 체크아웃의 `docs/sum/`에도 사본을 남긴다 — `git worktree remove`가 ignored인 로컬본을 함께 지우는 것을 방지.

## Principles

| 원칙 | 설명 |
|------|------|
| **델타만** | 대화를 재서술하지 않는다. "이 세션이 세상에 남긴 변화"만 기록 |
| **시점 기록** | sum 문서는 불변. 경로·diff는 작성 시점의 인용이며 이후 변경을 따라가지 않는다. 정정은 새 세션 기록/승격 문서에서 |
| **문서는 입구** | 내용 복제 대신 원천 포인터(파일 경로, 커밋 SHA). 원천은 코드/커밋이다 |
| **처분 없이 종결 금지** | 모든 결정·교훈은 `승격→<대상>` / `보관` / `승격 대기` 중 하나로 태그. write-only 보관소를 만들지 않는다 |
| **재현 가능하게** | 같은 문제가 생기면 이 문서만 보고 해결할 수 있어야 함 |
| **핵심 diff만** | 변경 전/후를 diff 블록으로. 전체 코드 복붙 X |
| **원인-해결 연결** | "뭘 바꿨다"만이 아니라 "왜 그게 문제였고 왜 이렇게 바꿨다" |

## Process

**Seed from breadcrumb (먼저)**: `.omp/harness-state/session-log.jsonl`이 있으면 먼저 읽는다 — `breadcrumb-tracker`가 자동 기록한 no-LLM 항목(커밋·테스트 PASS/FAIL·변경 파일)이 *Files Changed*·*Fixes & Troubleshooting* 섹션을 직접 시드하므로 수기 도출이 줄어든다. (자율화 Q1; 없으면 평소대로 대화에서 도출.)

### 1. 디렉토리 준비 + 최초 실행 백필

```bash
mkdir -p docs/sum
```

`docs/sum/INDEX.md`가 **없는데 기존 sum 문서가 있으면**, 먼저 백필한다: 파일당 한 줄(날짜 + 파일명/제목에서 뽑은 한 줄 요약, 처분 열은 `미처분(백필)`). 내용 정독이나 처분 판단은 하지 않는다 — 문맥이 죽은 문서의 처분은 비싸다. "찾으면 나오는 기록"으로 전환하는 것이 목적.

### 2. 지식 추출 (델타만)

대화에서 다음만 추출한다: 내려진 결정, 바뀐 계약(다른 코드/사람이 의존하는 것), 해결한 문제, 새 구현의 주의사항, 미결, 명시적으로 기각한 것.

### 3. 처분 태그

각 결정·교훈에 처분을 결정한다. 라우팅 기준:

| 지식 종류 | 승격 대상 |
|---|---|
| 살아있는 계약·불변식·작업 규칙 ("항상/절대 ~") | 프로젝트 AGENTS.md / CLAUDE.md |
| 갈림길 결정 (전략 변경, 외부 서비스 추가/교체, 보안 모델, 인프라, 프로젝트 전반 패턴, 기존 결정의 전제 파괴) | `docs/decisions/` (ADR). 디렉토리가 없으면 `승격 대기` |
| 반복 가능한 교훈 (Fix의 교훈 중 이 세션 밖에서도 유효한 것) | AGENTS.md 한 줄 |
| 절차 (운영·복구·릴리즈 순서) | runbook / README |
| 이 세션에서만 유효한 맥락 | `보관` (sum 문서로 충분) |

대상 문서가 프로젝트에 없으면 처분을 `승격 대기`로 표기한다 — 나중에 같은 주제가 반복 소환되면 그게 소유 문서를 만들 신호다.

**타인 소유 레포 가드**: 스터디 클론처럼 push 권한이 없거나 운영 주체가 내가 아닌 레포에서는 **레포 내 문서(AGENTS.md·docs 등)로 승격하지 않는다** — 승격 대상은 내 지식 기지(omp 하네스 .omp/rules/harness-*.md, 위키, 전역 메모리)이거나 `승격 대기`다. 미결 이슈화(5.5)도 같은 이유로 생략한다(남의 이슈 트래커에 내 백로그를 만들지 않는다).

### 4. 요약문서 작성

```markdown
# YYYY-MM-DD <세션 한 줄 주제>

> 시점 기록(불변): 경로·diff·코드는 작성 시점의 인용이며 이후 변경을 따라가지 않는다.
> 정정·후속은 이 문서를 고치지 않고 새 세션 기록 또는 승격된 문서에서 한다.

## Overview
1-3문장으로 이 세션에서 무슨 작업을 했는지.

## 결정
없으면 "이 세션의 결정 없음".

### D1: <결정 한 줄>
- **맥락**: 왜 이 판단이 필요했나 (1-2줄)
- **결정**: 무엇으로 정했나
- **기각한 대안**: <대안> — <기각 사유> (없으면 생략)
- **재검토 트리거**: <이 결정을 다시 봐야 할 조건> (없으면 생략)
- **처분**: 승격→<대상 문서> | 보관 | 승격 대기

## 계약 변화
API·스키마·env 키·스케줄·인터페이스 등 "다른 코드/사람이 의존하는 것"의 변화만.
내용을 복제하지 말고 원천 포인터로. 없으면 "계약 변화 없음".
- <무엇이 어떻게 바뀜> — `path/to/file`, commit `<sha>`

## Fixes & Troubleshooting
없으면 "이 세션에서 해결한 오류 없음".

### Fix 1: <문제 한 줄 요약>
**증상**: 어떤 현상 (에러 메시지, 잘못된 동작)
**원인**: 근본 원인
**해결**: 어떤 파일의 어떤 부분을 어떻게 수정했는지

```diff
- 변경 전
+ 변경 후
```

**교훈**: 다음에 비슷한 상황에서 기억할 점
**처분**: 교훈이 이 세션 밖에서도 반복 가능하면 승격→<대상>, 아니면 보관

## Implementation Details
새로 구현하거나 크게 변경한 기능. 단순 수정은 생략. 없으면 "새로운 구현 없음".

### Feature 1: <한 줄 요약>
**목적**: 왜 필요했나
**접근**: 어떤 접근을 택했고 왜 (기각한 접근이 있으면 한 줄)
**관련 파일**: `path/to/file`
**주의사항**: 제약, edge case. 미래 세션이 어겨서는 안 되는 것이면 **처분: 승격→<대상>**

## Files Changed
- `path/to/file1` — <what changed>

## 미결
- <열린 질문/후속 작업> → <다음 세션 | 이슈 #N | 보류>

## 폐기
논의했으나 채택하지 않은 것. "명시적으로 버렸다"는 사실 자체가 정보다. 없으면 생략.
- <아이디어/접근> — <버린 이유 한 줄>
```

### 5. 승격 제안 → 확인 → 반영

`승격→<대상>` 태그가 붙은 항목마다:

1. **제안을 보여준다**: 대상 문서 경로 + 삽입할 내용(요약 1~3줄 + sum 문서 링크). sum 내용을 통째로 복사하지 않는다 — 승격은 증류이지 이동이 아니다.
2. **사용자 확인을 받는다** (일괄 확인 가능).
3. 승인된 것만 대상 문서에 반영. 거부된 것은 sum 문서의 처분을 `보관`으로 수정.

### 5.5 미결 이슈화 제안

원격이 GitHub이고 `gh` 사용 가능하면, 미결 항목 중 **독립 작업 단위**인 것(다음 세션의 즉시 후속이 아니라, 언제 누가 해도 되는 일)을 골라 이슈 생성을 제안한다 (승격과 함께 일괄 확인):

- 제목 = 미결 항목 한 줄. 본문 = 맥락 1-2줄 + sum 문서 링크
- `gh issue list --state open`으로 같은 내용의 열린 이슈가 이미 있으면 생성 대신 참조
- 생성 후 sum 문서의 해당 항목을 `→ 이슈 #N`으로 갱신
- gh가 없거나 원격이 GitHub가 아니면 조용히 생략 (미결은 sum 문서와 INDEX에 남는다)

### 6. INDEX.md 등재

`docs/sum/INDEX.md`에 한 줄 append (없으면 생성):

```markdown
# Session Summaries Index

| 날짜 | 문서 | 한 줄 요약 | 처분 |
|---|---|---|---|
| 2026-07-28 | [session_2026-07-28_topic.md](session_2026-07-28_topic.md) | <한 줄> | 승격 1(AGENTS.md) · 미결 2(이슈 #12·보류 1) · 폐기 1 |
```

### 7. Vault backup + 워크트리 사본 (fail-open)

등재 직후 sum 문서와 `INDEX.md`를 중앙 아카이브(sum-vault)로 백업한다 — 프로젝트 레포는 `docs/sum/`을 추적하지 않으므로(untracked 정책, omp `.omp/rules/harness-doc_standards.md`) vault가 유일한 백업이다. 링크드 워크트리에서 실행된 세션은 추가로 메인 체크아웃 `docs/sum/`에 사본을 남긴다(①.5).

커밋 게이트는 이제 **대상 레포의 `.githooks/pre-commit`** 에서 집행된다(2026-07-30 재설계).
sum-vault는 하네스를 보유하지 않으므로 **관할 밖**이고, `git -C <vault> commit`은 게이트를
거치지 않는다 — 예전의 "리터럴 경로·단독 호출" 요구는 사라졌다. 아래 단계 분리는 규칙이
아니라 위생(실패 지점 분리)으로 유지한다. vault 미보유 머신은 ①에서 안내만 남기고 끝(fail-open).

```bash
# 1) 경로 산출 + vault 사전 체크 (커밋 없음 — 게이트 비대상; SUM_VAULT_DIR 커스텀 반영)
#    링크드 워크트리에서도 <proj>가 워크트리 폴더명이 아닌 메인 프로젝트명이 되도록
#    메인 워크트리 루트 기준으로 산출한다 (git worktree list 첫 항목 = 항상 메인).
T="$(git rev-parse --show-toplevel)"
M="$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
{ [ -n "$M" ] && [ -d "$M" ]; } || M="$T"   # 메인 특정 불가 → 현재 루트로 폴백 (fail-open)
echo "PROJ=$(basename "$M")"; [ "$M" = "$T" ] || echo "MAIN=$M"
V="${SUM_VAULT_DIR:-$HOME/projects/workspace/sum-vault}"
[ -d "$V/.git" ] && realpath "$V" \
  || echo "sum-vault 클론 없음 — 백업 생략 (위치 규약: ~/projects/workspace/sum-vault, env SUM_VAULT_DIR로 재정의)"
```

`MAIN=`이 출력됐으면(= 링크드 워크트리에서 실행) 메인 체크아웃에도 사본을 남긴다 — `git worktree remove`는 ignored인 `docs/sum/`을 경고 없이 함께 지우고, `breadcrumb-surface`는 세션 cwd의 `docs/sum`만 읽으므로 사본이 없으면 서사가 소실된다. `<main>`을 `MAIN=` 값으로, `<index-row>`를 6단계에서 등재한 표 행으로 **리터럴 치환**. vault 유무와 무관하게 수행하고, 실패해도 다음 단계로 진행한다(fail-open):

```bash
# 1.5) 워크트리 → 메인 체크아웃 사본 (MAIN= 출력 시에만; 커밋 없음)
mkdir -p "<main>/docs/sum" && cp "docs/sum/<filename>.md" "<main>/docs/sum/" \
  || echo "메인 체크아웃 사본 실패 — sum 저장·vault 백업은 그대로 진행"
if [ -f "<main>/docs/sum/INDEX.md" ]; then   # 메인 INDEX는 덮어쓰지 않는다 — 행 append만
  cat >> "<main>/docs/sum/INDEX.md" <<'EOF'
<index-row>
EOF
else
  cp "docs/sum/INDEX.md" "<main>/docs/sum/" || echo "메인 INDEX 사본 실패 — 그대로 진행"
fi
```

vault 실경로가 출력됐을 때만 이후 단계 진행 — 아래 `<vault>`를 ①의 실경로 출력으로, `<proj>`를 ①의 `PROJ=` 값으로, `<index>`를 INDEX 원본 경로(메인 체크아웃 실행 시 `docs/sum/INDEX.md`, 워크트리 실행 시 ①.5에서 병합된 `<main>/docs/sum/INDEX.md` — 워크트리의 1행짜리 INDEX로 vault 이력을 덮어쓰지 않기 위함)로 **리터럴 치환**:

```bash
# 2) 스테이징 (커밋 없음) — sum 문서 + INDEX.md 함께 백업
mkdir -p "<vault>/<proj>/sum" && cp "docs/sum/<filename>.md" "<index>" "<vault>/<proj>/sum/" && git -C "<vault>" add -A
```

```bash
# 3) 커밋 (vault는 관할 밖 — 게이트 비대상)
git -C "<vault>" commit -m "sum: <proj>/<filename>"
```
   ("nothing to commit" 실패는 무해 — 재백업과 동일, 그대로 진행)

```bash
# 4) 동기화 + 푸시 (fail-open) — vault는 다중 기록자(여러 프로젝트·머신) 공유 레포라
#    plain push가 non-fast-forward로 거절될 수 있다. push 전에 rebase로 원격을 흡수한다.
git -C "<vault>" pull --rebase --autostash || echo "vault rebase 실패 — 로컬 커밋은 보존됨; 수동 해소 후 push"
git -C "<vault>" push || echo "vault push 실패 — 로컬 vault에는 저장됨; 네트워크 복구 후 재시도"
```

- **fail-open**: vault 부재·rebase/push 실패·메인 체크아웃 특정 불가/사본 실패는 sum 저장 성공에 영향 없음 — 안내만 남긴다.
- vault는 **PRIVATE** 저장소여야 한다 — 서사·프로젝트명이 공개 노출되지 않도록.

### 8. 저장·보고

Report: `File saved: docs/sum/<filename>.md` + 승격 반영 결과(반영 N건 / 대기 N건) + 생성한 이슈(#N …).

### 9. Clear context (optional)

After saving, suggest `/clear` to reset conversation context.

## Scope Limits (과설계 방지)

- 린트, 번호 체계, 자동 검증, co-change 게이트는 도입하지 않는다. 지금 필요한 것은 처분과 진입점 두 개뿐이다.
- 기존 sum 문서의 소급 재구조화를 하지 않는다 (grandfather). 백필은 INDEX 등재까지만.
- `승격 대기`가 INDEX에 반복 누적되면 그때 한 번 전수 감사를 제안한다 — 그 전에는 감사 없음.

## Error Handling

| Condition | Action |
|-----------|--------|
| Can't create directory | Report error, suggest manual creation |
| No meaningful content | Create minimal summary, note "short session" |
| No fixes in session | "이 세션에서 해결한 오류 없음" 표기 |
| No new features | "새로운 구현 없음" 표기 |
| 승격 대상 문서 없음 | 처분을 `승격 대기`로 기록, INDEX에 반영 |
| INDEX.md 충돌/수동 편집 흔적 | 기존 행 보존, append만 수행 |
| gh 없음 / 원격이 GitHub 아님 | 이슈화 단계 조용히 생략 |
| Vault 클론 없음/push 실패 | 백업 생략·안내만, sum 저장은 성공 처리 (fail-open) |
| 워크트리: 메인 특정 불가/사본 실패 | PROJ는 현재 루트 기준으로 폴백·안내만, sum 저장은 성공 처리 (fail-open) |
